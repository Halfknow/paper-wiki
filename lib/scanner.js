const fsp = require('fs/promises');
const path = require('path');
const { sha1OfFile, log, sleep, parseArxivUrl, buildPaperFilename } = require('./util');

/** 扫描目录下所有 PDF 文件信息 */
async function scanDir(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
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

/** 对每个 PDF 计算 sha1(前16位) 作为稳定 id；同 id（内容重复的副本）只保留一条，
 *  避免重复文件互相覆盖已 enrich 的记录（历史 bug：同内容不同名 → 同 id → scan 覆盖丢数据）。 */
async function fingerprintAll(items) {
  const byId = new Map();
  for (const it of items) {
    const id = (await sha1OfFile(it.filepath)).slice(0, 16);
    const entry = { ...it, id };
    if (!byId.has(id)) {
      byId.set(id, entry);
    } else {
      // 同 id 重复：记录但不入扫描集（去重），日志提示用户可清理重复文件。
      const prev = byId.get(id);
      log('duplicate pdf (same content, ignored):', it.filename, '==', prev.filename);
    }
  }
  return [...byId.values()];
}

/** 对比现有 papers 与扫描指纹，算 added/changed/missing */
function diffPapers(existingPapers, scanned) {
  const scannedIds = new Set(scanned.map((s) => s.id));
  const added = [],
    changed = [];
  for (const s of scanned) {
    const cur = existingPapers[s.id];
    if (!cur) added.push(s);
    else if (cur.fileSize !== s.size || cur.status === 'missing') changed.push(s);
  }
  const missing = Object.values(existingPapers).filter((p) => !scannedIds.has(p.id) && p.status !== 'missing');
  return { added, changed, missing };
}

async function fileExists(fp) {
  try {
    await fsp.access(fp);
    return true;
  } catch {
    return false;
  }
}

/** 创建扫描器：负责增量扫描 + 串行处理流水线 */
function createScanner({ store, storePath, papersDir, deps, scanIntervalMs }) {
  const queue = [];
  let processing = false;
  let timer = null;
  let currentIntervalMs = scanIntervalMs; // 可热改：reschedule() 在设置面板改扫描间隔后重置定时器
  let inFlight = null; // 当前 processOne 的 Promise，供 drain() 等待，保证关停时不丢「正在写盘的那一篇」

  function enqueue(ids) {
    for (const id of ids) queue.push(id);
    pump();
  }

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try {
          inFlight = processOne(id);
          await inFlight;
        } catch (e) {
          log('process error', id, e.message);
        } finally {
          inFlight = null;
        }
      }
    } finally {
      processing = false;
    }
  }

  function setStatus(id, status) {
    if (store.papers[id]) store.papers[id].status = status;
  }

  async function processOne(id) {
    const p = store.papers[id];
    if (!p) return;
    const textDir = path.join(path.dirname(storePath), 'text');
    // 运行时配置覆盖：store.settings 覆盖 config（设置面板热改，无需重启）。
    // arxiv / AI / 提示词三段统一基于此 effConfig，使设置改动即时生效。
    const effConfig = deps.ai.applySettingsOverride
      ? deps.ai.applySettingsOverride(deps.config, store.settings)
      : deps.config;
    try {
      // 0) 文件存在性：孤立条目（PDF 已被移走/删除）直接标 missing，不进 extractText（否则 ENOENT）。
      if (!p.filepath || !(await fileExists(p.filepath))) {
        store.papers[id].status = 'missing';
        store.papers[id].error = 'PDF 文件缺失（不在 papers/ 目录），无法处理';
        return;
      }
      // 1) 解析全文
      setStatus(id, 'parsing');
      const { text } = await deps.parser.extractText(p.filepath);
      const textPath = path.join(textDir, `${id}.txt`);
      await fsp.mkdir(textDir, { recursive: true });
      await fsp.writeFile(textPath, text || '', 'utf8');
      store.papers[id].fulltextChars = (text || '').length;
      store.papers[id].fulltextPath = textPath;

      // 2) arXiv 元数据（读 effConfig.arxiv：enabled / minIntervalMs / titleSimilarityThreshold 可热改）
      if (effConfig.arxiv && effConfig.arxiv.enabled !== false) {
        setStatus(id, 'enriching');
        try {
          await deps.rateLimitArxiv();
          // 已知 arxivId（URL/发现导入）或文件名本身就是裸 arXiv ID（2401.12345.pdf）→ 用 id: 精确查，
          // 跳过 cleanFilenameToTitle 猜标题（裸ID当标题搜必失败，正是历史上元数据为空的根因）。
          // 其余文件走原 ti: 搜索 + pickBest。
          let knownArxivId = p.arxivId;
          if (!knownArxivId) {
            const fromName = parseArxivUrl(String(p.filename || '').replace(/\.pdf$/i, ''));
            if (fromName) knownArxivId = fromName.arxivId;
          }
          if (knownArxivId) {
            const { entries } = await deps.arxiv.searchArxiv(`id:${knownArxivId}`, fetch, {
              minIntervalMs: effConfig.arxiv.minIntervalMs || 0,
              timeoutMs: effConfig.arxiv.timeoutMs ?? 15000,
              maxRetries: effConfig.arxiv.maxRetries ?? 2,
            });
            if (entries && entries[0]) {
              const best = entries[0];
              Object.assign(store.papers[id], {
                title: best.title,
                authors: best.authors,
                abstract: best.summary,
                year: best.published ? String(best.published).slice(0, 4) : store.papers[id].year,
                arxivId: deps.arxiv.extractArxivId(best) || knownArxivId,
                arxivUrl: best.id,
                primaryCategory: best.primaryCategory,
                metaSource: 'arxiv',
                metaConfidence: 1,
              });
            }
          } else {
            const candidate = deps.arxiv.cleanFilenameToTitle(p.filename);
            const { entries } = await deps.arxiv.searchArxiv(`ti:"${candidate}"`, fetch, {
              minIntervalMs: effConfig.arxiv.minIntervalMs || 0,
              timeoutMs: effConfig.arxiv.timeoutMs ?? 15000,
              maxRetries: effConfig.arxiv.maxRetries ?? 2,
            });
            const { best, confidence, source } = deps.arxiv.pickBest(candidate, entries, {
              threshold: effConfig.arxiv.titleSimilarityThreshold,
            });
            if (best && source === 'arxiv') {
              Object.assign(store.papers[id], {
                title: best.title,
                authors: best.authors,
                abstract: best.summary,
                year: best.published ? String(best.published).slice(0, 4) : store.papers[id].year,
                arxivId: deps.arxiv.extractArxivId(best),
                arxivUrl: best.id,
                primaryCategory: best.primaryCategory,
                metaSource: 'arxiv',
                metaConfidence: confidence,
              });
            }
          }
        } catch (e) {
          log('arxiv error', id, e.message);
        }
      }

      // 3) AI 总结 + 标签 + 主题（两次独立调用，互不阻塞）
      //    v2.4 重构：总结走自由 Markdown（jsonMode:false），标签/主题走强制 JSON。
      //    历史上二者在同一次 JSON 调用里返回，用户自定义总结提示词（要 Markdown）与代码
      //    的 json_object 硬约束冲突 → 空对象 → 空总结 + 空标签。拆开后互不污染。
      setStatus(id, 'summarizing');

      // effConfig 已在 processOne 顶部基于 store.settings 计算（含 ai/arxiv/discover 覆盖）

      // 提示词优先级（各自独立三级）：store.settings > config > 内置默认
      const summaryPrompt = (store.settings && store.settings.summaryPrompt) || deps.config.summaryPrompt || undefined;
      const tagsPrompt = (store.settings && store.settings.tagsPrompt) || deps.config.tagsPrompt || undefined;

      // ---- 调用 1：总结（自由 Markdown，容许失败）----
      let summaryMd = null;
      try {
        summaryMd = await deps.ai.summarize({
          title: store.papers[id].title,
          abstract: store.papers[id].abstract,
          fulltext: text,
          config: effConfig,
          prompt: summaryPrompt,
        });
      } catch (e) {
        log('summary call failed', id, e.message);
      }
      const hasSummary = summaryMd && String(summaryMd).trim();
      if (hasSummary) {
        store.papers[id].summary = deps.ai.buildSummaryMarkdown(summaryMd);
        store.papers[id].summaryModel = effConfig.ai.model;
        store.papers[id].summaryAt = Date.now();
      } else {
        // 失败/空总结：存可重试占位，清空 summaryAt/Model 便于「重新总结」识别与重跑
        store.papers[id].summary = deps.ai.buildSummaryMarkdown(null);
        store.papers[id].summaryModel = null;
        store.papers[id].summaryAt = null;
        log('empty summary', id, '(model returned no content)');
      }

      // ---- 调用 2：标签/主题（独立调用，失败不影响已成功的总结）----
      try {
        const tt = await deps.ai.extractTagsTopics({
          title: store.papers[id].title,
          abstract: store.papers[id].abstract,
          fulltext: text,
          config: effConfig,
          prompt: tagsPrompt,
        });
        if (tt && Array.isArray(tt.tags)) {
          store.papers[id].tags = tt.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
          deps.mergeTags(store, store.papers[id].tags);
        }
        if (tt && Array.isArray(tt.topics)) {
          store.papers[id].topics = tt.topics
            .map((t) => String(t).trim())
            .filter(Boolean)
            .slice(0, 3);
          if (deps.mergeTopics) deps.mergeTopics(store, store.papers[id].topics);
        }
        // metadata 兜底：仅当 arxiv 没补上标题时，用 AI 的 metadata 补
        if (!store.papers[id].title && tt && tt.metadata) {
          store.papers[id].title = tt.metadata.title || p.filename.replace(/\.pdf$/i, '');
          store.papers[id].authors = tt.metadata.authors || [];
          store.papers[id].year = tt.metadata.year || null;
          store.papers[id].metaSource = store.papers[id].metaSource || 'ai-fallback';
        }
      } catch (e) {
        log('tags/topics call failed', id, e.message);
      }

      // 4) 规范化文件名：仅对「裸 arXiv ID 命名」的文件（发现/URL 导入落地名）改成
      //    「作者 等 - 年份 - 标题.pdf」。id 基于内容 sha1，重命名不影响 id/全文/概念/批注。
      //    用户自己起的描述性文件名（非裸ID）一律保留不动。
      try {
        const cur = store.papers[id];
        const isBareId = !!parseArxivUrl(String(cur.filename || '').replace(/\.pdf$/i, ''));
        if (isBareId && cur.title) {
          let desired = buildPaperFilename({
            authors: cur.authors,
            year: cur.year,
            title: cur.title,
            arxivId: cur.arxivId,
          });
          if (desired && desired !== cur.filename) {
            const dir = path.dirname(cur.filepath);
            let target = path.join(dir, desired);
            const same = (a, b) => path.resolve(a) === path.resolve(b);
            if ((await fileExists(target)) && !same(target, cur.filepath)) {
              desired = desired.replace(/\.pdf$/i, ` (${cur.arxivId || id}).pdf`); // 撞名 → 加 arxivId 区分
              target = path.join(dir, desired);
            }
            if (same(target, cur.filepath) || !(await fileExists(target))) {
              await fsp.rename(cur.filepath, target);
              cur.filename = desired;
              cur.filepath = target;
            }
          }
        }
      } catch (e) {
        log('rename error', id, e.message); // 改名失败不影响入库
      }

      store.papers[id].status = 'ready';
      store.papers[id].error = null;
    } catch (e) {
      // extractText 等步骤的 ENOENT = 文件缺失，归为 missing（而非笼统 error），与扫描缺失检测语义一致。
      const isMissing = e && (e.code === 'ENOENT' || /ENOENT/i.test(e.message || ''));
      store.papers[id].status = isMissing ? 'missing' : 'error';
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
      // 防御：已存在且非空的记录绝不用空初始化覆盖（防止任何路径的 id 冲突丢数据）。
      const existing = store.papers[s.id];
      if (existing && (existing.title || existing.summary || existing.tags.length || existing.status === 'ready')) {
        log('skip overwrite enriched record on add:', s.id, '(', s.filename, ')');
        continue;
      }
      store.papers[s.id] = {
        id: s.id,
        filename: s.filename,
        filepath: s.filepath,
        fileMtime: s.mtime,
        fileSize: s.size,
        addedAt: Date.now(),
        title: '',
        authors: [],
        year: null,
        abstract: '',
        arxivId: null,
        arxivUrl: null,
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
        rating: 0,
        readStatus: 'unread',
        status: 'pending',
        error: null,
        updatedAt: Date.now(),
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
    if (currentIntervalMs > 0) {
      timer = setInterval(() => scan().catch((e) => log('scan error', e.message)), currentIntervalMs);
    }
  }
  function stop() {
    if (timer) clearInterval(timer);
  }

  /** 热改定时扫描间隔（分钟）。设置面板改 scanIntervalMinutes 后调用，立即重置定时器；
   *  minutes<=0 关闭定时扫描（仅手动 / 导入触发）。不立即跑一次扫描（与 start 的首扫区分）。 */
  function reschedule(minutes) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    currentIntervalMs = (Number(minutes) || 0) * 60 * 1000;
    if (currentIntervalMs > 0) {
      timer = setInterval(() => scan().catch((e) => log('scan error', e.message)), currentIntervalMs);
    }
  }

  /** 等待「当前正在处理的那一篇」落盘，最多等 timeoutMs。
   *  不排空整个队列（队列可能几十篇，等不完），只保证关停时正在写盘的那篇不丢。 */
  function drain(timeoutMs = 5000) {
    return Promise.race([
      (async () => {
        while (inFlight) await inFlight.catch(() => {});
      })(),
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
      try {
        text = await fsp.readFile(path.join(textDir, `${id}.txt`), 'utf8');
      } catch (e) {
        log('concept extract: no text', id, e.message);
        continue;
      }
      if (!text) continue;
      try {
        const existingTerms = (store.concepts || []).map((c) => c.term);
        const effConfig = deps.ai.applySettingsOverride
          ? deps.ai.applySettingsOverride(deps.config, store.settings)
          : deps.config;
        const items = await deps.ai.extractConcepts({
          title: p.title,
          abstract: p.abstract,
          fulltext: text,
          existingTerms,
          config: effConfig,
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

  /** 重新打标（单篇/批量）：复用已有全文文本调 extractTagsTopics，用新结果覆盖该论文的
   *  tags/topics，然后从所有论文重新聚合字典——多的标签自动入库，少（被所有论文放弃）的自动清除。
   *  与 extractConcepts 同模式：串行调 AI，最后一次性 save。 */
  async function retagPapers(ids) {
    const textDir = path.join(path.dirname(storePath), 'text');
    const effConfig = deps.ai.applySettingsOverride
      ? deps.ai.applySettingsOverride(deps.config, store.settings)
      : deps.config;
    const tagsPrompt = (store.settings && store.settings.tagsPrompt) || deps.config.tagsPrompt || undefined;
    let processed = 0;
    for (const id of ids || []) {
      const p = store.papers[id];
      if (!p) continue;
      let text = '';
      try {
        text = await fsp.readFile(path.join(textDir, `${id}.txt`), 'utf8');
      } catch (e) {
        log('retag: no text', id, e.message);
        continue;
      }
      if (!text) continue;
      try {
        const tt = await deps.ai.extractTagsTopics({
          title: p.title,
          abstract: p.abstract,
          fulltext: text,
          config: effConfig,
          prompt: tagsPrompt,
        });
        if (tt && Array.isArray(tt.tags)) {
          p.tags = tt.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
        }
        if (tt && Array.isArray(tt.topics)) {
          p.topics = tt.topics.map((t) => String(t).trim()).filter(Boolean);
        }
        p.updatedAt = Date.now();
        processed++;
      } catch (e) {
        log('retag error', id, e.message);
      }
    }
    // 联动：从所有论文重新聚合字典——多的入库，被所有论文放弃的自动清除。
    const tagSet = new Set();
    const topicSet = new Set();
    for (const pp of Object.values(store.papers)) {
      for (const t of pp.tags || []) tagSet.add(t);
      for (const t of pp.topics || []) topicSet.add(t);
    }
    store.tags = [...tagSet].sort();
    store.topics = [...topicSet].sort();
    await deps.saveStore(store);
    return { processed };
  }

  return { scan, enqueue, start, stop, reschedule, drain, processOne, extractConcepts, retagPapers };
}

module.exports = { scanDir, fingerprintAll, diffPapers, createScanner };
