'use strict';

// 阅读架 API 测试（v3.21 多论文阅读抽屉）：
//   · GET/PUT /api/reader-shelf 往返：顺序保持、富化条目（标题/年份/进度）
//   · PUT 规整：去重（保留首次出现）、滤掉不存在的论文 id、上限 50
//   · per-space：?space= 路由到对应空间的 store
//   · 删除论文联动：deletePapersCleanup 就地剔除架子上的 id

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../src/api/router');
const { deletePapersCleanup } = require('../src/api/views');

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

const paper = (id, over = {}) => ({
  id,
  filename: id + '.pdf',
  title: '论文 ' + id,
  year: '2024',
  status: 'ready',
  readStatus: 'reading',
  starred: false,
  readProgress: { page: 3, scrollTop: 10, scale: 1, total: 10, updatedAt: 1 },
  ...over,
});

/** 最小多空间 ctx：只实现 resolveSpace 用到的 manager 方法。save 记录调用供断言。 */
function makeCtx(stores) {
  const saves = { default: 0 };
  const spaceObj = (id) => ({ id, name: id, papersDir: id, scanIntervalMinutes: 5, lastScanAt: 0, createdAt: 0 });
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj('default'),
    getSpace: (id) => (stores[id] ? spaceObj(id) : null),
    listSpaces: () => Object.keys(stores).map(spaceObj),
    getGlobalAi: () => null,
    getSpaceStore: async (id) => stores[id],
    saveStoreBinder: (id) => async () => { saves[id] = (saves[id] || 0) + 1; },
  };
  return { ctx: { manager, scanner: {}, globalConfig: { ai: {} } }, saves };
}

test('GET /api/reader-shelf：空架返回空 ids/items', async () => {
  const store = { papers: { a: paper('a') }, tags: [], topics: [], concepts: [], settings: {} };
  const { ctx } = makeCtx({ default: store });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/reader-shelf');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(r.json.data.ids, []);
  assert.deepStrictEqual(r.json.data.items, []);
  server.close();
});

test('PUT→GET 往返：顺序保持 + items 富化（标题/年份/进度）+ 落库', async () => {
  const store = {
    papers: { a: paper('a'), b: paper('b', { title: '', readProgress: null, readStatus: 'unread' }), c: paper('c') },
    tags: [], topics: [], concepts: [], settings: {},
  };
  const { ctx, saves } = makeCtx({ default: store });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;

  const put = await call(port, 'PUT', '/api/reader-shelf', { ids: ['c', 'a', 'b'] });
  assert.strictEqual(put.json.ok, true);
  assert.deepStrictEqual(put.json.data.ids, ['c', 'a', 'b'], '顺序原样保持');
  assert.strictEqual(saves.default, 1, 'PUT 落库一次');

  const get = await call(port, 'GET', '/api/reader-shelf');
  assert.deepStrictEqual(get.json.data.ids, ['c', 'a', 'b'], 'GET 读回同一顺序');
  const items = get.json.data.items;
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[1].title, '论文 a');
  assert.strictEqual(items[1].year, '2024');
  assert.deepStrictEqual(items[1].readProgress, { page: 3, total: 10 });
  // 无 readProgress 的论文：字段为 null、标题回退 filename
  assert.strictEqual(items[2].readProgress, null);
  assert.strictEqual(items[2].title, 'b.pdf');
  assert.strictEqual(store.settings.readerShelf.length, 3, '持久化到 settings.readerShelf');
  server.close();
});

test('PUT 规整：去重保首次出现 + 滤掉不存在的 id + 上限 50', async () => {
  const papers = {};
  for (let i = 0; i < 60; i++) papers['p' + i] = paper('p' + i);
  const store = { papers, tags: [], topics: [], concepts: [], settings: {} };
  const { ctx } = makeCtx({ default: store });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;

  const ids = ['p1', 'ghost', 'p0', 'p1', 'p2'];
  const r = await call(port, 'PUT', '/api/reader-shelf', { ids });
  assert.deepStrictEqual(r.json.data.ids, ['p1', 'p0', 'p2'], '死 id 滤除 + 重复保首次出现');
  assert.strictEqual(r.json.data.items.length, 3);

  const many = [];
  for (let i = 0; i < 60; i++) many.push('p' + i);
  const r2 = await call(port, 'PUT', '/api/reader-shelf', { ids: many });
  assert.strictEqual(r2.json.data.ids.length, 50, '上限 50 截断');
  server.close();
});

test('GET 自愈：store 里残留死 id（论文已删）时读取即滤除', async () => {
  const store = {
    papers: { a: paper('a') },
    tags: [], topics: [], concepts: [],
    settings: { readerShelf: ['a', 'deleted-one'] },
  };
  const { ctx } = makeCtx({ default: store });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const r = await call(server.address().port, 'GET', '/api/reader-shelf');
  assert.deepStrictEqual(r.json.data.ids, ['a']);
  server.close();
});

test('per-space：?space= 路由到对应空间，互不串', async () => {
  const storeA = { papers: { a: paper('a') }, tags: [], topics: [], concepts: [], settings: { readerShelf: ['a'] } };
  const storeB = { papers: { b: paper('b') }, tags: [], topics: [], concepts: [], settings: {} };
  const { ctx } = makeCtx({ default: storeA, second: storeB });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;

  const rb = await call(port, 'GET', '/api/reader-shelf?space=second');
  assert.deepStrictEqual(rb.json.data.ids, [], 'second 空间独立为空');

  await call(port, 'PUT', '/api/reader-shelf?space=second', { ids: ['b'] });
  const ra = await call(port, 'GET', '/api/reader-shelf');
  assert.deepStrictEqual(ra.json.data.ids, ['a'], 'default 空间不受影响');
  server.close();
});

test('deletePapersCleanup 联动剔除阅读架上的被删论文', () => {
  const store = {
    papers: { a: paper('a'), b: paper('b'), c: paper('c') },
    tags: [], topics: [], concepts: [], formulas: [],
    settings: { readerShelf: ['a', 'b', 'c'] },
  };
  const removed = deletePapersCleanup(store, ['b'], '/papers');
  // v3.63 返回 { ids, conceptsRemoved, formulasRemoved }（keepKnowledge 选项配套）
  assert.deepStrictEqual(removed.ids, ['b']);
  assert.deepStrictEqual(store.settings.readerShelf, ['a', 'c'], '被删论文从架上就地剔除');
  // 无 readerShelf 设置的旧 store 不受影响（不凭空创建字段）
  const store2 = { papers: { a: paper('a') }, tags: [], topics: [], concepts: [], formulas: [], settings: {} };
  deletePapersCleanup(store2, ['a'], '/papers');
  assert.strictEqual(store2.settings.readerShelf, undefined);
});
