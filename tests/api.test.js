const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../lib/api');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try { await handler(req, res, body); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
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

function baseCtx(store, save) {
  return {
    store,
    save: save || (async () => {}),
    scanner: { scan: async () => ({ added: 0 }), enqueue: () => {} },
    config: { ai: {} },
  };
}

test('GET /api/papers 返回列表视图', async () => {
  const store = { version: 1, tags: ['rlhf'], papers: {
    a: { id: 'a', title: 'T1', tags: ['rlhf'], status: 'ready', readStatus: 'unread', starred: false, addedAt: 1 },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data[0].id, 'a');
  server.close();
});

test('GET /api/papers 支持标签与全文 q 筛选', async () => {
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'Alpha', tags: ['rlhf'], status: 'ready', addedAt: 1, summary: '', notes: '', abstract: '' },
    b: { id: 'b', title: 'Beta', tags: ['data'], status: 'ready', addedAt: 2, summary: '', notes: '', abstract: '' },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byTag = await call(port, 'GET', '/api/papers?tag=rlhf');
  assert.strictEqual(byTag.json.data.length, 1);
  assert.strictEqual(byTag.json.data[0].id, 'a');
  const byQ = await call(port, 'GET', '/api/papers?q=beta');
  assert.strictEqual(byQ.json.data[0].id, 'b');
  server.close();
});

test('PATCH /api/papers/:id 更新 notes/starred 并持久化', async () => {
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'T', notes: '', starred: false, status: 'ready', updatedAt: 0 },
  } };
  let saved = null;
  const router = createApiRouter(baseCtx(store, async (s) => { saved = s; }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', { notes: 'my note', starred: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.papers.a.notes, 'my note');
  assert.strictEqual(store.papers.a.starred, true);
  assert.ok(saved, 'save should be called');
  server.close();
});

test('GET /api/tags 返回字典+计数', async () => {
  const store = { version: 1, tags: ['rlhf', 'data'], papers: {
    a: { id: 'a', tags: ['rlhf'], status: 'ready' },
    b: { id: 'b', tags: ['rlhf', 'data'], status: 'ready' },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/tags');
  const counts = Object.fromEntries(r.json.data.map((t) => [t.name, t.count]));
  assert.strictEqual(counts.rlhf, 2);
  assert.strictEqual(counts.data, 1);
  server.close();
});
