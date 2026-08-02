const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { runClaude } = require('../src/services/claude');
const { parseClaudeOutput } = require('../src/services/discover');

// 构造假子进程：EventEmitter + .stdout/.stderr 两个 emitter + .kill()
// （与 claude.js 实际用到的接口一一对应）
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

// 返回 { spawnImpl, calls, getLastChild }：spawnImpl 被调用时记录参数，
// 并在下一个 tick 执行 script(child) 以模拟异步事件（此时 runClaude 已挂好监听器）。
function makeSpawnImpl(script) {
  const calls = [];
  let lastChild = null;
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = fakeChild();
    lastChild = child;
    process.nextTick(() => script(child));
    return child;
  };
  return { spawnImpl, calls, getLastChild: () => lastChild };
}

test('runClaude 成功路径：exit 0 → ok:true，stdout 原样返回，reason 为 null', async () => {
  const payload = JSON.stringify({ result: '{"queries":["ti:\\"moe\\""]}' });
  const { spawnImpl, calls } = makeSpawnImpl((child) => {
    child.stderr.emit('data', Buffer.from('some warning'));
    child.stdout.emit('data', Buffer.from(payload));
    child.emit('close', 0);
  });
  const res = await runClaude('混合专家', { spawnImpl });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.reason, null);
  assert.strictEqual(res.stdout, payload, 'stdout 应原样拼接');
  assert.strictEqual(res.stderr, 'some warning', 'stderr 警告不影响 ok');
  // 验证 spawn 调用参数：cmd + 固定 argv + stdio 配置
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'claude');
  assert.deepStrictEqual(calls[0].args, ['-p', '--output-format', 'json', '混合专家']);
  assert.deepStrictEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('runClaude 非零退出（code=1）→ ok:false，reason=nonzero，不抛错', async () => {
  const { spawnImpl } = makeSpawnImpl((child) => {
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);
  });
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(res.reason, 'nonzero');
  assert.strictEqual(res.stderr, 'boom');
});

test('runClaude 退出码 127 → reason=not_found（command not found 约定）', async () => {
  const { spawnImpl } = makeSpawnImpl((child) => child.emit('close', 127));
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 127);
  assert.strictEqual(res.reason, 'not_found');
});

test('runClaude spawn 同步抛错（如 ENOENT）→ reason=not_found，不抛错', async () => {
  const spawnImpl = () => {
    throw new Error('spawn claude ENOENT');
  };
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, null);
  assert.strictEqual(res.reason, 'not_found');
});

test('runClaude error 事件含 ENOENT → reason=not_found', async () => {
  const { spawnImpl } = makeSpawnImpl((child) => {
    child.emit('error', new Error('spawn claude ENOENT'));
  });
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
});

test('runClaude error 事件为其他错误 → reason=error，不抛错', async () => {
  const { spawnImpl } = makeSpawnImpl((child) => {
    child.emit('error', new Error('permission denied'));
  });
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, null);
  assert.strictEqual(res.reason, 'error');
  assert.match(res.stderr, /permission denied/, 'error 事件消息应并入 stderr');
});

test('runClaude 超时 → kill 子进程，reason=timeout，不抛错', async () => {
  // 脚本什么都不发（子进程挂死），靠 timeoutMs 触发
  const { spawnImpl, getLastChild } = makeSpawnImpl(() => {});
  const res = await runClaude('x', { spawnImpl, timeoutMs: 30 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, null);
  assert.strictEqual(res.reason, 'timeout');
  assert.strictEqual(getLastChild().killed, true, '超时后应调用 child.kill()');
});

test('runClaude 成功后再来的 error/close 事件被忽略（settled 幂等）', async () => {
  const { spawnImpl } = makeSpawnImpl((child) => {
    child.stdout.emit('data', 'ok-data');
    child.emit('close', 0);
    // 重复事件不应改变结果
    child.emit('error', new Error('late error'));
    child.emit('close', 1);
  });
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stdout, 'ok-data');
  assert.strictEqual(res.code, 0);
});

test('runClaude 支持 opts.cmd 覆盖命令名', async () => {
  const { spawnImpl, calls } = makeSpawnImpl((child) => child.emit('close', 0));
  await runClaude('x', { spawnImpl, cmd: 'claude-custom' });
  assert.strictEqual(calls[0].cmd, 'claude-custom');
});

test('runClaude 对 is_error:true 载荷原样放行（由上层 parseClaudeOutput 判失败）', async () => {
  // claude.js 不解析载荷语义：is_error 的 JSON 仍算 ok:true（进程正常退出）
  const payload = JSON.stringify([{ type: 'result', is_error: true, result: 'API Error: 401' }]);
  const { spawnImpl } = makeSpawnImpl((child) => {
    child.stdout.emit('data', payload);
    child.emit('close', 0);
  });
  const res = await runClaude('x', { spawnImpl });
  assert.strictEqual(res.ok, true, 'claude.js 只看退出码，不判 is_error');
  // 上层链路：同样的 stdout 经 parseClaudeOutput 应判为失败(null)
  assert.strictEqual(parseClaudeOutput(res.stdout), null, 'is_error 载荷在解析层被判失败');
});
