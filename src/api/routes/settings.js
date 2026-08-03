'use strict';

// settings 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const pkg = require('../../../package.json');
const {
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TAGS_PROMPT,
  DEFAULT_FORMULA_PROMPT,
  DEFAULT_CONCEPT_PROMPT,
  DEFAULT_CONCEPT_MAP_PROMPT,
  applySettingsOverride,
} = require('../../services/ai');
const { DEFAULT_MINERU_NAMING_PROMPT } = require('../../services/mineru');
const {
  aiSettingsView,
  arxivSettingsView,
  translateSettingsView,
  formulasSettingsView,
  discoverSettingsView,
  maskedRawConfig,
} = require('../views');

function register(t, ctx) {
  const { ok, fail, config, manager, scanner, conceptMapMeta } = ctx;

  // ---- 设置（提示词 / AI 接口 / 主题标签等） ----
  // GET /api/settings  返回提示词 + 生效 AI 配置（掩码）+ 内置默认，供设置面板渲染
  t.get('/api/settings', async ({ res, spaceId, space, store }) => {
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
      formulaPrompt: store.settings.formulaPrompt || '',
      defaultFormulaPrompt: DEFAULT_FORMULA_PROMPT,
      // --- 概念抽取提示词（v3.10，三级回退，同 formulaPrompt 模式）---
      conceptPrompt: store.settings.conceptPrompt || '',
      defaultConceptPrompt: DEFAULT_CONCEPT_PROMPT,
      // --- 概念地图提示词（v3.14 开放设置页编辑；生成任务优先级：用户当次输入 > 此覆盖 > 内置默认）---
      conceptMapPrompt: store.settings.conceptMapPrompt || '',
      defaultConceptMapPrompt: DEFAULT_CONCEPT_MAP_PROMPT,
      // --- 聊天预置 Prompt（@ 引用之外，输入框上方的快捷提问按钮，用户可自定义）---
      chatPresets: Array.isArray(store.settings.chatPresets) ? store.settings.chatPresets : [],
      // --- v3.2 保存的搜索预设（高级搜索命名预设，per-space）---
      savedSearches: Array.isArray(store.settings.savedSearches) ? store.settings.savedSearches : [],
      // --- v3.10 概念地图制品（只回显元信息，html 按需 GET 单个，避免此接口变重）---
      // v3.14：元信息含 status/error/hasHtml（后台生成任务态；僵尸 generating 解析为 error）
      conceptMaps: (Array.isArray(store.settings.conceptMaps) ? store.settings.conceptMaps : []).map(conceptMapMeta),
      // 生效 AI 配置（store.settings.ai 覆盖 config.ai 后）+ config 原值
      ai: aiSettingsView(effConfig, store.settings.ai),
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
      // --- 公式抽取引擎（生效值 + config 原值）：ai | mineru + MinerU 服务地址 + 命名提示词 ---
      formulas: formulasSettingsView(effConfig.formulas),
      configFormulas: formulasSettingsView(config.formulas),
      defaultNamingPrompt: DEFAULT_MINERU_NAMING_PROMPT,
      // --- 哪些字段被 store.settings 覆盖（驱动「已覆盖 config」徽标 / 计数）---
      overrides: {
        ai: Object.keys(ov.ai || {}),
        arxiv: Object.keys(ov.arxiv || {}),
        discover: Object.keys(ov.discover || {}),
        translate: Object.keys(ov.translate || {}),
        formulas: Object.keys(ov.formulas || {}),
        scan: ov.scanIntervalMinutes !== undefined,
        summaryPrompt: !!ov.summaryPrompt,
        tagsPrompt: !!ov.tagsPrompt,
        formulaPrompt: !!ov.formulaPrompt,
        conceptPrompt: !!ov.conceptPrompt,
        conceptMapPrompt: !!ov.conceptMapPrompt,
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
  });

  // PUT /api/settings/summary-prompt  body: { value }  空串=恢复默认
  t.put('/api/settings/summary-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.summaryPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { summaryPrompt: store.settings.summaryPrompt });
  });

  // PUT /api/settings/tags-prompt  body: { value }  空串=恢复默认（标签/主题提示词）
  t.put('/api/settings/tags-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.tagsPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { tagsPrompt: store.settings.tagsPrompt });
  });

  // PUT /api/settings/formula-prompt  body: { value }  空串=恢复默认（公式抽取提示词）
  t.put('/api/settings/formula-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.formulaPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { formulaPrompt: store.settings.formulaPrompt });
  });

  // PUT /api/settings/concept-prompt  body: { value }  空串=恢复默认（概念抽取提示词，v3.10）
  t.put('/api/settings/concept-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.conceptPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { conceptPrompt: store.settings.conceptPrompt });
  });

  // PUT /api/settings/concept-map-prompt  body: { value }  空串=恢复默认（概念地图生成提示词，v3.14）
  t.put('/api/settings/concept-map-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.conceptMapPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { conceptMapPrompt: store.settings.conceptMapPrompt });
  });

  // PUT /api/settings/chat-presets  body: { value: [{label,prompt}] }  空数组=恢复内置默认
  //   聊天输入框上方的快捷提问按钮（用户可自定义 label/prompt）。规整：去空项、限 20 条、截断长度。
  t.put('/api/settings/chat-presets', async ({ res, body, store, save }) => {
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
  });

  // PUT /api/settings/saved-searches  body: { value: [{name, dsl, createdAt}] }
  //   v3.2 高级搜索：保存常用搜索为命名预设（per-space）。规整：去空 dsl、限 30 条、截断长度。
  t.put('/api/settings/saved-searches', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const raw = Array.isArray(op.value) ? op.value : [];
    const clean = raw
      .map((it) => ({
        name: String((it && it.name) || '')
          .trim()
          .slice(0, 40),
        dsl: String((it && it.dsl) || '')
          .trim()
          .slice(0, 500),
        createdAt: Number((it && it.createdAt) || Date.now()),
      }))
      .filter((it) => it.dsl)
      .slice(0, 30);
    store.settings.savedSearches = clean;
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { savedSearches: store.settings.savedSearches });
  });

  // PUT /api/settings/scan  body: { scanIntervalMinutes }  整数 ≥0，0=关闭定时扫描。热生效（reschedule 重置定时器）。
  t.put('/api/settings/scan', async ({ res, body, spaceId, store, save }) => {
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
  });

  // PUT /api/settings/arxiv  body: { enabled?, titleSimilarityThreshold?, minIntervalMs? }  白名单，未传不改。
  t.put('/api/settings/arxiv', async ({ res, body, store, save }) => {
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
  });

  // PUT /api/settings/translate  body: { engine?, targetLang? }  划线翻译引擎 + 目标语言。
  t.put('/api/settings/translate', async ({ res, body, store, save }) => {
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
  });

  // PUT /api/settings/formulas  公式抽取引擎：engine=ai|mineru，mineruUrl，namingPrompt（MinerU 命名提示词）。
  //   仿 translate 段：白名单枚举校验 + trim；空串 mineruUrl/namingPrompt=未设置（回退 config/默认）。
  t.put('/api/settings/formulas', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const next = { ...(store.settings.formulas || {}) };
    if (op.engine === 'ai' || op.engine === 'mineru') next.engine = op.engine;
    if (typeof op.mineruUrl === 'string') next.mineruUrl = op.mineruUrl.trim();
    if (typeof op.namingPrompt === 'string') next.namingPrompt = op.namingPrompt.trim();
    store.settings.formulas = next;
    store.settings.updatedAt = Date.now();
    await save(store);
    const eff = applySettingsOverride(config, store.settings);
    return ok(res, { formulas: formulasSettingsView(eff.formulas) });
  });

  // PUT /api/settings/discover  body: 白名单字段 + weights{rel,auth,rec}；semanticScholarApiKey 掩码协议同 ai.apiKey。
  t.put('/api/settings/discover', async ({ res, body, store, save }) => {
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
  });

  // POST /api/settings/reset  body: { section } 或 { all:true }  清除运行时覆盖，回到 config.json 默认。
  t.post('/api/settings/reset', async ({ res, body, spaceId, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    if (op.all) {
      store.settings = { updatedAt: Date.now() };
      if (scanner && scanner.reschedule) await scanner.reschedule(spaceId, config.scanIntervalMinutes ?? 5);
      await save(store);
      return ok(res, { ok: true });
    }
    const section = op.section;
    const known = [
      'ai',
      'summaryPrompt',
      'tagsPrompt',
      'formulaPrompt',
      'conceptPrompt',
      'conceptMapPrompt',
      'arxiv',
      'discover',
      'translate',
      'formulas',
      'scan',
    ];
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
  });
}

module.exports = { register };
