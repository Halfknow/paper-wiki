const { extractArxivId } = require('./arxiv');
const { normalizeTitle, titleSimilarity, sleep } = require('../core/util');
const { createLogger } = require('../core/logger');

const logger = createLogger('discover');

const UA = 'PaperWiki/1.0 (local research tool)';
const SEMANTIC_SCHOLAR_BATCH = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const OPENALEX_WORKS = 'https://api.openalex.org/works';

// 复合排序默认权重：相关 > 权威 > 新近。落地用户诉求「最新 + 最权威 + 引用量最高」的融合，
// 而不是单一轴（旧实现按 submittedDate 取候选再按引用量排，二者自相矛盾）。可经 config.discover.weights 覆盖。
const DEFAULT_WEIGHTS = { rel: 0.45, auth: 0.35, rec: 0.2 };

/** 把中文/模糊主题交给 claude -p，转成**结构化检索计划**：多个 arXiv 检索式 + 分类 + 英文关键词。
 *  - claude 不可用（ENOENT/exit 127）/超时/输出非法 → 回退：用 all:"<topic>" 作 query，usedClaude=false。
 *    保证没装 claude 的环境也能用「发现」功能，只是检索质量退化。
 *  - 依赖注入 runClaude（默认本模块的 claude.js），便于测试用假函数替换。
 *
 *  返回 { queries, query, categories, keyterms, note, usedClaude, claudeFailReason }：
 *    queries: 发给 arXiv 的检索式数组（1-3 条，精确 + 宽泛变体）
 *    query: queries[0]，向后兼容旧调用方
 *    categories: arXiv 分类（可空）
 *    keyterms: 英文关键词，用于对返回结果做相关度打分（claude 不给则用主题兜底）
 *    note: 给用户看的一句话说明
 *    usedClaude: 是否真的用了 claude 的输出
 *    claudeFailReason: claude 失败时的原因（not_found/timeout/bad_output/...）
 */
async function buildDiscoveryQuery(topic, opts = {}) {
  const t = String(topic || '').trim();
  const runClaude = opts.runClaude || require('./claude').runClaude;
  const generateViaGateway = opts.generateViaGateway || null; // (topic)=>rawPlan|null（默认走 GLM 网关）
  const queryEngine = opts.queryEngine || 'auto'; // 'auto'(claude→gateway→raw) | 'claude' | 'gateway'
  const timeoutMs = opts.claudeTimeoutMs ?? 60000;

  const fallbackQuery = `all:"${t}"`;
  const fallback = {
    queries: [fallbackQuery],
    query: fallbackQuery,
    categories: [],
    keyterms: t ? [t] : [],
    note: '未使用 LLM，按原始主题检索',
    usedClaude: false,
    engine: 'fallback',
    claudeFailReason: null,
  };
  if (!t) return fallback;

  let claudeFailReason = null;

  // 1) claude -p（除非显式 queryEngine='gateway'）
  if (queryEngine !== 'gateway') {
    let res;
    try {
      res = await runClaude(buildClaudePrompt(t), { timeoutMs });
    } catch (e) {
      logger.warn('claude 检索计划生成异常（回退兜底链）', e && e.message);
      res = { ok: false, reason: 'error' }; // runClaude 设计上不抛，这里兜底
    }
    if (res && res.ok) {
      const norm = normalizePlan(parseClaudeOutput(res.stdout), t);
      if (norm) return { ...norm, usedClaude: true, engine: 'claude', claudeFailReason: null };
      claudeFailReason = 'bad_output';
    } else {
      claudeFailReason = (res && res.reason) || 'error';
    }
  }

  // 2) GLM 网关兜底（claude 失败 / queryEngine='gateway'）。claude 在无头环境常因鉴权失败，
  //    而项目已有可用的 OpenAI 兼容网关（做总结用），用它生成检索计划能保证质量不退化到原始主题。
  if (queryEngine !== 'claude' && generateViaGateway) {
    let raw;
    try {
      raw = await generateViaGateway(t);
    } catch (e) {
      logger.warn('网关检索计划生成异常（回退原始主题）', e && e.message);
      raw = null;
    }
    const norm = normalizePlan(raw, t);
    if (norm) return { ...norm, usedClaude: false, engine: 'gateway', claudeFailReason };
  }

  // 3) 原始主题兜底
  return { ...fallback, claudeFailReason };
}

/** 用项目已有的 OpenAI 兼容网关（config.ai，即做总结的那套）生成检索计划，作为 claude 的兜底。
 *  返回裸解析对象（交给 buildDiscoveryQuery 统一 normalizePlan）或 null。 */
async function planViaGateway(topic, opts = {}) {
  const ai = opts.ai || require('./ai');
  const config = opts.config;
  const fetchImpl = opts.fetchImpl || fetch;
  const messages = [
    { role: 'system', content: '你是 arXiv 检索专家，只输出 JSON，不要任何解释或 markdown 围栏。' },
    { role: 'user', content: buildClaudePrompt(topic) },
  ];
  let content;
  try {
    content = await ai.callChat({ messages, config, fetchImpl });
  } catch (e) {
    logger.warn('planViaGateway 调用 AI 网关失败', e && e.message);
    return null;
  }
  return parseClaudeOutput(content);
}

/** 把 claude 解析出的对象规整成统一的检索计划；非法则返回 null（上层回退）。
 *  兼容两种形态：新的 {queries:[...],categories,keyterms,note} 与旧的 {query,note}。 */
function normalizePlan(parsed, topic) {
  if (!parsed || typeof parsed !== 'object') return null;
  let queries = [];
  if (Array.isArray(parsed.queries)) {
    queries = parsed.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim());
  } else if (typeof parsed.query === 'string' && parsed.query.trim()) {
    queries = [parsed.query.trim()];
  }
  if (!queries.length) return null;
  const categories = Array.isArray(parsed.categories)
    ? parsed.categories.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
    : [];
  let keyterms = Array.isArray(parsed.keyterms)
    ? parsed.keyterms.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  if (!keyterms.length) keyterms = [topic]; // claude 没给关键词就用主题本身兜底，保证相关度打分有依据
  const note = typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : 'claude 已生成检索式';
  return { queries: queries.slice(0, 3), query: queries[0], categories, keyterms, note };
}

function buildClaudePrompt(topic) {
  return [
    '你是 arXiv 检索专家。把用户的研究主题（可能是中文/英文/缩写/描述）转成一份高质量检索计划。',
    '',
    'arXiv 检索式语法：字段前缀 ti(标题) abs(摘要) au(作者) cat(分类如 cs.CL) all(全字段)；',
    '精确短语用双引号 ti:"mixture of experts"；布尔 AND/OR/ANDNOT 必须大写并用括号分组。',
    '',
    '请产出 2-3 条**互补**的检索式：',
    '- 第 1 条偏精确（核心术语 AND 组合，命中高相关论文）；',
    '- 第 2 条偏宽泛（核心概念的中英文同义词 OR 展开，提升召回，捞经典/高被引论文）；',
    '- 可选第 3 条限定相关 arXiv 分类。',
    '中文主题务必翻译成英文检索词（arXiv 以英文为主）。',
    '',
    `用户主题：${topic}`,
    '',
    '只输出一个 JSON 对象，不要任何额外文字或 markdown：',
    '{',
    '  "queries": ["<精确检索式>", "<宽泛检索式>"],',
    '  "categories": ["<相关 arXiv 分类，如 cs.CL>"],',
    '  "keyterms": ["<用于相关度判定的英文关键词/短语>"],',
    '  "note": "<一句话中文说明这次在找什么>"',
    '}',
  ].join('\n');
}

/** 解析 claude（或 LLM 网关）输出，抠出我们要的 plan JSON。容忍三种形态：
 *  1) 新版 CLI `--output-format json`：消息数组 [{type:'system'},…,{type:'result',result,is_error}]
 *     —— 取最后一个 type==='result'；若 is_error（如 401 鉴权失败）则视为失败返回 null。
 *  2) 旧版包裹对象 {result:"<json 串>"}。
 *  3) 网关直接返回的裸 JSON 文本（可能带 ```json 围栏）。 */
function parseClaudeOutput(stdout) {
  if (!stdout) return null;
  const text = String(stdout).trim();
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    outer = null;
  }
  if (Array.isArray(outer)) {
    const resultMsg = [...outer].reverse().find((m) => m && m.type === 'result');
    if (!resultMsg || resultMsg.is_error) return null; // 无 result 或执行/鉴权出错（如 401）→ 失败
    outer = typeof resultMsg.result === 'string' ? { result: resultMsg.result } : null;
  }
  const innerRaw = outer && typeof outer.result === 'string' ? outer.result : text;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(innerRaw);
  const candidate = fenced ? fenced[1].trim() : innerRaw.trim();
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object') return obj;
  } catch {
    /* fall through */
  }
  const m = /\{[\s\S]*\}/.exec(innerRaw);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

// ---------------- 相关度 / 权威 / 新近 打分 ----------------

function tokenSet(s) {
  return new Set(
    normalizeTitle(s || '')
      .split(' ')
      .filter(Boolean),
  );
}

/** 关键词在「标题+摘要」中的命中比例（0~1）。无关键词 → 0。
 *  用 token 级匹配（normalizeTitle 已小写去标点），对短语按其分词后的 token 取并集。 */
function computeRelevance(keyterms, title, summary) {
  const kt = new Set();
  for (const term of keyterms || []) for (const tok of normalizeTitle(term).split(' ').filter(Boolean)) kt.add(tok);
  if (kt.size === 0) return 0;
  const doc = tokenSet(`${title || ''} ${summary || ''}`);
  let hits = 0;
  for (const tok of kt) if (doc.has(tok)) hits++;
  return hits / kt.size;
}

/** 权威度：log 压缩的被引数，~1000 引用封顶为 1。缺引用量 → 0。 */
function authorityScore(citationCount) {
  if (typeof citationCount !== 'number' || citationCount < 0) return 0;
  return Math.min(1, Math.log10(1 + citationCount) / 3);
}

/** 新近度：发表越近越高；超出窗口（默认 8 年）线性衰减到 0。缺年份 → 0。 */
function recencyScore(year, nowYear, windowYears) {
  const y = parseInt(year, 10);
  if (!y) return 0;
  const age = Math.max(0, nowYear - y);
  return Math.max(0, Math.min(1, 1 - age / windowYears));
}

function scoreOne(r, { weights, nowYear, recencyWindowYears }) {
  const rel = typeof r.relevance === 'number' ? r.relevance : 0;
  const auth = authorityScore(r.citationCount);
  const rec = recencyScore(r.year, nowYear, recencyWindowYears);
  return weights.rel * rel + weights.auth * auth + weights.rec * rec;
}

// ---------------- 引用量补全：Semantic Scholar（主）+ OpenAlex（兜底） ----------------

/** 用 Semantic Scholar 批量补 citationCount。
 *  - arxivId → S2 paper id 用 "ArXiv:<id>" 前缀；一次 POST 一批（≤30）。
 *  - 支持 apiKey（x-api-key 头，未授权时 S2 限流极重）；对 429/5xx/网络错误有限重试。
 *  - 失败/超时整批降级：对应 entry 不带 citationCount，绝不抛错阻塞主流程。
 *  返回与入参同长度数组，每元素 = { citationCount?, influentialCitationCount? }（拿不到则空对象）。 */
async function enrichWithCitations(entries, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint || SEMANTIC_SCHOLAR_BATCH;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const apiKey = opts.apiKey || null;
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 600;
  const fields = 'citationCount,influentialCitationCount,year';

  const result = entries.map(() => ({}));
  const indexed = entries.map((e, i) => ({ id: extractArxivId(e), i })).filter((x) => x.id);
  if (!indexed.length) return result;

  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA };
  if (apiKey) headers['x-api-key'] = apiKey;

  const BATCH = 30;
  for (let off = 0; off < indexed.length; off += BATCH) {
    const slice = indexed.slice(off, off + BATCH);
    const ids = slice.map((x) => `ArXiv:${x.id}`);
    let data = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchImpl(`${endpoint}?fields=${fields}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          data = await res.json();
          break;
        }
        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!retryable || attempt >= maxRetries) {
          logger.warn('S2 引用量查询失败（本批放弃）', { status: res.status, offset: off });
          break;
        }
      } catch (e) {
        if (attempt >= maxRetries) {
          logger.warn('S2 引用量查询网络错误（本批放弃）', e && e.message);
          break;
        }
      }
      await sleep(retryDelayMs * Math.pow(2, attempt));
    }
    if (!Array.isArray(data)) continue;
    // S2 batch 返回顺序与请求 ids 一一对应，元素可能为 null（S2 未收录）
    data.forEach((p, j) => {
      if (p && typeof p.citationCount === 'number') {
        const idx = slice[j] && slice[j].i;
        if (typeof idx === 'number') {
          result[idx] = { citationCount: p.citationCount };
          if (typeof p.influentialCitationCount === 'number')
            result[idx].influentialCitationCount = p.influentialCitationCount;
        }
      }
    });
  }
  return result;
}

/** 从 arXiv DOI（10.48550/arXiv.<id>，OpenAlex 存为小写）反解出 arxivId。 */
function arxivIdFromDoi(doi) {
  if (!doi) return null;
  const m = /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i.exec(String(doi));
  return m ? m[1] : null;
}

/** 用 OpenAlex 按 arXiv DOI 批量补 cited_by_count（免费、无需 key、限速宽松，作 S2 兜底）。
 *  失败整批降级不抛。返回与入参同长度数组。 */
async function enrichWithOpenAlex(entries, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint || OPENALEX_WORKS;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const result = entries.map(() => ({}));
  const indexed = entries.map((e, i) => ({ id: extractArxivId(e), i })).filter((x) => x.id);
  if (!indexed.length) return result;
  const byArxiv = new Map(indexed.map((x) => [x.id, x.i]));

  const BATCH = 40;
  for (let off = 0; off < indexed.length; off += BATCH) {
    const slice = indexed.slice(off, off + BATCH);
    const dois = slice.map((x) => `10.48550/arxiv.${x.id}`).join('|');
    const url = `${endpoint}?filter=doi:${encodeURIComponent(dois)}&per-page=${slice.length}&select=doi,cited_by_count`;
    let data = null;
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) data = await res.json();
    } catch (e) {
      logger.warn('OpenAlex 引用量批次查询失败（跳过本批）', e && e.message);
      continue;
    }
    const rows = data && Array.isArray(data.results) ? data.results : [];
    for (const row of rows) {
      const aid = arxivIdFromDoi(row.doi);
      if (aid && byArxiv.has(aid) && typeof row.cited_by_count === 'number') {
        result[byArxiv.get(aid)] = { citationCount: row.cited_by_count };
      }
    }
  }
  return result;
}

// ---------------- 主流程 ----------------

function toResult(entry, citeInfo) {
  const arxivId = extractArxivId(entry);
  const year = entry.published ? String(entry.published).slice(0, 4) : null;
  const r = {
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
    pdfUrl: entry.pdfUrl || null,
    title: entry.title || '(无标题)',
    authors: entry.authors || [],
    year,
    summary: entry.summary || '',
    primaryCategory: entry.primaryCategory || null,
  };
  if (citeInfo && typeof citeInfo.citationCount === 'number') {
    r.citationCount = citeInfo.citationCount;
    if (typeof citeInfo.influentialCitationCount === 'number')
      r.influentialCitationCount = citeInfo.influentialCitationCount;
  }
  return r;
}

/** 「发现」主流程：主题 → 检索计划 → arXiv 多轴召回(相关+最新) → 引用量补全 → 去重 → 复合排序。
 *  全程依赖注入（runClaude / searchArxiv / fetch），便于测试与替换。
 *  onProgress(ev) 在每个阶段被调用，用于 SSE 流式进度（理解→检索→引用量→排序→完成）。
 *  返回 { queries, query, categories, note, usedClaude, claudeFailReason, citationsAvailable, results }。 */
async function discoverPapers(opts = {}) {
  const { topic, store } = opts;
  const runClaude = opts.runClaude || require('./claude').runClaude;
  const searchArxiv = opts.searchArxiv || require('./arxiv').searchArxivMulti;
  const fetchImpl = opts.fetchImpl || fetch;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const maxResults = opts.maxResults ?? 40;
  const perAxis = opts.perAxis ?? 25;
  const claudeTimeoutMs = opts.claudeTimeoutMs ?? 60000;
  const enableCitations = opts.enableCitations !== false;
  const useOpenAlex = opts.openAlex !== false;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const nowYear = opts.nowYear ?? new Date().getFullYear();
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const recencyWindowYears = opts.recencyWindowYears ?? 8;
  const titleSimThreshold = opts.titleSimThreshold ?? 0.85;
  const s2ApiKey = opts.s2ApiKey || null;
  const s2MaxRetries = opts.s2MaxRetries ?? 2;

  // 1) 理解主题 → 检索计划（claude → GLM 网关 → 原始 三级兜底）
  onProgress({ stage: 'understanding', message: '正在理解主题并生成检索式…' });
  const plan = await buildDiscoveryQuery(topic, {
    runClaude,
    claudeTimeoutMs,
    generateViaGateway: opts.generateViaGateway,
    queryEngine: opts.queryEngine,
  });
  onProgress({
    stage: 'query',
    queries: plan.queries,
    query: plan.query,
    note: plan.note,
    usedClaude: plan.usedClaude,
    engine: plan.engine,
    claudeFailReason: plan.claudeFailReason,
  });

  // 2) 多轴召回：每条检索式各按「相关度」与「提交时间」两轴拉一批，合并去重成候选池
  const axes = [
    { sortBy: 'relevance', label: '相关度' },
    { sortBy: 'submittedDate', label: '最新' },
  ];
  const merged = new Map(); // arxivId -> entry（首次出现胜出）
  for (const q of plan.queries) {
    for (const axis of axes) {
      let entries = [];
      try {
        const r = await searchArxiv(q, fetchImpl, {
          maxResults: perAxis,
          sortBy: axis.sortBy,
          sortOrder: 'descending',
          minIntervalMs,
        });
        entries = (r && r.entries) || [];
      } catch (e) {
        logger.warn('arXiv 轴向召回失败', { query: q, axis: axis.sortBy, error: e && e.message });
        entries = [];
      }
      let added = 0;
      for (const e of entries) {
        const id = extractArxivId(e);
        if (id && !merged.has(id)) {
          merged.set(id, e);
          added++;
        }
      }
      onProgress({
        stage: 'searching',
        axis: axis.sortBy,
        label: axis.label,
        query: q,
        found: entries.length,
        added,
        total: merged.size,
      });
    }
  }
  const pool = [...merged.values()];
  onProgress({ stage: 'searched', total: pool.length });

  // 3) 引用量补全（S2 主 + OpenAlex 兜底缺失项）
  let cites = pool.map(() => ({}));
  let citationsAvailable = false;
  if (enableCitations && pool.length) {
    onProgress({
      stage: 'citations',
      source: 'semantic-scholar',
      message: '查询引用量（Semantic Scholar）…',
      total: pool.length,
    });
    try {
      cites = await enrichWithCitations(pool, { fetchImpl, apiKey: s2ApiKey, maxRetries: s2MaxRetries });
    } catch (e) {
      logger.warn('S2 引用量富集整体失败（按相关+新近排）', e && e.message);
      cites = pool.map(() => ({}));
    }
    const missingIdx = cites.map((c, i) => (typeof c.citationCount === 'number' ? -1 : i)).filter((i) => i >= 0);
    if (useOpenAlex && missingIdx.length) {
      onProgress({
        stage: 'citations',
        source: 'openalex',
        message: '用 OpenAlex 兜底剩余引用量…',
        total: missingIdx.length,
      });
      try {
        const oa = await enrichWithOpenAlex(
          missingIdx.map((i) => pool[i]),
          { fetchImpl },
        );
        oa.forEach((c, k) => {
          if (typeof c.citationCount === 'number') cites[missingIdx[k]] = c;
        });
      } catch (e) {
        /* OpenAlex 兜底失败：保持缺失 */
        logger.warn('OpenAlex 兜底富集失败', e && e.message);
      }
    }
    const resolved = cites.filter((c) => typeof c.citationCount === 'number').length;
    citationsAvailable = resolved > 0;
    onProgress({ stage: 'citations-done', resolved, total: pool.length, available: citationsAvailable });
  }

  // 4) 去重（库内同 arxivId 或标题高度相似的剔除）
  const papers = Object.values((store && store.papers) || {});
  const existingIds = new Set(papers.map((p) => p.arxivId).filter(Boolean));
  const existingTitles = papers.map((p) => p.title).filter(Boolean);
  const isDup = (r) => {
    if (r.arxivId && existingIds.has(r.arxivId)) return true;
    for (const t of existingTitles) if (titleSimilarity(r.title, t) >= titleSimThreshold) return true;
    return false;
  };

  // 5) 复合打分 + 排序
  onProgress({ stage: 'ranking', message: '去重并按 相关度·权威·新近 排序…' });
  let results = pool.map((e, i) => toResult(e, cites[i])).filter((r) => r.arxivId && !isDup(r));
  for (const r of results) {
    r.relevance = computeRelevance(plan.keyterms, r.title, r.summary);
    r.score = scoreOne(r, { weights, nowYear, recencyWindowYears });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      (b.citationCount ?? -1) - (a.citationCount ?? -1) ||
      (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0),
  );
  if (results.length > maxResults) results = results.slice(0, maxResults);

  onProgress({ stage: 'done', count: results.length });
  return {
    queries: plan.queries,
    query: plan.query,
    categories: plan.categories,
    note: plan.note,
    usedClaude: plan.usedClaude,
    engine: plan.engine,
    claudeFailReason: plan.claudeFailReason,
    citationsAvailable,
    results,
  };
}

module.exports = {
  buildDiscoveryQuery,
  planViaGateway,
  computeRelevance,
  enrichWithCitations,
  enrichWithOpenAlex,
  discoverPapers,
  parseClaudeOutput,
  // 以下为内部件的附加导出（仅供单测直接调用，逻辑未变）
  DEFAULT_WEIGHTS,
  normalizePlan,
  tokenSet,
  authorityScore,
  recencyScore,
  scoreOne,
  arxivIdFromDoi,
  toResult,
};
