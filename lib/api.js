const path = require('path');
const fs = require('fs');
const { mergeTopics, deleteConcept, conceptsToMarkdown, addFolder, deleteFolder } = require('./store');
const { DEFAULT_PROMPT } = require('./ai');
const { sha1OfFile, parseArxivUrl } = require('./util');
const { normalizeAnnotations } = require('./annotations');
const arxiv = require('./arxiv');

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
      if (q.tag) list = list.filter((p) => (p.tags || []).includes(q.tag));
      if (q.topic) {
        const needle = String(q.topic).toLowerCase();
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
        'readStatus',
        'tags',
        'title',
        'topics',
        'folders',
        'readProgress',
        'annotations',
      ];
      for (const k of allowed) if (k in patch) p[k] = patch[k];
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

    // POST /api/papers/:id/summarize 或 /parse
    const action = /^\/api\/papers\/([\w.-]+)\/(summarize|parse)$/.exec(pathname);
    if (action && method === 'POST') {
      const id = action[1];
      const p = store.papers[id];
      if (!p) return fail(res, 404, 'Not found');
      if (action[2] === 'parse') p.status = 'pending';
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

    // POST /api/import  { url }  —— 从 arXiv 网址(abs/pdf/html)或 ID 导入
    if (pathname === '/api/import' && method === 'POST') {
      const op = JSON.parse(body || '{}');
      const parsed = parseArxivUrl(op.url);
      if (!parsed) return fail(res, 400, '无法识别的 arXiv 网址，请粘贴 abs/pdf/html 网址或 arXiv ID（如 2401.12345）');

      // 1) 按 arxivId 查重：已导入过则跳过，不重复下载
      const existing = Object.values(store.papers).find((p) => p.arxivId === parsed.arxivId);
      if (existing)
        return ok(res, { id: existing.id, status: 'duplicate', arxivId: parsed.arxivId, title: existing.title });

      // 2) 下载到 papers/，文件名用 arxivId 保证唯一可识别（2401.12345.pdf）
      const papersDir = path.resolve(__dirname, '..', config.papersDir || 'papers');
      const filename = `${parsed.arxivId}.pdf`;
      const dest = path.resolve(papersDir, filename);
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

      // 3) 算 sha1 前16位作 id（与文件导入一致），写 store 条目，复用 scanner 初始化结构
      const stat = fs.statSync(dest);
      const id = (await sha1OfFile(dest)).slice(0, 16);
      const prev = store.papers[id];
      store.papers[id] = {
        ...(prev || {}),
        id,
        filename,
        filepath: dest,
        fileMtime: stat.mtimeMs,
        fileSize: stat.size,
        addedAt: (prev && prev.addedAt) || Date.now(),
        title: '',
        authors: [],
        year: null,
        abstract: '',
        arxivId: parsed.arxivId,
        arxivUrl: `https://arxiv.org/abs/${parsed.arxivId}`,
        sourceUrl: parsed.raw,
        importSource: 'url',
        primaryCategory: null,
        metaSource: null,
        metaConfidence: 0,
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

    // ---- 设置（提示词等） ----
    // GET /api/settings  返回当前 summaryPrompt 与内置默认
    if (pathname === '/api/settings' && method === 'GET') {
      store.settings = store.settings || {};
      return ok(res, {
        summaryPrompt: store.settings.summaryPrompt || '',
        configPrompt: config.summaryPrompt || '',
        defaultPrompt: DEFAULT_PROMPT,
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
