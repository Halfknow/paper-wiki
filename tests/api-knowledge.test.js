'use strict';

// v3.29 知识页深度功能 API 测试：POST /api/concepts（手动录入）、POST /api/concepts/bulk、
// per-paper contexts（由来）、POST /api/formulas（手动录入）、POST /api/formulas/bulk、
// PATCH /api/formulas 的 conceptTerms/plotHint.plotExpr。

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../src/api/router');
const { mergeConcepts } = require('../src/core/store');

// 服务器兜底回收：断言失败若发生在 server.close() 之前，监听中的 server 会让测试进程
// 永不退出（node --test 挂起）。after() 统一兜底 close（幂等，已 close 的再调无副作用）。
const _servers = [];
after(() => {
  for (const s of _servers) s.close();
});

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
    server.listen(0, '127.0.0.1', () => {
      _servers.push(server);
      resolve(server);
    });
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

/** 最小 ctx（同 api-formulas.test.js，裁剪到知识页路由所需）。 */
function ctxFor(store) {
  const spaceObj = {
    id: 'default',
    name: '默认',
    papersDir: 'papers',
    scanIntervalMinutes: 5,
    lastScanAt: 0,
    createdAt: 0,
  };
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj,
    getSpace: (id) => (id === 'default' ? spaceObj : null),
    listSpaces: () => [spaceObj],
    getGlobalAi: () => null,
    getSpaceStore: async () => store,
    saveStoreBinder: () => async () => {},
    resolveSpacePapersDir: () => 'papers',
    minScheduledIntervalMs: () => 300000,
    scheduledSpaces: () => [spaceObj],
  };
  return {
    manager,
    scanner: { scan: async () => ({ added: 0 }) },
    globalConfig: { ai: {} },
    ok: (res, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data }));
    },
    fail: (res, code, error) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error }));
    },
  };
}

function baseStore() {
  return {
    version: 2,
    papers: {
      p1: { id: 'p1', title: 'Paper One', filename: 'a.pdf', formulaIds: [], conceptIds: [] },
      p2: { id: 'p2', title: 'Paper Two', filename: 'b.pdf', formulaIds: [], conceptIds: [] },
    },
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    formulas: [],
    settings: {},
  };
}

test('POST /api/concepts：手动录入（manual 源 + 多论文关联 + per-paper 由来）', async () => {
  const store = baseStore();
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts', {
    term: 'Flow Matching',
    definition: '用常微分方程把噪声分布搬运到数据分布的生成范式。',
    category: 'generative',
    importance: 'core',
    context: '组会笔记 2026-08',
    paperIds: ['p1', 'p2', 'ghost'], // ghost 不存在，应被忽略
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  const c = r.json.data.concept;
  assert.strictEqual(c.term, 'Flow Matching');
  assert.strictEqual(c.source, 'manual');
  assert.strictEqual(c.importance, 'core');
  assert.deepStrictEqual(c.paperIds, ['p1', 'p2']);
  assert.strictEqual(c.contexts.length, 2, 'per-paper 由来两篇各一条');
  assert.ok(c.contexts.every((x) => x.context === '组会笔记 2026-08'));
  assert.strictEqual(r.json.data.merged, false);
  // 再次录入同一 term → 合并语义：不覆盖已有 definition，merged=true
  const r2 = await call(port, 'POST', '/api/concepts', {
    term: 'flow matching',
    definition: '新的解释应被忽略',
    paperIds: ['p2'],
  });
  assert.strictEqual(r2.json.data.merged, true);
  assert.strictEqual(r2.json.data.concept.definition, '用常微分方程把噪声分布搬运到数据分布的生成范式。');
  // 缺 term → 400
  const r3 = await call(port, 'POST', '/api/concepts', { definition: 'x' });
  assert.strictEqual(r3.status, 400);
  server.close();
});

test('POST /api/concepts/bulk：批量删除 + 批量改分类', async () => {
  const store = baseStore();
  const [idA, idB] = [0, 1].map((i) => mergeConcepts(store, [{ term: 'Term' + i }], 'p1')[0]);
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts/bulk', { ids: [idA, idB], category: 'attention' });
  assert.strictEqual(r.json.data.updated, 2);
  assert.ok(store.concepts.every((c) => c.category === 'attention'));
  const r2 = await call(port, 'POST', '/api/concepts/bulk', { ids: [idA], delete: true });
  assert.strictEqual(r2.json.data.updated, 1);
  assert.strictEqual(store.concepts.length, 1);
  assert.strictEqual(store.concepts[0].id, idB);
  // 空 ids / 无动作 → 400
  assert.strictEqual((await call(port, 'POST', '/api/concepts/bulk', { ids: [] })).status, 400);
  assert.strictEqual((await call(port, 'POST', '/api/concepts/bulk', { ids: [idB] })).status, 400);
  server.close();
});

test('POST /api/formulas：手动录入（manual 源 + 论文关联 + paper.formulaIds 回填）', async () => {
  const store = baseStore();
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/formulas', {
    canonicalName: 'my-handmade-loss',
    name: '手工损失',
    latex: 'L = \\\\sum_i (y_i - f(x_i))^2',
    description: '手写示例。',
    category: 'loss',
    variables: [{ symbol: 'y_i', meaning: '标签（标量）', role: 'input' }],
    plottable: true,
    plotHint: { variable: 'x', range: [0, 5], params: { s: 2 }, plotExpr: 'x^s' },
    paperIds: ['p1'],
  });
  assert.strictEqual(r.status, 200);
  const f = r.json.data.formula;
  assert.strictEqual(f.source, 'manual');
  assert.ok(f.id.startsWith('fm_'));
  assert.deepStrictEqual(f.paperIds, ['p1']);
  assert.strictEqual(f.occurrences.length, 1);
  assert.strictEqual(f.plotHint.plotExpr, 'x^s');
  assert.deepStrictEqual(store.papers.p1.formulaIds, [f.id], 'paper.formulaIds 回填');
  // 命中已有 canonicalName → 合并（不覆盖解读）
  const r2 = await call(port, 'POST', '/api/formulas', {
    canonicalName: 'my-handmade-loss',
    latex: 'B',
    description: '应被忽略',
    paperIds: ['p2'],
  });
  assert.strictEqual(r2.json.data.merged, true);
  assert.strictEqual(r2.json.data.formula.description, '手写示例。');
  assert.deepStrictEqual(r2.json.data.formula.paperIds.sort(), ['p1', 'p2'].sort());
  // 缺 canonicalName/latex → 400
  assert.strictEqual((await call(port, 'POST', '/api/formulas', { latex: 'x' })).status, 400);
  server.close();
});

test('POST /api/formulas/bulk + PATCH conceptTerms', async () => {
  const store = baseStore();
  const { mergeFormulas } = require('../src/core/formulas');
  mergeFormulas(
    store,
    [
      { canonicalName: 'f-a', latex: 'a=b' },
      { canonicalName: 'f-b', latex: 'c=d' },
    ],
    'p1',
  );
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  const ids = store.formulas.map((f) => f.id);
  // 批量改分类
  const r = await call(port, 'POST', '/api/formulas/bulk', { ids, category: 'loss' });
  assert.strictEqual(r.json.data.updated, 2);
  assert.ok(store.formulas.every((f) => f.category === 'loss'));
  // PATCH conceptTerms（编辑抽屉保存路径）
  const r2 = await call(port, 'PATCH', '/api/formulas/' + ids[0], { conceptTerms: ['Flow Matching', ''] });
  assert.deepStrictEqual(r2.json.data.conceptTerms, ['Flow Matching']);
  assert.strictEqual(r2.json.data.source, 'manual');
  // 批量删除
  const r3 = await call(port, 'POST', '/api/formulas/bulk', { ids: [ids[0]], delete: true });
  assert.strictEqual(r3.json.data.updated, 1);
  assert.strictEqual(store.formulas.length, 1);
  server.close();
});

// ---------------------------------------------------------------- v3.30：合并 / 星标 / 筛选导出 / AI 解读

test('v3.30 POST /api/concepts/merge：paperIds/contexts 并集 + papers 反向替换 + source 删除', async () => {
  const store = baseStore();
  const { mergeConcepts } = require('../src/core/store');
  mergeConcepts(store, [{ term: 'Self-Attention', context: '3.1 节' }], 'p1');
  mergeConcepts(store, [{ term: 'self attention', context: '式(5)' }], 'p2');
  const source = store.concepts.find((c) => c.term === 'Self-Attention');
  const target = store.concepts.find((c) => c.term === 'self attention');
  store.papers.p1.conceptIds = [source.id];
  store.papers.p2.conceptIds = [target.id];
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts/merge', { sourceId: source.id, targetId: target.id });
  assert.strictEqual(r.status, 200);
  const merged = r.json.data.concept;
  assert.strictEqual(merged.id, target.id);
  assert.deepStrictEqual(merged.paperIds.sort(), ['p1', 'p2'].sort());
  assert.strictEqual(merged.contexts.length, 2, 'per-paper 由来并集');
  // papers 反向替换：p1 的 conceptIds 指向 target，source 消失
  assert.deepStrictEqual(store.papers.p1.conceptIds, [target.id]);
  assert.strictEqual(store.concepts.length, 1);
  // 自并 / 不存在 → 400
  assert.strictEqual(
    (await call(port, 'POST', '/api/concepts/merge', { sourceId: target.id, targetId: target.id })).status,
    400,
  );
  assert.strictEqual(
    (await call(port, 'POST', '/api/concepts/merge', { sourceId: 'ghost', targetId: target.id })).status,
    400,
  );
  server.close();
});

test('v3.30 PATCH starred + 纯星标不改 source（公式）；概念 starred 往返', async () => {
  const store = baseStore();
  const { mergeFormulas } = require('../src/core/formulas');
  mergeFormulas(store, [{ canonicalName: 'elbo', latex: 'A', description: '解读' }], 'p1');
  const f = store.formulas[0];
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  // 纯星标 PATCH：source 保持 ai（不算人工修订）
  const r1 = await call(port, 'PATCH', '/api/formulas/' + f.id, { starred: true });
  assert.strictEqual(r1.json.data.starred, true);
  assert.strictEqual(r1.json.data.source, 'ai', '纯星标不改 source');
  // 内容 PATCH：source → manual
  const r2 = await call(port, 'PATCH', '/api/formulas/' + f.id, { description: '新解读' });
  assert.strictEqual(r2.json.data.source, 'manual');
  // 概念 starred
  const cid = require('../src/core/store').mergeConcepts(store, [{ term: 'X' }], 'p1')[0];
  const r3 = await call(port, 'PATCH', '/api/concepts/' + cid, { starred: true });
  assert.strictEqual(r3.json.data.starred, true);
  server.close();
});

test('v3.30 POST /api/concepts.md：ids 子集导出 + starred ⭐ 标记', async () => {
  const store = baseStore();
  const { mergeConcepts } = require('../src/core/store');
  const ids = [
    ...mergeConcepts(store, [{ term: 'Alpha', definition: 'a', starred: true }], 'p1'),
    ...mergeConcepts(store, [{ term: 'Beta', definition: 'b' }], 'p1'),
  ];
  const server = await startServer(createApiRouter(ctxFor(store)).handle);
  const port = server.address().port;
  // 全量 GET：两条都在，starred 带 ⭐
  const all = await fetch(`http://127.0.0.1:${port}/api/concepts.md`).then((r) => r.text());
  assert.ok(all.includes('### ⭐ Alpha'), 'starred 概念带 ⭐');
  assert.ok(all.includes('### Beta'));
  // 子集 POST：只含 Beta
  const sub = await fetch(`http://127.0.0.1:${port}/api/concepts.md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [ids[1]] }),
  }).then((r) => r.text());
  assert.ok(sub.includes('### Beta'));
  assert.ok(!sub.includes('Alpha'), '子集导出不含未选条目');
  server.close();
});

test('v3.30 POST /api/concepts/:id/explain：SSE 流式（token/done），404 未知概念', async () => {
  const store = baseStore();
  const { mergeConcepts } = require('../src/core/store');
  const [id] = mergeConcepts(store, [{ term: 'RLHF', definition: 'd' }], 'p1');
  const tokens = [];
  const ctx = ctxFor(store);
  ctx.scanner = { scan: async () => ({ added: 0 }) };
  // 假 AI：流式回 3 个 token
  ctx.config = { ai: {} };
  const router = createApiRouter({
    ...ctx,
    // 覆盖 routes 不可行——explain 直接 require services/ai。改为在其上打补丁：
  });
  const aiSvc = require('../src/services/ai');
  const orig = aiSvc.callChatStream;
  aiSvc.callChatStream = async ({ onToken }) => {
    onToken({ t: 'hel' });
    onToken({ t: 'lo' });
  };
  const server = await startServer(router.handle);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/concepts/${id}/explain`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text();
  aiSvc.callChatStream = orig; // 还原（同进程内其它测试不受影响）
  assert.ok(body.includes('event: token'), 'token 事件');
  assert.ok(body.includes('"tok":"hel"') || body.includes('"t"'), 'token 数据');
  assert.ok(body.includes('event: done'), 'done 事件');
  const r404 = await fetch(`http://127.0.0.1:${port}/api/concepts/ghost/explain`, { method: 'POST' });
  assert.strictEqual(r404.status, 404);
  server.close();
});
