const test = require('node:test');
const assert = require('node:assert');

// logger 的 level 在调用时读 env（resolveThreshold 每次调用），故改 env 立即生效；
// 无需 beforeEach reset require cache。但要保证测试间 env 不互相污染 → 用后还原。

const _origLevel = process.env.PW_LOG_LEVEL;
const _origNodeEnv = process.env.NODE_ENV;

function restoreEnv() {
  if (_origLevel === undefined) delete process.env.PW_LOG_LEVEL;
  else process.env.PW_LOG_LEVEL = _origLevel;
  if (_origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = _origNodeEnv;
}

/** 捕获 console.log / console.error 的输出（返回字符串数组）。 */
function captureConsole() {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errs.push(args.join(' '));
  return {
    logs,
    errs,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

test('格式：ISO 时间 + LEVEL + [module] + msg', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('mymod');
    log.info('hello world');
    const line = cap.logs[0];
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 时间前缀');
    assert.match(line, /INFO \[mymod\] hello world$/, 'LEVEL + module + msg');
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('level 过滤：默认 info，debug 不输出', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.debug('dbg');
    log.info('inf');
    assert.strictEqual(cap.logs.length, 1, 'debug 被过滤，info 输出');
    assert.match(cap.logs[0], /INFO/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('PW_LOG_LEVEL=warn 时 info 不输出、warn/error 输出', () => {
  process.env.PW_LOG_LEVEL = 'warn';
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.info('should-skip');
    log.warn('should-warn');
    log.error('should-err');
    assert.strictEqual(cap.logs.length, 1, 'info 过滤');
    assert.match(cap.logs[0], /WARN/);
    assert.strictEqual(cap.errs.length, 1, 'error 走 stderr');
    assert.match(cap.errs[0], /ERROR/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('error 走 console.error（stderr），其余走 console.log', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.info('info-msg');
    log.error('err-msg');
    assert.strictEqual(cap.logs.length, 1);
    assert.strictEqual(cap.errs.length, 1);
    assert.match(cap.logs[0], /info-msg/);
    assert.match(cap.errs[0], /err-msg/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('对象 extra 序列化为 JSON 片段', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.error('写入失败', { id: 'p1', rows: 12 });
    assert.match(cap.errs[0], /写入失败/);
    assert.match(cap.errs[0], /"id":"p1"/);
    assert.match(cap.errs[0], /"rows":12/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('Error 对象：附加堆栈', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    const e = new Error('boom');
    log.error('请求异常', e);
    assert.match(cap.errs[0], /boom/);
    assert.match(cap.errs[0], /Error: boom/); // 堆栈行
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('生产环境默认 warn level（env 未显式设置时）', () => {
  delete process.env.PW_LOG_LEVEL;
  process.env.NODE_ENV = 'production';
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.info('should-skip-in-prod');
    log.warn('should-show');
    assert.strictEqual(cap.logs.length, 1, 'production 默认 warn，info 被过滤');
    assert.match(cap.logs[0], /should-show/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('PW_LOG_LEVEL 显式设置优先于 NODE_ENV', () => {
  process.env.NODE_ENV = 'production';
  process.env.PW_LOG_LEVEL = 'debug';
  const cap = captureConsole();
  try {
    delete require.cache[require.resolve('../src/core/logger')];
    const { createLogger } = require('../src/core/logger');
    const log = createLogger('t');
    log.debug('dbg-in-prod-but-env-overrides');
    assert.strictEqual(cap.logs.length, 1, 'PW_LOG_LEVEL=debug 在 production 下仍生效');
    assert.match(cap.logs[0], /DEBUG/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});

test('util.log() 向后兼容：委托 logger，输出含 [app]', () => {
  delete process.env.PW_LOG_LEVEL;
  delete process.env.NODE_ENV;
  const cap = captureConsole();
  try {
    // util.log 不 require.cache 清除（它内部持有 logger.root 引用，level 仍是动态读）
    const { log } = require('../src/core/util');
    log('a', 'b', 'c');
    assert.strictEqual(cap.logs.length, 1);
    assert.match(cap.logs[0], /\[app\] a b c$/);
  } finally {
    cap.restore();
    restoreEnv();
  }
});
