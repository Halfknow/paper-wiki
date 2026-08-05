const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../src/api/router');
const { __setBackoffForTests } = require('../src/services/ai');

// 退避置零：AI 失败重试不等真实指数退避（~30s），与本仓库其它测试一致
__setBackoffForTests(() => Promise.resolve());

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

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

/** 最小 ctx（同 api-formulas.test.js 的 ctxFor 模式）。 */
function ctxFor(store, opts = {}) {
  const globalConfig = opts.config || { ai: { baseURL: 'http://mock-ai/v1', apiKey: 'k', model: 'm' } };
  const spaceObj = {
    id: 'default',
    name: '默认',
    papersDir: 'papers',
    scanIntervalMinutes: 5,
    lastScanAt: 0,
    createdAt: 0,
  };
  let saved = 0;
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj,
    getSpace: (id) => (id === 'default' ? spaceObj : null),
    listSpaces: () => [spaceObj],
    getGlobalAi: () => null, // v3.19 全局渠道：本文件不涉及，置空走 per-space 兜底
    getSpaceStore: async () => store,
    saveStoreBinder: () => async () => {
      saved++;
    },
    resolveSpacePapersDir: () => 'papers',
    minScheduledIntervalMs: () => 300000,
    scheduledSpaces: () => [spaceObj],
  };
  const scanner = { scan: async () => ({ added: 0 }), enqueue: () => {} };
  return { ctx: { manager, scanner, globalConfig }, savedCount: () => saved };
}

function storeWithConcepts() {
  return {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [
      { id: 'c1', term: 'Attention', definition: 'd', category: 'model', paperIds: ['p1'], createdAt: 1, updatedAt: 1 },
    ],
    formulas: [],
    settings: {},
    papers: {},
  };
}

/** 把全局 fetch 换成 mock（AI 网关请求返回 SSE 流式 HTML；本地请求放行），返回恢复函数。
 *  v3.14 起 generateConceptMap 走流式（callChatStream）——非流式长请求会被代理空闲超时掐断。 */
function mockAiFetchSse(html) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('http://mock-ai')) return orig(url, opts);
    return {
      ok: true,
      text: async () =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`,
    };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

/** 轮询直到 cond 返回真值（后台任务是异步的，HTTP 响应不含生成结果）。 */
async function waitForCond(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitForCond timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('POST /api/concepts/map：后台占位 → 生成落库 → settings 回显元信息（不吐 html）', async () => {
  const store = storeWithConcepts();
  const { ctx, savedCount } = ctxFor(store);
  const restore = mockAiFetchSse('<html><body>MAP</body></html>');
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const post = await call(port, 'POST', '/api/concepts/map', {});
    assert.strictEqual(post.status, 200, JSON.stringify(post.json));
    assert.strictEqual(post.json.ok, true);
    // v3.14：POST 立即返回 generating 占位（不等 AI），不含 html
    assert.strictEqual(post.json.data.status, 'generating');
    assert.strictEqual(post.json.data.hasHtml, false);
    assert.ok(post.json.data.id, '制品应有 id');
    const id = post.json.data.id;
    assert.strictEqual(store.settings.conceptMaps.length, 1, '占位制品应立即写入 store.settings.conceptMaps');
    // 后台任务完成 → 落库为 ready + html
    await waitForCond(() => {
      const m = store.settings.conceptMaps.find((x) => x.id === id);
      return m && m.status === 'ready' ? m : null;
    });
    assert.strictEqual(store.settings.conceptMaps[0].html, '<html><body>MAP</body></html>');
    assert.ok(savedCount() >= 2, '占位 + 完成各 save 一次');
    // settings 回显：只回元信息（html 按需 GET 单个）
    const s = await call(port, 'GET', '/api/settings');
    assert.strictEqual(s.json.data.conceptMaps.length, 1, 'settings 应回显制品元信息');
    assert.strictEqual(s.json.data.conceptMaps[0].html, undefined, 'settings 不回显 html（体积控制）');
    assert.strictEqual(s.json.data.conceptMaps[0].status, 'ready');
    // GET 单个制品取完整 html
    const one = await call(port, 'GET', '/api/concepts/map/' + id);
    assert.strictEqual(one.json.data.html, '<html><body>MAP</body></html>');
  } finally {
    restore();
    server.close();
  }
});

test('POST /api/concepts/map：概念清单为空 → 400；AI 失败 → 占位转 error（不丢失败现场）', async () => {
  // 空清单
  const empty = ctxFor({ ...storeWithConcepts(), concepts: [] });
  let server = await startServer(createApiRouter(empty.ctx).handle);
  let port = server.address().port;
  let r = await call(port, 'POST', '/api/concepts/map', {});
  assert.strictEqual(r.status, 400);
  server.close();

  // AI 网关 500（重试后仍失败）→ v3.14 起不再 502 挂请求：占位落库，后台任务失败转 error 制品
  const store = storeWithConcepts();
  const { ctx } = ctxFor(store);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('http://mock-ai')) return orig(url, opts);
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  server = await startServer(createApiRouter(ctx).handle);
  port = server.address().port;
  try {
    r = await call(port, 'POST', '/api/concepts/map', {});
    assert.strictEqual(r.status, 200, '后台任务模式下 POST 立即返回占位而非 502');
    assert.strictEqual(r.json.data.status, 'generating');
    const m = await waitForCond(() => {
      const x = store.settings.conceptMaps.find((y) => y.id === r.json.data.id);
      return x && x.status !== 'generating' ? x : null;
    });
    assert.strictEqual(m.status, 'error', 'AI 失败应转 error 制品（前端可见失败原因，可删除重试）');
    assert.ok(m.error.includes('500'), 'error 应带上游状态码，实际：' + m.error);
    assert.strictEqual(m.html, '', '失败不得落 html');
  } finally {
    globalThis.fetch = orig;
    server.close();
  }
});

test('PUT /api/concepts/map：基于 prevHtml 后台优化已有制品（期间旧 html 保留可看）', async () => {
  const store = storeWithConcepts();
  const { ctx } = ctxFor(store);
  const restore = mockAiFetchSse('<html>v1</html>');
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const post = await call(port, 'POST', '/api/concepts/map', {});
    const id = post.json.data.id;
    await waitForCond(() => {
      const m = store.settings.conceptMaps.find((x) => x.id === id);
      return m && m.status === 'ready' ? m : null;
    });
    globalThis.fetch = (() => {
      const orig2 = globalThis.fetch;
      return async (url, opts) => {
        if (!String(url).startsWith('http://mock-ai')) return orig2(url, opts);
        return {
          ok: true,
          text: async () =>
            `data: ${JSON.stringify({ choices: [{ delta: { content: '<html>v2</html>' } }] })}\n\ndata: [DONE]\n\n`,
        };
      };
    })();
    const put = await call(port, 'PUT', '/api/concepts/map', { id, prompt: '改成矩阵图' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.strictEqual(put.json.data.status, 'generating', 'PUT 立即返回 generating（后台优化）');
    assert.strictEqual(store.settings.conceptMaps.length, 1, '优化不新增制品');
    // 后台任务完成后 html 被替换为 v2（优化期间旧 html 保留可看——由路由顺序保证：先 save 占位再启动任务）
    await waitForCond(() => {
      const m = store.settings.conceptMaps.find((x) => x.id === id);
      return m && m.status === 'ready' ? m : null;
    });
    assert.strictEqual(store.settings.conceptMaps[0].html, '<html>v2</html>');
    assert.strictEqual(store.settings.conceptMaps[0].prompt, '改成矩阵图');
  } finally {
    restore();
    server.close();
  }
});

test('DELETE /api/concepts/map/:id：删除制品', async () => {
  const store = storeWithConcepts();
  const { ctx } = ctxFor(store);
  const restore = mockAiFetchSse('<html><body>x</body></html>');
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const post = await call(port, 'POST', '/api/concepts/map', {});
    const id = post.json.data.id;
    const del = await call(port, 'DELETE', '/api/concepts/map/' + id);
    assert.strictEqual(del.json.ok, true);
    assert.strictEqual(store.settings.conceptMaps.length, 0);
    const gone = await call(port, 'GET', '/api/concepts/map/' + id);
    assert.strictEqual(gone.status, 404);
  } finally {
    restore();
    server.close();
  }
});
