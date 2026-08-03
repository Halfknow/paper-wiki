const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../src/api/router');
const { mergeFormulas } = require('../src/core/formulas');

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

/** 最小 ctx（同 api.test.js 的 baseCtx，裁剪到公式路由所需）。 */
function ctxFor(store, opts = {}) {
  const globalConfig = opts.config || { ai: {} };
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
  const scanner = {
    scan: async () => ({ added: 0 }),
    enqueue: () => {},
    extractFormulas: async (spaceId, ids) => ({ processed: ids.length, added: 2 }),
    ...(opts.scanner || {}),
  };
  return { ctx: { manager, scanner, globalConfig }, savedCount: () => saved };
}

function storeWith(formulas = [], papers = {}) {
  return {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    formulas,
    settings: {},
    papers,
  };
}

function seedFormulas(store, paperId = 'a') {
  mergeFormulas(
    store,
    [
      {
        canonicalName: 'scaled-dot-product-attention',
        name: '缩放点积注意力',
        latex: '\\mathrm{softmax}(QK^\\top/\\sqrt{d_k})V',
        description: '注意力核心式',
        category: 'attention',
        variables: [{ symbol: 'Q', meaning: '查询矩阵', role: 'input' }],
        rawLatex: 'QK^T',
      },
      { canonicalName: 'kl-divergence', name: 'KL 散度', latex: 'D_{KL}(p\\|q)' },
    ],
    paperId,
  );
  return store;
}

// ---------------------------------------------------------------- 读取

test('GET /api/formulas：全量 / ?paper= / ?q= 筛选', async () => {
  const store = seedFormulas(
    storeWith([], { a: { id: 'a', title: 'A', status: 'ready' }, b: { id: 'b', title: 'B', status: 'ready' } }),
  );
  mergeFormulas(store, [{ canonicalName: 'elbo', name: 'ELBO', latex: '\\mathcal{L}' }], 'b');
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;

  const all = await call(port, 'GET', '/api/formulas');
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.json.data.length, 3);

  const byPaper = await call(port, 'GET', '/api/formulas?paper=b');
  assert.deepStrictEqual(
    byPaper.json.data.map((f) => f.canonicalName),
    ['elbo'],
  );

  // q 匹配 name / canonicalName / latex / description / category
  assert.strictEqual((await call(port, 'GET', '/api/formulas?q=散度')).json.data.length, 1);
  assert.strictEqual((await call(port, 'GET', '/api/formulas?q=attention')).json.data.length, 1);
  assert.strictEqual((await call(port, 'GET', '/api/formulas?q=softmax')).json.data.length, 1);
  assert.strictEqual((await call(port, 'GET', '/api/formulas?q=注意力核心')).json.data.length, 1);
  assert.strictEqual((await call(port, 'GET', '/api/formulas?q=不存在')).json.data.length, 0);
  server.close();
});

test('GET /api/formulas.md：Markdown 导出含公式块与符号表', async () => {
  const store = seedFormulas(storeWith([], { a: { id: 'a', title: 'A 论文', status: 'ready' } }));
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/formulas.md`);
  assert.strictEqual(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const md = await res.text();
  assert.ok(md.includes('# 公式清单'));
  assert.ok(md.includes('缩放点积注意力'));
  assert.ok(md.includes('$$'));
  assert.ok(md.includes('| `Q` | 查询矩阵 |'));
  assert.ok(md.includes('A 论文'));
  server.close();
});

test('GET /api/stats 含 formulas 计数；列表/详情视图含 formulaCount/formulaIds', async () => {
  const store = seedFormulas(storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } }));
  store.papers.a.formulaIds = store.formulas.map((f) => f.id);
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  assert.strictEqual((await call(port, 'GET', '/api/stats')).json.data.formulas, 2);
  assert.strictEqual((await call(port, 'GET', '/api/papers')).json.data[0].formulaCount, 2);
  assert.strictEqual((await call(port, 'GET', '/api/papers/a')).json.data.formulaIds.length, 2);
  server.close();
});

// ---------------------------------------------------------------- 修订 / 删除

test('PATCH /api/formulas/:id：修订字段 + latex 归一化 + source 转 manual', async () => {
  const store = seedFormulas(storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } }));
  const target = store.formulas.find((f) => f.canonicalName === 'kl-divergence');
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;

  const r = await call(port, 'PATCH', `/api/formulas/${target.id}`, {
    name: '  KL 散度（相对熵）  ',
    latex: '$$D_{KL}(P\\|Q)=\\sum_i P(i)\\log\\frac{P(i)}{Q(i)}$$',
    description: '衡量两个分布的差异',
    category: 'Information Theory',
    variables: [
      { symbol: 'P', meaning: '真实分布', role: 'input' },
      { symbol: 'x', role: 'bogus' },
    ],
    plottable: true,
    plotHint: { variable: 'x', range: [0, 1] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.name, 'KL 散度（相对熵）');
  assert.strictEqual(r.json.data.latex, 'D_{KL}(P\\|Q)=\\sum_i P(i)\\log\\frac{P(i)}{Q(i)}', '$$ 被剥离');
  assert.strictEqual(r.json.data.category, 'information-theory');
  assert.strictEqual(r.json.data.variables.length, 2);
  assert.strictEqual(r.json.data.variables[1].role, 'param', '非法 role 兜底');
  assert.strictEqual(r.json.data.plottable, true);
  assert.deepStrictEqual(r.json.data.plotHint, { variable: 'x', range: [0, 1], params: {} });
  assert.strictEqual(r.json.data.source, 'manual');
  assert.strictEqual(r.json.data.canonicalName, 'kl-divergence', 'canonicalName 不可改（合并 key）');
  server.close();
});

test('PATCH /api/formulas/:id：latex 清空被拒（400），未知 id 404', async () => {
  const store = seedFormulas(storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } }));
  const target = store.formulas[0];
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  assert.strictEqual((await call(port, 'PATCH', `/api/formulas/${target.id}`, { latex: '   ' })).status, 400);
  assert.strictEqual((await call(port, 'PATCH', '/api/formulas/fm_nope', { name: 'x' })).status, 404);
  server.close();
});

test('DELETE /api/formulas/:id：删条目并清 paper.formulaIds', async () => {
  const store = seedFormulas(storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } }));
  store.papers.a.formulaIds = store.formulas.map((f) => f.id);
  const target = store.formulas[0];
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', `/api/formulas/${target.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.formulas.length, 1);
  assert.ok(!store.papers.a.formulaIds.includes(target.id));
  assert.strictEqual((await call(port, 'DELETE', `/api/formulas/${target.id}`)).status, 404);
  server.close();
});

// ---------------------------------------------------------------- 批量抽取

test('POST /api/papers/formulas：过滤无效 id 后调 scanner.extractFormulas', async () => {
  const store = storeWith([], {
    a: { id: 'a', title: 'A', status: 'ready' },
    b: { id: 'b', title: 'B', status: 'ready' },
  });
  let gotIds = null;
  const { ctx } = ctxFor(store, {
    scanner: {
      extractFormulas: async (spaceId, ids) => {
        gotIds = ids;
        return { processed: ids.length, added: 3 };
      },
    },
  });
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/formulas', { ids: ['a', 'ghost', 'b'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(gotIds, ['a', 'b'], '不存在的 id 被过滤');
  assert.deepStrictEqual(r.json.data, { processed: 2, added: 3 });
  // 全部无效 → 400
  assert.strictEqual((await call(port, 'POST', '/api/papers/formulas', { ids: ['ghost'] })).status, 400);
  server.close();
});

test('POST /api/papers/formulas：scanner 未实现时 501', async () => {
  const store = storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } });
  const { ctx } = ctxFor(store);
  delete ctx.scanner.extractFormulas;
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  assert.strictEqual((await call(port, 'POST', '/api/papers/formulas', { ids: ['a'] })).status, 501);
  server.close();
});

// ---------------------------------------------------------------- 删论文清理

test('DELETE /api/papers/:id：清理公式 occurrences，孤立条目整条移除', async () => {
  const store = storeWith([], {
    a: { id: 'a', title: 'A', status: 'ready', filepath: null },
    b: { id: 'b', title: 'B', status: 'ready', filepath: null },
  });
  mergeFormulas(store, [{ canonicalName: 'shared', latex: 'x' }], 'a');
  mergeFormulas(store, [{ canonicalName: 'shared', latex: 'x' }], 'b');
  mergeFormulas(store, [{ canonicalName: 'lonely', latex: 'y' }], 'a');
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', '/api/papers/a');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    store.formulas.map((f) => f.canonicalName),
    ['shared'],
    '只被 a 引用的 lonely 被移除',
  );
  assert.deepStrictEqual(store.formulas[0].paperIds, ['b']);
  server.close();
});

// ---------------------------------------------------------------- 整篇抽取候选 + 批量入库

test('POST /api/papers/:id/formulas/merge：批量入库勾选的候选公式', async () => {
  const store = storeWith([], { a: { id: 'a', title: 'A', status: 'ready', formulaIds: [] } });
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/a/formulas/merge', {
    items: [
      { canonicalName: 'ppo-clip-objective', name: 'PPO 裁剪', latex: 'J^{CLIP}', description: '裁剪目标' },
      { canonicalName: 'kl-divergence', name: 'KL 散度', latex: 'D_{KL}', description: '分布差异' },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.added, 2);
  assert.strictEqual(store.formulas.length, 2);
  assert.deepStrictEqual(store.papers.a.formulaIds.length, 2);
  server.close();
});

test('POST /api/papers/:id/formulas/merge：空 items 返回 added:0', async () => {
  const store = storeWith([], { a: { id: 'a', title: 'A', status: 'ready' } });
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/a/formulas/merge', { items: [] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.added, 0);
  server.close();
});

test('POST /api/papers/:id/formulas/merge：未知论文 404', async () => {
  const store = storeWith([], {});
  const { ctx } = ctxFor(store);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  assert.strictEqual((await call(port, 'POST', '/api/papers/ghost/formulas/merge', { items: [] })).status, 404);
  server.close();
});

// ---------------------------------------------------------------- 设置

test('设置：formulaPrompt 三级回显 + PUT /api/settings/formula-prompt', async () => {
  const store = storeWith([], {});
  const { ctx } = ctxFor(store, { config: { ai: {}, formulaPrompt: 'config 级' } });
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  let s = await call(port, 'GET', '/api/settings');
  assert.strictEqual(s.json.data.formulaPrompt, '');
  assert.ok(s.json.data.defaultFormulaPrompt.includes('canonicalName'));
  assert.strictEqual(s.json.data.overrides.formulaPrompt, false);

  await call(port, 'PUT', '/api/settings/formula-prompt', { value: '  我的公式提示词  ' });
  assert.strictEqual(store.settings.formulaPrompt, '我的公式提示词');
  s = await call(port, 'GET', '/api/settings');
  assert.strictEqual(s.json.data.overrides.formulaPrompt, true);

  await call(port, 'PUT', '/api/settings/formula-prompt', { value: '' });
  assert.strictEqual(store.settings.formulaPrompt, '');
  server.close();
});

test('设置：taskMaxInputChars 回显补齐全键 + PUT 白名单写入 + 清空回落 null', async () => {
  const store = storeWith([], {});
  const { ctx } = ctxFor(store, { config: { ai: { maxInputChars: 24000 } } });
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;

  const s = await call(port, 'GET', '/api/settings');
  const t0 = s.json.data.ai.taskMaxInputChars;
  assert.deepStrictEqual(Object.keys(t0).sort(), ['chat', 'concepts', 'formulas', 'notes', 'summary', 'tags']);
  assert.ok(
    Object.values(t0).every((v) => v === null),
    '未设置时全为 null（跟随全局）',
  );

  const put = await call(port, 'PUT', '/api/settings/ai', {
    taskMaxInputChars: { formulas: 120000, summary: 0, bogusTask: 999 },
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.json.data.ai.taskMaxInputChars.formulas, 120000);
  assert.strictEqual(put.json.data.ai.taskMaxInputChars.summary, null, '0 视为跟随全局');
  assert.ok(!('bogusTask' in store.settings.ai.taskMaxInputChars), '非白名单任务键被忽略');

  // 只传部分键不清空其它键
  await call(port, 'PUT', '/api/settings/ai', { taskMaxInputChars: { chat: 8000 } });
  assert.strictEqual(store.settings.ai.taskMaxInputChars.formulas, 120000);
  assert.strictEqual(store.settings.ai.taskMaxInputChars.chat, 8000);

  // 显式 null 清空回落
  await call(port, 'PUT', '/api/settings/ai', { taskMaxInputChars: { formulas: null } });
  assert.strictEqual(store.settings.ai.taskMaxInputChars.formulas, null);
  server.close();
});
