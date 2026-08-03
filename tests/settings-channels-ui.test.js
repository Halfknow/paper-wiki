// 模型渠道卡片 UI 测试（jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）。
// 覆盖（v3.13）：渠道卡片渲染 / 编辑卡模型选择器（自定义下拉——全量可见、子串过滤、
// 键盘导航选中回填 tokens、chevron 展开、点外关闭、大列表截断提示）/ 设为默认 PUT。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('settings-channels-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** /api/settings 最小完整 mock（loadSettingsData 全字段回显不报错）。 */
function makeSettings(channels, activeChannelId) {
  const view = (c) => ({
    id: c.id, name: c.name, baseURL: c.baseURL, model: c.model,
    maxInputTokens: c.maxInputTokens ?? null,
    hasApiKey: !!c.hasKey, apiKeyMasked: c.hasKey ? 'sk-****xxxx' : '',
    active: c.id === activeChannelId,
  });
  const active = channels.find((c) => c.id === activeChannelId) || {};
  return {
    summaryPrompt: '', defaultPrompt: '默认总结', tagsPrompt: '', defaultTagsPrompt: '默认标签',
    formulaPrompt: '', defaultFormulaPrompt: '默认公式', conceptPrompt: '', defaultConceptPrompt: '默认概念',
    chatPresets: [], savedSearches: [], conceptMaps: [],
    ai: {
      baseURL: active.baseURL || '', model: active.model || '',
      apiKeyMasked: '', hasApiKey: !!active.hasKey,
      channels: channels.map(view), activeChannelId,
      maxInputTokens: 32000, timeoutMs: 120000,
      taskMaxInputTokens: {}, taskMaxInputChars: {},
    },
    configAi: { baseURL: '', model: '' },
    scan: { scanIntervalMinutes: 5 }, configScan: { scanIntervalMinutes: 5 },
    arxiv: { enabled: true }, configArxiv: {},
    discover: { weights: {} }, configDiscover: { weights: {} },
    translate: { engine: 'google', targetLang: 'zh-CN' }, configTranslate: { engine: 'google', targetLang: 'zh-CN' },
    formulas: { engine: 'ai', mineruUrl: '', namingPrompt: '' }, configFormulas: { engine: 'ai' },
    defaultNamingPrompt: '默认命名',
    overrides: { ai: ['channels'] },
    system: { host: '0.0.0.0', port: 8888, version: '2.7.0', papers: 1, uptime: 1, rawConfig: {} },
  };
}

function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

const CHANNELS = [
  { id: 'ch_default', name: '智谱 GLM', baseURL: 'http://glm/v1', model: 'glm-5.2', maxInputTokens: 200000, hasKey: true },
  { id: 'ch_kimi', name: 'Kimi', baseURL: 'https://api.kimi.com/coding/v1', model: 'k3', maxInputTokens: 1000000, hasKey: true },
];
const UPSTREAM_MODELS = [
  { id: 'glm-5.2', contextLength: 200000, displayName: null },
  { id: 'k3', contextLength: 1000000, displayName: 'K3' },
  { id: 'k3-256k', contextLength: 262144, displayName: 'K3 256K' },
];

let backend;
let settingsState;

before(async () => {
  settingsState = { channels: CHANNELS.map((c) => ({ ...c })), active: 'ch_default' };
  ui = await bootUi({
    listItems: [
      {
        id: 'p1', filename: 'a.pdf', title: '测试论文', authors: [], year: '2024', abstract: '',
        arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
        fulltextChars: 100, summaryExcerpt: 'TL;DR', status: 'ready', error: null,
        tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
        readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false, conceptCount: 0,
      },
    ],
    details: {},
    routes: {
      '/api/settings': ({ method }) => jsonRes(makeSettings(settingsState.channels, settingsState.active)),
      '/api/settings/ai/models': () => jsonRes({ models: UPSTREAM_MODELS, source: 'upstream' }),
      '/api/settings/ai/channels': ({ body }) => {
        if (body && Array.isArray(body.channels)) {
          settingsState.channels = body.channels.map((c) => ({ ...c, hasKey: true }));
          settingsState.active = body.activeChannelId;
        }
        return jsonRes({ ai: makeSettings(settingsState.channels, settingsState.active).ai });
      },
    },
  });
  backend = ui.backend;
  // 进入设置 → 模型渠道面板
  $('btn-settings').click();
  await sleep(120);
  ui.document.querySelector('.settings-nav-item[data-tab="ai"]').click();
  await sleep(120);
});

test('渠道卡片：两张卡渲染，默认徽标在 GLM 上', () => {
  const cards = [...ui.document.querySelectorAll('#ch-grid .ch-card')];
  assert.strictEqual(cards.length, 2);
  assert.ok(cards[0].classList.contains('active'));
  assert.ok(cards[0].querySelector('.ch-badge'), '默认卡有「默认」徽标');
  assert.ok(!cards[1].querySelector('.ch-badge'));
  assert.strictEqual(cards[0].querySelector('.ch-model').textContent.trim().startsWith('glm-5.2'), true);
});

test('编辑卡模型选择器：拉取后菜单展示全部模型（不再用 datalist）', async () => {
  const card = ui.document.querySelector('#ch-grid .ch-card[data-id="ch_default"]');
  card.querySelector('[data-act="edit"]').click();
  await sleep(20);
  const editCard = ui.document.querySelector('.ch-card.editing');
  assert.ok(editCard, '编辑卡出现');
  assert.strictEqual(editCard.querySelector('datalist'), null, '不应再使用原生 datalist');
  editCard.querySelector('[data-act="fetch-models"]').click();
  await sleep(60);
  const menu = editCard.querySelector('.chf-model-menu');
  assert.strictEqual(menu.hidden, false, '拉取后菜单自动展开');
  const items = [...menu.querySelectorAll('.chf-mm-item')];
  assert.strictEqual(items.length, 3, '全部 3 个模型可见（不被输入框当前值过滤掉）');
  assert.ok(items[1].textContent.includes('k3'));
  assert.ok(items[1].querySelector('.chf-mm-ctx').textContent.includes('1M'), '上下文徽标 1M');
  assert.ok(items[1].querySelector('.chf-mm-name').textContent.includes('K3'), 'displayName 展示');
  assert.ok(menu.querySelector('.chf-mm-item.cur'), '当前模型高亮 cur');
});

test('模型菜单：输入过滤 → 键盘选中回填 tokens；chevron 展开全量；点外关闭', async () => {
  const editCard = ui.document.querySelector('.ch-card.editing');
  const input = editCard.querySelector('.chf-model');
  const menu = editCard.querySelector('.chf-model-menu');
  // 输入过滤（子串）
  input.value = 'k3';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await sleep(20);
  assert.strictEqual(menu.querySelectorAll('.chf-mm-item').length, 2, 'k3 过滤剩 2 项');
  // 键盘 ↓ + Enter 选中第二项（k3-256k）
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(20);
  assert.strictEqual(input.value, 'k3-256k');
  assert.strictEqual(editCard.querySelector('.chf-tokens').value, '262144', '选中自动回填上下文 tokens');
  assert.strictEqual(menu.hidden, true, '选中后菜单关闭');
  // chevron 展开全量（不按当前值过滤）
  editCard.querySelector('[data-act="model-menu"]').click();
  await sleep(20);
  assert.strictEqual(menu.hidden, false);
  assert.strictEqual(menu.querySelectorAll('.chf-mm-item').length, 3, 'chevron 展示全量');
  // 点外部关闭
  ui.document.body.click();
  await sleep(20);
  assert.strictEqual(menu.hidden, true, '点选择器外部菜单关闭');
});

test('设为默认：PUT channels 带新 activeChannelId，徽标迁移', async () => {
  // 退出编辑态
  ui.document.querySelector('.ch-card.editing [data-act="cancel"]').click();
  await sleep(20);
  const kimiCard = ui.document.querySelector('#ch-grid .ch-card[data-id="ch_kimi"]');
  const beforePosts = backend.posts.length;
  kimiCard.querySelector('[data-act="default"]').click();
  await sleep(80);
  const put = backend.posts.slice(beforePosts).find((p) => p.path.startsWith('/api/settings/ai/channels'));
  assert.ok(put, '发出 PUT /api/settings/ai/channels');
  assert.strictEqual(put.body.activeChannelId, 'ch_kimi');
  assert.strictEqual(settingsState.active, 'ch_kimi');
  await sleep(80); // loadSettingsData 后台刷新
  const kimiAfter = ui.document.querySelector('#ch-grid .ch-card[data-id="ch_kimi"]');
  assert.ok(kimiAfter.querySelector('.ch-badge'), '默认徽标迁移到 Kimi');
  assert.ok(kimiAfter.classList.contains('active'));
});

test('大列表截断：超过 100 个匹配时只渲染前 100 并提示过滤', async () => {
  // 临时换上游模型列表（150 个）
  const many = Array.from({ length: 150 }, (_, i) => ({ id: 'model-' + i, contextLength: null, displayName: null }));
  backend.fetch; // 保持引用
  const origModels = UPSTREAM_MODELS.slice();
  UPSTREAM_MODELS.splice(0, UPSTREAM_MODELS.length, ...many);
  try {
    ui.document.querySelector('#ch-grid .ch-card[data-id="ch_kimi"] [data-act="edit"]').click();
    await sleep(20);
    const editCard = ui.document.querySelector('.ch-card.editing');
    editCard.querySelector('[data-act="fetch-models"]').click();
    await sleep(60);
    const menu = editCard.querySelector('.chf-model-menu');
    assert.strictEqual(menu.querySelectorAll('.chf-mm-item').length, 100, '只渲染前 100 个');
    assert.ok(menu.textContent.includes('共 150 个匹配'), '提示继续输入过滤');
    editCard.querySelector('[data-act="cancel"]').click();
    await sleep(20);
  } finally {
    UPSTREAM_MODELS.splice(0, UPSTREAM_MODELS.length, ...origModels);
  }
});
