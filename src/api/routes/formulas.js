'use strict';

// formulas 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const {
  normalizeFormula,
  normalizeVariables,
  normalizePlotHint,
  deleteFormula,
  formulasToMarkdown,
} = require('../../core/formulas');

function register(t, ctx) {
  const { ok, fail } = ctx;

  // ---- 公式清单（v3.9）----
  // GET /api/formulas (?q= / ?paper=)
  t.get('/api/formulas', async ({ res, q, store }) => {
    let list = (store.formulas || []).slice();
    if (q.paper) list = list.filter((f) => (f.paperIds || []).includes(q.paper));
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      list = list.filter((f) =>
        [f.name, f.canonicalName, f.latex, f.description, f.category].join(' ').toLowerCase().includes(needle),
      );
    }
    return ok(res, list);
  });

  // GET /api/formulas.md  纯 Markdown 文档（KaTeX 语法，Obsidian 可直接渲染）
  t.get('/api/formulas.md', async ({ res, store }) => {
    const md = formulasToMarkdown(store);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  t.patch('/api/formulas/:id', async ({ res, body, params, store, save }) => {
    const f = (store.formulas || []).find((x) => x.id === params.id);
    if (!f) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    if (typeof op.name === 'string') f.name = op.name.trim().slice(0, 200) || f.canonicalName;
    if (typeof op.latex === 'string') {
      // 归一化后为空视为非法（前端清空 latex 会让卡片无内容可渲染）
      const probe = normalizeFormula({ canonicalName: f.canonicalName, latex: op.latex });
      if (!probe) return fail(res, 400, 'invalid latex');
      f.latex = probe.latex;
    }
    if (typeof op.description === 'string') f.description = op.description.trim().slice(0, 4000);
    if (typeof op.category === 'string') f.category = String(op.category).trim().toLowerCase().replace(/\s+/g, '-');
    if (op.variables !== undefined) f.variables = normalizeVariables(op.variables);
    if (op.plottable !== undefined) f.plottable = !!op.plottable;
    if (op.plotHint !== undefined) f.plotHint = normalizePlotHint(op.plotHint);
    f.source = 'manual';
    f.updatedAt = Date.now();
    await save(store);
    return ok(res, f);
  });

  // DELETE /api/formulas/:id
  t.delete('/api/formulas/:id', async ({ res, params, store, save }) => {
    const removed = deleteFormula(store, params.id);
    if (!removed) return fail(res, 404, 'Not found');
    await save(store);
    return ok(res, { deleted: params.id });
  });
}

module.exports = { register };
