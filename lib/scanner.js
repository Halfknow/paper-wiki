const fsp = require('fs/promises');
const path = require('path');
const { sha1OfFile, log } = require('./util');

/** 扫描目录下所有 PDF 文件信息 */
async function scanDir(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/\.pdf$/i.test(name)) continue;
    const filepath = path.join(dir, name);
    try {
      const st = await fsp.stat(filepath);
      if (!st.isFile()) continue;
      out.push({ filepath, filename: name, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out;
}

/** 对每个 PDF 计算 sha1(前16位) 作为稳定 id */
async function fingerprintAll(items) {
  const out = [];
  for (const it of items) {
    const id = (await sha1OfFile(it.filepath)).slice(0, 16);
    out.push({ ...it, id });
  }
  return out;
}

/** 对比现有 papers 与扫描指纹，算 added/changed/missing */
function diffPapers(existingPapers, scanned) {
  const scannedIds = new Set(scanned.map((s) => s.id));
  const added = [], changed = [];
  for (const s of scanned) {
    const cur = existingPapers[s.id];
    if (!cur) added.push(s);
    else if (cur.fileSize !== s.size || cur.status === 'missing') changed.push(s);
  }
  const missing = Object.values(existingPapers)
    .filter((p) => !scannedIds.has(p.id) && p.status !== 'missing');
  return { added, changed, missing };
}

/** 创建扫描器：负责增量扫描 + 串行处理流水线 */
function createScanner({ store, storePath, papersDir, deps, scanIntervalMs }) {
  const queue = [];
  let processing = false;
  let timer = null;

  function enqueue(ids) { for (const id of ids) queue.push(id); pump(); }

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try { await processOne(id); }
        catch (e) { log('process error', id, e.message); }
      }
    } finally { processing = false; }
  }

  function setStatus(id, status) { if (store.papers[id]) store.papers[id].status = status; }

  async function processOne(id) {
    const p = store.papers[id];
    if (!p) return;
    const textDir = path.join(path.dirname(storePath), 'text');
    try {
      // 1) 解析全文
      setStatus(id, 'parsing');
      const { text } = await deps.parser.extractText(p.filepath);
      const textPath = path.join(textDir, `${id}.txt`);
      await fsp.mkdir(textDir, { recursive: true });
      await fsp.writeFile(textPath, text || '', 'utf8');
      store.papers[id].fulltextChars = (text || '').length;
      store.papers[id].fulltextPath = textPath;

      // 2) arXiv 元数据
      if (deps.config.arxiv && deps.config.arxiv.enabled !== false) {
        setStatus(id, 'enriching');
        const candidate = deps.arxiv.cleanFilenameToTitle(p.filename);
        try {
          await deps.rateLimitArxiv();
          const { entries } = await deps.arxiv.searchArxiv(
            `ti:"${candidate}"`, fetch, deps.config.arxiv.minIntervalMs || 0);
          const { best, confidence, source } = deps.arxiv.pickBest(candidate, entries,
            { threshold: deps.config.arxiv.titleSimilarityThreshold });
          if (best && source === 'arxiv') {
            Object.assign(store.papers[id], {
              title: best.title, authors: best.authors, abstract: best.summary,
              arxivId: deps.arxiv.extractArxivId(best), arxivUrl: best.id,
              primaryCategory: best.primaryCategory, metaSource: 'arxiv', metaConfidence: confidence,
            });
          }
        } catch (e) { log('arxiv error', id, e.message); }
      }

      // 3) AI 总结 + 标签
      setStatus(id, 'summarizing');
      const obj = await deps.ai.summarize({
        title: store.papers[id].title, abstract: store.papers[id].abstract,
        fulltext: text, config: deps.config,
      });
      if (obj) {
        store.papers[id].summary = deps.ai.buildSummaryMarkdown(obj);
        store.papers[id].summaryModel = deps.config.ai.model;
        store.papers[id].summaryAt = Date.now();
        if (Array.isArray(obj.tags)) {
          store.papers[id].tags = obj.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
          deps.mergeTags(store, store.papers[id].tags);
        }
        if (!store.papers[id].title && obj.metadata) {
          store.papers[id].title = obj.metadata.title || p.filename.replace(/\.pdf$/i, '');
          store.papers[id].authors = obj.metadata.authors || [];
          store.papers[id].year = obj.metadata.year || null;
          store.papers[id].metaSource = store.papers[id].metaSource || 'ai-fallback';
        }
      }
      store.papers[id].status = 'ready';
      store.papers[id].error = null;
    } catch (e) {
      store.papers[id].status = 'error';
      store.papers[id].error = e.message;
      log('pipeline error', id, e.message);
    } finally {
      store.papers[id].updatedAt = Date.now();
      await deps.saveStore(storePath, store);
    }
  }

  async function scan() {
    log('scanning', papersDir);
    const items = await scanDir(papersDir);
    const fp = await fingerprintAll(items);
    const { added, changed, missing } = diffPapers(store.papers, fp);
    for (const s of added) {
      store.papers[s.id] = {
        id: s.id, filename: s.filename, filepath: s.filepath,
        fileMtime: s.mtime, fileSize: s.size, addedAt: Date.now(),
        title: '', authors: [], year: null, abstract: '',
        arxivId: null, arxivUrl: null, primaryCategory: null,
        metaSource: null, metaConfidence: 0,
        fulltextChars: 0, fulltextPath: null,
        summary: '', summaryModel: null, summaryAt: null, tags: [],
        notes: '', starred: false, readStatus: 'unread',
        status: 'pending', error: null, updatedAt: Date.now(),
      };
    }
    for (const s of changed) {
      store.papers[s.id].status = 'pending';
      store.papers[s.id].fileSize = s.size;
    }
    for (const m of missing) store.papers[m.id].status = 'missing';
    await deps.saveStore(storePath, store);
    enqueue([...added, ...changed].map((s) => s.id));
    return { added: added.length, changed: changed.length, missing: missing.length };
  }

  function start() {
    scan().catch((e) => log('initial scan error', e.message));
    if (scanIntervalMs > 0) {
      timer = setInterval(() => scan().catch((e) => log('scan error', e.message)), scanIntervalMs);
    }
  }
  function stop() { if (timer) clearInterval(timer); }

  return { scan, enqueue, start, stop, processOne };
}

module.exports = { scanDir, fingerprintAll, diffPapers, createScanner };
