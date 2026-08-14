'use strict';

// taxonomy 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { addFolder, deleteFolder } = require('../../core/store');

function register(t, ctx) {
  const { ok, fail } = ctx;

  // GET /api/tags
  t.get('/api/tags', async ({ res, store }) => {
    const counts = {};
    for (const p of Object.values(store.papers)) for (const t of p.tags || []) counts[t] = (counts[t] || 0) + 1;
    return ok(
      res,
      (store.tags || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count),
    );
  });

  // PATCH /api/tags  { merge, into } | { delete }
  t.patch('/api/tags', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    if (op.merge && op.into) {
      for (const p of Object.values(store.papers)) {
        if ((p.tags || []).includes(op.merge)) {
          p.tags = Array.from(new Set(p.tags.map((t) => (t === op.merge ? op.into : t))));
        }
      }
    } else if (op.delete) {
      for (const p of Object.values(store.papers)) p.tags = (p.tags || []).filter((t) => t !== op.delete);
    }
    const set = new Set();
    for (const p of Object.values(store.papers)) for (const t of p.tags || []) set.add(t);
    store.tags = [...set].sort();
    await save(store);
    return ok(res, { tags: store.tags });
  });

  // GET /api/topics  主题字典 + 计数
  t.get('/api/topics', async ({ res, store }) => {
    const counts = {};
    for (const p of Object.values(store.papers)) for (const t of p.topics || []) counts[t] = (counts[t] || 0) + 1;
    return ok(
      res,
      (store.topics || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count),
    );
  });

  // PATCH /api/topics  { merge, into } | { delete }  主题重命名/删除（对齐标签 PATCH）
  t.patch('/api/topics', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    if (op.merge && op.into) {
      for (const p of Object.values(store.papers)) {
        if ((p.topics || []).includes(op.merge)) {
          p.topics = Array.from(new Set(p.topics.map((t) => (t === op.merge ? op.into : t))));
        }
      }
    } else if (op.delete) {
      for (const p of Object.values(store.papers)) p.topics = (p.topics || []).filter((t) => t !== op.delete);
    }
    const set = new Set();
    for (const p of Object.values(store.papers)) for (const t of p.topics || []) set.add(t);
    store.topics = [...set].sort();
    await save(store);
    return ok(res, { topics: store.topics });
  });

  // ---- 收藏夹（虚拟文件夹） ----
  // GET /api/folders
  t.get('/api/folders', async ({ res, store }) => {
    const counts = {};
    for (const p of Object.values(store.papers)) for (const f of p.folders || []) counts[f] = (counts[f] || 0) + 1;
    return ok(
      res,
      (store.folders || []).map((f) => ({ ...f, count: counts[f.id] || 0 })),
    );
  });

  // POST /api/folders { name, color }
  t.post('/api/folders', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const f = addFolder(store, op.name, op.color);
    await save(store);
    return ok(res, f);
  });

  t.patch('/api/folders/:id', async ({ res, body, params, store, save }) => {
    const f = (store.folders || []).find((x) => x.id === params.id);
    if (!f) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    if (op.name) f.name = String(op.name).trim();
    if (op.color) f.color = String(op.color);
    await save(store);
    return ok(res, f);
  });

  // PUT /api/folders/order { ids: [...] }（v3.22 收藏夹管理面板的拖拽排序）
  // 按给定 id 顺序重排：未知 id 忽略、重复取首现；未列出的夹按原相对顺序补在末尾
  // （前端只发可见顺序，新增未同步的夹不会被误删）。返回与 GET 同形（带 count）。
  t.put('/api/folders/order', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
    const byId = new Map((store.folders || []).map((f) => [f.id, f]));
    const next = [];
    const seen = new Set();
    for (const id of ids) {
      const f = byId.get(id);
      if (f && !seen.has(id)) {
        next.push(f);
        seen.add(id);
      }
    }
    for (const f of store.folders || []) if (!seen.has(f.id)) next.push(f);
    store.folders = next;
    await save(store);
    const counts = {};
    for (const p of Object.values(store.papers)) for (const f of p.folders || []) counts[f] = (counts[f] || 0) + 1;
    return ok(res, store.folders.map((f) => ({ ...f, count: counts[f.id] || 0 })));
  });

  // DELETE /api/folders/:id
  t.delete('/api/folders/:id', async ({ res, params, store, save }) => {
    deleteFolder(store, params.id);
    await save(store);
    return ok(res, { deleted: params.id });
  });
}

module.exports = { register };
