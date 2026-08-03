const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../src/api/router');

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

/** 把全局 fetch 换成 mock（AI 网关请求返回 HTML；本地请求放行），返回恢复函数。 */
function mockAiFetch(html) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('http://mock-ai')) return orig(url, opts);
    return { ok: true, json: async () => ({ choices: [{ message: { content: html } }] }) };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

test('POST /api/concepts/map：生成制品入库 + GET /api/settings 回显元信息（不吐 html）', async () => {
  const store = storeWithConcepts();
  const { ctx, savedCount } = ctxFor(store);
  const restore = mockAiFetch('<html><body>MAP</body></html>');
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const post = await call(port, 'POST', '/api/concepts/map', {});
    assert.strictEqual(post.status, 200, JSON.stringify(post.json));
    assert.strictEqual(post.json.ok, true);
    assert.strictEqual(post.json.data.html, '<html><body>MAP</body></html>');
    assert.ok(post.json.data.id, '制品应有 id');
    assert.ok(savedCount() >= 1, '生成后必须 save(store) 持久化');
    assert.strictEqual(store.settings.conceptMaps.length, 1, '制品应写入 store.settings.conceptMaps');
    assert.strictEqual(store.settings.conceptMaps[0].html, '<html><body>MAP</body></html>');

    // settings 回显：只回元信息（html 按需 GET 单个）
    const s = await call(port, 'GET', '/api/settings');
    assert.strictEqual(s.json.data.conceptMaps.length, 1, 'settings 应回显制品元信息');
    assert.strictEqual(s.json.data.conceptMaps[0].html, undefined, 'settings 不回显 html（体积控制）');

    // GET 单个制品取完整 html
    const one = await call(port, 'GET', '/api/concepts/map/' + post.json.data.id);
    assert.strictEqual(one.json.data.html, '<html><body>MAP</body></html>');
  } finally {
    restore();
    server.close();
  }
});

test('POST /api/concepts/map：概念清单为空 → 400；AI 失败 → 502 且不落制品', async () => {
  // 空清单
  const empty = ctxFor({ ...storeWithConcepts(), concepts: [] });
  let server = await startServer(createApiRouter(empty.ctx).handle);
  let port = server.address().port;
  let r = await call(port, 'POST', '/api/concepts/map', {});
  assert.strictEqual(r.status, 400);
  server.close();

  // AI 网关 500（重试后仍失败）→ 502，且不写 conceptMaps
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
    assert.strictEqual(r.status, 502, JSON.stringify(r.json));
    assert.strictEqual((store.settings.conceptMaps || []).length, 0, 'AI 失败不得落半成品制品');
  } finally {
    globalThis.fetch = orig;
    server.close();
  }
});

test('PUT /api/concepts/map：基于 prevHtml 优化已有制品', async () => {
  const store = storeWithConcepts();
  const { ctx } = ctxFor(store);
  const restore = mockAiFetch('<html>v1</html>');
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const post = await call(port, 'POST', '/api/concepts/map', {});
    const id = post.json.data.id;
    globalThis.fetch = (() => {
      const orig2 = globalThis.fetch;
      return async (url, opts) => {
        if (!String(url).startsWith('http://mock-ai')) return orig2(url, opts);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '<html>v2</html>' } }] }) };
      };
    })();
    const put = await call(port, 'PUT', '/api/concepts/map', { id, prompt: '改成矩阵图' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.strictEqual(put.json.data.html, '<html>v2</html>');
    assert.strictEqual(store.settings.conceptMaps.length, 1, '优化不新增制品');
    assert.strictEqual(store.settings.conceptMaps[0].html, '<html>v2</html>');
  } finally {
    restore();
    server.close();
  }
});

test('DELETE /api/concepts/map/:id：删除制品', async () => {
  const store = storeWithConcepts();
  const { ctx } = ctxFor(store);
  const restore = mockAiFetch('<html>x</html>');
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
