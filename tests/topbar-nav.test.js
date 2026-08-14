'use strict';

// 顶栏导航与信息架构测试（v3.17）——jsdom 驱动真实 public/app.js。
//
// 覆盖 docs/superpowers/specs/2026-08-04-navigation-ia-design.md 第一步的可回归点：
//   · 深链非库视图时 showView 必须先于数据请求（否则先闪现论文页）
//   · 一级导航分段的 active 态 / 计数徽标
//   · 顶栏搜索框的 scope 随视图切换（placeholder + 实际过滤 + ?q= 深链还原）
//   · 设置入口在三个视图下都可达（旧实现藏在 #library-view 内的侧栏里，切页即消失）
//   · 状态胶囊在「处理中 / 出错」时不折叠（后台失败静默是可用性红线）
//
// 每个用例一个独立 bootUi（各自初始 URL），故本文件是多 jsdom 实例——归入慢速守卫。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('topbar-nav')) return;

const { test } = require('node:test');
const assert = require('node:assert');
const { bootUi, sleep } = require('./helpers/ui');

const mkPaper = (id, title) => ({
  id,
  filename: id + '.pdf',
  title,
  authors: ['Vaswani'],
  year: '2017',
  abstract: '',
  arxivId: null,
  arxivUrl: null,
  primaryCategory: null,
  metaSource: null,
  metaConfidence: 0,
  fulltextChars: 100,
  summaryExcerpt: '',
  status: 'ready',
  error: null,
  tags: ['llm'],
  topics: ['NLP'],
  folders: [],
  rating: 0,
  starred: false,
  readStatus: 'unread',
  readProgress: null,
  addedAt: 1,
  updatedAt: 1,
  hasSummary: true,
  hasNotes: false,
  conceptCount: 0,
});
const LIST = [mkPaper('p1', 'Attention Is All You Need'), mkPaper('p2', 'BERT')];

function json(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

const CONCEPTS = [
  { id: 'c1', term: 'Attention', definition: '注意力机制', paperIds: ['p1'], category: 'mechanism' },
  { id: 'c2', term: 'Tokenizer', definition: '分词器', paperIds: ['p2'], category: 'component' },
];
const FORMULAS = [
  {
    id: 'f1',
    canonicalName: 'softmax',
    name: 'Softmax',
    latex: '\\sigma(z)_i',
    description: '归一化指数函数',
    category: 'activation',
    variables: [],
    occurrences: [{ paperId: 'p1' }],
    paperIds: ['p1'],
  },
];

/** 假后端补充路由。delayConcepts>0 时让 /api/concepts 挂起，用于验证 showView 抢在数据之前。 */
function extraRoutes({ delayConcepts = 0, stats } = {}) {
  return {
    '/api/concepts': async () => {
      if (delayConcepts) await sleep(delayConcepts);
      return json(CONCEPTS);
    },
    '/api/formulas': () => json(FORMULAS),
    '/api/stats': () =>
      json(stats || { ready: 2, total: 2, processing: 0, error: 0, concepts: 2, formulas: 1, starred: 0, unread: 2 }),
    '/api/settings': () =>
      json({
        conceptMaps: [],
        savedSearches: [],
        chatPresets: null,
        ai: { channels: [], activeChannelId: '' },
        overrides: {},
      }),
  };
}

async function boot(initialPath, opts) {
  const ui = await bootUi({
    listItems: LIST,
    details: {},
    routes: extraRoutes(opts),
    initialPath,
  });
  await sleep(40);
  return ui;
}

const view = (ui) => ui.document.body.dataset.view;
const navItem = (ui, name) => ui.document.querySelector(`#view-nav [data-view="${name}"]`);

// ---------------------------------------------------------------------------
// 闪现修复：showView 必须先于数据请求
// ---------------------------------------------------------------------------

test('深链 /concepts：视图在概念数据到达前就已切换（不闪现论文页）', async () => {
  const ui = await boot('/concepts', { delayConcepts: 200 });
  // bootUi 一见 dataset.view 非 library 就返回——此刻 /api/concepts 仍挂起
  assert.equal(view(ui), 'concepts');
  assert.ok(ui.$('library-view').classList.contains('view-hidden'), '论文视图应已隐藏，而不是等数据回来才切');
  assert.equal(ui.$('concepts-grid').children.length, 0, '此时数据未到，网格应为空（证明 showView 抢在前面）');
  await sleep(300);
  assert.ok(ui.$('concepts-grid').children.length > 0, '数据到达后应渲染概念卡片');
});

test('index.html 默认不显示任何视图，首帧由 data-boot-path 决定', async () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /data-boot-path/, '<head> 内联脚本应写入 data-boot-path 供 CSS 选中首帧视图');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\[data-boot-path\^="\/concepts"\]/, 'styles.css 应有按 boot path 选中首帧视图的规则');
});

// ---------------------------------------------------------------------------
// 一级导航
// ---------------------------------------------------------------------------

test('导航分段：active 态随路由切换，且是真链接（<a href>）', async () => {
  const ui = await boot('/library');
  assert.ok(navItem(ui, 'library').classList.contains('active'));
  assert.ok(!navItem(ui, 'concepts').classList.contains('active'));
  assert.equal(navItem(ui, 'concepts').tagName, 'A', '导航段应是 <a>，以支持中键开新标签页');
  assert.equal(navItem(ui, 'concepts').getAttribute('href'), '/concepts');

  navItem(ui, 'concepts').click();
  await sleep(80);
  assert.equal(ui.path(), '/concepts');
  assert.equal(view(ui), 'concepts');
  assert.ok(navItem(ui, 'concepts').classList.contains('active'));
  assert.ok(!navItem(ui, 'library').classList.contains('active'));
});

test('导航分段带计数徽标，非库视图深链时也有值', async () => {
  const ui = await boot('/concepts');
  await sleep(60);
  assert.equal(ui.$('vn-count-papers').textContent.trim(), '2');
  assert.equal(ui.$('vn-count-concepts').textContent.trim(), '2');
  assert.equal(ui.$('vn-count-formulas').textContent.trim(), '1');
});

// ---------------------------------------------------------------------------
// 上下文搜索
// ---------------------------------------------------------------------------

test('顶栏搜索 placeholder 随视图切换', async () => {
  const ui = await boot('/library');
  assert.match(ui.$('search').placeholder, /论文/);
  navItem(ui, 'concepts').click();
  await sleep(80);
  assert.match(ui.$('search').placeholder, /术语|解释/);
  navItem(ui, 'formulas').click();
  await sleep(80);
  assert.match(ui.$('search').placeholder, /公式|LaTeX/);
});

test('概念页输入顶栏搜索框即过滤概念清单（页内搜索框已退役）', async () => {
  const ui = await boot('/concepts');
  await sleep(60);
  assert.equal(ui.$('concept-q'), null, '页内 #concept-q 应删除，只保留顶栏唯一搜索框');
  assert.equal(ui.$('concepts-grid').children.length, 2);
  const s = ui.$('search');
  s.value = 'tokenizer';
  s.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await sleep(350); // 防抖
  assert.equal(ui.$('concepts-grid').children.length, 1);
});

test('/concepts?q= 深链还原查询词并应用过滤', async () => {
  const ui = await boot('/concepts?q=tokenizer');
  await sleep(80);
  assert.equal(ui.$('search').value, 'tokenizer');
  assert.equal(ui.$('concepts-grid').children.length, 1);
});

test('论文页专属筛选条已沉进库视图工具条（顶栏只剩纯 chrome）；高级搜索控件三页都可用（v3.20）', async () => {
  const ui = await boot('/library');
  const strip = ui.document.querySelector('.filter-strip');
  assert.ok(strip.closest('#library-view .list-toolbar'), '筛选条应收进库视图的列表工具条');
  assert.ok(!ui.document.querySelector('.topbar .filter-strip'), '顶栏不再承载页面专属筛选');
  assert.ok(!ui.$('filter-starred'), '仅星标 checkbox 已退役（侧栏星标视图/DSL star:1/高级面板仍在）');
  navItem(ui, 'concepts').click();
  await sleep(80);
  assert.ok(ui.$('library-view').classList.contains('view-hidden'), '库视图整体隐藏，筛选条随之消失');
  // v3.20：概念/公式页也支持高级搜索（category:/freq:/source: 等前端字段），不再隐藏
  assert.ok(!ui.$('search-advanced-toggle').hasAttribute('hidden'), '概念页高级搜索按钮可见（v3.20）');
  assert.ok(!ui.$('search-help').hasAttribute('hidden'), '概念页语法帮助按钮可见（v3.20）');
});

test('收起态 rail 随视图切上下文：概念/公式页不再挂论文筛选按钮（v3.19）', async () => {
  const ui = await boot('/library');
  await sleep(60);
  const railCtx = (name) => ui.document.querySelector(`.rail-ctx[data-ctx="${name}"]`);
  assert.ok(!railCtx('library').classList.contains('view-hidden'), '论文页 rail = 论文筛选');
  assert.ok(railCtx('concepts').classList.contains('view-hidden'));
  assert.ok(railCtx('formulas').classList.contains('view-hidden'));
  // 切概念页：rail 换成 清单/地图，论文按钮随 library 上下文隐藏
  navItem(ui, 'concepts').click();
  await sleep(80);
  assert.ok(railCtx('library').classList.contains('view-hidden'), '概念页不再挂论文 rail');
  assert.ok(!railCtx('concepts').classList.contains('view-hidden'));
  // 概念 rail 的「地图」按钮走路由切换
  ui.document.querySelector('.rail-ctx[data-ctx="concepts"] .rail-btn[data-cview="maps"]').click();
  await sleep(80);
  assert.equal(ui.path(), '/concepts/maps');
  // 切公式页：rail 换成「全部公式」
  navItem(ui, 'formulas').click();
  await sleep(80);
  assert.ok(railCtx('concepts').classList.contains('view-hidden'));
  assert.ok(!railCtx('formulas').classList.contains('view-hidden'));
  assert.ok(ui.$('rail-formula-all'), '公式 rail 有「全部公式」按钮');
});

// ---------------------------------------------------------------------------
// 设置入口（侧栏 footer + rail，跨视图常驻）
// ---------------------------------------------------------------------------

test('设置入口在概念页/公式页同样可达（v3.18 移回常驻侧栏 footer，不再随切页消失）', async () => {
  const ui = await boot('/concepts');
  await sleep(60);
  const gear = ui.$('btn-settings');
  assert.ok(gear, '侧栏 footer 应有设置入口');
  assert.ok(!ui.$('btn-settings-top'), '顶栏不再放设置齿轮');
  gear.click();
  await sleep(80);
  assert.equal(ui.path(), '/settings/overview');
  assert.equal(view(ui), 'settings');
});

test('概念页/公式页不再有「返回论文库」箭头（平级导航不下钻）', async () => {
  const ui = await boot('/concepts');
  await sleep(60);
  assert.equal(ui.$('btn-concepts-close'), null);
  assert.equal(ui.$('btn-formulas-close'), null);
});

// ---------------------------------------------------------------------------
// 状态胶囊
// ---------------------------------------------------------------------------

test('状态胶囊：空闲时收起，处理中/出错时外露文案', async () => {
  const idle = await boot('/library');
  assert.equal(idle.$('status-chip').dataset.level, 'idle');
  assert.equal(idle.$('sc-text').textContent.trim(), '', '空闲态不占位');

  const busy = await boot('/library', {
    stats: { ready: 1, total: 4, processing: 2, error: 1, concepts: 2, formulas: 1, starred: 0, unread: 3 },
  });
  assert.equal(busy.$('status-chip').dataset.level, 'error', '同时有错误时以错误为准（更高优先级）');
  const txt = busy.$('sc-text').textContent;
  assert.match(txt, /2/);
  assert.match(txt, /处理中/);
  assert.match(txt, /1/);
  assert.match(txt, /错误/);
});

test('状态胶囊 popover 收纳「立即扫描」，且明细可展开', async () => {
  const ui = await boot('/library');
  assert.ok(ui.$('status-pop').hasAttribute('hidden'));
  ui.$('status-chip').click();
  await sleep(20);
  assert.ok(!ui.$('status-pop').hasAttribute('hidden'));
  assert.ok(ui.$('btn-scan'), '扫描按钮收进状态面板');
  assert.match(ui.$('sp-rows').textContent, /就绪/);
});

// ---------------------------------------------------------------------------
// 骨架统一（第二步）：常驻侧栏 + 设置覆盖层
// ---------------------------------------------------------------------------

test('侧栏常驻三个视图，只换里面的上下文区块', async () => {
  const ui = await boot('/library');
  const ctx = (name) => ui.document.querySelector(`#sidebar .side-ctx[data-ctx="${name}"]`);
  const shown = (el) => !el.classList.contains('view-hidden');

  assert.ok(ui.$('sidebar'), '侧栏在论文页');
  assert.ok(shown(ctx('library')) && !shown(ctx('concepts')) && !shown(ctx('formulas')));

  navItem(ui, 'concepts').click();
  await sleep(120);
  assert.ok(ui.$('sidebar'), '侧栏在概念页依然存在（旧实现随 #library-view 一起消失）');
  assert.ok(!shown(ctx('library')) && shown(ctx('concepts')) && !shown(ctx('formulas')));

  navItem(ui, 'formulas').click();
  await sleep(120);
  assert.ok(!shown(ctx('library')) && !shown(ctx('concepts')) && shown(ctx('formulas')));
});

test('侧栏收起态挂在常驻骨架上，跨视图保持', async () => {
  const ui = await boot('/library');
  ui.$('btn-collapse').click();
  await sleep(30);
  assert.ok(ui.$('app-shell').classList.contains('sidebar-collapsed'));
  navItem(ui, 'concepts').click();
  await sleep(120);
  assert.ok(ui.$('app-shell').classList.contains('sidebar-collapsed'), '切页后仍是收起态');
});

test('概念页侧栏：分类分面点击即过滤，再点取消', async () => {
  const ui = await boot('/concepts');
  await sleep(80);
  assert.equal(ui.$('concepts-grid').children.length, 2);
  const cat = ui.document.querySelector('#side-concepts .side-item[data-cat="component"]');
  assert.ok(cat, '侧栏列出概念分类（分类分面已从漏斗面板搬到侧栏）');
  assert.match(cat.textContent, /1/, '分类项带计数');
  cat.click();
  await sleep(60);
  assert.equal(ui.$('concepts-grid').children.length, 1, '按分类过滤');
  ui.document.querySelector('#side-concepts .side-item[data-cat="component"]').click();
  await sleep(60);
  assert.equal(ui.$('concepts-grid').children.length, 2, '再点取消，恢复全部');
});

test('概念页「清单 / 地图」入口在侧栏，不在页内工具条', async () => {
  const ui = await boot('/concepts');
  await sleep(80);
  assert.equal(ui.$('concept-view'), null, '页内视图分段已退役');
  const maps = ui.document.querySelector('#side-concepts .side-item[data-cview="maps"]');
  assert.ok(maps, '侧栏有「概念地图」入口');
  maps.click();
  await sleep(120);
  assert.equal(ui.path(), '/concepts/maps');
});

test('公式页侧栏：分类分面点击即过滤', async () => {
  const ui = await boot('/formulas');
  await sleep(80);
  const cat = ui.document.querySelector('#side-formulas .side-item[data-cat="activation"]');
  assert.ok(cat, '侧栏列出公式分类');
  cat.click();
  await sleep(60);
  assert.equal(ui.document.querySelectorAll('.formula-card').length, 1);
  ui.document.querySelector('#side-formulas .side-item[data-cat=""]').click(); // 「全部公式」
  await sleep(60);
  assert.equal(ui.document.querySelectorAll('.formula-card').length, 1);
});

test('设置是覆盖层：打开时底下的内容视图仍在，关闭回到来路而非一律回论文库', async () => {
  const ui = await boot('/concepts');
  await sleep(80);
  ui.$('btn-settings').click();
  await sleep(120);
  assert.equal(view(ui), 'settings');
  assert.ok(!ui.$('concepts-view').classList.contains('view-hidden'), '覆盖层不应把底下的概念页藏掉——关掉后要原样回来');
  assert.ok(!ui.$('settings-view').classList.contains('view-hidden'));

  ui.$('btn-settings-close').click();
  await sleep(120);
  assert.equal(ui.path(), '/concepts', '从概念页进设置，关掉应回概念页');
  assert.equal(view(ui), 'concepts');
  assert.ok(ui.$('settings-view').classList.contains('view-hidden'));
});

test('设置覆盖层：点遮罩关闭；深链直达时兜底回论文库', async () => {
  const ui = await boot('/settings/overview');
  await sleep(80);
  assert.equal(view(ui), 'settings');
  ui.$('settings-view').click(); // 点遮罩本体（非面板）
  await sleep(120);
  assert.equal(ui.path(), '/library', '无来路时兜底回论文库');
});

// ---------------------------------------------------------------------------
// 动作收敛
// ---------------------------------------------------------------------------

test('导入 / 发现收进「+ 添加」下拉', async () => {
  const ui = await boot('/library');
  assert.ok(ui.$('add-menu-list').hasAttribute('hidden'));
  ui.$('btn-add').click();
  await sleep(20);
  assert.ok(!ui.$('add-menu-list').hasAttribute('hidden'));
  assert.ok(ui.$('btn-import'));
  assert.ok(ui.$('btn-discover'));
  ui.$('btn-import').click();
  await sleep(30);
  assert.ok(ui.$('import-modal').classList.contains('active'), '仍应打开导入弹窗');
  assert.ok(ui.$('add-menu-list').hasAttribute('hidden'), '选中一项后下拉应收起');
});
