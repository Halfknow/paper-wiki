const fsp = require('fs/promises');
const path = require('path');
const { sha1OfFile, log, sleep, parseArxivUrl, buildPaperFilename } = require('../core/util');
const { splitMarkdownToCards } = require('../core/notes');

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

/** 创建扫描器：负责增量扫描 + 串行处理流水线
 *  onEnqueue（可选）：多空间模式下，子扫描器的 scan() 发现新论文后调 enqueue；
 *    传 onEnqueue 时改为把它转交给多空间扫描器的共享队列（而非本子扫描器的内部队列，否则无人 pump）。
 *    单空间模式（不传）维持原行为：推本扫描器内部 queue 并 pump。 */
function createScanner({ store, papersDir, textStore, deps, scanIntervalMs, onEnqueue }) {
  const queue = [];
  let processing = false;
  let timer = null;
  let currentIntervalMs = scanIntervalMs; // 可热改：reschedule() 在设置面板改扫描间隔后重置定时器
  let inFlight = null; // 当前 processOne 的 Promise，供 drain() 等待，保证关停时不丢「正在写盘的那一篇」
  let lastFuse = null; // 上次 scan 的 missing 熔断状态（null=正常），/api/health 经 getFuseState 暴露

  function enqueue(ids) {
    if (onEnqueue) {
      // 多空间子扫描器模式：转交共享队列（子扫描器自身不被 start，内部 queue 无人 pump）
      onEnqueue(ids);
      return;
    }
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
      await textStore.save(id, text || '');
      store.papers[id].fulltextChars = (text || '').length;
      store.papers[id].fulltextPath = null; // v3：全文入 PG paper_texts，路径字段废弃

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

      // 5) 自动抽取概念：复用已提取的全文，增量抽取并追加到全局概念库 + p.conceptIds。
      //    容错：失败不影响入库（概念是附加价值，不阻塞 ready）。
      try {
        const existingTerms = (store.concepts || []).map((c) => c.term);
        const items = await deps.ai.extractConcepts({
          title: store.papers[id].title,
          abstract: store.papers[id].abstract,
          fulltext: text,
          existingTerms,
          config: effConfig,
        });
        const newIds = deps.mergeConcepts(store, items || [], id);
        if (newIds.length) {
          store.papers[id].conceptIds = [...new Set([...(store.papers[id].conceptIds || []), ...newIds])];
          log('concepts extracted', id, '+', newIds.length);
        }
      } catch (e) {
        log('concepts extract failed', id, e.message);
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
        chat: [],
        updatedAt: Date.now(),
      };
    }
    for (const s of changed) {
      store.papers[s.id].status = 'pending';
      store.papers[s.id].fileSize = s.size;
      // 文件可能被移动/改名后重现（rebind 自愈路径）：同步 filename/filepath 指向当前实际位置
      store.papers[s.id].filename = s.filename;
      store.papers[s.id].filepath = s.filepath;
    }
    // missing 熔断：大面积同时缺失（>5 且 >50%）通常是目录挂载失效/被清空（Docker bind mount 掉了），
    // 此时翻转全库状态弊大于利——本轮不动任何状态，只告警 + 暴露 fuse 状态（/api/health 可见）。
    const totalPapers = Object.keys(store.papers).length;
    const missingFuse = missing.length > 5 && missing.length > totalPapers * 0.5;
    if (missingFuse) {
      lastFuse = { at: Date.now(), missing: missing.length, total: totalPapers, papersDir };
      log(`[scan] missing 熔断：${missing.length}/${totalPapers} 篇同时缺失，疑似目录挂载失效，本轮不翻转状态`);
    } else {
      lastFuse = null;
      for (const m of missing) store.papers[m.id].status = 'missing';
    }
    // 中间态自愈：processOne 在写完 summary+tags 后、跑到 `status='ready'`（见下方 processOne）
    // 之前若进程被中断，store 会残留中间态（pending/parsing/enriching/summarizing）。
    // 重启后 diffPapers 不把未变文件当 changed，这些论文就永远停在中间态（前端圆点不变绿）。
    // 自愈规则：有实质 summary（>30 字，过滤占位）+ 有 summaryAt → 翻成 ready。
    // 空总结的不动（那才是真没处理好，需要重新入队）。
    const STALE_STATUSES = ['pending', 'parsing', 'enriching', 'summarizing'];
    let healed = 0;
    for (const p of Object.values(store.papers)) {
      if (!p || !STALE_STATUSES.includes(p.status)) continue;
      if (!p.summaryAt) continue;
      if (String(p.summary || '').trim().length < 30) continue;
      p.status = 'ready';
      p.error = null;
      healed++;
    }
    if (healed > 0) log(`[scan] 中间态自愈：${healed} 篇已有完整内容但 status 卡在中间态，已修正为 ready`);
    await deps.saveStore(store);
    enqueue([...added, ...changed].map((s) => s.id));
    return { added: added.length, changed: changed.length, missing: missing.length, missingFuse, healed };
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
    let added = 0;
    let processed = 0;
    for (const id of ids || []) {
      const p = store.papers[id];
      if (!p) continue;
      const text = (await textStore.load(id).catch(() => null)) || '';
      if (!text) {
        log('concept extract: no text', id);
        continue;
      }
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
    const effConfig = deps.ai.applySettingsOverride
      ? deps.ai.applySettingsOverride(deps.config, store.settings)
      : deps.config;
    const tagsPrompt = (store.settings && store.settings.tagsPrompt) || deps.config.tagsPrompt || undefined;
    let processed = 0;
    for (const id of ids || []) {
      const p = store.papers[id];
      if (!p) continue;
      const text = (await textStore.load(id).catch(() => null)) || '';
      if (!text) {
        log('retag: no text', id);
        continue;
      }
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

  /** 论文聊天：读全文 → 注入上下文+历史 → 调 AI → 追加 user/assistant 两条消息到 p.chat 并落盘。
   *  全文缺失（未解析）时退化为仅摘要，仍可问答。返回 { reply, chat }。
   *  opts.onToken(text)：流式逐 token 回调（透传给 ai.chatPaper → callChatStream）；
   *    回调返回 false 表示客户端已断开/中止，立即停止累积（配合 api 层 req.on('close')）。
   *  opts.regenerate=true：重新生成最后一轮——丢弃末尾的 user+assistant 对（按 ts 配对），
   *    取该 user 的 message 作为本次 message 重新回答。落盘时旧对被丢弃、新对用新 ts 写入。
   *  opts.extraIds（v2.6 @ 引用）：用户 @ 引用的其它论文 id 数组；读取每篇全文（缺失则仅摘要），
   *    组装成 extraPapers 透传给 ai.chatPaper。落盘时记到 user 消息 extraIds 字段（回显 chip 用）。
   *    regenerate 时若 opts.extraIds 未显式传入，则回退取末尾被丢弃 user 的 extraIds（保持引用一致）。 */
  async function chatPaper(id, message, opts = {}) {
    const p = store.papers[id];
    if (!p) return { reply: '', chat: [] };
    const effConfig = deps.ai.applySettingsOverride
      ? deps.ai.applySettingsOverride(deps.config, store.settings)
      : deps.config;
    const systemPrompt =
      (store.settings && store.settings.chatSystemPrompt) || deps.config.chatSystemPrompt || undefined;
    // 读取单篇论文全文的辅助（缺失返回空串，降级仅摘要）
    const readFull = async (pid) => (await textStore.load(pid).catch(() => null)) || '';
    const text = await readFull(id); // 未解析时空串：退化为仅摘要
    // 重新生成：先弹出最后一轮（user+assistant 对），取其 user message 作为本次问题。
    // history 也随之缩短（不含被丢弃的这轮），等于「回到上一次提问前」的状态重新答。
    let chatArr = Array.isArray(p.chat) ? p.chat.slice() : [];
    let regenExtraIds = null; // 重新生成时回退取被丢弃 user 的 extraIds
    if (opts.regenerate) {
      // 从末尾找最后一轮：assistant 在末尾、其前是 user（成对）。丢这对，message 用该 user 内容。
      if (
        chatArr.length >= 2 &&
        chatArr[chatArr.length - 1].role === 'assistant' &&
        chatArr[chatArr.length - 2].role === 'user'
      ) {
        const lastUser = chatArr[chatArr.length - 2];
        message = String(lastUser.content || '').trim() || message;
        regenExtraIds = Array.isArray(lastUser.extraIds) ? lastUser.extraIds : null;
        chatArr = chatArr.slice(0, -2);
      }
    }
    const history = chatArr.map((m) => ({ role: m.role, content: m.content }));
    // @ 引用论文：白名单（必须存在于 store），regenerate 时回退末尾 user 的 extraIds
    const rawExtraIds = Array.isArray(opts.extraIds) && opts.extraIds.length ? opts.extraIds : regenExtraIds || [];
    const extraIds = rawExtraIds.filter((eid) => eid && eid !== id && store.papers[eid]);
    const extraPapers = extraIds.length
      ? await Promise.all(
          extraIds.map(async (eid) => {
            const ep = store.papers[eid];
            return { title: ep.title, abstract: ep.abstract, fulltext: await readFull(eid) };
          }),
        )
      : undefined;
    // 流式：onToken 透传（含 kind: reasoning/content）；包裹一层让回调返回 false 时中断流。
    let aborted = false;
    const onToken =
      typeof opts.onToken === 'function'
        ? (t, kind) => {
            const r = opts.onToken(t, kind);
            if (r === false) aborted = true;
            return r;
          }
        : undefined;
    const reply = await deps.ai.chatPaper({
      title: p.title,
      abstract: p.abstract,
      fulltext: text,
      history,
      message,
      config: effConfig,
      systemPrompt,
      onToken,
      chatParams: opts.chatParams, // 透传前端调节的模型参数（temperature/thinking/topP/maxTokens/model）
      extraPapers,
      images: Array.isArray(opts.images) && opts.images.length ? opts.images : undefined, // Phase 3 视觉问答附图
    });
    if (aborted) {
      // 客户端已断开：不落盘未完成的回复。重新生成场景下，被丢弃的旧轮也不落盘（保持原样）。
      return { reply, chat: p.chat || [], aborted: true };
    }
    const ts = Date.now();
    // 重新生成：用缩短后的 chatArr 作为基底（已丢弃旧轮）；正常：用原 p.chat。
    p.chat = opts.regenerate ? chatArr : Array.isArray(p.chat) ? p.chat : [];
    // user 消息：仅当引用了论文时才挂 extraIds 字段（向后兼容，旧消息无此字段）
    const userMsg = { role: 'user', content: message, ts };
    if (extraIds.length) userMsg.extraIds = extraIds;
    // Phase 3：附图缩略图（dataURL）持久化到 user 消息，供回显（限制大小，避免 papers.json 膨胀）
    if (Array.isArray(opts.images) && opts.images.length) userMsg.images = opts.images.slice(0, 4);
    p.chat.push(userMsg);
    // assistant 消息：记录所用模型（Phase 2 模型徽章），仅在有显式覆盖时挂 model 字段
    const assistantMsg = { role: 'assistant', content: reply, ts };
    const usedModel = opts.chatParams && opts.chatParams.model;
    if (usedModel) assistantMsg.model = usedModel;
    p.chat.push(assistantMsg);
    p.updatedAt = ts;
    await deps.saveStore(store);
    return { reply, chat: p.chat };
  }

  /** 生成笔记骨架卡（AI 笔记）：读全文 → AI 六段式 Markdown → 按 ## 拆成 skeleton 卡。
   *  不落盘（由调用方决定插入位置后 PATCH noteCards），只返回 cards。
   *  提示词三级回退：store.settings.notesPrompt > config.notesPrompt > DEFAULT_NOTES_PROMPT（同 summaryPrompt 模式）。 */
  async function generateNoteCards(id) {
    const p = store.papers[id];
    if (!p) return { cards: [] };
    const effConfig = deps.ai.applySettingsOverride
      ? deps.ai.applySettingsOverride(deps.config, store.settings)
      : deps.config;
    const prompt = (store.settings && store.settings.notesPrompt) || deps.config.notesPrompt || undefined;
    const text = (await textStore.load(id).catch(() => null)) || '';
    if (!text && !p.abstract) return { cards: [], error: '全文未解析且无摘要，无法生成' };
    const md = await deps.ai.generateNotes({ title: p.title, abstract: p.abstract, fulltext: text, config: effConfig, prompt });
    // 骨架语义要求分段输出：无 ## 标题说明模型没按格式来（整段文本塞成一张卡体验很差），报 error 请重试
    if (!/^##\s+/m.test(md || '')) return { cards: [], error: '模型未按骨架格式输出，请重试' };
    const cards = splitMarkdownToCards(md || '', 'skeleton');
    if (!cards.length) return { cards: [], error: '模型返回为空，请重试' };
    return { cards };
  }

  return {
    scan,
    enqueue,
    start,
    stop,
    reschedule,
    drain,
    processOne,
    extractConcepts,
    retagPapers,
    chatPaper,
    generateNoteCards,
    getFuseState: () => lastFuse,
  };
}

/**
 * 多空间扫描器：多个空间共享**单一串行队列**（遵守陷阱：串行防压垮本地 AI / 触发 arXiv 限速）。
 *
 * 设计：
 *   - 每个空间创建一个「子扫描器」（复用 createScanner 的完整流水线闭包：processOne/extractConcepts/
 *     retagPapers/chatPaper/scanDir），子扫描器的 store/storePath/papersDir 各自指向该空间。
 *   - 子扫描器自带的内部队列/pump **被绕过**——所有 enqueue/scan 入队都进本多空间扫描器的共享队列。
 *     共享队列项 = {spaceId, id}，pump 串行 await 对应子扫描器的 processOne，保证全局串行。
 *   - 单一定时器：间隔 = min(所有 scheduled 空间 scanInterval)；每次 tick 调 scan()，内部按 per-space
 *     lastScanAt 判定哪些空间到点（遵守陷阱 20：reschedule 热改定时器）。
 *
 * @param {object} manager 空间管理器（lib/spaces.js createSpaceManager 返回值）
 * @param {object} deps 共享依赖：{ parser, arxiv, ai, config(=globalConfig), rateLimitArxiv,
 *   mergeTags, mergeTopics, mergeConcepts }。注意：不传 saveStore——每空间的 saveStore 由 manager 注入。
 */
function createMultiSpaceScanner({ manager, deps }) {
  // 共享串行队列（跨所有空间）
  const queue = [];
  let processing = false;
  let inFlight = null; // 当前 processOne 的 Promise，供 drain() 等待
  let timer = null;

  // 每空间的子扫描器缓存：spaceId -> { scanner, saveStore }
  const subScanners = new Map();

  /** 取/建某空间的子扫描器（含该空间的 store/storePath/papersDir + 空间绑定的 saveStore 单参闭包）。
   *  manager.getSpaceStore 异步加载，所以本函数是 async。store 用 manager 缓存的内存引用（与 api 共享）。 */
  async function subFor(spaceId) {
    if (subScanners.has(spaceId)) return subScanners.get(spaceId);
    const space = manager.getSpace(spaceId);
    if (!space) return null;
    const store = await manager.getSpaceStore(spaceId);
    const papersDir = manager.resolveSpacePapersDir(spaceId);
    const saveStore = manager.saveStoreBinder(spaceId); // 单参闭包 (store)=>saveStore，遵守陷阱 1
    const textStore = manager.textStoreBinder(spaceId); // 全文 {load,save,remove} → PG paper_texts
    const subDeps = {
      ...deps,
      saveStore,
      // config 用全局 config（applySettingsOverride 在 processOne 内基于各空间 store.settings 合成）
      config: deps.config,
    };
    const scanner = createScanner({
      store,
      papersDir,
      textStore,
      deps: subDeps,
      scanIntervalMs: 0,
      // 子扫描器 scan() 发现新论文后，转交到多空间共享队列（子扫描器自身不被 start，内部 queue 无人 pump）
      onEnqueue: (ids) => enqueue(spaceId, ids),
    });
    const entry = { scanner, store, saveStore };
    subScanners.set(spaceId, entry);
    return entry;
  }

  /** 空间被删/改名后需失效子扫描器缓存（store 引用可能已变） */
  function invalidate(spaceId) {
    subScanners.delete(spaceId);
  }

  /** 入队 {spaceId, id} 到共享队列，触发 pump */
  function enqueue(spaceId, ids) {
    for (const id of ids || []) queue.push({ spaceId, id });
    pump();
  }

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const { spaceId, id } = queue.shift();
        try {
          const sub = await subFor(spaceId);
          if (!sub) continue;
          inFlight = sub.scanner.processOne(id);
          await inFlight;
        } catch (e) {
          log('process error', spaceId, id, e.message);
        } finally {
          inFlight = null;
        }
      }
    } finally {
      processing = false;
    }
  }

  /** 扫描：遍历所有空间，按 per-space lastScanAt 判定到点（dueOnly=true）或强制全扫（dueOnly=false）。
   *  返回各空间的扫描结果聚合。 */
  async function scan({ dueOnly = true } = {}) {
    const results = [];
    const now = Date.now();
    for (const space of manager.listSpaces()) {
      // 定时扫描时跳过未到点的空间（per-space 节奏）；手动 scan() 时 dueOnly=false 全扫
      if (dueOnly && Number(space.scanIntervalMinutes) > 0) {
        const dueAt = Number(space.lastScanAt) + Number(space.scanIntervalMinutes) * 60 * 1000;
        if (now < dueAt) continue;
      }
      const sub = await subFor(space.id);
      if (!sub) continue;
      try {
        const r = await sub.scanner.scan(); // 子扫描器 scan 只读自己的 papersDir + 自己的 store
        await manager.markScanned(space.id);
        results.push({ spaceId: space.id, ...r });
      } catch (e) {
        log('scan error', space.id, e.message);
        results.push({ spaceId: space.id, error: e.message });
      }
    }
    return results;
  }

  /** 手动扫描单个空间（POST /api/scan?space=id 或无参=active） */
  async function scanSpace(spaceId) {
    const sub = await subFor(spaceId);
    if (!sub) return { error: 'space not found' };
    const r = await sub.scanner.scan();
    await manager.markScanned(spaceId);
    return r;
  }

  function start() {
    scan({ dueOnly: false }).catch((e) => log('initial multi-space scan error', e.message));
    rescheduleTimer();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 重算定时器间隔 = min(所有 scheduled 空间 scanInterval)；每次 tick scan({dueOnly:true})。
   *  reschedule(spaceId, minutes) 改某空间间隔后也调本函数重算。 */
  function rescheduleTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const ms = manager.minScheduledIntervalMs();
    if (ms > 0) {
      timer = setInterval(() => scan({ dueOnly: true }).catch((e) => log('scheduled scan error', e.message)), ms);
    }
  }

  /** 热改某空间扫描间隔：持久化到注册表 + 重算定时器（遵守陷阱 20）。 */
  async function reschedule(spaceId, minutes) {
    await manager.setScanInterval(spaceId, minutes);
    rescheduleTimer();
  }

  function drain(timeoutMs = 5000) {
    return Promise.race([
      (async () => {
        while (inFlight) await inFlight.catch(() => {});
      })(),
      sleep(timeoutMs),
    ]);
  }

  // 透传到子扫描器的方法（加 spaceId 首参），api 层调用约定
  async function extractConcepts(spaceId, ids) {
    const sub = await subFor(spaceId);
    if (!sub) return { processed: 0, added: 0 };
    return sub.scanner.extractConcepts(ids);
  }
  async function retagPapers(spaceId, ids) {
    const sub = await subFor(spaceId);
    if (!sub) return { processed: 0 };
    return sub.scanner.retagPapers(ids);
  }
  async function chatPaper(spaceId, id, message, opts = {}) {
    const sub = await subFor(spaceId);
    if (!sub) return { reply: '', chat: [] };
    return sub.scanner.chatPaper(id, message, opts);
  }
  async function generateNoteCards(spaceId, id) {
    const sub = await subFor(spaceId);
    if (!sub) return { cards: [], error: 'space not found' };
    return sub.scanner.generateNoteCards(id);
  }

  /** 各空间 missing 熔断状态聚合：{spaceId: fuseInfo}（全部正常时为 {}） */
  function getFuseState() {
    const out = {};
    for (const [spaceId, sub] of subScanners) {
      const f = sub.scanner.getFuseState && sub.scanner.getFuseState();
      if (f) out[spaceId] = f;
    }
    return out;
  }

  return {
    scan,
    scanSpace,
    enqueue,
    start,
    stop,
    reschedule,
    rescheduleTimer,
    drain,
    extractConcepts,
    retagPapers,
    chatPaper,
    generateNoteCards,
    invalidate,
    getFuseState,
    _subFor: subFor,
  };
}

module.exports = { scanDir, fingerprintAll, diffPapers, createScanner, createMultiSpaceScanner };
