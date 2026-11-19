'use strict';

// papers 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const fs = require('fs');
const { mergeTopics, mergeConcepts, removePaperFromConcepts } = require('../../core/store');
const { applySettingsOverride, withGlobalAi, extractFormulasViaEngine, extractConcepts } = require('../../services/ai');
const { removePaperFromFormulas, mergeFormulas } = require('../../core/formulas');
const { normalizeAnnotations } = require('../../core/annotations');
const { normalizeNoteCards } = require('../../core/notes');
const { parseSearchQuery, applyMetadataQuery } = require('../../core/search-query');
const { papersToBibtex, papersToCsv } = require('../../core/export');
const { summaryView, detailView, mergeInto, deletePapersCleanup } = require('../views');

function register(t, ctx) {
  const { ok, fail, config, manager, scanner, isProd } = ctx;

  // GET /api/papers
  t.get('/api/papers', async ({ res, url, q, store }) => {
    let list = Object.values(store.papers);
    // 标签 / 主题：支持多选（?tag=a&tag=b），维度内默认 OR（含任一即命中），
    // 可用 ?tagOp=and / ?topicOp=and 切换为 AND（必须全部命中，论文更少更精确）。
    // 用 getAll 读数组（Object.fromEntries 只保留末值，会丢重复 key）。保留单值分支向后兼容。
    const tags = url.searchParams.getAll('tag');
    const tagAnd = String(q.tagOp || '').toLowerCase() === 'and';
    if (tags.length > 1) {
      list = list.filter((p) =>
        tagAnd ? tags.every((t) => (p.tags || []).includes(t)) : tags.some((t) => (p.tags || []).includes(t)),
      );
    } else if (tags.length === 1 || q.tag) {
      const t = tags[0] || q.tag;
      list = list.filter((p) => (p.tags || []).includes(t));
    }
    const topics = url.searchParams.getAll('topic');
    const topicAnd = String(q.topicOp || '').toLowerCase() === 'and';
    if (topics.length > 1) {
      const needles = topics.map((t) => String(t).toLowerCase());
      list = list.filter((p) => {
        const pts = (p.topics || []).map((t) => String(t).toLowerCase());
        return topicAnd ? needles.every((n) => pts.includes(n)) : needles.some((n) => pts.includes(n));
      });
    } else if (topics.length === 1 || q.topic) {
      const needle = String(topics[0] || q.topic).toLowerCase();
      list = list.filter((p) => (p.topics || []).some((t) => String(t).toLowerCase() === needle));
    }
    if (q.folder) list = list.filter((p) => (p.folders || []).includes(q.folder));
    if (q.status) list = list.filter((p) => p.status === q.status);
    if (q.starred === '1') list = list.filter((p) => p.starred);
    if (q.readStatus) list = list.filter((p) => p.readStatus === q.readStatus);
    if (q.q) {
      // v3.2 高级搜索 DSL：解析 GitHub 式字段语法（title:/tag:/year:/-排除/"phrase" body: ...）。
      // 裸词分词 AND（修单子串只能匹配连续短语的 bug）；字段限定；year 比较；status/read/starred。
      // body: 词不在此处理（走 /api/search），这里只应用元数据部分。
      const parsed = parseSearchQuery(q.q);
      list = applyMetadataQuery(list, parsed);
    }
    const sort = q.sort || 'addedDesc';
    const yearNum = (p) => parseInt(p.year, 10) || 0;
    const progressFrac = (p) =>
      p.readProgress && p.readProgress.total ? (p.readProgress.page || 0) / p.readProgress.total : 0;
    list.sort((a, b) => {
      switch (sort) {
        case 'titleAsc':
          return (a.title || '').localeCompare(b.title || '');
        case 'titleDesc':
          return (b.title || '').localeCompare(a.title || '');
        case 'updatedDesc':
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        case 'addedAsc':
          return (a.addedAt || 0) - (b.addedAt || 0);
        case 'yearDesc':
          return yearNum(b) - yearNum(a) || (b.addedAt || 0) - (a.addedAt || 0);
        case 'yearAsc': {
          // 升序时无年份（0）也沉底，而非冒到最前
          const ya = yearNum(a),
            yb = yearNum(b);
          if (!ya || !yb) return (yb ? 1 : 0) - (ya ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0);
          return ya - yb || (b.addedAt || 0) - (a.addedAt || 0);
        }
        case 'ratingDesc':
          return (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0);
        case 'progressDesc':
          return progressFrac(b) - progressFrac(a) || (b.updatedAt || 0) - (a.updatedAt || 0);
        case 'conceptDesc':
          return (b.conceptIds || []).length - (a.conceptIds || []).length || (b.addedAt || 0) - (a.addedAt || 0);
        default:
          return (b.addedAt || 0) - (a.addedAt || 0); // addedDesc
      }
    });
    return ok(res, list.map(summaryView));
  });

  // GET /api/papers.bib / /api/papers.csv  导出（BibTeX / CSV）。
  // ?ids=a,b,c 限定子集（前端「导出选中/当前筛选」走这里）；无参 = 全库。
  // 静态段优先于 /api/papers/:id 参数段，与注册顺序无关。
  const pickExportList = (q, store) => {
    const all = Object.values(store.papers);
    if (!q.ids) return all;
    const ids = new Set(String(q.ids).split(',').filter(Boolean));
    return all.filter((p) => ids.has(p.id));
  };
  t.get('/api/papers.bib', async ({ res, q, store }) => {
    const bib = papersToBibtex(pickExportList(q, store));
    res.writeHead(200, {
      'Content-Type': 'application/x-bibtex; charset=utf-8',
      'Content-Disposition': 'attachment; filename="paperwiki.bib"',
    });
    return res.end(bib);
  });
  t.get('/api/papers.csv', async ({ res, q, store }) => {
    const csv = papersToCsv(pickExportList(q, store));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="paperwiki.csv"',
    });
    return res.end(csv);
  });

  // GET /api/papers/:id
  t.get('/api/papers/:id', async ({ res, params, store }) => {
    const p = store.papers[params.id];
    return p ? ok(res, detailView(p)) : fail(res, 404, 'Not found');
  });

  // PATCH /api/papers/:id
  t.patch('/api/papers/:id', async ({ res, body, params, store, save }) => {
    const p = store.papers[params.id];
    if (!p) return fail(res, 404, 'Not found');
    const patch = JSON.parse(body || '{}');
    // 类型清洗：PATCH 是前端唯一自由写入入口，畸形类型轻则打崩视图层（summary.slice(0,160)、
    // sort 的 localeCompare），重则打崩 PG 写入（summaryAt 列是 DOUBLE PRECISION，'abc' 会让
    // 该空间此后所有保存 500——坏行恒在 diff 里）。非法类型的字段静默忽略（保持原值）。
    const asStrArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined);
    const asNum = (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    for (const k of ['notes', 'title', 'summary', 'summaryModel']) {
      if (k in patch && typeof patch[k] === 'string') p[k] = patch[k];
    }
    if ('readStatus' in patch && ['unread', 'reading', 'done'].includes(patch.readStatus)) {
      p.readStatus = patch.readStatus;
    }
    if ('tags' in patch) p.tags = asStrArr(patch.tags) ?? p.tags;
    if ('topics' in patch) p.topics = asStrArr(patch.topics) ?? p.topics;
    if ('folders' in patch) p.folders = asStrArr(patch.folders) ?? p.folders;
    if ('chat' in patch) p.chat = Array.isArray(patch.chat) ? patch.chat : p.chat;
    if ('summaryAt' in patch) p.summaryAt = patch.summaryAt == null ? null : asNum(patch.summaryAt) ?? null;
    if ('readProgress' in patch) {
      p.readProgress =
        patch.readProgress && typeof patch.readProgress === 'object' && !Array.isArray(patch.readProgress)
          ? patch.readProgress
          : null;
    }
    // 笔记卡片：写入边界归一化（形状/限量/补 id 时间戳），防客户端写坏 jsonb
    if ('noteCards' in patch) p.noteCards = normalizeNoteCards(patch.noteCards);
    // 星级评分（0-5）与 starred 互为镜像，rating 为准；兼容旧的 starred 布尔。
    if ('rating' in patch) {
      p.rating = Math.max(0, Math.min(5, Math.round(asNum(patch.rating) ?? 0)));
      p.starred = p.rating > 0;
    } else if ('starred' in patch) {
      p.starred = !!patch.starred;
      p.rating = p.starred ? (p.rating > 0 ? p.rating : 5) : 0;
    }
    // 写入时清洗：浏览器 JSON.stringify 会把 quadPoints/ink 坐标的 Float32Array 退化成
    // {"0":..} 对象，这里在落盘前还原成真数组，保证存储格式干净、可被 pdf.js 正确回灌。
    if ('annotations' in patch) p.annotations = normalizeAnnotations(patch.annotations);
    if (Array.isArray(patch.tags)) {
      p.tags = patch.tags;
      mergeInto(store, patch.tags);
    }
    if (Array.isArray(patch.topics)) {
      p.topics = patch.topics;
      mergeTopics(store, patch.topics);
    }
    p.updatedAt = Date.now();
    await save(store);
    return ok(res, detailView(p));
  });

  // DELETE /api/papers/:id?keepKnowledge=1  —— 删论文条目 + PDF + 全文 + 清理概念/标签/主题
  //   （统一走 deletePapersCleanup；keepKnowledge=1 时概念/公式只解除关联、不删孤立条目）
  t.delete('/api/papers/:id', async ({ res, q, params, spaceId, store, save }) => {
    const id = params.id;
    if (!store.papers[id]) return fail(res, 404, 'Not found');
    const r = deletePapersCleanup(store, [id], manager.resolveSpacePapersDir(spaceId), {
      keepKnowledge: q.keepKnowledge === '1' || q.keepKnowledge === 'true',
    });
    await save(store);
    return ok(res, {
      id: r.ids[0],
      status: 'deleted',
      conceptsRemoved: r.conceptsRemoved,
      formulasRemoved: r.formulasRemoved,
    });
  });

  // POST /api/papers/bulk-delete  { ids: [...], keepKnowledge? }  —— 多选批量删除（含空 tags/topics 清理）。
  //   keepKnowledge=true：概念/公式只解除关联、不删孤立条目（与单删 ?keepKnowledge=1 同语义）
  t.post('/api/papers/bulk-delete', async ({ res, body, spaceId, store, save }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.filter((id) => typeof id === 'string' && store.papers[id]) : [];
    if (!ids.length) return fail(res, 400, 'no valid ids');
    const r = deletePapersCleanup(store, ids, manager.resolveSpacePapersDir(spaceId), {
      keepKnowledge: !!op.keepKnowledge,
    });
    await save(store);
    return ok(res, { deleted: r.ids.length, ids: r.ids, conceptsRemoved: r.conceptsRemoved, formulasRemoved: r.formulasRemoved });
  });

  const h_api_papers_id_summarize = async ({ res, params, spaceId, store, save }) => {
    const id = params.id;
    const p = store.papers[id];
    if (!p) return fail(res, 404, 'Not found');
    // 防护孤立条目：PDF 文件已不在 papers/ 目录（被移走/删除）→ 不入队，
    // 否则 processOne 的 extractText 会 ENOENT 并把状态写成 error（误导，应为 missing）。
    if (!p.filepath || !fs.existsSync(p.filepath)) {
      p.status = 'missing';
      p.error = 'PDF 文件缺失（不在 papers/ 目录），无法重新总结';
      await save(store);
      return fail(res, 409, 'PDF 文件缺失（不在 papers/ 目录），请重新导入或删除该条目');
    }
    // summarize/parse 都立即标 pending：让串行队列里排队等待的论文在列表/详情
    // 显示为「排队」忙碌态（dot 脉冲 + busy-tag），而非停留在 ready 让用户以为没生效。
    // processOne 实际开始处理时会覆盖为 parsing/enriching/summarizing。
    p.status = 'pending';
    p.error = null;
    scanner.enqueue(spaceId, [id]);
    return ok(res, { queued: id });
  };
  t.post('/api/papers/:id/summarize', h_api_papers_id_summarize);
  t.post('/api/papers/:id/parse', h_api_papers_id_summarize);

  // POST /api/papers/concepts  body: { ids: [...] }  对选中论文重新抽取概念并追加
  t.post('/api/papers/concepts', async ({ res, body, spaceId, store }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
    if (!ids.length) return fail(res, 400, 'no valid ids');
    if (!scanner.extractConcepts) return fail(res, 501, 'scanner.extractConcepts unavailable');
    const r = await scanner.extractConcepts(spaceId, ids);
    return ok(res, r);
  });

  // POST /api/papers/formulas  body: { ids: [...] }  对选中论文重新抽取公式并归并入清单
  t.post('/api/papers/formulas', async ({ res, body, spaceId, store }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
    if (!ids.length) return fail(res, 400, 'no valid ids');
    if (!scanner.extractFormulas) return fail(res, 501, 'scanner.extractFormulas unavailable');
    const r = await scanner.extractFormulas(spaceId, ids);
    return ok(res, r);
  });

  t.post('/api/papers/:id/formulas/candidates', async ({ res, params, spaceId, store, gai }) => {
    const id = params.id;
    const p = store.papers[id];
    if (!p) return fail(res, 404, 'Not found');
    const effConfig = applySettingsOverride(config, withGlobalAi(store.settings || {}, gai));
    const engine = (effConfig.formulas && effConfig.formulas.engine) || 'ai';
    // MinerU 引擎需要 PDF 文件路径；AI 引擎需要全文。dispatcher 按 engine 自取所需字段
    const ts = manager.textStoreBinder ? manager.textStoreBinder(spaceId) : null;
    const text = ts ? (await ts.load(id).catch(() => null)) || '' : '';
    let items = [];
    try {
      items = await extractFormulasViaEngine({
        filepath: p.filepath,
        title: p.title,
        abstract: p.abstract,
        fulltext: text,
        existingFormulas: store.formulas || [],
        config: effConfig,
      });
    } catch (e) {
      return fail(res, 502, isProd ? '公式抽取失败' : `公式抽取失败：${e.message}`);
    }
    return ok(res, { items: Array.isArray(items) ? items : [], source: engine });
  });

  t.post('/api/papers/:id/formulas/merge', async ({ res, body, params, store, save }) => {
    const id = params.id;
    const p = store.papers[id];
    if (!p) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    const items = Array.isArray(op.items) ? op.items : [];
    if (op.mode === 'replace') removePaperFromFormulas(store, id);
    if (!items.length) {
      p.formulaIds = (store.formulas || [])
        .filter((f) => (f.occurrences || []).some((o) => o.paperId === id))
        .map((f) => f.id);
      p.updatedAt = Date.now();
      await save(store);
      return ok(res, { added: 0 });
    }
    const newIds = mergeFormulas(store, items, id);
    p.formulaIds = (store.formulas || [])
      .filter((f) => (f.occurrences || []).some((o) => o.paperId === id))
      .map((f) => f.id);
    p.updatedAt = Date.now();
    await save(store);
    return ok(res, { added: newIds.length });
  });

  t.post('/api/papers/:id/concepts/candidates', async ({ res, params, spaceId, store, gai }) => {
    const id = params.id;
    const p = store.papers[id];
    if (!p) return fail(res, 404, 'Not found');
    const effConfig = applySettingsOverride(config, withGlobalAi(store.settings || {}, gai));
    const ts = manager.textStoreBinder ? manager.textStoreBinder(spaceId) : null;
    const text = ts ? (await ts.load(id).catch(() => null)) || '' : '';
    const existingTerms = (store.concepts || []).map((c) => c.term);
    const conceptPrompt = store.settings.conceptPrompt || config.conceptPrompt || undefined;
    let items = [];
    try {
      items = await extractConcepts({
        title: p.title,
        abstract: p.abstract,
        fulltext: text,
        existingTerms,
        config: effConfig,
        prompt: conceptPrompt,
      });
    } catch (e) {
      return fail(res, 502, isProd ? '概念抽取失败' : `概念抽取失败：${e.message}`);
    }
    return ok(res, { items: Array.isArray(items) ? items : [] });
  });

  t.post('/api/papers/:id/concepts/merge', async ({ res, body, params, store, save }) => {
    const id = params.id;
    const p = store.papers[id];
    if (!p) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    const items = Array.isArray(op.items) ? op.items : [];
    if (op.mode === 'replace') removePaperFromConcepts(store, id);
    if (!items.length) {
      p.conceptIds = (store.concepts || []).filter((c) => (c.paperIds || []).includes(id)).map((c) => c.id);
      p.updatedAt = Date.now();
      await save(store);
      return ok(res, { added: 0 });
    }
    const newIds = mergeConcepts(store, items, id);
    p.conceptIds = [...new Set([...(p.conceptIds || []), ...newIds])];
    p.updatedAt = Date.now();
    await save(store);
    return ok(res, { added: newIds.length });
  });

  t.post('/api/papers/:id/retag', async ({ res, params, spaceId, store }) => {
    const id = params.id;
    if (!store.papers[id]) return fail(res, 404, 'Not found');
    if (!scanner.retagPapers) return fail(res, 501, 'scanner.retagPapers unavailable');
    const r = await scanner.retagPapers(spaceId, [id]);
    return ok(res, r);
  });

  t.post('/api/papers/:id/notes/generate', async ({ res, params, spaceId, store }) => {
    const id = params.id;
    if (!store.papers[id]) return fail(res, 404, 'Not found');
    if (!scanner.generateNoteCards) return fail(res, 501, 'scanner.generateNoteCards unavailable');
    try {
      const r = await scanner.generateNoteCards(spaceId, id);
      if (r.error) return fail(res, 422, r.error);
      return ok(res, r);
    } catch (e) {
      return fail(res, 502, 'AI 生成失败：' + (e && e.message));
    }
  });

  // POST /api/papers/retag  body: { ids: [...] }  批量重新打标（含标签/主题库联动：多的入库、少的清除）
  t.post('/api/papers/retag', async ({ res, body, spaceId, store }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
    if (!ids.length) return fail(res, 400, 'no valid ids');
    if (!scanner.retagPapers) return fail(res, 501, 'scanner.retagPapers unavailable');
    const r = await scanner.retagPapers(spaceId, ids);
    return ok(res, r);
  });
}

module.exports = { register };
