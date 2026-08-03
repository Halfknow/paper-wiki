'use strict';

// concepts 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { deleteConcept, conceptsToMarkdown } = require('../../core/store');

function register(t, ctx) {
  const { ok, fail } = ctx;

  // ---- 概念清单 ----
  // GET /api/concepts (?q= / ?paper=)
  t.get('/api/concepts', async ({ res, q, store }) => {
    let list = (store.concepts || []).slice();
    if (q.paper) list = list.filter((c) => (c.paperIds || []).includes(q.paper));
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      list = list.filter((c) => (c.term + ' ' + (c.definition || '')).toLowerCase().includes(needle));
    }
    return ok(res, list);
  });

  // GET /api/concepts.md  纯 Markdown 文档
  t.get('/api/concepts.md', async ({ res, store }) => {
    const md = conceptsToMarkdown(store);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  t.patch('/api/concepts/:name', async ({ res, body, params, store, save }) => {
    const c = (store.concepts || []).find((x) => x.id === params.name);
    if (!c) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    if (op.term) c.term = String(op.term).trim();
    if ('definition' in op) c.definition = String(op.definition).trim();
    if ('category' in op)
      c.category =
        String(op.category || '')
          .trim()
          .toLowerCase() || 'other';
    c.updatedAt = Date.now();
    await save(store);
    return ok(res, c);
  });

  // DELETE /api/concepts/:id
  t.delete('/api/concepts/:name', async ({ res, params, store, save }) => {
    const removed = deleteConcept(store, params.name);
    if (!removed) return fail(res, 404, 'Not found');
    await save(store);
    return ok(res, { deleted: params.name });
  });
}

module.exports = { register };
