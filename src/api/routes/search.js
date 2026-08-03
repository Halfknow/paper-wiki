'use strict';

// search 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { parseSearchQuery, applyMetadataQuery } = require('../../core/search-query');

function register(t, ctx) {
  const { ok, fail, manager } = ctx;

  // GET /api/search?q=<query>&limit=&filters=<DSL>  —— 论文全文检索（v3.1 + v3.2 高级搜索）
  // SQL 定命中与排序（英文 tsvector/GIN + ts_rank；中文/降级 ILIKE），Node 侧对命中篇加载全文生成
  // 高亮 snippet（lib/search.buildSnippets，输出已转义 HTML）。ILIKE 路径（rank=null）按命中次数排序。
  // v3.2：支持 ?filters=<DSL> 把元数据筛选（title:/tag:/year:...）作为候选 id 子集先过滤，
  //      再在该子集上做正文检索 → 实现「正文词 + 元数据筛选」统一查询。
  //      q 本身也支持 DSL：若含 body:phrase，phrase 作为正文词，其余作为 filters。
  t.get('/api/search', async ({ res, q, spaceId, store }) => {
    const rawQ = String(q.q || '').trim();
    if (!rawQ) return fail(res, 400, '缺少查询词 q');
    // 解析 q 为 DSL：bodyQuery（正文词）+ 元数据部分
    const parsedQ = parseSearchQuery(rawQ);
    // 正文词优先级：filters 参数 > q 里的 body: > q 整串（向后兼容：纯文本 q 当正文词）
    let bodyWord = String(q.filters || '').trim() ? String(q.filters).trim() : null;
    if (bodyWord === null) bodyWord = parsedQ.bodyQuery !== null ? parsedQ.bodyQuery : rawQ;
    if (!bodyWord) return fail(res, 400, '缺少正文检索词');
    const limit = Math.max(1, Math.min(50, parseInt(q.limit, 10) || 30));
    const { splitTerms, buildSnippets } = require('../../core/search');
    // 元数据候选子集：若 q 含字段前缀（非 body），先筛论文 id
    let idSubset = null;
    const qHasFields =
      parsedQ.metadata &&
      (parsedQ.metadata.text.words.length ||
        parsedQ.metadata.text.phrases.length ||
        parsedQ.metadata.text.excludeWords.length ||
        parsedQ.metadata.text.excludePhrases.length ||
        Object.keys(parsedQ.metadata.fields).length);
    if (qHasFields) {
      const filtered = applyMetadataQuery(Object.values(store.papers), parsedQ);
      idSubset = filtered.map((p) => p.id);
    }
    const hits = await manager.searchFulltext(spaceId, bodyWord, { limit, ids: idSubset });
    const textStore = manager.textStoreBinder(spaceId);
    const terms = splitTerms(bodyWord); // CJK 整串、英文分词（见 lib/search.js）
    const results = [];
    for (const h of hits) {
      const p = store.papers[h.paperId];
      if (!p) continue; // 全文行存在但论文条目已删（理论不该出现，防御）
      const text = (await textStore.load(h.paperId).catch(() => null)) || '';
      const { snippets, matches } = buildSnippets(text, terms);
      results.push({
        id: p.id,
        title: p.title || p.filename,
        authors: p.authors || [],
        year: p.year || null,
        status: p.status,
        readStatus: p.readStatus,
        rating: p.rating || 0,
        tags: p.tags || [],
        topics: p.topics || [],
        rank: h.rank,
        matches,
        snippets,
      });
    }
    if (results.length && results[0].rank == null) results.sort((a, b) => b.matches - a.matches);
    return ok(res, { query: rawQ, bodyWord, total: results.length, results });
  });

  // GET /api/search/suggest?field=tag&prefix=mo&limit=10  —— 搜索框内联补全（v3.2）
  //   field: tag | topic | author | title | status | read
  //   返回该字段在当前空间论文里的候选值（去重 + 按使用频次倒序），prefix 子串过滤。
  t.get('/api/search/suggest', async ({ res, q, store }) => {
    const field = String(q.field || '').toLowerCase();
    const prefix = String(q.prefix || '')
      .toLowerCase()
      .trim();
    const limit = Math.max(1, Math.min(20, parseInt(q.limit, 10) || 10));
    const allowed = ['tag', 'topic', 'author', 'title', 'status', 'read'];
    if (!allowed.includes(field)) return fail(res, 400, '不支持的 field');
    const counts = new Map(); // value → 出现次数
    const collect = (vals) => {
      for (const v of vals) {
        if (v == null) continue;
        const arr = Array.isArray(v) ? v : [v];
        for (const item of arr) {
          const s = String(item || '').trim();
          if (!s) continue;
          counts.set(s, (counts.get(s) || 0) + 1);
        }
      }
    };
    const papers = Object.values(store.papers);
    if (field === 'tag') collect(papers.map((p) => p.tags));
    else if (field === 'topic') collect(papers.map((p) => p.topics));
    else if (field === 'author') collect(papers.map((p) => p.authors));
    else if (field === 'title') collect(papers.map((p) => p.title));
    else if (field === 'status') collect(papers.map((p) => p.status));
    else if (field === 'read') collect(papers.map((p) => p.readStatus));
    let items = [...counts.entries()];
    if (prefix) items = items.filter(([v]) => v.toLowerCase().includes(prefix));
    items.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ok(res, { field, prefix, results: items.slice(0, limit).map(([v, c]) => ({ value: v, count: c })) });
  });
}

module.exports = { register };
