const path = require('path');
const fs = require('fs');
const { mergeTopics, deleteConcept, conceptsToMarkdown, addFolder, deleteFolder } = require('./store');
const { DEFAULT_SUMMARY_PROMPT, DEFAULT_TAGS_PROMPT, applySettingsOverride, callChat } = require('./ai');
const { sha1OfFile, parseArxivUrl, buildPaperFilename } = require('./util');
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

function createApiRouter(ctx) {
  const { store, save, scanner, config } = ctx;
  const isProd = process.env.NODE_ENV === 'production';

  function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  const ok = (res, data) => send(res, 200, { ok: true, data });
  const fail = (res, code, error) => send(res, code, { ok: false, error });

  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;

    // GET /api/health — 探活（pm2 / 反向代理用），无需鉴权
    if (pathname === '/api/health' && method === 'GET') {
      return ok(res, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        papers: Object.keys(store.papers).length,
      });
    }

    // GET /api/papers
    if (pathname === '/api/papers' && method === 'GET') {
      let list = Object.values(store.papers);
      // 标签 / 主题：支持多选（?tag=a&tag=b），维度内 OR（含任一即命中）。
      // 用 getAll 读数组（Object.fromEntries 只保留末值，会丢重复 key）。保留单值分支向后兼容。
      const tags = url.searchParams.getAll('tag');
      if (tags.length > 1) {
        list = list.filter((p) => tags.some((t) => (p.tags || []).includes(t)));
      } else if (tags.length === 1 || q.tag) {
        const t = tags[0] || q.tag;
        list = list.filter((p) => (p.tags || []).includes(t));
      }
      const topics = url.searchParams.getAll('topic');
      if (topics.length > 1) {
        const needles = topics.map((t) => String(t).toLowerCase());
        list = list.filter((p) => (p.topics || []).some((t) => needles.includes(String(t).toLowerCase())));
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

    // DELETE /api/papers/:id  —— 删除论文条目 + PDF 文件 + 全文文本，并清理概念引用
    if (detail && method === 'DELETE') {
      const id = detail[1];
      const p = store.papers[id];
      if (!p) return fail(res, 404, 'Not found');
      const papersDir = path.resolve(__dirname, '..', config.papersDir || 'papers');
      // 删 PDF：仅当其位于 papersDir 内（防越界删除）；文件缺失/占用一律忽略，仍删条目
      if (p.filepath) {
        const abs = path.resolve(p.filepath);
        if (abs === papersDir || abs.startsWith(papersDir + path.sep)) {
          try {
            fs.rmSync(abs, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      // 删全文文本（data/text/<id>.txt，由本程序写入，路径可信）
      if (p.fulltextPath) {
        try {
          fs.rmSync(path.resolve(p.fulltextPath), { force: true });
        } catch {
          /* ignore */
        }
      }
      delete store.papers[id];
      // 清理概念里的论文引用（保留概念本身，避免误删他人共享概念）
      for (const c of store.concepts || []) {
        if (Array.isArray(c.paperIds) && c.paperIds.includes(id)) {
          c.paperIds = c.paperIds.filter((x) => x !== id);
        }
      }
      await save(store);
      return ok(res, { id, status: 'deleted' });
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
      scanner.enqueue([id]);
      return ok(res, { queued: id });
    }

    // POST /api/papers/concepts  body: { ids: [...] }  对选中论文重新抽取概念并追加
    if (pathname === '/api/papers/concepts' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const ids = Array.isArray(op.ids) ? op.ids.filter((id) => store.papers[id]) : [];
      if (!ids.length) return fail(res, 400, 'no valid ids');
      if (!scanner.extractConcepts) return fail(res, 501, 'scanner.extractConcepts unavailable');
      const r = await scanner.extractConcepts(ids);
      return ok(res, r);
    }

    // POST /api/scan
    if (pathname === '/api/scan' && method === 'POST') {
      const r = await scanner.scan();
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

      // 2) 下载到 papers/。有标题元数据 → 用「作者 等 - 年份 - 标题.pdf」；否则回退 <arxivId>.pdf。
      const papersDir = path.resolve(__dirname, '..', config.papersDir || 'papers');
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
        updatedAt: Date.now(),
      };

      // 4) 落盘 + 入队，复用现有流水线（processOne 已支持已知 arxivId 精确查元数据）
      await save(store);
      scanner.enqueue([id]);
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
        // --- 哪些字段被 store.settings 覆盖（驱动「已覆盖 config」徽标 / 计数）---
        overrides: {
          ai: Object.keys(ov.ai || {}),
          arxiv: Object.keys(ov.arxiv || {}),
          discover: Object.keys(ov.discover || {}),
          scan: ov.scanIntervalMinutes !== undefined,
          summaryPrompt: !!ov.summaryPrompt,
          tagsPrompt: !!ov.tagsPrompt,
        },
        // --- 系统只读（host/port/papersDir 运行时不可改，仅展示）---
        system: {
          host: config.host,
          port: config.port,
          papersDir: config.papersDir,
          version: pkg.version,
          papers: Object.keys(store.papers).length,
          uptime: Math.round(process.uptime()),
          rawConfig: maskedRawConfig(config),
        },
      });
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
    // POST /api/settings/test  用当前生效配置发一条 ping 消息验证连通性
    if (pathname === '/api/settings/test' && method === 'POST') {
      const effConfig = applySettingsOverride(config, store.settings);
      try {
        await callChat({
          messages: [
            { role: 'system', content: 'Reply with the single word: ok' },
            { role: 'user', content: 'ping' },
          ],
          config: effConfig,
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
      if (scanner && scanner.reschedule) scanner.reschedule(n);
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
        if (scanner && scanner.reschedule) scanner.reschedule(config.scanIntervalMinutes ?? 5);
        await save(store);
        return ok(res, { ok: true });
      }
      const section = op.section;
      const known = ['ai', 'summaryPrompt', 'tagsPrompt', 'arxiv', 'discover', 'scan'];
      if (!known.includes(section)) return fail(res, 400, 'unknown section: ' + section);
      if (section === 'scan') {
        delete store.settings.scanIntervalMinutes;
        if (scanner && scanner.reschedule) scanner.reschedule(config.scanIntervalMinutes ?? 5);
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
