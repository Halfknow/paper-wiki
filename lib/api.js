const path = require('path');
const fs = require('fs');
const { mergeTopics, deleteConcept, conceptsToMarkdown, addFolder, deleteFolder } = require('./store');
const {
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TAGS_PROMPT,
  applySettingsOverride,
  callChat,
  callChatStream,
  listModels,
  TRANSLATE_SYSTEM_PROMPT,
} = require('./ai');
const { sha1OfFile, parseArxivUrl, buildPaperFilename, proxyFetchJson } = require('./util');
const { normalizeAnnotations } = require('./annotations');
const arxiv = require('./arxiv');
const pkg = require('../package.json');

/** 掩码 apiKey 用于回显：只露前 3 / 后 4 位。空 key 返回空串。 */
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 计算当前生效 AI 配置（store.settings.ai 覆盖 config.ai）的只读视图（回显用，不含完整 key）。 */
function aiSettingsView(effConfig) {
  return {
    baseURL: effConfig.ai.baseURL || '',
    model: effConfig.ai.model || '',
    apiKeyMasked: maskKey(effConfig.ai.apiKey),
    hasApiKey: !!effConfig.ai.apiKey,
    maxInputChars: effConfig.ai.maxInputChars ?? 24000,
    timeoutMs: effConfig.ai.timeoutMs ?? 120000,
  };
}

/** arXiv 段只读视图（enabled 默认 true：scanner 以 `!== false` 判定开启）。 */
function arxivSettingsView(a) {
  a = a || {};
  return {
    enabled: a.enabled !== false,
    titleSimilarityThreshold: a.titleSimilarityThreshold,
    minIntervalMs: a.minIntervalMs,
  };
}

/** translate 段只读视图（划线翻译：engine 默认 google——免费端点秒回，对齐 Zotero 划线翻译默认；targetLang 默认 zh-CN）。 */
function translateSettingsView(t) {
  t = t || {};
  return {
    engine: t.engine || 'google',
    targetLang: t.targetLang || 'zh-CN',
  };
}

/** 目标语言代码 → 中文名（AI 翻译提示词用，与设置面板 select 选项对齐）。 */
const LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
};

/** 设置面板语言代码 → Google 翻译 tl 参数（大部分一致，个别需映射）。 */
const GL_LANG_MAP = {
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
};

/** discover 段只读视图（S2 密钥掩码回显，不泄露明文）。 */
function discoverSettingsView(d) {
  d = d || {};
  return {
    maxResults: d.maxResults,
    perAxis: d.perAxis,
    semanticScholar: d.semanticScholar,
    openAlex: d.openAlex,
    recencyWindowYears: d.recencyWindowYears,
    titleSimThreshold: d.titleSimThreshold,
    claudeTimeoutMs: d.claudeTimeoutMs,
    weights: d.weights ? { ...d.weights } : {},
    hasS2Key: !!d.semanticScholarApiKey,
    s2KeyMasked: maskKey(d.semanticScholarApiKey),
  };
}

/** config.json 脱敏副本（apiKey / S2 key 掩码），供「系统信息」只读展示原始配置。 */
function maskedRawConfig(config) {
  const c = { ...(config || {}) };
  if (c.ai) c.ai = { ...c.ai, apiKey: maskKey(c.ai.apiKey) };
  if (c.discover) c.discover = { ...c.discover, semanticScholarApiKey: maskKey(c.discover.semanticScholarApiKey) };
  return c;
}

/** 列表视图：去掉超长大字段，保留前端列表所需 */
function summaryView(p) {
  return {
    id: p.id,
    filename: p.filename,
    title: p.title,
    authors: p.authors,
    year: p.year,
    status: p.status,
    error: p.error,
    metaSource: p.metaSource,
    metaConfidence: p.metaConfidence,
    primaryCategory: p.primaryCategory,
    arxivId: p.arxivId,
    arxivUrl: p.arxivUrl,
    importSource: p.importSource || null,
    tags: p.tags || [],
    topics: p.topics || [],
    folders: p.folders || [],
    rating: Math.max(0, Math.min(5, Math.round(p.rating || 0))),
    starred: !!p.starred,
    readStatus: p.readStatus,
    readProgress: p.readProgress || null,
    addedAt: p.addedAt,
    updatedAt: p.updatedAt,
    hasSummary: !!p.summary,
    hasNotes: !!p.notes,
    summaryExcerpt: p.summary ? p.summary.slice(0, 160) : '',
    conceptCount: (p.conceptIds || []).length,
  };
}

/** 详情视图：含完整 summary / notes / annotations（批注，打开阅读器时需要） */
function detailView(p) {
  return {
    ...summaryView(p),
    summary: p.summary || '',
    notes: p.notes || '',
    abstract: p.abstract || '',
    fulltextChars: p.fulltextChars || 0,
    conceptIds: p.conceptIds || [],
    // 读取时归一化：把历史上被 JSON 写坏的 quadPoints/ink 坐标（Float32Array→{"0":..}）
    // 还原成真数组，使前端 pdf.js deserialize 能正确重建高亮/手写（自愈存量脏数据）。
    annotations: normalizeAnnotations(p.annotations) || null,
    chat: Array.isArray(p.chat) ? p.chat : [],
  };
}

function mergeInto(store, tags) {
  const map = new Map((store.tags || []).map((t) => [t.toLowerCase(), t]));
  for (const raw of tags) {
    const t = String(raw).trim();
    if (t && !map.has(t.toLowerCase())) map.set(t.toLowerCase(), t);
  }
  store.tags = [...map.values()].sort();
}

/** 删除论文并做完整数据清理（单篇/批量共用）：
 *  - 删 PDF（限该空间 papersDir 内防越界）+ 全文文本
 *  - 删 store.papers[id]
 *  - 清理概念 paperIds（移除该论文引用）
 *  - 移除 paperIds 变空的孤立概念（不再被任何论文引用）
 *  - 重新聚合 store.tags/topics（从论文重建），自动清除计数归零的标签/主题
 *  papersDir 由调用方传入（来自 manager.resolveSpacePapersDir，统一收口，不再各自 path.resolve config.papersDir）。
 *  文件删除失败一律忽略（占用/缺失），仍删条目。
 *  返回实际删除的 id 列表（跳过不存在的）。 */
function deletePapersCleanup(store, ids, papersDir) {
  const removed = [];
  for (const id of ids) {
    const p = store.papers[id];
    if (!p) continue;
    // 删 PDF（限 papersDir 内防越界）
    if (p.filepath) {
      const abs = path.resolve(p.filepath);
      if (abs !== papersDir && abs.startsWith(papersDir + path.sep)) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    // 全文清理：v3 全文在 PG paper_texts，repo.saveSpaceStore 检测到论文行删除时连带删除，无需在此处理
    delete store.papers[id];
    removed.push(id);
  }
  // 清理概念 paperIds + 移除 paperIds 变空的孤立概念
  if (Array.isArray(store.concepts)) {
    for (const c of store.concepts) {
      if (Array.isArray(c.paperIds)) c.paperIds = c.paperIds.filter((x) => !removed.includes(x));
    }
    store.concepts = store.concepts.filter((c) => Array.isArray(c.paperIds) && c.paperIds.length > 0);
  }
  // 重新聚合标签/主题字典（从论文重建）→ 自动清除计数归零的项
  const tagSet = new Set();
  const topicSet = new Set();
  for (const p of Object.values(store.papers)) {
    for (const t of p.tags || []) tagSet.add(t);
    for (const t of p.topics || []) topicSet.add(t);
  }
  store.tags = [...tagSet].sort();
  store.topics = [...topicSet].sort();
  return removed;
}

function createApiRouter(ctx) {
  const { manager, scanner, globalConfig } = ctx;
  const config = globalConfig; // 别名：保持下方既有代码可读（config 即全局 config）
  const isProd = process.env.NODE_ENV === 'production';

  function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  const ok = (res, data) => send(res, 200, { ok: true, data });
  const fail = (res, code, error) => send(res, code, { ok: false, error });

  /** 解析当前请求的空间上下文：?space=<id> 指定空间，无参回 active 空间。
   *  返回 { spaceId, space, store, save }。store 是 manager 内存缓存的引用（与 scanner 共享）。
   *  SSE 路由（chat/discover）EventSource 无法设 header，spaceId 走 URL query。 */
  async function resolveSpace(q) {
    const spaceId = (q && q.space) || manager.getActiveSpaceId();
    const space = manager.getSpace(spaceId);
    if (!space) {
      // 容错：回退 active（空间被删后旧引用等情况）
      const activeId = manager.getActiveSpaceId();
      return {
        spaceId: activeId,
        space: manager.getActiveSpace(),
        store: await manager.getSpaceStore(activeId),
        save: manager.saveStoreBinder(activeId),
      };
    }
    const store = await manager.getSpaceStore(spaceId);
    return { spaceId, space, store, save: manager.saveStoreBinder(spaceId) };
  }

  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;

    // ---- 空间管理路由（不依赖具体空间）----
    // GET /api/spaces  列出所有空间 + activeId（含每空间论文数）
    if (pathname === '/api/spaces' && method === 'GET') {
      return ok(res, await manager.spacesView());
    }
    // POST /api/spaces  body: { name, papersDir? }  创建新空间
    if (pathname === '/api/spaces' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      try {
        const sp = await manager.createSpace({ name: op.name, papersDir: op.papersDir });
        return ok(res, sp);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    // PATCH /api/spaces/:id  body: { name?, papersDir? }  改名 / 改绑定文件夹
    const spaceMatch = /^\/api\/spaces\/([\w.-]+)$/.exec(pathname);
    if (spaceMatch && method === 'PATCH') {
      const id = spaceMatch[1];
      const op = JSON.parse(body || '{}');
      try {
        if (typeof op.name === 'string') await manager.renameSpace(id, op.name);
        if (typeof op.papersDir === 'string') await manager.changePapersDir(id, op.papersDir);
        return ok(res, manager.getSpace(id));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    // DELETE /api/spaces/:id  删空间（default 不可删；保留物理 PDF 文件夹）
    if (spaceMatch && method === 'DELETE') {
      try {
        const r = await manager.deleteSpace(spaceMatch[1]);
        scanner.invalidate(spaceMatch[1]);
        return ok(res, r);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    // POST /api/spaces/:id/dir/preview  body: { newDir }
    // papersDir 改绑预检（只读）：新目录 PDF 数 / sha1 匹配数 / 将缺失清单 / 新文件数 + 冲突校验
    const dirPreviewMatch = /^\/api\/spaces\/([\w.-]+)\/dir\/preview$/.exec(pathname);
    if (dirPreviewMatch && method === 'POST') {
      const op = JSON.parse(body || '{}');
      try {
        return ok(res, await manager.previewPapersDirChange(dirPreviewMatch[1], op.newDir));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
    // POST /api/spaces/:id/dir  body: { newDir, mode: 'move'|'rebind' }
    // 执行改绑：暂停扫描（stop+drain）→ move（物理搬移+同步 filename）或 rebind（sha1 对账）→
    // 失效子扫描器缓存（papersDir 已变）→ finally 恢复扫描（start 会立即触发一轮 scan 收尾）。
    const dirApplyMatch = /^\/api\/spaces\/([\w.-]+)\/dir$/.exec(pathname);
    if (dirApplyMatch && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const id = dirApplyMatch[1];
      try {
        if (scanner.stop) scanner.stop();
        if (scanner.drain) await scanner.drain(10000);
        const r = await manager.applyPapersDirChange(id, op.newDir, op.mode);
        if (scanner.invalidate) scanner.invalidate(id);
        return ok(res, r);
      } catch (e) {
        return fail(res, 400, e.message);
      } finally {
        if (scanner.start) scanner.start();
      }
    }
    // POST /api/spaces/:id/activate  切换 active 空间
    const activateMatch = /^\/api\/spaces\/([\w.-]+)\/activate$/.exec(pathname);
    if (activateMatch && method === 'POST') {
      try {
        const sp = await manager.setActiveSpace(activateMatch[1]);
        return ok(res, sp);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }

    // 解析本次请求的空间上下文（?space= 或 active）。论文/标签/主题/概念/设置/收藏夹路由都基于此。
    // 空间管理路由（/api/spaces*）已在上方处理，不进入此段。
    const { spaceId, space, store, save } = await resolveSpace(q);

    // GET /api/health — 探活（pm2 / 反向代理用），无需鉴权。返回 active 空间篇数 + 总空间数。
    if (pathname === '/api/health' && method === 'GET') {
      return ok(res, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        spaces: manager.listSpaces().length,
        activeSpaceId: manager.getActiveSpaceId(),
        papers: Object.keys(store.papers).length,
        // missing 熔断状态（{spaceId: {at, missing, total}}，空对象=正常）：挂载失效可观测
        missingFuse: scanner.getFuseState ? scanner.getFuseState() : {},
      });
    }

    // GET /api/papers
    if (pathname === '/api/papers' && method === 'GET') {
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
        const needle = q.q.toLowerCase();
        list = list.filter((p) =>
          [p.title, p.abstract, p.summary, p.notes, ...(p.tags || []), ...(p.topics || [])]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        );
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
    }

    const detail = /^\/api\/papers\/([\w.-]+)$/.exec(pathname);
    // GET /api/papers/:id
    if (detail && method === 'GET') {
      const p = store.papers[detail[1]];
      return p ? ok(res, detailView(p)) : fail(res, 404, 'Not found');
    }

    // PATCH /api/papers/:id
    if (detail && method === 'PATCH') {
      const p = store.papers[detail[1]];
      if (!p) return fail(res, 404, 'Not found');
      const patch = JSON.parse(body || '{}');
      const allowed = [
        'notes',
        'starred',
        'rating',
        'readStatus',
        'tags',
        'title',
        'topics',
        'folders',
        'readProgress',
        'annotations',
        'chat',
        'summary',
        'summaryModel',
        'summaryAt',
      ];
      for (const k of allowed) if (k in patch) p[k] = patch[k];
      // 星级评分（0-5）与 starred 互为镜像，rating 为准；兼容旧的 starred 布尔。
      if ('rating' in patch) {
        p.rating = Math.max(0, Math.min(5, Math.round(Number(patch.rating) || 0)));
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
    }

    // DELETE /api/papers/:id  —— 删论文条目 + PDF + 全文 + 清理概念/标签/主题（统一走 deletePapersCleanup）
    if (detail && method === 'DELETE') {
      const id = detail[1];
      if (!store.papers[id]) return fail(res, 404, 'Not found');
      const removed = deletePapersCleanup(store, [id], manager.resolveSpacePapersDir(spaceId));
      await save(store);
      return ok(res, { id: removed[0], status: 'deleted' });
    }

    // POST /api/papers/bulk-delete  { ids: [...] }  —— 多选批量删除（含空 tags/topics/概念清理）
    if (pathname === '/api/papers/bulk-delete' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const ids = Array.isArray(op.ids) ? op.ids.filter((id) => typeof id === 'string' && store.papers[id]) : [];
      if (!ids.length) return fail(res, 400, 'no valid ids');
      const removed = deletePapersCleanup(store, ids, manager.resolveSpacePapersDir(spaceId));
      await save(store);
      return ok(res, { deleted: removed.length, ids: removed });
    }

    // POST /api/papers/:id/summarize 或 /parse
    const action = /^\/api\/papers\/([\w.-]+)\/(summarize|parse)$/.exec(pathname);
    if (action && method === 'POST') {
      const id = action[1];
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
    }

    // POST /api/papers/concepts  body: { ids: [...] }  对选中论文重新抽取概念并追加
    if (pathname === '/api/papers/concepts' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
      if (!ids.length) return fail(res, 400, 'no valid ids');
      if (!scanner.extractConcepts) return fail(res, 501, 'scanner.extractConcepts unavailable');
      const r = await scanner.extractConcepts(spaceId, ids);
      return ok(res, r);
    }

    // POST /api/papers/:id/retag —— 单篇重新打标（用当前标签提示词）
    const retagAction = /^\/api\/papers\/([\w.-]+)\/retag$/.exec(pathname);
    if (retagAction && method === 'POST') {
      const id = retagAction[1];
      if (!store.papers[id]) return fail(res, 404, 'Not found');
      if (!scanner.retagPapers) return fail(res, 501, 'scanner.retagPapers unavailable');
      const r = await scanner.retagPapers(spaceId, [id]);
      return ok(res, r);
    }

    // /api/papers/:id/chat  与论文对话（注入全文上下文 + 历史多轮）
    //   GET  —— 流式 SSE（EventSource；?message= 带问题）。事件 token/done/fail（discover 同款模式）
    //   POST —— 非流式 JSON（body {message}），向后兼容
    const chatAction = /^\/api\/papers\/([\w.-]+)\/chat$/.exec(pathname);
    if (chatAction && (method === 'POST' || method === 'GET')) {
      const id = chatAction[1];
      if (!store.papers[id]) return fail(res, 404, 'Not found');
      if (!scanner.chatPaper) return fail(res, 501, 'scanner.chatPaper unavailable');
      // message 来源：GET 取 query.message，POST 取 body.message
      let message;
      let extraIdsRaw;
      if (method === 'GET') {
        message = typeof q.message === 'string' ? q.message : '';
        // extraIds=id1,id2 （逗号分隔，@ 引用的其它论文）
        extraIdsRaw = typeof q.extraIds === 'string' ? q.extraIds : '';
      } else {
        const op = JSON.parse(body || '{}');
        message = typeof op.message === 'string' ? op.message : '';
        extraIdsRaw = Array.isArray(op.extraIds)
          ? op.extraIds.join(',')
          : typeof op.extraIds === 'string'
            ? op.extraIds
            : '';
      }
      message = message.trim();
      // @ 引用论文 id：白名单过滤（必须存在于 store），scanner.chatPaper 内部会再校验
      const extraIds = extraIdsRaw
        ? extraIdsRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && store.papers[s])
        : [];
      // regenerate=1：重新生成最后一轮（message 可为空，scanner 从末尾轮取 user message）
      const regenerate = q.regenerate === '1';
      if (!message && !regenerate) return fail(res, 400, 'empty message');

      // —— 流式分支（仅 GET，前端用 EventSource；POST 走原非流式 JSON 向后兼容）——
      if (method === 'GET') {
        // 事件名 token/done/fail，避免 error 防 EventSource 原生 error 误判 + 自动重连
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no', // 反向代理下禁用缓冲，保证逐 token 下发
        });
        const sse = (event, data) => {
          if (res.writableEnded) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let aborted = false;
        req.on('close', () => {
          aborted = true;
        });
        // 模型参数：从 query 读取（前端 UI 调节后透传），白名单 + 类型校验
        const chatParams = {};
        if (q.thinking != null) {
          const v = Number(q.thinking);
          if (Number.isFinite(v)) chatParams.thinking = v;
        }
        if (q.temperature != null) {
          const v = Number(q.temperature);
          if (Number.isFinite(v)) chatParams.temperature = v;
        }
        if (q.topP != null) {
          const v = Number(q.topP);
          if (Number.isFinite(v)) chatParams.topP = v;
        }
        if (q.maxTokens != null) {
          const v = parseInt(q.maxTokens, 10);
          if (Number.isFinite(v)) chatParams.maxTokens = v;
        }
        // Phase 2 模型切换：?model=xxx 透传。白名单校验——必须属于可用模型集合（config.ai.model +
        // config.ai.extraModels + 上游 /v1/models），防注入。校验失败静默回退默认模型。
        if (typeof q.model === 'string' && q.model.trim()) {
          const effConfig = applySettingsOverride(config, store.settings);
          const allowed = new Set([effConfig.ai && effConfig.ai.model].filter(Boolean));
          const extra = effConfig.ai && Array.isArray(effConfig.ai.extraModels) ? effConfig.ai.extraModels : [];
          for (const m of extra) if (m) allowed.add(m);
          if (allowed.has(q.model)) chatParams.model = q.model;
        }
        try {
          const r = await scanner.chatPaper(spaceId, id, message, {
            regenerate,
            extraIds: extraIds.length ? extraIds : undefined, // @ 引用论文
            chatParams: Object.keys(chatParams).length ? chatParams : undefined,
            onToken: (t, kind) => {
              if (!aborted) sse('token', { t, kind: kind || 'content' });
              return !aborted; // 客户端断开时返回 false，scanner 停止累积/落盘
            },
          });
          if (aborted) return; // 客户端已断：不发 done，直接结束
          sse('done', { reply: r.reply, chat: r.chat });
        } catch (e) {
          sse('fail', { error: isProd ? 'AI 回答失败' : `AI 回答失败：${e.message}` });
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }
      // POST：非流式 JSON（向后兼容，现有 POST 调用方继续工作）
      const r = await scanner.chatPaper(spaceId, id, message, {
        regenerate,
        extraIds: extraIds.length ? extraIds : undefined,
      });
      return ok(res, r);
    }

    // POST /api/papers/:id/chat/vision  —— Phase 3 视觉问答（带图片 body，EventSource 无法携带）。
    //   body: { message, extraIds?, chatParams?, images: ['data:image/png;base64,...'], regenerate? }
    //   响应：SSE 流（事件 token/done/fail，与 GET /chat 同协议），前端用 fetch+ReadableStream 解析。
    //   图片作为多模态 content 追加到末尾 user 消息（ai.js chatPaper 内部处理）。
    const visionAction = /^\/api\/papers\/([\w.-]+)\/chat\/vision$/.exec(pathname);
    if (visionAction && method === 'POST') {
      const id = visionAction[1];
      if (!store.papers[id]) return fail(res, 404, 'Not found');
      if (!scanner.chatPaper) return fail(res, 501, 'scanner.chatPaper unavailable');
      const op = JSON.parse(body || '{}');
      const message = typeof op.message === 'string' ? op.message.trim() : '';
      const regenerate = !!op.regenerate;
      if (!message && !regenerate) return fail(res, 400, 'empty message');
      const extraIds = Array.isArray(op.extraIds)
        ? op.extraIds.filter((s) => s && store.papers[s])
        : typeof op.extraIds === 'string'
          ? op.extraIds
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s && store.papers[s])
          : [];
      // 图片白名单：必须是 data:image/* URL，限制 4 张（防滥用 + papers.json 膨胀）
      const images = Array.isArray(op.images)
        ? op.images.filter((s) => typeof s === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s)).slice(0, 4)
        : [];
      // chatParams + model 白名单（与 GET /chat 同规则）
      const chatParams = {};
      const cpSrc = op.chatParams || {};
      for (const k of ['thinking', 'temperature', 'topP']) {
        if (cpSrc[k] != null && Number.isFinite(Number(cpSrc[k]))) chatParams[k] = Number(cpSrc[k]);
      }
      if (cpSrc.maxTokens != null && Number.isFinite(parseInt(cpSrc.maxTokens, 10)))
        chatParams.maxTokens = parseInt(cpSrc.maxTokens, 10);
      if (typeof cpSrc.model === 'string' && cpSrc.model.trim()) {
        const effConfig = applySettingsOverride(config, store.settings);
        const allowed = new Set([effConfig.ai && effConfig.ai.model].filter(Boolean));
        const extra = effConfig.ai && Array.isArray(effConfig.ai.extraModels) ? effConfig.ai.extraModels : [];
        for (const m of extra) if (m) allowed.add(m);
        if (allowed.has(cpSrc.model)) chatParams.model = cpSrc.model;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      try {
        const r = await scanner.chatPaper(spaceId, id, message, {
          regenerate,
          extraIds: extraIds.length ? extraIds : undefined,
          chatParams: Object.keys(chatParams).length ? chatParams : undefined,
          images: images.length ? images : undefined,
          onToken: (t, kind) => {
            if (!aborted) sse('token', { t, kind: kind || 'content' });
            return !aborted;
          },
        });
        if (aborted) return;
        sse('done', { reply: r.reply, chat: r.chat });
      } catch (e) {
        sse('fail', { error: isProd ? 'AI 回答失败' : `AI 回答失败：${e.message}` });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // POST /api/papers/retag  body: { ids: [...] }  批量重新打标（含标签/主题库联动：多的入库、少的清除）
    if (pathname === '/api/papers/retag' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
      if (!ids.length) return fail(res, 400, 'no valid ids');
      if (!scanner.retagPapers) return fail(res, 501, 'scanner.retagPapers unavailable');
      const r = await scanner.retagPapers(spaceId, ids);
      return ok(res, r);
    }

    // POST /api/scan  扫描当前空间（?space= 或 active）
    if (pathname === '/api/scan' && method === 'POST') {
      const r = await scanner.scanSpace(spaceId);
      return ok(res, r);
    }

    // POST /api/import  { url, meta? }  —— 从 arXiv 网址(abs/pdf/html)或 ID 导入
    //   meta（可选，来自「发现」候选）：{ title, authors, year, abstract, primaryCategory, arxivId }
    //   提供 meta 时：① 文件名用「作者 等 - 年份 - 标题.pdf」；② 预填元数据，使总结/标签直接基于真实标题摘要。
    if (pathname === '/api/import' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const parsed = parseArxivUrl(op.url);
      if (!parsed) return fail(res, 400, '无法识别的 arXiv 网址，请粘贴 abs/pdf/html 网址或 arXiv ID（如 2401.12345）');
      const meta = op.meta && typeof op.meta === 'object' ? op.meta : {};
      const mTitle = typeof meta.title === 'string' ? meta.title.trim() : '';
      const mAuthors = Array.isArray(meta.authors) ? meta.authors.filter((a) => typeof a === 'string' && a.trim()) : [];
      const mYear = meta.year != null && String(meta.year).trim() ? String(meta.year).slice(0, 4) : null;
      const mAbstract = typeof meta.abstract === 'string' ? meta.abstract : '';
      const mCategory = typeof meta.primaryCategory === 'string' ? meta.primaryCategory : null;

      // 1) 按 arxivId 查重：已导入过则跳过，不重复下载
      const existing = Object.values(store.papers).find((p) => p.arxivId === parsed.arxivId);
      if (existing)
        return ok(res, { id: existing.id, status: 'duplicate', arxivId: parsed.arxivId, title: existing.title });

      // 2) 下载到该空间的 papersDir。有标题元数据 → 用「作者 等 - 年份 - 标题.pdf」；否则回退 <arxivId>.pdf。
      const papersDir = manager.resolveSpacePapersDir(spaceId);
      let filename =
        buildPaperFilename({ authors: mAuthors, year: mYear, title: mTitle, arxivId: parsed.arxivId }) ||
        `${parsed.arxivId}.pdf`;
      let dest = path.resolve(papersDir, filename);
      // 撞名（不同内容的同名文件）→ 加 arxivId 区分，避免覆盖
      if (fs.existsSync(dest)) {
        filename = filename.replace(/\.pdf$/i, ` (${parsed.arxivId}).pdf`);
        dest = path.resolve(papersDir, filename);
      }
      try {
        await arxiv.downloadPaperPdf(parsed.pdfUrl, dest);
      } catch (e) {
        return fail(
          res,
          502,
          isProd
            ? '下载失败：无法从 arXiv 获取该论文（直连模式；若需代理请配置 config.proxy）'
            : `下载失败：${e.message}（直连模式；若需代理请配置 config.proxy，本功能暂不支持）`,
        );
      }

      // 3) 算 sha1 前16位作 id（与文件导入一致），写 store 条目，复用 scanner 初始化结构。
      //    预填 meta：让 processOne 的总结直接基于真实标题+摘要（避免空标题 → 空总结）。
      const stat = fs.statSync(dest);
      const id = (await sha1OfFile(dest)).slice(0, 16);
      const prev = store.papers[id];
      const hasMeta = !!(mTitle || mAuthors.length);
      store.papers[id] = {
        ...(prev || {}),
        id,
        filename,
        filepath: dest,
        fileMtime: stat.mtimeMs,
        fileSize: stat.size,
        addedAt: (prev && prev.addedAt) || Date.now(),
        title: mTitle,
        authors: mAuthors,
        year: mYear,
        abstract: mAbstract,
        arxivId: parsed.arxivId,
        arxivUrl: `https://arxiv.org/abs/${parsed.arxivId}`,
        sourceUrl: parsed.raw,
        importSource: hasMeta ? 'discover' : 'url',
        primaryCategory: mCategory,
        metaSource: hasMeta ? 'arxiv' : null,
        metaConfidence: hasMeta ? 1 : 0,
        fulltextChars: 0,
        fulltextPath: null,
        summary: '',
        summaryModel: null,
        summaryAt: null,
        tags: [],
        topics: [],
        concepts: [],
        conceptIds: [],
        folders: [],
        readProgress: null,
        notes: '',
        starred: false,
        rating: 0,
        readStatus: 'unread',
        status: 'pending',
        error: null,
        chat: [],
        updatedAt: Date.now(),
      };

      // 4) 落盘 + 入队，复用现有流水线（processOne 已支持已知 arxivId 精确查元数据）
      await save(store);
      scanner.enqueue(spaceId, [id]);
      return ok(res, { id, status: 'imported', arxivId: parsed.arxivId });
    }

    // 把 config.discover 折成 discoverPapers 的入参（两个路由共用）。
    function discoverOpts(topic) {
      const cfg = config.discover || {};
      const arx = config.arxiv || {};
      const { planViaGateway } = require('./discover');
      // discover 的「网关规划」走 AI 调用，需用生效配置（store.settings.ai 覆盖 config.ai）
      const effConfig = applySettingsOverride(config, store.settings);
      return {
        topic,
        store,
        maxResults: cfg.maxResults ?? 40,
        perAxis: cfg.perAxis ?? 25,
        claudeTimeoutMs: cfg.claudeTimeoutMs ?? 60000,
        enableCitations: cfg.semanticScholar !== false,
        openAlex: cfg.openAlex !== false,
        s2ApiKey: cfg.semanticScholarApiKey || null,
        minIntervalMs: arx.minIntervalMs ?? 3000, // arXiv 礼貌限速，多轴多 query 时尤其重要
        weights: cfg.weights || undefined,
        recencyWindowYears: cfg.recencyWindowYears ?? undefined,
        titleSimThreshold: cfg.titleSimThreshold ?? undefined,
        // 查询理解引擎：默认 auto（claude → GLM 网关 → 原始）。claude 无头鉴权失败时用网关兜底。
        queryEngine: cfg.queryEngine || 'auto',
        generateViaGateway: (t) => planViaGateway(t, { config: effConfig }),
      };
    }

    // POST /api/discover  { topic }  —— 非流式发现（一次性返回候选；保留作兜底/脚本调用）
    // 只返回候选列表；勾选后由前端逐个 POST /api/import 走已有下载+入库链路。
    if (pathname === '/api/discover' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const topic = typeof op.topic === 'string' ? op.topic.trim() : '';
      if (!topic) return fail(res, 400, '请输入主题');
      const { discoverPapers } = require('./discover');
      try {
        const data = await discoverPapers(discoverOpts(topic));
        return ok(res, data);
      } catch (e) {
        return fail(res, 502, isProd ? '发现失败：arXiv / Semantic Scholar 检索出错' : `发现失败：${e.message}`);
      }
    }

    // GET /api/discover/stream?topic=...  —— SSE 流式发现，逐阶段推送进度
    // 事件：event:progress（每阶段）/ event:done（含 results）/ event:error
    if (pathname === '/api/discover/stream' && method === 'GET') {
      const topic = typeof q.topic === 'string' ? q.topic.trim() : '';
      if (!topic) return fail(res, 400, '请输入主题');
      const { discoverPapers } = require('./discover');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 反向代理（nginx）下禁用缓冲，保证逐条下发
      });
      const sse = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      sse('progress', { stage: 'start', message: '开始发现…' });
      try {
        const data = await discoverPapers({
          ...discoverOpts(topic),
          onProgress: (ev) => {
            if (!aborted) sse('progress', ev);
          },
        });
        sse('done', data);
      } catch (e) {
        // 用自定义事件名 'fail'（而非 'error'）：EventSource 的原生 'error' 用于连接层，混用会触发前端误判与自动重连
        sse('fail', { error: isProd ? '发现失败：arXiv / Semantic Scholar 检索出错' : `发现失败：${e.message}` });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // GET /api/tags
    if (pathname === '/api/tags' && method === 'GET') {
      const counts = {};
      for (const p of Object.values(store.papers)) for (const t of p.tags || []) counts[t] = (counts[t] || 0) + 1;
      return ok(
        res,
        (store.tags || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count),
      );
    }

    // PATCH /api/tags  { merge, into } | { delete }
    if (pathname === '/api/tags' && method === 'PATCH') {
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
    }

    // GET /api/topics  主题字典 + 计数
    if (pathname === '/api/topics' && method === 'GET') {
      const counts = {};
      for (const p of Object.values(store.papers)) for (const t of p.topics || []) counts[t] = (counts[t] || 0) + 1;
      return ok(
        res,
        (store.topics || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count),
      );
    }

    // PATCH /api/topics  { merge, into } | { delete }  主题重命名/删除（对齐标签 PATCH）
    if (pathname === '/api/topics' && method === 'PATCH') {
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
    }

    // ---- 设置（提示词 / AI 接口 / 主题标签等） ----
    // GET /api/settings  返回提示词 + 生效 AI 配置（掩码）+ 内置默认，供设置面板渲染
    if (pathname === '/api/settings' && method === 'GET') {
      store.settings = store.settings || {};
      const effConfig = applySettingsOverride(config, store.settings);
      const ov = store.settings;
      return ok(res, {
        // --- 智能：提示词（向后兼容 summaryPrompt / configPrompt / defaultPrompt）---
        summaryPrompt: store.settings.summaryPrompt || '',
        configPrompt: config.summaryPrompt || '',
        defaultPrompt: DEFAULT_SUMMARY_PROMPT,
        tagsPrompt: store.settings.tagsPrompt || '',
        defaultTagsPrompt: DEFAULT_TAGS_PROMPT,
        // --- 聊天预置 Prompt（@ 引用之外，输入框上方的快捷提问按钮，用户可自定义）---
        chatPresets: Array.isArray(store.settings.chatPresets) ? store.settings.chatPresets : [],
        // 生效 AI 配置（store.settings.ai 覆盖 config.ai 后）+ config 原值
        ai: aiSettingsView(effConfig),
        configAi: { baseURL: (config.ai && config.ai.baseURL) || '', model: (config.ai && config.ai.model) || '' },
        // --- 采集：扫描 / arxiv / discover（生效值 + config 原值）---
        scan: { scanIntervalMinutes: effConfig.scanIntervalMinutes ?? 5 },
        configScan: { scanIntervalMinutes: config.scanIntervalMinutes ?? 5 },
        arxiv: arxivSettingsView(effConfig.arxiv),
        configArxiv: arxivSettingsView(config.arxiv),
        discover: discoverSettingsView(effConfig.discover),
        configDiscover: discoverSettingsView(config.discover),
        // --- 阅读：划线翻译（生效值 + config 原值）---
        translate: translateSettingsView(effConfig.translate),
        configTranslate: translateSettingsView(config.translate),
        // --- 哪些字段被 store.settings 覆盖（驱动「已覆盖 config」徽标 / 计数）---
        overrides: {
          ai: Object.keys(ov.ai || {}),
          arxiv: Object.keys(ov.arxiv || {}),
          discover: Object.keys(ov.discover || {}),
          translate: Object.keys(ov.translate || {}),
          scan: ov.scanIntervalMinutes !== undefined,
          summaryPrompt: !!ov.summaryPrompt,
          tagsPrompt: !!ov.tagsPrompt,
        },
        // --- 系统只读（host/port 全局；papersDir 现为当前空间绑定的文件夹，可在空间管理中修改）---
        system: {
          host: config.host,
          port: config.port,
          spaceId,
          spaceName: space && space.name,
          papersDir: space && space.papersDir, // 当前空间绑定的文件夹（用户可改）
          configPapersDir: config.papersDir, // config.json 原始值（新空间默认模板）
          version: pkg.version,
          papers: Object.keys(store.papers).length,
          spaces: manager.listSpaces().length,
          uptime: Math.round(process.uptime()),
          rawConfig: maskedRawConfig(config),
        },
      });
    }

    // GET /api/ai/models  返回可用模型列表（Phase 2 模型切换器用）。
    //   优先调上游 /v1/models；失败回退 config.ai.model + config.ai.extraModels。
    //   永不抛错——上游不可达时返回静态候选，保证前端切换器总能渲染。
    if (pathname === '/api/ai/models' && method === 'GET') {
      const effConfig = applySettingsOverride(config, store.settings || {});
      try {
        const r = await listModels({ config: effConfig });
        return ok(res, r);
      } catch (e) {
        return fail(res, 500, isProd ? '列出模型失败' : `列出模型失败：${e.message}`);
      }
    }
    // PUT /api/settings/summary-prompt  body: { value }  空串=恢复默认
    if (pathname === '/api/settings/summary-prompt' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      store.settings.summaryPrompt = typeof op.value === 'string' ? op.value.trim() : '';
      store.settings.updatedAt = Date.now();
      await save(store);
      return ok(res, { summaryPrompt: store.settings.summaryPrompt });
    }
    // PUT /api/settings/tags-prompt  body: { value }  空串=恢复默认（标签/主题提示词）
    if (pathname === '/api/settings/tags-prompt' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      store.settings.tagsPrompt = typeof op.value === 'string' ? op.value.trim() : '';
      store.settings.updatedAt = Date.now();
      await save(store);
      return ok(res, { tagsPrompt: store.settings.tagsPrompt });
    }
    // PUT /api/settings/chat-presets  body: { value: [{label,prompt}] }  空数组=恢复内置默认
    //   聊天输入框上方的快捷提问按钮（用户可自定义 label/prompt）。规整：去空项、限 20 条、截断长度。
    if (pathname === '/api/settings/chat-presets' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      const raw = Array.isArray(op.value) ? op.value : [];
      const clean = raw
        .map((it) => ({
          label: String((it && it.label) || '')
            .trim()
            .slice(0, 24),
          prompt: String((it && it.prompt) || '')
            .trim()
            .slice(0, 500),
        }))
        .filter((it) => it.prompt)
        .slice(0, 20);
      store.settings.chatPresets = clean;
      store.settings.updatedAt = Date.now();
      await save(store);
      return ok(res, { chatPresets: store.settings.chatPresets });
    }
    // PUT /api/settings/ai  body: { baseURL?, apiKey?, model?, maxInputChars?, timeoutMs? }
    //   运行时覆盖 config.ai（写入 store.settings.ai，热生效，无需重启）。
    //   - 白名单字段，未传的不覆盖。
    //   - apiKey 为空串 → 清空；为掩码 '****' 或未传 → 保持原值（前端掩码回显误传保护）。
    if (pathname === '/api/settings/ai' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      const cur = store.settings.ai || {};
      const next = { ...cur };
      if (typeof op.baseURL === 'string') next.baseURL = op.baseURL.trim();
      if (typeof op.model === 'string') next.model = op.model.trim();
      if (op.maxInputChars != null) next.maxInputChars = Number(op.maxInputChars) || 24000;
      if (op.timeoutMs != null) next.timeoutMs = Number(op.timeoutMs) || 120000;
      // apiKey：显式空串=清空；掩码或未传=保持原值
      if (op.apiKey === '') next.apiKey = '';
      else if (typeof op.apiKey === 'string' && op.apiKey.trim() && !/^\*+$/i.test(op.apiKey)) {
        next.apiKey = op.apiKey.trim();
      }
      store.settings.ai = next;
      store.settings.updatedAt = Date.now();
      await save(store);
      const effConfig = applySettingsOverride(config, store.settings);
      return ok(res, { ai: aiSettingsView(effConfig) });
    }
    // POST /api/settings/test  用当前生效配置发一条 ping 消息验证连通性。
    //   body 可选透传表单值 { baseURL?, apiKey?, model? }（覆盖生效配置），让用户改完不保存也能测。
    if (pathname === '/api/settings/test' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const effConfig = applySettingsOverride(config, store.settings);
      // 表单透传覆盖（未传则用已保存的生效值）：baseURL/model 非空才覆盖，apiKey 非掩码才覆盖
      const testAi = { ...effConfig.ai };
      if (typeof op.baseURL === 'string' && op.baseURL.trim()) testAi.baseURL = op.baseURL.trim();
      if (typeof op.model === 'string' && op.model.trim()) testAi.model = op.model.trim();
      if (typeof op.apiKey === 'string' && op.apiKey.trim() && !/^\*+$/i.test(op.apiKey))
        testAi.apiKey = op.apiKey.trim();
      const testConfig = { ...effConfig, ai: testAi };
      try {
        await callChat({
          messages: [
            { role: 'system', content: 'Reply with the single word: ok' },
            { role: 'user', content: 'ping' },
          ],
          config: testConfig,
          jsonMode: false,
        });
        return ok(res, { ok: true });
      } catch (e) {
        return fail(res, 200, isProd ? '连接失败，请检查配置' : e.message);
      }
    }

    // PUT /api/settings/scan  body: { scanIntervalMinutes }  整数 ≥0，0=关闭定时扫描。热生效（reschedule 重置定时器）。
    if (pathname === '/api/settings/scan' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      let n = parseInt(op.scanIntervalMinutes, 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
      store.settings.scanIntervalMinutes = n;
      store.settings.updatedAt = Date.now();
      await save(store);
      if (scanner && scanner.reschedule) await scanner.reschedule(spaceId, n);
      const eff = applySettingsOverride(config, store.settings);
      return ok(res, { scan: { scanIntervalMinutes: eff.scanIntervalMinutes ?? 5 } });
    }

    // PUT /api/settings/arxiv  body: { enabled?, titleSimilarityThreshold?, minIntervalMs? }  白名单，未传不改。
    if (pathname === '/api/settings/arxiv' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      const next = { ...(store.settings.arxiv || {}) };
      if (typeof op.enabled === 'boolean') next.enabled = op.enabled;
      if (op.titleSimilarityThreshold != null) {
        const t = Number(op.titleSimilarityThreshold);
        if (Number.isFinite(t)) next.titleSimilarityThreshold = Math.min(1, Math.max(0, t));
      }
      if (op.minIntervalMs != null) {
        const m = Number(op.minIntervalMs);
        if (Number.isFinite(m) && m >= 0) next.minIntervalMs = m;
      }
      store.settings.arxiv = next;
      store.settings.updatedAt = Date.now();
      await save(store);
      const eff = applySettingsOverride(config, store.settings);
      return ok(res, { arxiv: arxivSettingsView(eff.arxiv) });
    }

    // PUT /api/settings/translate  body: { engine?, targetLang? }  划线翻译引擎 + 目标语言。
    if (pathname === '/api/settings/translate' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      const next = { ...(store.settings.translate || {}) };
      if (op.engine === 'bing' || op.engine === 'google' || op.engine === 'ai' || op.engine === 'none')
        next.engine = op.engine;
      if (typeof op.targetLang === 'string' && op.targetLang.trim()) next.targetLang = op.targetLang.trim();
      store.settings.translate = next;
      store.settings.updatedAt = Date.now();
      await save(store);
      const eff = applySettingsOverride(config, store.settings);
      return ok(res, { translate: translateSettingsView(eff.translate) });
    }

    // GET /api/translate?text=&engine=  划线翻译（浮窗内显示译文，不跳转外链）。
    //   ?text= 选中文本（URL 编码，≤8000 字符）&engine= ai | google（bing 由前端走外链，不到这）。
    //   - engine=ai（默认）：流式 SSE（EventSource，与 chat 同款），复用 callChatStream + TRANSLATE_SYSTEM_PROMPT。
    //   - engine=google：RESTful JSON（调用 Google 免费端点 translate.googleapis.com，无需 Key，秒回）。
    //     Google 端点返回 [[["译文","原文",...],...]]，拼接 data[0][*][0] 得完整译文。
    //   用 GET：浏览器 EventSource 只支持 GET（ai 分支）；google 分支也走 GET 保持统一。
    if (pathname === '/api/translate' && method === 'GET') {
      const text = typeof q.text === 'string' ? q.text.trim() : '';
      if (!text) return fail(res, 400, 'empty text');
      const effConfig = applySettingsOverride(config, store.settings || {});
      // engine 优先取 query（前端按用户所选引擎传），回退 config 设置
      const engine =
        q.engine === 'ai' || q.engine === 'google'
          ? q.engine
          : (effConfig.translate && effConfig.translate.engine) || 'ai';
      const targetLang = (effConfig.translate && effConfig.translate.targetLang) || 'zh-CN';

      // —— Google 免费端点：RESTful JSON（非流式），秒回 ——
      // 端点 translate.googleapis.com/translate_a/single?client=gtx&dt=t，无需 Key。
      // 非官方端点（网页版内部用），可能被限流/变动，故 try/catch 兜底 + 超时。
      // 用 proxyFetchJson（零依赖 https + 代理隧道）：Node 原生 fetch 不读 HTTP_PROXY 环境变量，
      // 用户有代理（如 Clash）时原生 fetch 会超时；proxyFetchJson 自动尊崇 HTTPS_PROXY。
      if (engine === 'google') {
        const glu = GL_LANG_MAP[targetLang] || targetLang;
        const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(glu)}&q=${encodeURIComponent(text.slice(0, 5000))}`;
        try {
          const gj = await proxyFetchJson(gUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 PaperWiki' } });
          // gj[0] = [[译文片段, 原文片段, ...], ...]；拼接所有译文片段
          const reply = Array.isArray(gj && gj[0]) ? gj[0].map((seg) => (seg && seg[0]) || '').join('') : '';
          if (!reply) throw new Error('Google 返回为空');
          return ok(res, { reply, engine: 'google' });
        } catch (e) {
          return fail(res, 502, isProd ? 'Google 翻译失败（需代理访问 Google）' : `Google 翻译失败：${e.message}`);
        }
      }

      // —— AI 引擎：流式 SSE（EventSource）——
      const langName = LANG_NAMES[targetLang] || targetLang;
      const messages = [
        { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
        { role: 'user', content: `请将以下文本翻译为「${langName}」，只输出译文：\n\n${text.slice(0, 8000)}` },
      ];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      try {
        const reply = await callChatStream({
          messages,
          config: effConfig,
          jsonMode: false,
          onToken: (t, kind) => {
            if (!aborted && kind !== 'reasoning') sse('token', { t });
            return !aborted;
          },
        });
        if (aborted) return;
        sse('done', { reply });
      } catch (e) {
        sse('fail', { error: isProd ? '翻译失败' : `翻译失败：${e.message}` });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // PUT /api/settings/discover  body: 白名单字段 + weights{rel,auth,rec}；semanticScholarApiKey 掩码协议同 ai.apiKey。
    if (pathname === '/api/settings/discover' && method === 'PUT') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      const next = { ...(store.settings.discover || {}) };
      for (const k of ['maxResults', 'perAxis', 'recencyWindowYears', 'claudeTimeoutMs']) {
        if (op[k] != null) {
          const v = parseInt(op[k], 10);
          if (Number.isFinite(v) && v >= 0) next[k] = v;
        }
      }
      if (typeof op.semanticScholar === 'boolean') next.semanticScholar = op.semanticScholar;
      if (typeof op.openAlex === 'boolean') next.openAlex = op.openAlex;
      if (op.titleSimThreshold != null) {
        const t = Number(op.titleSimThreshold);
        if (Number.isFinite(t)) next.titleSimThreshold = Math.min(1, Math.max(0, t));
      }
      if (op.weights && typeof op.weights === 'object') {
        const w = { ...(next.weights || {}) };
        for (const k of ['rel', 'auth', 'rec']) {
          if (op.weights[k] != null) {
            const v = Number(op.weights[k]);
            if (Number.isFinite(v) && v >= 0) w[k] = v;
          }
        }
        next.weights = w;
      }
      // S2 key：空串=清空；掩码（纯星号）/未传=保持原值；新值=覆盖
      if (op.semanticScholarApiKey === '') next.semanticScholarApiKey = '';
      else if (
        typeof op.semanticScholarApiKey === 'string' &&
        op.semanticScholarApiKey.trim() &&
        !/^\*+$/i.test(op.semanticScholarApiKey)
      ) {
        next.semanticScholarApiKey = op.semanticScholarApiKey.trim();
      }
      store.settings.discover = next;
      store.settings.updatedAt = Date.now();
      await save(store);
      const eff = applySettingsOverride(config, store.settings);
      return ok(res, { discover: discoverSettingsView(eff.discover) });
    }

    // POST /api/settings/reset  body: { section } 或 { all:true }  清除运行时覆盖，回到 config.json 默认。
    if (pathname === '/api/settings/reset' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      store.settings = store.settings || {};
      if (op.all) {
        store.settings = { updatedAt: Date.now() };
        if (scanner && scanner.reschedule) await scanner.reschedule(spaceId, config.scanIntervalMinutes ?? 5);
        await save(store);
        return ok(res, { ok: true });
      }
      const section = op.section;
      const known = ['ai', 'summaryPrompt', 'tagsPrompt', 'arxiv', 'discover', 'translate', 'scan'];
      if (!known.includes(section)) return fail(res, 400, 'unknown section: ' + section);
      if (section === 'scan') {
        delete store.settings.scanIntervalMinutes;
        if (scanner && scanner.reschedule) await scanner.reschedule(spaceId, config.scanIntervalMinutes ?? 5);
      } else {
        delete store.settings[section];
      }
      store.settings.updatedAt = Date.now();
      await save(store);
      return ok(res, { ok: true });
    }

    // ---- 收藏夹（虚拟文件夹） ----
    // GET /api/folders
    if (pathname === '/api/folders' && method === 'GET') {
      const counts = {};
      for (const p of Object.values(store.papers)) for (const f of p.folders || []) counts[f] = (counts[f] || 0) + 1;
      return ok(
        res,
        (store.folders || []).map((f) => ({ ...f, count: counts[f.id] || 0 })),
      );
    }
    // POST /api/folders { name, color }
    if (pathname === '/api/folders' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const f = addFolder(store, op.name, op.color);
      await save(store);
      return ok(res, f);
    }
    // PATCH /api/folders/:id { name?, color? }
    const folderMatch = /^\/api\/folders\/([\w.-]+)$/.exec(pathname);
    if (folderMatch && method === 'PATCH') {
      const f = (store.folders || []).find((x) => x.id === folderMatch[1]);
      if (!f) return fail(res, 404, 'Not found');
      const op = JSON.parse(body || '{}');
      if (op.name) f.name = String(op.name).trim();
      if (op.color) f.color = String(op.color);
      await save(store);
      return ok(res, f);
    }
    // DELETE /api/folders/:id
    if (folderMatch && method === 'DELETE') {
      deleteFolder(store, folderMatch[1]);
      await save(store);
      return ok(res, { deleted: folderMatch[1] });
    }

    // ---- 概念清单 ----
    // GET /api/concepts (?q= / ?paper=)
    if (pathname === '/api/concepts' && method === 'GET') {
      let list = (store.concepts || []).slice();
      if (q.paper) list = list.filter((c) => (c.paperIds || []).includes(q.paper));
      if (q.q) {
        const needle = String(q.q).toLowerCase();
        list = list.filter((c) => (c.term + ' ' + (c.definition || '')).toLowerCase().includes(needle));
      }
      return ok(res, list);
    }
    // GET /api/concepts.md  纯 Markdown 文档
    if (pathname === '/api/concepts.md' && method === 'GET') {
      const md = conceptsToMarkdown(store);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return res.end(md);
    }
    // PATCH /api/concepts/:id { term?, definition? }
    const conceptMatch = /^\/api\/concepts\/([\w.-]+)$/.exec(pathname);
    if (conceptMatch && method === 'PATCH') {
      const c = (store.concepts || []).find((x) => x.id === conceptMatch[1]);
      if (!c) return fail(res, 404, 'Not found');
      const op = JSON.parse(body || '{}');
      if (op.term) c.term = String(op.term).trim();
      if ('definition' in op) c.definition = String(op.definition).trim();
      c.updatedAt = Date.now();
      await save(store);
      return ok(res, c);
    }
    // DELETE /api/concepts/:id
    if (conceptMatch && method === 'DELETE') {
      const removed = deleteConcept(store, conceptMatch[1]);
      if (!removed) return fail(res, 404, 'Not found');
      await save(store);
      return ok(res, { deleted: conceptMatch[1] });
    }

    // GET /api/stats
    if (pathname === '/api/stats' && method === 'GET') {
      const all = Object.values(store.papers);
      return ok(res, {
        total: all.length,
        ready: all.filter((p) => p.status === 'ready').length,
        error: all.filter((p) => p.status === 'error').length,
        processing: all.filter((p) => ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)).length,
        // 全局星标/未读计数（不随筛选变，供侧栏「全部/星标/未读」徽标用，避免被当前视图筛选污染）
        starred: all.filter((p) => p.starred).length,
        unread: all.filter((p) => (p.readStatus || 'unread') === 'unread').length,
        folders: (store.folders || []).length,
        topics: (store.topics || []).length,
        concepts: (store.concepts || []).length,
      });
    }

    return fail(res, 404, 'No route');
  }

  return { handle };
}

module.exports = { createApiRouter, summaryView, detailView };
