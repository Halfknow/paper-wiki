const { log } = require('./util');

/** 列表视图：去掉超长大字段，保留前端列表所需 */
function summaryView(p) {
  return {
    id: p.id, filename: p.filename, title: p.title,
    authors: p.authors, year: p.year,
    status: p.status, error: p.error,
    metaSource: p.metaSource, metaConfidence: p.metaConfidence,
    arxivId: p.arxivId, arxivUrl: p.arxivUrl,
    tags: p.tags || [], starred: !!p.starred,
    readStatus: p.readStatus, addedAt: p.addedAt, updatedAt: p.updatedAt,
    hasSummary: !!p.summary, hasNotes: !!p.notes,
    summaryExcerpt: p.summary ? p.summary.slice(0, 160) : '',
  };
}

/** 详情视图：含完整 summary / notes */
function detailView(p) {
  return {
    ...summaryView(p),
    summary: p.summary || '', notes: p.notes || '',
    abstract: p.abstract || '', fulltextChars: p.fulltextChars || 0,
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

    // GET /api/papers
    if (pathname === '/api/papers' && method === 'GET') {
      let list = Object.values(store.papers);
      if (q.tag) list = list.filter((p) => (p.tags || []).includes(q.tag));
      if (q.status) list = list.filter((p) => p.status === q.status);
      if (q.starred === '1') list = list.filter((p) => p.starred);
      if (q.readStatus) list = list.filter((p) => p.readStatus === q.readStatus);
      if (q.q) {
        const needle = q.q.toLowerCase();
        list = list.filter((p) => [p.title, p.abstract, p.summary, p.notes, ...(p.tags || [])]
          .join(' ').toLowerCase().includes(needle));
      }
      const sort = q.sort || 'addedDesc';
      list.sort((a, b) => (sort === 'titleAsc')
        ? (a.title || '').localeCompare(b.title || '')
        : (b.addedAt || 0) - (a.addedAt || 0));
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
      const allowed = ['notes', 'starred', 'readStatus', 'tags', 'title'];
      for (const k of allowed) if (k in patch) p[k] = patch[k];
      if (Array.isArray(patch.tags)) {
        p.tags = patch.tags;
        mergeInto(store, patch.tags);
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

    // POST /api/scan
    if (pathname === '/api/scan' && method === 'POST') {
      const r = await scanner.scan();
      return ok(res, r);
    }

    // GET /api/tags
    if (pathname === '/api/tags' && method === 'GET') {
      const counts = {};
      for (const p of Object.values(store.papers)) for (const t of (p.tags || [])) counts[t] = (counts[t] || 0) + 1;
      return ok(res, (store.tags || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count));
    }

    // PATCH /api/tags  { merge, into } | { delete }
    if (pathname === '/api/tags' && method === 'PATCH') {
      const op = JSON.parse(body || '{}');
      if (op.merge && op.into) {
        for (const p of Object.values(store.papers)) {
          if ((p.tags || []).includes(op.merge)) {
            p.tags = Array.from(new Set(p.tags.map((t) => t === op.merge ? op.into : t)));
          }
        }
      } else if (op.delete) {
        for (const p of Object.values(store.papers)) p.tags = (p.tags || []).filter((t) => t !== op.delete);
      }
      const set = new Set();
      for (const p of Object.values(store.papers)) for (const t of (p.tags || [])) set.add(t);
      store.tags = [...set].sort();
      await save(store);
      return ok(res, { tags: store.tags });
    }

    // GET /api/stats
    if (pathname === '/api/stats' && method === 'GET') {
      const all = Object.values(store.papers);
      return ok(res, {
        total: all.length,
        ready: all.filter((p) => p.status === 'ready').length,
        error: all.filter((p) => p.status === 'error').length,
        processing: all.filter((p) => ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)).length,
      });
    }

    return fail(res, 404, 'No route');
  }

  return { handle };
}

module.exports = { createApiRouter, summaryView, detailView };
