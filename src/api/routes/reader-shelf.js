'use strict';

// 阅读架路由（v3.21 多论文阅读抽屉）。由 createApiRouter 在启动时调用 register(t, ctx) 注册。
//
// 阅读架 = 阅读器内的有序论文栈（浏览器多标签的学术版）：
//   - 顺序完全由用户手动维护（拖拽），切换/打开不重排；
//   - per-space 持久化在 store.settings.readerShelf（id 有序数组）；
//   - GET 返回富化条目（标题/年份/进度），删除论文时由 deletePapersCleanup 联动剔除。

/** 上限：阅读架最多 50 篇（防误操作把全库塞进来；富化渲染与心智负担都有限度）。 */
const SHELF_MAX = 50;

/** 规整 id 列表：字符串化 → 去重（保留首次出现）→ 只留库内存在的论文 → 截断上限。
 *  过滤不存在的 id 让「论文已删但架子残留死 id」在任一次读写时自愈。 */
function sanitizeShelfIds(raw, store) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const id = typeof it === 'string' ? it : String(it || '');
    if (!id || seen.has(id) || !store.papers[id]) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, SHELF_MAX);
}

/** 富化单条条目（渲染抽屉卡片所需的全部字段，客户端零二次拼装）。 */
function shelfItemView(p) {
  return {
    id: p.id,
    title: p.title || p.filename || p.id,
    year: p.year || '',
    status: p.status || '',
    readStatus: p.readStatus || 'unread',
    starred: !!p.starred,
    readProgress:
      p.readProgress && typeof p.readProgress === 'object'
        ? { page: p.readProgress.page || 1, total: p.readProgress.total || 0 }
        : null,
  };
}

function register(t, ctx) {
  const { ok, fail } = ctx;

  // GET /api/reader-shelf  → { ids:[...], items:[...] }（ids 有序；items 与 ids 一一对应，死 id 已滤）
  t.get('/api/reader-shelf', async ({ res, store }) => {
    store.settings = store.settings || {};
    const ids = sanitizeShelfIds(store.settings.readerShelf, store);
    return ok(res, {
      ids,
      items: ids.map((id) => shelfItemView(store.papers[id])),
    });
  });

  // PUT /api/reader-shelf  body: { ids: [...] }  整体替换（前端持有权威顺序）。
  // 规整：去重/滤不存在的 id/截断上限，返回规整后的 ids 供前端回同步。
  t.put('/api/reader-shelf', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const ids = sanitizeShelfIds(op.ids, store);
    store.settings.readerShelf = ids;
    store.settings.updatedAt = Date.now();
    try {
      await save(store);
    } catch (e) {
      return fail(res, 500, '保存失败：' + (e && e.message));
    }
    return ok(res, {
      ids,
      items: ids.map((id) => shelfItemView(store.papers[id])),
    });
  });
}

module.exports = { register, sanitizeShelfIds, SHELF_MAX };
