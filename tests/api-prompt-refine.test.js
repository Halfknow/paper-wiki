const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const pathm = require('node:path');
const { createApiRouter } = require('../src/api/router');
// 命名空间访问：monkey-patch callChatStream 拦截 prompt-refine 的 AI 调用（见 routes/settings.js 顶部注释）
const aiSvc = require('../src/services/ai');

// ---- 测试夹具（从 tests/api.test.js 复制，保持本文件自包含）----

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try {
        await handler(req, res, body);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseCtx(store, save, opts = {}) {
  const globalConfig = opts.config || { ai: {}, scanIntervalMinutes: 5 };
  const papersDir = opts.papersDir || 'papers';
  const spaceObj = { id: 'default', name: '默认', papersDir, scanIntervalMinutes: 5, lastScanAt: 0, createdAt: 0 };
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj,
    getSpace: (id) => (id === 'default' ? spaceObj : null),
    listSpaces: () => [spaceObj],
    getGlobalAi: () => null,
    getStorePath: () => 'papers.json',
    getSpaceStore: async () => store,
    saveStoreBinder: () => async () => {
      if (save) await save(store);
    },
    resolveSpacePapersDir: () => papersDir,
    resolveSpaceTextDir: () => pathm.join(papersDir, 'text'),
    spacesView: async () => ({ activeSpaceId: 'default', spaces: [{ ...spaceObj, paperCount: 0 }] }),
    minScheduledIntervalMs: () => 5 * 60 * 1000,
    scheduledSpaces: () => [spaceObj],
    markScanned: async () => {},
    backupAllSpaces: async () => {},
  };
  const scanner = { scan: async () => ({ added: 0 }), reschedule: async () => {}, invalidate: () => {} };
  return { manager, scanner, globalConfig };
}

function emptyStore(settings = {}) {
  return { version: 2, tags: [], topics: [], folders: [], concepts: [], formulas: [], settings, papers: {} };
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

test('prompt-refine：未知 key / 空 request 返回 400（JSON，非 SSE）', async () => {
  const router = createApiRouter(baseCtx(emptyStore()));
  const server = await startServer(router.handle);
  const port = server.address().port;
  try {
    const r1 = await post(port, '/api/settings/prompt-refine', { key: 'nope', request: 'x' });
    assert.strictEqual(r1.status, 400);
    assert.match((await r1.json()).error, /unknown prompt key/);
    const r2 = await post(port, '/api/settings/prompt-refine', { key: 'summary', request: '   ' });
    assert.strictEqual(r2.status, 400);
    assert.match((await r2.json()).error, /request required/);
  } finally {
    server.close();
  }
});

test('prompt-refine：SSE 流式产出修改稿；base 缺省取「覆盖值 || 内置默认」', async () => {
  const orig = aiSvc.callChatStream;
  const captured = {};
  aiSvc.callChatStream = async ({ messages, onToken }) => {
    captured.messages = messages;
    onToken('改后');
    onToken('稿件');
  };
  try {
    const store = emptyStore({ summaryPrompt: '我的自定义总结提示词' });
    const router = createApiRouter(baseCtx(store));
    const server = await startServer(router.handle);
    const port = server.address().port;
    try {
      const res = await post(port, '/api/settings/prompt-refine', { key: 'summary', request: '加一节局限性' });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const text = await res.text();
      assert.ok(text.includes('event: token'), '有 token 事件');
      assert.ok(text.includes('改后') && text.includes('稿件'), 'token 内容齐全');
      assert.ok(text.includes('event: done'), '有 done 事件');
      // user 消息带「覆盖值」（非内置默认）与修改要求
      const user = captured.messages.find((m) => m.role === 'user').content;
      assert.ok(user.includes('我的自定义总结提示词'), 'base = 当前覆盖值');
      assert.ok(user.includes('加一节局限性'), '修改要求进入 user 消息');
      // system 消息含该提示词的保留机制说明（防把硬约束改丢）
      const system = captured.messages.find((m) => m.role === 'system').content;
      assert.ok(system.includes('Markdown'), 'summary 的硬约束说明进入 system');
    } finally {
      server.close();
    }
  } finally {
    aiSvc.callChatStream = orig;
  }
});

test('prompt-refine：显式 base 优先（多轮修改时前端传上一稿）；AI 异常发 fail 事件', async () => {
  const orig = aiSvc.callChatStream;
  const captured = {};
  aiSvc.callChatStream = async ({ messages }) => {
    captured.messages = messages;
    throw new Error('网关 502');
  };
  try {
    const store = emptyStore({ tagsPrompt: '覆盖值不应被采用' });
    const router = createApiRouter(baseCtx(store));
    const server = await startServer(router.handle);
    const port = server.address().port;
    try {
      const res = await post(port, '/api/settings/prompt-refine', {
        key: 'tags',
        request: '再精简一点',
        base: '上一稿修改稿',
      });
      const text = await res.text();
      const user = captured.messages.find((m) => m.role === 'user').content;
      assert.ok(user.includes('上一稿修改稿'), '显式 base 优先于覆盖值');
      assert.ok(!user.includes('覆盖值不应被采用'), '覆盖值未被采用');
      assert.ok(text.includes('event: fail'), 'AI 异常 → fail 事件');
      assert.ok(text.includes('网关 502'), 'fail 带错误信息');
    } finally {
      server.close();
    }
  } finally {
    aiSvc.callChatStream = orig;
  }
});

test('prompt-refine：无覆盖时 base 落内置默认；mineruNaming 取 formulas.namingPrompt', async () => {
  const orig = aiSvc.callChatStream;
  const captured = {};
  aiSvc.callChatStream = async ({ messages }) => {
    captured.messages = messages;
  };
  try {
    const store = emptyStore({ formulas: { namingPrompt: '我的命名提示词' } });
    const router = createApiRouter(baseCtx(store));
    const server = await startServer(router.handle);
    const port = server.address().port;
    try {
      await post(port, '/api/settings/prompt-refine', { key: 'concept', request: 'x' }).then((r) => r.text());
      assert.ok(
        captured.messages.find((m) => m.role === 'user').content.includes(aiSvc.DEFAULT_CONCEPT_PROMPT.slice(0, 40)),
        '无覆盖时 base = 内置默认概念提示词',
      );
      await post(port, '/api/settings/prompt-refine', { key: 'mineruNaming', request: 'x' }).then((r) => r.text());
      assert.ok(
        captured.messages.find((m) => m.role === 'user').content.includes('我的命名提示词'),
        'mineruNaming 的覆盖值取自 settings.formulas.namingPrompt',
      );
    } finally {
      server.close();
    }
  } finally {
    aiSvc.callChatStream = orig;
  }
});
