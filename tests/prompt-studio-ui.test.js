// 提示词工作台 UI 测试（v3.55，jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）。
// 覆盖：studio 挂载（只读视图 + 内置默认角标 + composer）/ 手动编辑进入与取消回滚 /
// AI 改写全链（SSE 假流 → 修改稿预览 → 采用并保存 → 视图与角标更新）/ 恢复默认。
// 假后端注意：body 已被 ui.js 预解析为对象；PWDialog 是自动确认桩（见 helpers/ui.js 注释）。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('prompt-studio-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

/** 假 SSE 响应：streamPostSse 只要求 ok/status/json + body.getReader()。 */
function sseRes(events) {
  const enc = new TextEncoder();
  const chunks = events.map(([ev, data]) => enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    json: async () => ({}),
    body: {
      getReader: () => {
        let i = 0;
        return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
      },
    },
  };
}

function makeSettings() {
  return {
    summaryPrompt: settingsState.summaryPrompt,
    defaultPrompt: '默认总结提示词正文',
    tagsPrompt: '', defaultTagsPrompt: '默认标签', formulaPrompt: '', defaultFormulaPrompt: '默认公式',
    conceptPrompt: '', defaultConceptPrompt: '默认概念', conceptMapPrompt: '', defaultConceptMapPrompt: '默认地图',
    chatPresets: [], savedSearches: [], conceptMaps: [],
    ai: { channels: [], activeChannelId: '', maxInputTokens: 32000, timeoutMs: 120000, taskMaxInputTokens: {} },
    configAi: { baseURL: '', model: '' },
    scan: { scanIntervalMinutes: 5 }, configScan: { scanIntervalMinutes: 5 },
    arxiv: { enabled: true }, configArxiv: {},
    discover: { weights: {} }, configDiscover: { weights: {} },
    translate: { engine: 'google', targetLang: 'zh-CN' }, configTranslate: { engine: 'google', targetLang: 'zh-CN' },
    formulas: { engine: 'ai', mineruUrl: '', namingPrompt: '' }, configFormulas: { engine: 'ai' },
    defaultNamingPrompt: '默认命名',
    overrides: settingsState.summaryPrompt ? { summaryPrompt: true } : {},
    system: { host: '0.0.0.0', port: 8888, version: '3.55.0', papers: 1, uptime: 1, rawConfig: {} },
  };
}

let settingsState;
let refineCalls;

before(async () => {
  settingsState = { summaryPrompt: '' };
  refineCalls = [];
  ui = await bootUi({
    listItems: [],
    details: {},
    routes: {
      '/api/settings': () => jsonRes(makeSettings()),
      '/api/settings/summary-prompt': ({ body }) => {
        settingsState.summaryPrompt = String((body && body.value) || '').trim();
        return jsonRes({ summaryPrompt: settingsState.summaryPrompt });
      },
      '/api/settings/prompt-refine': ({ body }) => {
        refineCalls.push(body);
        return sseRes([
          ['token', { tok: 'AI 改写' }],
          ['token', { tok: '后的稿子' }],
          ['done', {}],
        ]);
      },
    },
  });
  // 进入设置 →「提示词」页 → 展开总结提示词（v3.56：提示词从平级 tab 收成一页行列表）
  $('btn-settings').click();
  await sleep(120);
  ui.document.querySelector('.settings-nav-item[data-tab="prompts"]').click();
  await sleep(120);
  ui.document.querySelector('#prompt-rows [data-prompt-open="summary"]').click();
  await sleep(60);
});

test('studio 挂载：只读视图显示内置默认 + 角标 + composer', () => {
  const box = ui.document.querySelector('.ps[data-ps="summary"]');
  assert.ok(box, 'studio 容器存在');
  const view = box.querySelector('.ps-view');
  assert.ok(view.textContent.includes('默认总结提示词正文'), '无覆盖时只读视图展示内置默认');
  assert.strictEqual(box.querySelector('.ps-src').textContent, '内置默认');
  assert.ok(box.querySelector('.ps-composer .ps-input'), 'composer 输入框存在');
  assert.ok(box.querySelector('.ps-composer .ps-send'), '发送按钮存在');
  assert.ok($('summary-prompt-edit'), '手动编辑 textarea 以旧 id 生成（loadSettingsData 回显兼容）');
  // v3.56：手动编辑入口移出 composer，落在只读视图上方的工具行——「改正文」与
  // 「让 AI 改」是两条通道，不该共用一个控件
  assert.ok(box.querySelector('.ps-head .ps-manual'), '「编辑」在内容头部工具行');
  assert.strictEqual(box.querySelector('.ps-composer .ps-manual'), null, 'composer 里不再有手动编辑钮');
});

test('手动编辑：进入预填生效文本，取消回滚未保存改动', async () => {
  const box = ui.document.querySelector('.ps[data-ps="summary"]');
  box.querySelector('.ps-manual').click();
  await sleep(20);
  assert.strictEqual(box.querySelector('.ps-edit').hidden, false, '编辑区可见');
  assert.strictEqual(box.querySelector('.ps-viewwrap').hidden, true, '只读视图整体让位');
  assert.strictEqual(box.querySelector('.ps-manual').hidden, true, '编辑态下「编辑」钮收起');
  assert.strictEqual(box.querySelector('.ps-head').hidden, false, '头部行本身保留，编辑框才不会上跳');
  assert.strictEqual(box.querySelector('.ps-composer').hidden, true, '编辑态下 AI composer 收起，避免两条通道并行');
  const ta = $('summary-prompt-edit');
  assert.ok(ta.value.includes('默认总结提示词正文'), '覆盖为空时预填内置默认便于在其基础上改');
  ta.value = '改了一半不想要了';
  box.querySelector('.ps-cancel').click();
  await sleep(20);
  assert.strictEqual(box.querySelector('.ps-edit').hidden, true, '取消后回到只读视图');
  assert.strictEqual(box.querySelector('.ps-manual').hidden, false, '「编辑」钮随之回来');
  assert.ok(box.querySelector('.ps-view').textContent.includes('默认总结提示词正文'), '未保存改动已回滚');
});

test('AI 改写全链：SSE 修改稿 → 采用并保存 → 视图/角标/覆盖徽标更新', async () => {
  const box = ui.document.querySelector('.ps[data-ps="summary"]');
  const input = box.querySelector('.ps-input');
  input.value = '加一节局限性';
  box.querySelector('.ps-send').click();
  for (let i = 0; i < 50 && !box.querySelector('.ps-draft-status').classList.contains('done'); i++) await sleep(20);
  assert.strictEqual(refineCalls.length, 1, '调用了 prompt-refine');
  assert.strictEqual(refineCalls[0].key, 'summary');
  assert.strictEqual(refineCalls[0].request, '加一节局限性');
  assert.ok(refineCalls[0].base.includes('默认总结提示词正文'), 'base = 当前生效提示词');
  assert.strictEqual(box.querySelector('.ps-draft-body').textContent, 'AI 改写后的稿子', 'token 累积成完整修改稿');
  assert.strictEqual(box.querySelector('.ps-apply').disabled, false, '完成后可采用');

  box.querySelector('.ps-apply').click();
  for (let i = 0; i < 50 && box.querySelector('.ps-draft').hidden !== true; i++) await sleep(20);
  assert.strictEqual(settingsState.summaryPrompt, 'AI 改写后的稿子', 'PUT 保存了修改稿');
  assert.ok(box.querySelector('.ps-view').textContent.includes('AI 改写后的稿子'), '只读视图更新为新提示词');
  assert.strictEqual(box.querySelector('.ps-src').textContent, '自定义');
  assert.strictEqual($('ovr-summary').hidden, false, '设置头「自定义」徽标点亮');
});

test('多轮修改：有未采用修改稿时以其为 base 继续改；放弃后 base 回落当前生效', async () => {
  const box = ui.document.querySelector('.ps[data-ps="summary"]');
  // 第一轮（基于刚保存的自定义提示词）
  box.querySelector('.ps-input').value = '再精简';
  box.querySelector('.ps-send').click();
  for (let i = 0; i < 50 && !box.querySelector('.ps-draft-status').classList.contains('done'); i++) await sleep(20);
  assert.ok(refineCalls[1].base.includes('AI 改写后的稿子'), '第一轮 base = 已保存的自定义提示词');
  // 第二轮（不采用，直接再提需求——base 应是上一稿）
  box.querySelector('.ps-input').value = '语气再正式些';
  box.querySelector('.ps-send').click();
  for (let i = 0; i < 50 && !box.querySelector('.ps-draft-status').classList.contains('done'); i++) await sleep(20);
  assert.strictEqual(refineCalls[2].base, 'AI 改写后的稿子', '第二轮 base = 上一稿修改稿');
  box.querySelector('.ps-discard').click();
  await sleep(20);
  assert.strictEqual(box.querySelector('.ps-draft').hidden, true, '放弃后修改稿收起');
});

test('恢复默认：PUT 空串 → 视图回到内置默认 + 徽标熄灭', async () => {
  const box = ui.document.querySelector('.ps[data-ps="summary"]');
  $('btn-summary-prompt-default').click(); // PWDialog 桩自动确认
  for (let i = 0; i < 50 && settingsState.summaryPrompt !== ''; i++) await sleep(20);
  for (let i = 0; i < 50 && !box.querySelector('.ps-view').textContent.includes('默认总结提示词正文'); i++) await sleep(20);
  assert.strictEqual(box.querySelector('.ps-src').textContent, '内置默认');
  assert.strictEqual($('ovr-summary').hidden, true, '覆盖徽标熄灭');
});
