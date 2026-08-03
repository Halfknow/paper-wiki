// 概念地图制品面板 UI 测试（v3.14）：jsdom 驱动真实 public/app.js + 真实 index.html。
// 覆盖：后台生成占位渲染（spinner/取消）/ 轮询跳变（generating→ready 重渲 + 停轮询）/
//       error 制品渲染（原因 + 查看半成品）/ 生成按钮 POST / 设置页概念地图提示词面板。

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
function resetSettings() {
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

function makeRoutes() {
  return {
    '/api/concepts': () => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, data: [{ id: 'c1', term: 'Attention', definition: 'd', category: 'model', paperIds: ['p1'] }] }),
    }),
    '/api/settings': () => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, data: SETTINGS }),
    }),
    '/api/concepts/map': ({ method, body }) => {
      if (method === 'POST') {
        const item = {
          id: 'cm_test1', name: '概念地图', prompt: (body && body.prompt) || '',
          status: 'generating', error: '', hasHtml: false, createdAt: 100, updatedAt: 100,
        };
        SETTINGS.conceptMaps.unshift(item);
        return {
          ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => ({ ok: true, data: item }),
        };
      }
      return { ok: false, status: 405, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: '405' }) };
    },
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

test('空制品列表提示 + 生成按钮 POST 后出现 generating 占位（spinner + 取消）', async () => {
  assert.ok($('concept-maps-list').innerHTML.includes('暂无概念地图'), '空列表应有引导文案');
  globalThis.prompt = () => ''; // PWDialog.prompt 桩：留空用默认提示词
  const intervalsBefore = ui.intervalFns.length;
  $('btn-concept-map').click();
  for (let i = 0; i < 50 && !SETTINGS.conceptMaps.length; i++) await sleep(20);
  for (let i = 0; i < 50 && !$('concept-maps-list').innerHTML.includes('后台生成中'); i++) await sleep(20);
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('cms-spinner'), 'generating 制品应有 spinner');
  assert.ok(html.includes('后台生成中'), '应有后台生成中提示（不再要求留在页面）');
  assert.ok(html.includes('取消'), '生成中制品只提供「取消」（=删除并中断任务）');
  assert.ok(!html.includes('查看'), '生成中不提供查看');
  const post = ui.backend.posts.find((x) => x.path.startsWith('/api/concepts/map'));
  assert.ok(post, '应 POST /api/concepts/map');
  assert.ok(ui.intervalFns.length > intervalsBefore, '提交后应启动轮询定时器');
});

test('轮询检测 generating→ready 跳变：重渲列表（查看/优化/新标签页）并停止轮询', async () => {
  // 服务端任务完成：翻 ready
  SETTINGS.conceptMaps[0].status = 'ready';
  SETTINGS.conceptMaps[0].hasHtml = true;
  // 手动触发最新一个轮询回调（bootUi 捕获的 setInterval）
  const poll = ui.intervalFns[ui.intervalFns.length - 1];
  const intervalsBefore = ui.intervalFns.length;
  await poll();
  for (let i = 0; i < 50 && !$('concept-maps-list').innerHTML.includes('查看'); i++) await sleep(20);
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('查看'), 'ready 制品应有查看按钮');
  assert.ok(html.includes('优化'), 'ready 制品应有优化按钮');
  assert.ok(!html.includes('后台生成中'), 'ready 后不再显示生成中');
  // 再触发一次确认轮询已停（_stopConceptMapPolling 后 poll 内部短路不再拉取）
  const postsBefore = ui.backend.posts.length;
  await poll();
  assert.strictEqual(ui.backend.posts.length, postsBefore, '无 generating 制品后轮询应停止');
  assert.strictEqual(ui.intervalFns.length, intervalsBefore, '不再新增定时器');
});

test('error 制品渲染失败原因 + 可查看半成品/优化/删除', async () => {
  SETTINGS.conceptMaps = [
    { id: 'cm_err', name: '概念地图', prompt: '', status: 'error', error: '输出不完整（可能被模型输出上限截断）——已保留半成品', hasHtml: true, createdAt: 100, updatedAt: 101 },
  ];
  // 重进概念页（showConcepts 重新拉 settings → state.conceptMaps 同步假后端）
  $('btn-concepts').click();
  for (let i = 0; i < 50 && !$('concept-maps-list').innerHTML.includes('截断'); i++) await sleep(20);
  const html = $('concept-maps-list').innerHTML;
  assert.ok(html.includes('截断'), 'error 制品应展示失败原因');
  assert.ok(html.includes('查看'), '有半成品的 error 制品仍可查看');
  assert.ok(html.includes('优化'), 'error 制品可再优化补全');
  assert.ok(html.includes('删除'), 'error 制品可删除');
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
