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
    scanner: { scan: async () => ({ added: 0 }), enqueue: () => {}, extractConcepts: async (ids) => ({ processed: ids.length, added: 1 }) },
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

test('PATCH→GET 批注往返：对象型 quadPoints 被还原为真数组（高亮持久化根因修复）', async () => {
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'T', status: 'ready', annotations: null },
  } };
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 复刻浏览器：serializable 里 quadPoints 是 Float32Array，经 fetch 的 JSON.stringify 发出，
  // 到服务端已退化成 {"0":..} 对象（call() 内部 JSON.stringify 等价于这一步）。
  const payload = { items: [{
    id: null, annotationType: 9, color: [187, 247, 208], opacity: 1, thickness: 12,
    quadPoints: new Float32Array([265, 660, 329, 660, 265, 649, 329, 649]),
    pageIndex: 0, rect: [69, 524, 525, 664],
  }], updatedAt: 1 };
  const w = await call(port, 'PATCH', '/api/papers/a', { annotations: payload });
  assert.strictEqual(w.status, 200);
  // 写入侧：落盘的 quadPoints 必须是真数组
  const storedQp = store.papers.a.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(storedQp), '落盘 quadPoints 应为数组');
  assert.strictEqual(storedQp.length, 8);
  // 读取侧：GET 详情返回的 quadPoints 可被 pdf.js 的 for(i<length;i+=8) 正常重建
  const r = await call(port, 'GET', '/api/papers/a');
  const qp = r.json.data.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(qp));
  let boxes = 0; for (let i = 0; i < qp.length; i += 8) boxes++;
  assert.strictEqual(boxes, 1, '高亮区域应可重建（修复前为 0）');
  server.close();
});

test('GET 详情：自愈历史脏数据（已落盘的对象型 quadPoints）', async () => {
  // 模拟历史上已被写坏的存量数据：quadPoints 已是 {"0":..} 对象
  const corrupted = JSON.parse(JSON.stringify({ q: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) })).q;
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'T', status: 'ready', annotations: { items: [{ annotationType: 9, quadPoints: corrupted, pageIndex: 0 }], updatedAt: 1 } },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers/a');
  const qp = r.json.data.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(qp), '读取时应把存量脏数据还原为数组');
  assert.deepStrictEqual(qp, [1, 2, 3, 4, 5, 6, 7, 8]);
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

test('GET /api/papers 支持 topic 与 folder 筛选', async () => {
  const store = { version: 2, tags: [], topics: ['推理'], folders: [], concepts: [], papers: {
    a: { id: 'a', title: 'A', tags: [], topics: ['推理'], folders: ['f1'], status: 'ready', addedAt: 1 },
    b: { id: 'b', title: 'B', tags: [], topics: ['数据'], folders: [], status: 'ready', addedAt: 2 },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byTopic = await call(port, 'GET', '/api/papers?topic=' + encodeURIComponent('推理'));
  assert.strictEqual(byTopic.json.data.length, 1);
  assert.strictEqual(byTopic.json.data[0].id, 'a');
  const byFolder = await call(port, 'GET', '/api/papers?folder=f1');
  assert.strictEqual(byFolder.json.data.length, 1);
  assert.strictEqual(byFolder.json.data[0].id, 'a');
  server.close();
});

test('PATCH /api/papers/:id 可写入 topics/folders/readProgress', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {
    a: { id: 'a', title: 'T', topics: [], folders: [], readProgress: null, status: 'ready', updatedAt: 0 },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', { topics: ['推理'], folders: ['f1'], readProgress: { page: 3, scrollTop: 120 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(store.papers.a.topics, ['推理']);
  assert.deepStrictEqual(store.papers.a.folders, ['f1']);
  assert.strictEqual(store.papers.a.readProgress.page, 3);
  assert.ok(store.topics.includes('推理'));
  server.close();
});

test('收藏夹 CRUD：POST / PATCH / DELETE，计数随论文变化', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {
    a: { id: 'a', title: 'A', folders: [], status: 'ready' },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const create = await call(port, 'POST', '/api/folders', { name: '精读', color: '#2563eb' });
  assert.strictEqual(create.status, 200);
  const fid = create.json.data.id;
  store.papers.a.folders = [fid];
  const list = await call(port, 'GET', '/api/folders');
  assert.strictEqual(list.json.data[0].count, 1);
  const upd = await call(port, 'PATCH', '/api/folders/' + fid, { name: '已精读' });
  assert.strictEqual(upd.json.data.name, '已精读');
  const del = await call(port, 'DELETE', '/api/folders/' + fid);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(store.folders.length, 0);
  assert.deepStrictEqual(store.papers.a.folders, []); // 自动解绑
  server.close();
});

test('GET /api/concepts 与概念清单 Markdown', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [],
    concepts: [{ id: 'c1', term: 'RLHF', definition: 'd', paperIds: ['a'] }], papers: {
      a: { id: 'a', title: 'A 论文', conceptIds: ['c1'], status: 'ready' },
    } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byPaper = await call(port, 'GET', '/api/concepts?paper=a');
  assert.strictEqual(byPaper.json.data.length, 1);
  const mdRes = await fetch(`http://127.0.0.1:${port}/api/concepts.md`);
  const md = await mdRes.text();
  assert.ok(md.includes('# 概念清单'));
  assert.ok(md.includes('RLHF'));
  server.close();
});

test('POST /api/papers/concepts 对选中论文调用 scanner.extractConcepts', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {
    a: { id: 'a', title: 'A', status: 'ready' },
    b: { id: 'b', title: 'B', status: 'ready' },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/concepts', { ids: ['a', 'b'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.processed, 2);
  server.close();
});

test('GET /api/stats 含 folders/topics/concepts 计数', async () => {
  const store = { version: 2, tags: [], topics: ['推理'], folders: [{ id: 'f1', name: 'x' }], concepts: [{ id: 'c1', term: 'y' }], papers: {
    a: { id: 'a', status: 'ready' },
  } };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/stats');
  assert.strictEqual(r.json.data.folders, 1);
  assert.strictEqual(r.json.data.topics, 1);
  assert.strictEqual(r.json.data.concepts, 1);
  server.close();
});

test('GET /api/settings 返回 summaryPrompt 与内置默认', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: { summaryPrompt: '我的提示词' }, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/settings');
  assert.strictEqual(r.json.data.summaryPrompt, '我的提示词');
  assert.ok(r.json.data.defaultPrompt && r.json.data.defaultPrompt.length > 50);
  server.close();
});

test('PUT /api/settings/summary-prompt 持久化并 trim', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let saved = null;
  const router = createApiRouter(baseCtx(store, async (s) => { saved = s; }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/summary-prompt', { value: '  新提示  ' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.summaryPrompt, '新提示');
  assert.ok(saved, 'save should be called');
  // 空串 = 恢复默认
  const r2 = await call(port, 'PUT', '/api/settings/summary-prompt', { value: '   ' });
  assert.strictEqual(store.settings.summaryPrompt, '');
  server.close();
});
