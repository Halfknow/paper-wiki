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
  let inFlight = null; // 当前 processOne 的 Promise，供 drain() 等待，保证关停时不丢「正在写盘的那一篇」

  function enqueue(ids) { for (const id of ids) queue.push(id); pump(); }

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try {
          inFlight = processOne(id);
          await inFlight;
        }
        catch (e) { log('process error', id, e.message); }
        finally { inFlight = null; }
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
            `ti:"${candidate}"`, fetch, {
              minIntervalMs: deps.config.arxiv.minIntervalMs || 0,
              timeoutMs: deps.config.arxiv.timeoutMs ?? 15000,
              maxRetries: deps.config.arxiv.maxRetries ?? 2,
            });
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

      // 3) AI 总结 + 标签 + 主题 + 概念
      setStatus(id, 'summarizing');
      // 提示词优先级：store.settings.summaryPrompt > config.summaryPrompt > 内置默认
      const summaryPrompt = (store.settings && store.settings.summaryPrompt)
        || deps.config.summaryPrompt || undefined;
      const obj = await deps.ai.summarize({
        title: store.papers[id].title, abstract: store.papers[id].abstract,
        fulltext: text, config: deps.config, prompt: summaryPrompt,
      });
      if (obj) {
        store.papers[id].summary = deps.ai.buildSummaryMarkdown(obj);
        store.papers[id].summaryModel = deps.config.ai.model;
        store.papers[id].summaryAt = Date.now();
        if (Array.isArray(obj.tags)) {
          store.papers[id].tags = obj.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
          deps.mergeTags(store, store.papers[id].tags);
        }
        if (Array.isArray(obj.topics)) {
          store.papers[id].topics = obj.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
          if (deps.mergeTopics) deps.mergeTopics(store, store.papers[id].topics);
        }
        if (Array.isArray(obj.concepts) && deps.mergeConcepts) {
          const newIds = deps.mergeConcepts(store, obj.concepts, id);
          if (newIds.length) {
            const set = new Set([...(store.papers[id].conceptIds || []), ...newIds]);
            store.papers[id].conceptIds = [...set];
          }
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
      await deps.saveStore(store);
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
        topics: [], concepts: [], conceptIds: [], folders: [], readProgress: null,
        notes: '', starred: false, readStatus: 'unread',
        status: 'pending', error: null, updatedAt: Date.now(),
      };
    }
    for (const s of changed) {
      store.papers[s.id].status = 'pending';
      store.papers[s.id].fileSize = s.size;
    }
    for (const m of missing) store.papers[m.id].status = 'missing';
    await deps.saveStore(store);
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

  /** 等待「当前正在处理的那一篇」落盘，最多等 timeoutMs。
   *  不排空整个队列（队列可能几十篇，等不完），只保证关停时正在写盘的那篇不丢。 */
  function drain(timeoutMs = 5000) {
    return Promise.race([
      (async () => { while (inFlight) await inFlight.catch(() => {}); })(),
      sleep(timeoutMs),
    ]);
  }

  /**
   * 对一批论文「重新抽取概念」并追加到全局概念清单。
   * 复用已提取的全文（data/text/<id>.txt），按归一化 term 增量去重。
   * 返回 { processed, added }。
   */
  async function extractConcepts(ids) {
    const textDir = path.join(path.dirname(storePath), 'text');
    let added = 0;
    let processed = 0;
    for (const id of ids || []) {
      const p = store.papers[id];
      if (!p) continue;
      let text = '';
      try { text = await fsp.readFile(path.join(textDir, `${id}.txt`), 'utf8'); }
      catch (e) { log('concept extract: no text', id, e.message); continue; }
      if (!text) continue;
      try {
        const existingTerms = (store.concepts || []).map((c) => c.term);
        const items = await deps.ai.extractConcepts({
          title: p.title, abstract: p.abstract, fulltext: text,
          existingTerms, config: deps.config,
        });
        if (items && items.length && deps.mergeConcepts) {
          const newIds = deps.mergeConcepts(store, items, id);
          const set = new Set([...(p.conceptIds || []), ...newIds]);
          p.conceptIds = [...set];
          p.updatedAt = Date.now();
          added += newIds.length;
        }
        processed++;
      } catch (e) {
        log('concept extract error', id, e.message);
      }
    }
    await deps.saveStore(store);
    return { processed, added };
  }

  return { scan, enqueue, start, stop, drain, processOne, extractConcepts };
}

module.exports = { scanDir, fingerprintAll, diffPapers, createScanner };
