'use strict';

// settings 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const pkg = require('../../../package.json');
// 命名空间访问（可测试性）：测试 monkey-patch aiSvc.callChatStream 即可拦截 prompt-refine 的 AI 调用
const aiSvc = require('../../services/ai');
const {
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TAGS_PROMPT,
  DEFAULT_FORMULA_PROMPT,
  DEFAULT_CONCEPT_PROMPT,
  DEFAULT_CONCEPT_MAP_PROMPT,
  DEFAULT_NOTES_PROMPT,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  applySettingsOverride,
  withGlobalAi,
} = aiSvc;
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

  // ---- AI 改写提示词（v3.55，memory 式编辑）----
  // 各提示词的取用规则与「改写时必须保留的机制」说明（喂给改写模型，防把硬约束改丢）。
  // get(settings) 取当前覆盖值（空=用内置默认）；def() 取内置默认。
  const PROMPT_REFINE_KEYS = {
    summary: {
      label: '论文总结提示词',
      get: (s) => s.summaryPrompt,
      def: () => DEFAULT_SUMMARY_PROMPT,
      note: '该提示词驱动模型直接输出 Markdown 总结正文（非 JSON、不包代码块）。改写后必须仍要求输出 Markdown 正文。',
    },
    tags: {
      label: '标签/主题抽取提示词',
      get: (s) => s.tagsPrompt,
      def: () => DEFAULT_TAGS_PROMPT,
      note: '该提示词强制 JSON 输出（response_format: json_object），结构为 {"tags":[...],"topics":[...],"metadata":{...}}。改写后必须保留 JSON 输出要求与该字段结构。',
    },
    formula: {
      label: '公式抽取提示词',
      get: (s) => s.formulaPrompt,
      def: () => DEFAULT_FORMULA_PROMPT,
      note: '该提示词强制 JSON 输出；canonicalName 是跨论文合并的唯一 key，提示词中的规范名对照表决定同名公式能否合并——改写时必须保留规范名机制与 JSON 结构。',
    },
    concept: {
      label: '概念抽取提示词',
      get: (s) => s.conceptPrompt,
      def: () => DEFAULT_CONCEPT_PROMPT,
      note: '该提示词强制 JSON 输出，每条概念含 category（枚举）与 importance（core|supporting）字段；term 规范名对照表决定跨论文归并。改写后必须保留 JSON 结构、category 枚举与规范名机制。',
    },
    conceptMap: {
      label: '概念地图生成提示词',
      get: (s) => s.conceptMapPrompt,
      def: () => DEFAULT_CONCEPT_MAP_PROMPT,
      note: '该提示词驱动生成单文件 HTML 概念地图（自由输出，非 JSON）。改写后必须仍要求输出完整自包含的单文件 HTML。',
    },
    notes: {
      label: '笔记骨架提示词',
      get: (s) => s.notesPrompt,
      def: () => DEFAULT_NOTES_PROMPT,
      note: '该提示词驱动生成读书笔记骨架（Markdown），六个 ## 二级章节的标题文字被前端用来定位/分栏——改写时可增删章节，但必须保持「## 标题」这一层级结构。',
    },
    chat: {
      label: '论文聊天系统提示词',
      get: (s) => s.chatSystemPrompt,
      def: () => DEFAULT_CHAT_SYSTEM_PROMPT,
      note: '该提示词是论文对话的 system 角色，论文标题/摘要/全文会作为上下文另行注入。改写后不要在其中重复正文内容，也不要要求 JSON（对话是自由文本）。',
    },
    translate: {
      label: '划线翻译提示词',
      get: (s) => s.translatePrompt,
      def: () => TRANSLATE_SYSTEM_PROMPT,
      note: '该提示词用于 PDF 划线的 AI 翻译，目标语言由用户消息给出。改写后必须仍要求「只输出译文」——多余的解释会被整段塞进浮窗。',
    },
    mineruNaming: {
      label: 'MinerU 公式命名提示词',
      get: (s) => (s.formulas && s.formulas.namingPrompt) || '',
      def: () => DEFAULT_MINERU_NAMING_PROMPT,
      note: 'MinerU 只产出 LaTeX，该提示词让 AI 批量产出 canonicalName/名称/解读，并要求逐条回显 index、可对噪声条目答 skip 拒判。改写后必须保留 index 对齐与 skip 机制（否则名字整体错位）。',
    },
  };

  // ---- 设置（提示词 / AI 接口 / 主题标签等） ----
  // GET /api/settings  返回提示词 + 生效 AI 配置（掩码）+ 内置默认，供设置面板渲染
  t.get('/api/settings', async ({ res, spaceId, space, store, gai }) => {
    store.settings = store.settings || {};
    const merged = withGlobalAi(store.settings, gai);
    const effConfig = applySettingsOverride(config, merged);
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
      // --- v3.58 新开放编辑的三条：笔记骨架 / 论文聊天 / 划线翻译 ---
      // notes 与 chat 的三级回退后端早就有了（scanner.js），此前只是没有 API 与设置页入口；
      // translate 原本是硬编码常量，本次一并接入同一套覆盖机制。
      notesPrompt: store.settings.notesPrompt || '',
      defaultNotesPrompt: DEFAULT_NOTES_PROMPT,
      chatSystemPrompt: store.settings.chatSystemPrompt || '',
      defaultChatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
      translatePrompt: store.settings.translatePrompt || '',
      defaultTranslatePrompt: TRANSLATE_SYSTEM_PROMPT,
      // --- 聊天预置 Prompt（@ 引用之外，输入框上方的快捷提问按钮，用户可自定义）---
      chatPresets: Array.isArray(store.settings.chatPresets) ? store.settings.chatPresets : [],
      // --- v3.2 保存的搜索预设（高级搜索命名预设，per-space）---
      savedSearches: Array.isArray(store.settings.savedSearches) ? store.settings.savedSearches : [],
      // --- v3.10 概念地图制品（只回显元信息，html 按需 GET 单个，避免此接口变重）---
      // v3.14：元信息含 status/error/hasHtml（后台生成任务态；僵尸 generating 解析为 error）
      conceptMaps: (Array.isArray(store.settings.conceptMaps) ? store.settings.conceptMaps : []).map(conceptMapMeta),
      // 生效 AI 配置（store.settings.ai 覆盖 config.ai 后）+ config 原值
      ai: aiSettingsView(effConfig, merged.ai),
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
        notesPrompt: !!ov.notesPrompt,
        chatSystemPrompt: !!ov.chatSystemPrompt,
        translatePrompt: !!ov.translatePrompt,
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

  // PUT /api/settings/notes-prompt  笔记骨架提示词。空串=恢复内置默认（同其它 *-prompt）。
  t.put('/api/settings/notes-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.notesPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { notesPrompt: store.settings.notesPrompt });
  });

  // PUT /api/settings/chat-prompt  论文聊天的 system 提示词。
  t.put('/api/settings/chat-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.chatSystemPrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { chatSystemPrompt: store.settings.chatSystemPrompt });
  });

  // PUT /api/settings/translate-prompt  划线翻译（engine=ai）的 system 提示词。
  t.put('/api/settings/translate-prompt', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    store.settings.translatePrompt = typeof op.value === 'string' ? op.value.trim() : '';
    store.settings.updatedAt = Date.now();
    await save(store);
    return ok(res, { translatePrompt: store.settings.translatePrompt });
  });

  // POST /api/settings/prompt-refine —— AI 改写提示词（v3.55，SSE 流式）。
  //   memory 式编辑：用户用自然语言提修改需求，模型基于当前提示词产出完整修改稿。
  //   body: { key, request, base? }——base 省略时取「覆盖值 || 内置默认」；多轮修改时前端传上一稿。
  //   不落库：前端预览后由用户「采用」时走既有 PUT 端点保存。陷阱 42：走流式防代理空闲超时。
  t.post('/api/settings/prompt-refine', async ({ res, body, store, gai }) => {
    const op = JSON.parse(body || '{}');
    const spec = PROMPT_REFINE_KEYS[op.key];
    if (!spec) return fail(res, 400, 'unknown prompt key: ' + op.key);
    const request = String(op.request || '').trim();
    if (!request) return fail(res, 400, 'request required');
    store.settings = store.settings || {};
    const base =
      typeof op.base === 'string' && op.base.trim()
        ? op.base
        : String(spec.get(store.settings) || '').trim() || spec.def();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const system = [
        '你是一位资深的 LLM 提示词工程专家。用户会给你一条正在使用的提示词和一句自然语言修改要求，',
        '你要输出改写后的完整提示词正文。',
        '',
        `这条提示词的背景：${spec.label}。${spec.note}`,
        '',
        '硬性要求：',
        '- 只输出改写后的提示词正文本身——不要任何解释、前言、总结，不要用 Markdown 代码块包裹整条输出。',
        '- 完整输出整条提示词（不是 diff、不是片段），未被要求修改的部分原样保留。',
        '- 保持原提示词的语言（中文提示词就用中文，英文就用英文）与整体结构。',
      ].join('\n');
      const user = `【当前提示词】\n${base}\n\n【修改要求】\n${request}`;
      const effConfig = aiSvc.applySettingsOverride(config, aiSvc.withGlobalAi(store.settings, gai));
      await aiSvc.callChatStream({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        config: effConfig,
        chatParams: { timeoutMs: 180000 },
        onToken: (tok) => send('token', { tok }),
      });
      send('done', {});
    } catch (e) {
      send('fail', { error: e && e.message ? e.message : '改写失败' });
    }
    return res.end();
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
  t.put('/api/settings/scan', async ({ res, body, spaceId, store, save, gai }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    let n = parseInt(op.scanIntervalMinutes, 10);
    if (!Number.isFinite(n) || n < 0) n = 0;
    store.settings.scanIntervalMinutes = n;
    store.settings.updatedAt = Date.now();
    await save(store);
    if (scanner && scanner.reschedule) await scanner.reschedule(spaceId, n);
    const eff = applySettingsOverride(config, withGlobalAi(store.settings, gai));
    return ok(res, { scan: { scanIntervalMinutes: eff.scanIntervalMinutes ?? 5 } });
  });

  // PUT /api/settings/arxiv  body: { enabled?, titleSimilarityThreshold?, minIntervalMs? }  白名单，未传不改。
  t.put('/api/settings/arxiv', async ({ res, body, store, save, gai }) => {
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
    const eff = applySettingsOverride(config, withGlobalAi(store.settings, gai));
    return ok(res, { arxiv: arxivSettingsView(eff.arxiv) });
  });

  // PUT /api/settings/translate  body: { engine?, targetLang? }  划线翻译引擎 + 目标语言。
  t.put('/api/settings/translate', async ({ res, body, store, save, gai }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const next = { ...(store.settings.translate || {}) };
    if (op.engine === 'bing' || op.engine === 'google' || op.engine === 'ai' || op.engine === 'none')
      next.engine = op.engine;
    if (typeof op.targetLang === 'string' && op.targetLang.trim()) next.targetLang = op.targetLang.trim();
    store.settings.translate = next;
    store.settings.updatedAt = Date.now();
    await save(store);
    const eff = applySettingsOverride(config, withGlobalAi(store.settings, gai));
    return ok(res, { translate: translateSettingsView(eff.translate) });
  });

  // PUT /api/settings/formulas  公式抽取引擎：engine=ai|mineru，mineruUrl，namingPrompt（MinerU 命名提示词）。
  //   仿 translate 段：白名单枚举校验 + trim；空串 mineruUrl/namingPrompt=未设置（回退 config/默认）。
  t.put('/api/settings/formulas', async ({ res, body, store, save, gai }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const next = { ...(store.settings.formulas || {}) };
    if (op.engine === 'ai' || op.engine === 'mineru') next.engine = op.engine;
    if (typeof op.mineruUrl === 'string') next.mineruUrl = op.mineruUrl.trim();
    if (typeof op.namingPrompt === 'string') next.namingPrompt = op.namingPrompt.trim();
    store.settings.formulas = next;
    store.settings.updatedAt = Date.now();
    await save(store);
    const eff = applySettingsOverride(config, withGlobalAi(store.settings, gai));
    return ok(res, { formulas: formulasSettingsView(eff.formulas) });
  });

  // PUT /api/settings/discover  body: 白名单字段 + weights{rel,auth,rec}；semanticScholarApiKey 掩码协议同 ai.apiKey。
  t.put('/api/settings/discover', async ({ res, body, store, save, gai }) => {
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
    const eff = applySettingsOverride(config, withGlobalAi(store.settings, gai));
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
      'notesPrompt',
      'chatSystemPrompt',
      'translatePrompt',
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
