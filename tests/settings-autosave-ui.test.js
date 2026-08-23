// 设置页即时保存 UI 测试（v3.56，jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）。
//
// v3.56 把设置页对齐 claude.ai：面板底部的「保存」按钮全部取消，控件变更即 PUT。
// 这里锁住三件容易回退的事：
//   1. change 事件真的触发了对应分区的 PUT（而不是静默什么都没发生）；
//   2. 保存后的整页回填不会覆盖用户手上正在编辑的那个输入框（setField 的聚焦保护）；
//   3. 失败时行为可见——节标题旁的指示变成 error 态，不是静默吞掉。
//
// 假后端注意：body 已被 ui.js 预解析为对象；PWDialog 是自动确认桩（见 helpers/ui.js 注释）。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('settings-autosave-ui')) return;

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

/** /api/settings 最小完整 mock（loadSettingsData 全字段回显不报错）。 */
function makeSettings(state) {
  return {
    summaryPrompt: '',
    defaultPrompt: '默认总结',
    tagsPrompt: '',
    defaultTagsPrompt: '默认标签',
    formulaPrompt: '',
    defaultFormulaPrompt: '默认公式',
    conceptPrompt: '',
    defaultConceptPrompt: '默认概念',
    conceptMapPrompt: '',
    defaultConceptMapPrompt: '默认地图',
    chatPresets: [],
    savedSearches: [],
    conceptMaps: [],
    ai: { channels: [], activeChannelId: '', maxInputTokens: 32000, timeoutMs: 120000, taskMaxInputTokens: {} },
    configAi: { baseURL: '', model: '' },
    scan: { scanIntervalMinutes: state.scanInterval },
    configScan: { scanIntervalMinutes: 5 },
    arxiv: { enabled: state.arxivEnabled, titleSimilarityThreshold: 0.8, minIntervalMs: 3000 },
    configArxiv: {},
    discover: { weights: {} },
    configDiscover: { weights: {} },
    translate: { engine: 'google', targetLang: 'zh-CN' },
    configTranslate: { engine: 'google', targetLang: 'zh-CN' },
    formulas: { engine: 'ai', mineruUrl: '', namingPrompt: '' },
    configFormulas: { engine: 'ai' },
    defaultNamingPrompt: '默认命名',
    overrides: {},
    system: { host: '0.0.0.0', port: 8888, version: '3.56.0', papers: 1, uptime: 60, rawConfig: {} },
  };
}

let state;
let puts;
let failNext;

before(async () => {
  state = { scanInterval: 5, arxivEnabled: true };
  puts = [];
  failNext = null;
  ui = await bootUi({
    listItems: [],
    details: {},
    routes: {
      '/api/settings': () => jsonRes(makeSettings(state)),
      '/api/settings/scan': ({ body }) => {
        puts.push(['scan', body]);
        if (failNext === 'scan')
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ ok: false, error: '后端拒绝了' }),
          };
        state.scanInterval = body.scanIntervalMinutes;
        return jsonRes({ scan: { scanIntervalMinutes: state.scanInterval } });
      },
      '/api/settings/arxiv': ({ body }) => {
        puts.push(['arxiv', body]);
        if (typeof body.enabled === 'boolean') state.arxivEnabled = body.enabled;
        return jsonRes({ arxiv: { enabled: state.arxivEnabled } });
      },
      '/api/settings/ai': ({ body }) => {
        puts.push(['ai', body]);
        return jsonRes({ ai: {} });
      },
    },
  });
  $('btn-settings').click();
  await sleep(150);
});

beforeEach(() => {
  puts.length = 0;
  failNext = null;
});

/** 改一个输入框的值并派发 change（= 用户 blur 或按 Enter 的时刻）。 */
function change(id, value) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}

async function goto(tab) {
  ui.document.querySelector(`.settings-nav-item[data-tab="${tab}"]`).click();
  await sleep(120);
}

test('设置页不再有任何「保存」按钮', async () => {
  await goto('ingest');
  for (const id of [
    'btn-scan-save',
    'btn-arxiv-save',
    'btn-discover-save',
    'btn-translate-save',
    'btn-formula-engine-save',
    'btn-ai-save',
  ]) {
    assert.strictEqual($(id), null, `${id} 应已随即时保存移除`);
  }
});

test('数字输入 change → 立即 PUT 对应分区', async () => {
  await goto('ingest');
  change('scan-interval', '12');
  await sleep(120);
  const scan = puts.filter(([k]) => k === 'scan');
  assert.strictEqual(scan.length, 1, '只打一次 /api/settings/scan');
  assert.strictEqual(scan[0][1].scanIntervalMinutes, 12);
});

test('开关 change → 立即 PUT，且指示进入已保存态', async () => {
  await goto('ingest');
  change('arxiv-enabled', false);
  await sleep(120);
  const arxiv = puts.filter(([k]) => k === 'arxiv');
  assert.strictEqual(arxiv.length, 1);
  assert.strictEqual(arxiv[0][1].enabled, false);
  assert.ok($('arxiv-hint').className.includes('saved'), '节标题旁显示「已保存」');
  assert.strictEqual($('arxiv-hint').textContent, '已保存');
  // 复位，免得影响后续用例
  change('arxiv-enabled', true);
  await sleep(120);
});

test('保存后的整页回填不覆盖正在编辑的输入框', async () => {
  await goto('ingest');
  // 用户改 A（触发保存与整页重载），紧接着 Tab 到 B 并开始打字
  change('scan-interval', '20');
  const thr = $('arxiv-thr');
  thr.focus();
  thr.value = '0.95';
  await sleep(160); // 让 saveScan → loadSettingsData 的回填跑完
  assert.strictEqual(thr.value, '0.95', '聚焦中的输入框不被服务端旧值盖掉');
  assert.strictEqual($('scan-interval').value, '20', '未聚焦的输入框正常回填新值');
});

test('保存失败：指示进入 error 态并给出原因，不静默', async () => {
  await goto('ingest');
  failNext = 'scan';
  change('scan-interval', '7');
  await sleep(150);
  const hint = $('scan-hint');
  assert.ok(hint.className.includes('error'), '保存失败要看得见');
  assert.match(hint.textContent, /后端拒绝了/);
});

test('全局 AI 参数：每任务上限输入框同样即时保存', async () => {
  await goto('ai');
  change('tb-summary', '8000');
  await sleep(120);
  const ai = puts.filter(([k]) => k === 'ai');
  assert.strictEqual(ai.length, 1);
  assert.strictEqual(ai[0][1].taskMaxInputTokens.summary, 8000);
});
