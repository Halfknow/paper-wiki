'use strict';

// settings-ai 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const crypto = require('crypto');
const {
  applySettingsOverride,
  callChat,
  listModels,
  INPUT_BUDGET_TASKS,
  DEFAULT_MAX_INPUT_TOKENS,
} = require('../../services/ai');
const { aiSettingsView, resolveChannelApiKey } = require('../views');

function register(t, ctx) {
  const { ok, fail, config, isProd } = ctx;

  // PUT /api/settings/ai  body: { baseURL?, apiKey?, model?, maxInputTokens?, maxInputChars?, timeoutMs?, taskMaxInputTokens?, taskMaxInputChars? }
  //   运行时覆盖 config.ai（写入 store.settings.ai，热生效，无需重启）。
  //   - 白名单字段，未传的不覆盖。
  //   - v3.11：maxInputTokens（token 计，主字段）+ 旧 maxInputChars（废弃别名）并存；前端只发 tokens。
  //   - apiKey 为空串 → 清空；为掩码 '****' 或未传 → 保持原值（前端掩码回显误传保护）。
  t.put('/api/settings/ai', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings = store.settings || {};
    const cur = store.settings.ai || {};
    const next = { ...cur };
    if (typeof op.baseURL === 'string') next.baseURL = op.baseURL.trim();
    if (typeof op.model === 'string') next.model = op.model.trim();
    if (op.maxInputTokens != null) next.maxInputTokens = Number(op.maxInputTokens) || DEFAULT_MAX_INPUT_TOKENS;
    if (op.maxInputChars != null) next.maxInputChars = Number(op.maxInputChars) || 24000;
    if (op.timeoutMs != null) next.timeoutMs = Number(op.timeoutMs) || 120000;
    // taskMaxInputTokens / taskMaxInputChars（每任务输入预算）：只收白名单任务键；null/空/非正数写 null（= 跟随全局）
    const mergeTaskBudget = (field) => {
      if (op[field] === undefined) return;
      const src = op[field] && typeof op[field] === 'object' ? op[field] : {};
      const t = { ...(cur[field] || {}) };
      for (const k of INPUT_BUDGET_TASKS) {
        if (!(k in src)) continue;
        const v = Number(src[k]);
        t[k] = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
      }
      next[field] = t;
    };
    mergeTaskBudget('taskMaxInputTokens');
    mergeTaskBudget('taskMaxInputChars');
    // apiKey：显式空串=清空；掩码或未传=保持原值
    if (op.apiKey === '') next.apiKey = '';
    else if (typeof op.apiKey === 'string' && op.apiKey.trim() && !/^\*+$/i.test(op.apiKey)) {
      next.apiKey = op.apiKey.trim();
    }
    store.settings.ai = next;
    store.settings.updatedAt = Date.now();
    await save(store);
    const effConfig = applySettingsOverride(config, store.settings);
    return ok(res, { ai: aiSettingsView(effConfig, store.settings.ai) });
  });

  // PUT /api/settings/ai/channels  body: { channels: [...], activeChannelId? }  全量替换渠道列表（v3.13）。
  //   渠道 = OpenAI 兼容端点卡片 { id?, name?, baseURL, apiKey?, model, maxInputTokens? }。
  //   - id 缺省生成 ch_xxxxxxxx；name 缺省取 baseURL host。
  //   - apiKey：掩码（全 *）/未传 → 保留同 id 已存 key（含旧部署合成 ch_default 的生效 key）；空串 → 清空。
  //   - baseURL / model 必填（空则 400）；activeChannelId 必须命中，否则回落第一个渠道。
  //   - 首次保存渠道（列表非空）时把旧版顶层 baseURL/apiKey/model 覆盖迁移进渠道并删除（渠道成单一事实源）。
  t.put('/api/settings/ai/channels', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const list = Array.isArray(op.channels) ? op.channels : [];
    store.settings = store.settings || {};
    const cur = store.settings.ai || {};
    const effBefore = applySettingsOverride(config, store.settings);
    // 旧 key 解析表：已存渠道 + 旧部署合成默认渠道（ch_default → 当前生效 key）
    const oldKeyOf = (id) => {
      const hit = (Array.isArray(cur.channels) ? cur.channels : []).find((c) => c && c.id === id);
      if (hit) return hit.apiKey;
      if (id === 'ch_default') return effBefore.ai.apiKey;
      return undefined;
    };
    const clean = [];
    const seenIds = new Set();
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] && typeof list[i] === 'object' ? list[i] : {};
      const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      if (!baseURL || !model) return fail(res, 400, `第 ${i + 1} 个渠道缺少 baseURL 或 model`);
      let id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : '';
      if (!id || seenIds.has(id)) id = 'ch_' + crypto.randomBytes(4).toString('hex');
      seenIds.add(id);
      let name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) {
        try {
          name = new URL(baseURL).host;
        } catch {
          name = model;
        }
      }
      const tokens = Number(raw.maxInputTokens);
      clean.push({
        id,
        name: name.slice(0, 40),
        baseURL,
        apiKey: resolveChannelApiKey(raw.apiKey, id, oldKeyOf) || '',
        model,
        maxInputTokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : null,
      });
    }
    const next = { ...cur };
    if (clean.length) {
      // 迁移：渠道接管后删除旧版顶层三元组，避免双事实源
      delete next.baseURL;
      delete next.apiKey;
      delete next.model;
      let active = typeof op.activeChannelId === 'string' ? op.activeChannelId : cur.activeChannelId;
      if (!clean.some((c) => c.id === active)) active = clean[0].id;
      next.channels = clean;
      next.activeChannelId = active;
    } else {
      // 清空渠道：回到旧版顶层字段 / config.json 语义
      delete next.channels;
      delete next.activeChannelId;
    }
    store.settings.ai = next;
    store.settings.updatedAt = Date.now();
    await save(store);
    const effConfig = applySettingsOverride(config, store.settings);
    return ok(res, { ai: aiSettingsView(effConfig, store.settings.ai) });
  });

  // POST /api/settings/ai/models  body: { baseURL?, apiKey?, channelId? }  按表单值拉上游 /v1/models（渠道编辑器用）。
  //   apiKey 掩码/未传 → 按 channelId 取已存渠道 key（缺省回落当前生效 key）。永不抛错（listModels 自带回退）。
  t.post('/api/settings/ai/models', async ({ res, body, store }) => {
    const op = JSON.parse(body || '{}');
    const effConfig = applySettingsOverride(config, store.settings || {});
    const ch = (
      store.settings && store.settings.ai && Array.isArray(store.settings.ai.channels) ? store.settings.ai.channels : []
    ).find((c) => c && c.id === op.channelId);
    const baseURL =
      typeof op.baseURL === 'string' && op.baseURL.trim()
        ? op.baseURL.trim()
        : (ch && ch.baseURL) || effConfig.ai.baseURL;
    let apiKey = typeof op.apiKey === 'string' ? op.apiKey.trim() : '';
    if (!apiKey || /^\*+$/.test(apiKey)) apiKey = (ch && ch.apiKey) || effConfig.ai.apiKey || '';
    const adhoc = { ...effConfig, ai: { ...effConfig.ai, baseURL, apiKey } };
    try {
      const r = await listModels({ config: adhoc });
      return ok(res, r);
    } catch (e) {
      return fail(res, 500, isProd ? '列出模型失败' : `列出模型失败：${e.message}`);
    }
  });

  // POST /api/settings/test  用当前生效配置发一条 ping 消息验证连通性。
  //   body 可选透传表单值 { baseURL?, apiKey?, model? }（覆盖生效配置），让用户改完不保存也能测。
  t.post('/api/settings/test', async ({ res, body, store }) => {
    const op = JSON.parse(body || '{}');
    const effConfig = applySettingsOverride(config, store.settings);
    // v3.13：channelId 指向已存渠道时以其为基底（卡片「测试连接」），否则用当前生效配置
    const ch = (
      store.settings && store.settings.ai && Array.isArray(store.settings.ai.channels) ? store.settings.ai.channels : []
    ).find((c) => c && c.id === op.channelId);
    const testAi = { ...effConfig.ai };
    if (ch) {
      testAi.baseURL = ch.baseURL || testAi.baseURL;
      testAi.model = ch.model || testAi.model;
      testAi.apiKey = ch.apiKey || '';
    }
    // 表单透传覆盖（未传则用基底值）：baseURL/model 非空才覆盖，apiKey 非掩码才覆盖
    if (typeof op.baseURL === 'string' && op.baseURL.trim()) testAi.baseURL = op.baseURL.trim();
    if (typeof op.model === 'string' && op.model.trim()) testAi.model = op.model.trim();
    if (typeof op.apiKey === 'string' && op.apiKey.trim() && !/^\*+$/i.test(op.apiKey))
      testAi.apiKey = op.apiKey.trim();
    const testConfig = { ...effConfig, ai: testAi };
    try {
      await callChat({
        messages: [
          { role: 'system', content: 'Reply with the single word: ok' },
          { role: 'user', content: 'ping' },
        ],
        config: testConfig,
        jsonMode: false,
      });
      return ok(res, { ok: true });
    } catch (e) {
      return fail(res, 200, isProd ? '连接失败，请检查配置' : e.message);
    }
  });
}

module.exports = { register };
