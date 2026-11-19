'use strict';

// 只读视图与共享数据清理助手。原先散落在 src/api/router.js 顶部（v3.15 路由化重构抽出），
// 供 src/api/routes/*.js 与 src/api/router.js 共用。
//
// 「视图」= 面向前端的序列化函数（掩码敏感字段、裁掉超长大字段、补默认值）；
// 末尾两个（mergeInto / deletePapersCleanup）是跨路由共用的 store 变更助手。

const path = require('path');
const fs = require('fs');
const { removePaperFromFormulas } = require('../core/formulas');
const { normalizeAnnotations } = require('../core/annotations');
const { normalizeNoteCards } = require('../core/notes');
const { INPUT_BUDGET_TASKS, DEFAULT_MAX_INPUT_TOKENS } = require('../services/ai');

/** 掩码 apiKey 用于回显：只露前 3 / 后 4 位。空 key 返回空串。 */
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 单渠道只读视图（apiKey 掩码，不回显明文）。 */
function channelView(c, activeChannelId) {
  return {
    id: c.id,
    name: c.name || '',
    baseURL: c.baseURL || '',
    model: c.model || '',
    maxInputTokens: Number(c.maxInputTokens) > 0 ? Number(c.maxInputTokens) : null,
    hasApiKey: !!c.apiKey,
    apiKeyMasked: maskKey(c.apiKey),
    active: c.id === activeChannelId,
  };
}

/** 计算当前生效 AI 配置（store.settings.ai 覆盖 config.ai）的只读视图（回显用，不含完整 key）。
 *  v3.13：附带多渠道视图——有存根渠道则掩码回显；无渠道（旧部署）从生效配置合成单渠道「默认渠道」。 */
function aiSettingsView(effConfig, aiOverride) {
  const o = aiOverride && typeof aiOverride === 'object' ? aiOverride : {};
  const stored = Array.isArray(o.channels) ? o.channels.filter((c) => c && c.id) : [];
  const channels = stored.length
    ? stored.map((c) => channelView(c, o.activeChannelId))
    : effConfig.ai.baseURL || effConfig.ai.model
      ? [
          channelView(
            {
              id: 'ch_default',
              name: '默认渠道',
              baseURL: effConfig.ai.baseURL,
              apiKey: effConfig.ai.apiKey,
              model: effConfig.ai.model,
              maxInputTokens: null, // 合成渠道不抢全局 tokens（跟随全局字段）
            },
            'ch_default',
          ),
        ]
      : [];
  return {
    baseURL: effConfig.ai.baseURL || '',
    model: effConfig.ai.model || '',
    apiKeyMasked: maskKey(effConfig.ai.apiKey),
    hasApiKey: !!effConfig.ai.apiKey,
    // v3.13 多渠道（卡片式管理；activeChannelId 指向默认渠道）
    channels,
    activeChannelId: stored.length ? o.activeChannelId || '' : channels.length ? channels[0].id : '',
    // v3.11：输入上限以 tokens 为准（OpenAI 标准）；旧 maxInputChars 作废弃别名仍回显（兼容存量）
    maxInputTokens: effConfig.ai.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxInputChars: effConfig.ai.maxInputChars ?? 24000,
    timeoutMs: effConfig.ai.timeoutMs ?? 120000,
    // 每任务输入上限：null = 跟随全局
    taskMaxInputTokens: taskBudgetView(effConfig.ai.taskMaxInputTokens),
    taskMaxInputChars: taskBudgetView(effConfig.ai.taskMaxInputChars),
  };
}

/** 解析渠道表单里的 apiKey：掩码/未传 → 取同 id 已存 key（含旧部署合成 ch_default 的生效 key）；
 *  空串 → 显式清空；其余 → 新值。oldKeyOf(id) 返回该渠道此前存储的 key（无则 undefined）。 */
function resolveChannelApiKey(raw, id, oldKeyOf) {
  if (typeof raw !== 'string') return oldKeyOf(id);
  const v = raw.trim();
  if (!v) return ''; // 显式清空
  if (/^\*+$/.test(v)) return oldKeyOf(id); // 掩码 = 未改动
  return v;
}

/** 每任务输入上限只读视图：补齐全部任务键，未设置/非正数一律回显 null（= 跟随全局）。 */
function taskBudgetView(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const t of INPUT_BUDGET_TASKS) {
    const v = Number(src[t]);
    out[t] = Number.isFinite(v) && v > 0 ? v : null;
  }
  return out;
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

/** formulas 段只读视图（公式抽取引擎：engine 默认 ai；mineruUrl 默认空，引擎选 mineru 时必填）。 */
function formulasSettingsView(f) {
  f = f || {};
  return {
    engine: f.engine || 'ai',
    mineruUrl: f.mineruUrl || '',
    namingPrompt: f.namingPrompt || '',
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
    hasNotes: !!(p.notes || (Array.isArray(p.noteCards) && p.noteCards.length)),
    summaryExcerpt: p.summary ? p.summary.slice(0, 160) : '',
    conceptCount: (p.conceptIds || []).length,
    formulaCount: (p.formulaIds || []).length,
  };
}

/** 详情视图：含完整 summary / notes / annotations（批注，打开阅读器时需要） */
function detailView(p) {
  return {
    ...summaryView(p),
    summary: p.summary || '',
    notes: p.notes || '',
    noteCards: normalizeNoteCards(p.noteCards),
    abstract: p.abstract || '',
    fulltextChars: p.fulltextChars || 0,
    conceptIds: p.conceptIds || [],
    formulaIds: p.formulaIds || [],
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
 *  - 移除 paperIds 变空的孤立概念（不再被任何论文引用）——opts.keepKnowledge=true 时跳过：
 *    概念/公式是空间级知识资产（含人工命名/合并/plotHint 等治理投入），删论文默认只解除关联、
 *    条目即使不再被任何论文引用也保留，由用户在知识页自行清理
 *  - 重新聚合 store.tags/topics（从论文重建），自动清除计数归零的标签/主题
 *  papersDir 由调用方传入（来自 manager.resolveSpacePapersDir，统一收口，不再各自 path.resolve config.papersDir）。
 *  文件删除失败一律忽略（占用/缺失），仍删条目。
 *  返回 { ids, conceptsRemoved, formulasRemoved }（ids=实际删除的 id，跳过不存在的）。 */
function deletePapersCleanup(store, ids, papersDir, opts) {
  const keepKnowledge = !!(opts && opts.keepKnowledge);
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
  // 清理概念 paperIds；keepKnowledge 时保留变空的条目（只解除关联）
  const conceptsBefore = Array.isArray(store.concepts) ? store.concepts.length : 0;
  if (Array.isArray(store.concepts)) {
    for (const c of store.concepts) {
      if (Array.isArray(c.paperIds)) c.paperIds = c.paperIds.filter((x) => !removed.includes(x));
    }
    if (!keepKnowledge) store.concepts = store.concepts.filter((c) => Array.isArray(c.paperIds) && c.paperIds.length > 0);
  }
  // 清理公式 occurrences（occurrence 清空的条目整条移除，与概念同语义；keepKnowledge 同样保留）
  const formulasBefore = Array.isArray(store.formulas) ? store.formulas.length : 0;
  if (keepKnowledge) {
    for (const f of store.formulas || []) {
      f.occurrences = (f.occurrences || []).filter((o) => !removed.includes(o.paperId));
      f.paperIds = f.occurrences.map((o) => o.paperId);
    }
  } else {
    for (const id of removed) removePaperFromFormulas(store, id);
  }
  // 阅读架联动剔除（v3.21）：否则架子上残留死 id；GET 规整是兜底，删除时就地清掉是正道
  if (store.settings && Array.isArray(store.settings.readerShelf) && removed.length) {
    store.settings.readerShelf = store.settings.readerShelf.filter((x) => !removed.includes(x));
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
  return {
    ids: removed,
    conceptsRemoved: conceptsBefore - (store.concepts ? store.concepts.length : 0),
    formulasRemoved: formulasBefore - (store.formulas ? store.formulas.length : 0),
  };
}

module.exports = {
  maskKey,
  channelView,
  aiSettingsView,
  resolveChannelApiKey,
  taskBudgetView,
  arxivSettingsView,
  translateSettingsView,
  formulasSettingsView,
  LANG_NAMES,
  GL_LANG_MAP,
  discoverSettingsView,
  maskedRawConfig,
  summaryView,
  detailView,
  mergeInto,
  deletePapersCleanup,
};
