// 概念地图制品面板 UI 测试（v3.14 后台任务 / v3.15 缩略图网格）：jsdom 驱动真实 public/index.html + 真实前端模块。
// 覆盖：制品卡网格渲染（spinner 占位/取消）/ 轮询跳变（generating→ready 重渲挂缩略图 + 停轮询）/
//       缩略图懒挂载（jsdom 无 IO → 立即全挂 live iframe）/ error 制品（徽标 + 半成品缩略图）/ 设置页提示词面板。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('conceptmaps-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = [
  {
    id: 'p1', filename: 'a.pdf', title: 'Attention Is All You Need', authors: ['V'], year: '2017',
    abstract: '', arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 100, summaryExcerpt: '', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false,
    conceptCount: 1, formulaCount: 0,
  },
];

/** 可变假 settings（测试可改 conceptMaps 模拟服务端任务状态变化）。 */
let SETTINGS;
let settingsGets = 0; // /api/settings GET 计数（验证轮询停止后不再拉取）
function resetSettings() {
  settingsGets = 0;
  SETTINGS = {
    conceptMapPrompt: '',
    defaultConceptMapPrompt: '内置默认概念地图提示词（很长）'.repeat(10),
    conceptMaps: [],
    ai: { channels: [], activeChannelId: '' },
    scan: { scanIntervalMinutes: 5 },
    configScan: { scanIntervalMinutes: 5 },
    arxiv: {}, configArxiv: {}, discover: {}, configDiscover: {},
    translate: {}, configTranslate: {}, formulas: {}, configFormulas: {},
    overrides: {},
    system: {},
  };
}

function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

function makeRoutes() {
  return {
    '/api/concepts': () => jsonRes([{ id: 'c1', term: 'Attention', definition: 'd', category: 'model', paperIds: ['p1'] }]),
    '/api/settings': () => { settingsGets++; return jsonRes(SETTINGS); },
    '/api/concepts/map': ({ method, body }) => {
      if (method === 'POST') {
        const item = {
          id: 'cm_test1', name: '概念地图', prompt: (body && body.prompt) || '',
          status: 'generating', error: '', hasHtml: false, createdAt: 100, updatedAt: 100,
        };
        SETTINGS.conceptMaps.unshift(item);
        return jsonRes(item);
      }
      return { ok: false, status: 405, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: '405' }) };
    },
    // 缩略图/查看按需 GET 单个制品（含 html）
    '/api/concepts/map/cm_test1': () =>
      jsonRes({ id: 'cm_test1', name: '概念地图', status: 'ready', error: '', hasHtml: true, html: '<!DOCTYPE html><html><body>MAP1</body></html>' }),
    '/api/concepts/map/cm_err': () =>
      jsonRes({ id: 'cm_err', name: '概念地图', status: 'error', error: '截断', hasHtml: true, html: '<!DOCTYPE html><html><body>HALF</body></html>' }),
  };
}

before(async () => {
  resetSettings();
  ui = await bootUi({ listItems: LIST, details: {}, routes: makeRoutes() });
  // 进入概念页 → 切到「地图」tab
  $('btn-concepts').click();
  for (let i = 0; i < 50 && $('concepts-view').style.display === 'none'; i++) await sleep(20);
  ui.document.querySelector('#concept-view button[data-view="maps"]').click();
  await sleep(30);
});

test('概念页视图 tab 已改名「地图」', async () => {
  const tab = ui.document.querySelector('#concept-view button[data-view="maps"]');
  assert.strictEqual(tab.textContent, '地图');
  assert.strictEqual($('btn-concept-map').textContent, '生成概念地图');
});

test('空制品网格提示 + 生成按钮 POST 后出现 generating 占位卡（spinner + 取消）', async () => {
  assert.ok($('concept-maps-list').innerHTML.includes('暂无概念地图'), '空列表应有引导文案');
  globalThis.prompt = () => ''; // PWDialog.prompt 桩：留空用默认提示词
  const intervalsBefore = ui.intervalFns.length;
  $('btn-concept-map').click();
  for (let i = 0; i < 50 && !SETTINGS.conceptMaps.length; i++) await sleep(20);
  for (let i = 0; i < 50 && !$('concept-maps-list').innerHTML.includes('后台生成中'); i++) await sleep(20);
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('cms-card'), '制品应以卡片网格渲染');
  assert.ok(html.includes('cms-thumb-status'), 'generating 卡应有缩略图占位区');
  assert.ok(html.includes('cms-spinner'), 'generating 制品应有 spinner');
  assert.ok(html.includes('取消'), '生成中制品只提供「取消」（=删除并中断任务）');
  assert.ok(!html.includes('data-cm-thumb='), '生成中不挂缩略图');
  const post = ui.backend.posts.find((x) => x.path.startsWith('/api/concepts/map'));
  assert.ok(post, '应 POST /api/concepts/map');
  assert.ok(ui.intervalFns.length > intervalsBefore, '提交后应启动轮询定时器');
});

test('轮询检测 generating→ready 跳变：重渲并挂载 live iframe 缩略图，随后停止轮询', async () => {
  // 服务端任务完成：翻 ready
  SETTINGS.conceptMaps[0].status = 'ready';
  SETTINGS.conceptMaps[0].hasHtml = true;
  const poll = ui.intervalFns[ui.intervalFns.length - 1];
  await poll();
  // 重渲后缩略图懒挂载（jsdom 无 IntersectionObserver → 立即全挂）
  for (let i = 0; i < 50 && !$('concept-maps-list').querySelector('iframe.cms-thumb-frame'); i++) await sleep(20);
  const iframe = $('concept-maps-list').querySelector('iframe.cms-thumb-frame');
  assert.ok(iframe, 'ready 制品应挂载 live iframe 缩略图');
  assert.strictEqual(iframe.getAttribute('sandbox'), 'allow-scripts', '缩略图 iframe 严格沙箱（不放 same-origin）');
  assert.ok((iframe.style.transform || '').includes('scale('), 'iframe 应按卡片宽度 scale 缩小');
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('优化') && html.includes('新标签页') && html.includes('删除'), 'ready 卡应有优化/新标签页/删除');
  assert.ok(!html.includes('后台生成中'), 'ready 后不再显示生成中');
  // 轮询应已停止（无 generating 制品）：settings GET 计数不再增长
  const getsBefore = settingsGets;
  await poll();
  await sleep(50);
  assert.strictEqual(settingsGets, getsBefore, '无 generating 制品后轮询应停止（不再拉 settings）');
});

test('error 制品：失败徽标 + 半成品缩略图 + 查看/优化/删除', async () => {
  SETTINGS.conceptMaps = [
    { id: 'cm_err', name: '概念地图', prompt: '', status: 'error', error: '输出不完整（可能被模型输出上限截断）——已保留半成品', hasHtml: true, createdAt: 100, updatedAt: 101 },
  ];
  // 重进概念页（showConcepts 重新拉 settings → state.conceptMaps 同步假后端）
  $('btn-concepts').click();
  for (let i = 0; i < 50 && !$('concept-maps-list').innerHTML.includes('截断'); i++) await sleep(20);
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('cms-thumb-badge'), '半成品 error 卡应有「不完整」徽标');
  assert.ok(html.includes('截断'), 'error 制品应展示失败原因');
  assert.ok(html.includes('查看') && html.includes('优化') && html.includes('删除'), 'error 卡可查看半成品/再优化/删除');
  for (let i = 0; i < 50 && !$('concept-maps-list').querySelector('iframe.cms-thumb-frame'); i++) await sleep(20);
  assert.ok($('concept-maps-list').querySelector('iframe.cms-thumb-frame'), '半成品也挂缩略图（可看残缺效果）');
});

test('设置页含「概念地图提示词」面板并回显默认值', async () => {
  const nav = ui.document.querySelector('.settings-nav-item[data-tab="concept-map"]');
  assert.ok(nav, '设置导航应有概念地图提示词入口');
  assert.ok(nav.textContent.includes('概念地图提示词'));
  const panel = ui.document.querySelector('.settings-panel[data-panel="concept-map"]');
  assert.ok(panel, '设置面板应存在');
  assert.ok(panel.querySelector('#concept-map-prompt-edit'), '面板应有编辑框');
  assert.ok(panel.querySelector('#btn-concept-map-prompt-save'), '面板应有保存按钮');
});
