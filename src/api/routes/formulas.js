'use strict';

// formulas 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。
// v3.29 新增：POST /api/formulas（手动录入）+ POST /api/formulas/bulk（批量删除/改分类）；
// PATCH 扩展接受 conceptTerms（编辑抽屉全字段保存）。

const {
  normalizeFormula,
  normalizeVariables,
  normalizePlotHint,
  normalizeConceptTerms,
  deleteFormula,
  formulasToMarkdown,
  mergeFormulas,
  mergeFormulaInto,
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

  // GET /api/formulas.md  纯 Markdown 文档（KaTeX 语法，Obsidian 可直接渲染；全量）
  t.get('/api/formulas.md', async ({ res, store }) => {
    const md = formulasToMarkdown(store);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  // POST /api/formulas.md —— 按当前筛选导出子集（v3.30）：body {ids}
  t.post('/api/formulas.md', async ({ res, body, store }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.map((x) => String(x)) : [];
    const md = formulasToMarkdown(store, { ids });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  // POST /api/formulas/merge —— 重复条目合并（v3.30 治理）：{sourceId, targetId}
  t.post('/api/formulas/merge', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const merged = mergeFormulaInto(store, String(op.sourceId || ''), String(op.targetId || ''));
    if (!merged) return fail(res, 400, 'invalid source/target');
    await save(store);
    return ok(res, { formula: merged });
  });

  // POST /api/formulas —— 手动录入（v3.29）：纸面/其它来源的公式补进知识库，source='manual'。
  // canonicalName 命中已有条目时走合并语义（补空字段 + occurrence 追加），不覆盖已有解读。
  t.post('/api/formulas', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const item = {
      canonicalName: String(op.canonicalName || ''),
      name: String(op.name || ''),
      latex: String(op.latex || ''),
      description: String(op.description || ''),
      category: String(op.category || ''),
      variables: Array.isArray(op.variables) ? op.variables : [],
      plottable: !!op.plottable,
      plotHint: op.plotHint || null,
      conceptTerms: op.conceptTerms,
      source: 'manual',
    };
    const probe = normalizeFormula(item);
    if (!probe) return fail(res, 400, 'canonicalName 与 latex 必填');
    const paperIds = Array.isArray(op.paperIds)
      ? op.paperIds.map((x) => String(x)).filter((id) => store.papers[id])
      : [];
    const before = (store.formulas || []).find((f) => f.id === probe.id);
    const targets = paperIds.length ? paperIds : [null];
    for (const pid of targets) mergeFormulas(store, [item], pid);
    await save(store);
    const f = (store.formulas || []).find((x) => x.id === probe.id);
    if (!f) return fail(res, 500, 'merge failed');
    // 手动新建的论文关联同步进 paper.formulaIds（与 scanner 抽取同维护口径）
    for (const pid of paperIds) {
      const p = store.papers[pid];
      if (p && Array.isArray(p.formulaIds) && !p.formulaIds.includes(f.id)) p.formulaIds.push(f.id);
      else if (p && !Array.isArray(p.formulaIds)) p.formulaIds = [f.id];
    }
    if (paperIds.length) await save(store);
    return ok(res, { formula: f, merged: !!before });
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
    if (op.conceptTerms !== undefined) f.conceptTerms = normalizeConceptTerms(op.conceptTerms);
    if ('starred' in op) f.starred = !!op.starred; // v3.30 重点标记
    // source='manual' 仅在内容字段被修订时标记——纯星标切换不算人工修订
    const contentKeys = [
      'name',
      'latex',
      'description',
      'category',
      'variables',
      'plottable',
      'plotHint',
      'conceptTerms',
    ];
    if (contentKeys.some((k) => op[k] !== undefined)) f.source = 'manual';
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

  // POST /api/formulas/bulk —— 批量管理（v3.29）：{ids, delete:true} 或 {ids, category}。
  t.post('/api/formulas/bulk', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const ids = new Set(Array.isArray(op.ids) ? op.ids.map((x) => String(x)) : []);
    if (!ids.size) return fail(res, 400, 'ids required');
    let n = 0;
    if (op.delete) {
      for (const id of ids) if (deleteFormula(store, id)) n++;
    } else if (typeof op.category === 'string') {
      const category = String(op.category).trim().toLowerCase().replace(/\s+/g, '-');
      for (const f of store.formulas || []) {
        if (ids.has(f.id)) {
          f.category = category;
          f.updatedAt = Date.now();
          n++;
        }
      }
    } else return fail(res, 400, 'nothing to do (delete | category)');
    await save(store);
    return ok(res, { updated: n });
  });
}

module.exports = { register };
