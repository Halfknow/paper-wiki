'use strict';

// 前端路由集成测试（v3.15）——jsdom 驱动真实 public/app.js，验证「URL ↔ 视图」双向绑定。
//
// 纯匹配逻辑在 tests/frontend-router.test.js 里单测；这里只测有状态的那一层：
// 深链直达、点击改写 URL、前进后退、筛选进 query、?space= 透传。
//
// 每个用例用独立 bootUi（各自的初始 URL），因此本文件是 8 个 jsdom 实例——归入慢速守卫。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('routing-ui')) return;

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
const detailOf = (id) => ({
  ...mkPaper(id, id === 'p1' ? 'Attention Is All You Need' : 'BERT'),
  summary: '## TL;DR\n要点',
  notes: '',
  noteCards: [],
  chat: [],
  annotations: null,
});

/** 概念/设置路由用到的假后端补充路由。 */
const EXTRA_ROUTES = {
  '/api/concepts': () => json([{ id: 'c1', term: 'Attention', definition: '注意力', paperIds: ['p1'], category: '' }]),
  '/api/formulas': () => json([]),
  '/api/settings': () =>
    json({
      conceptMaps: [],
      savedSearches: [],
      chatPresets: null,
      ai: { channels: [], activeChannelId: '' },
      overrides: {},
    }),
};
function json(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}

async function boot(initialPath) {
  const ui = await bootUi({
    listItems: LIST,
    details: { p1: detailOf('p1'), p2: detailOf('p2') },
    routes: EXTRA_ROUTES,
    initialPath,
  });
  await sleep(40);
  return ui;
}
const view = (ui) => ui.document.body.dataset.view;
/** 顶栏一级导航段（v3.17 起是 <a href>，取代原先的 #btn-concepts / #btn-formulas 按钮）。 */
const nav = (ui, name) => ui.document.querySelector(`#view-nav [data-view="${name}"]`);

// ---------------------------------------------------------------------------
// 深链直达
// ---------------------------------------------------------------------------

test('深链 /：重定向到 /library 并渲染列表', async () => {
  const ui = await boot('/');
  assert.strictEqual(ui.path(), '/library', '根路径 replaceState 到 /library');
  assert.strictEqual(view(ui), 'library');
  assert.ok(ui.document.querySelector('.paper-item'), '列表已渲染');
});

test('深链 /paper/:id/chat：直达论文详情的聊天 tab', async () => {
  const ui = await boot('/paper/p1/chat');
  for (let i = 0; i < 60 && !ui.$('tab-body'); i++) await sleep(20);
  assert.strictEqual(ui.path(), '/paper/p1/chat', 'URL 保持不变');
  assert.strictEqual(view(ui), 'library', '详情是库视图内的面板');
  const active = ui.document.querySelector('.tab.active');
  assert.ok(active, '有激活的 tab');
  assert.strictEqual(active.dataset.tab, 'chat', '激活的是聊天 tab');
});

test('深链 /paper/:id（无 tab）：默认总结 tab', async () => {
  const ui = await boot('/paper/p2');
  for (let i = 0; i < 60 && !ui.document.querySelector('.tab.active'); i++) await sleep(20);
  assert.strictEqual(ui.document.querySelector('.tab.active').dataset.tab, 'summary');
});

test('深链 /concepts 与 /formulas：直达对应视图，不经过库视图', async () => {
  const c = await boot('/concepts');
  for (let i = 0; i < 60 && view(c) !== 'concepts'; i++) await sleep(20);
  assert.strictEqual(view(c), 'concepts');

  const f = await boot('/formulas');
  for (let i = 0; i < 60 && view(f) !== 'formulas'; i++) await sleep(20);
  assert.strictEqual(view(f), 'formulas');
});

test('深链 /settings/:tab：直达设置中心的指定分区', async () => {
  const ui = await boot('/settings/ai');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  assert.strictEqual(view(ui), 'settings');
  const activeNav = ui.document.querySelector('.settings-nav-item.active');
  assert.strictEqual(activeNav.dataset.tab, 'ai', '左侧导航高亮 AI 接口');
  const panel = ui.document.querySelector('.settings-panel[data-panel="ai"]');
  assert.strictEqual(panel.hidden, false, 'AI 面板可见');
});

test('未知路径回退到 /library（不留死页）', async () => {
  const ui = await boot('/nope/whatever');
  assert.strictEqual(ui.path(), '/library');
  assert.strictEqual(view(ui), 'library');
});

test('非法 tab 名回退 summary，非法设置 tab 回退 overview', async () => {
  const p = await boot('/paper/p1/bogus');
  for (let i = 0; i < 60 && !p.document.querySelector('.tab.active'); i++) await sleep(20);
  assert.strictEqual(p.document.querySelector('.tab.active').dataset.tab, 'summary');

  const s = await boot('/settings/bogus');
  for (let i = 0; i < 60 && view(s) !== 'settings'; i++) await sleep(20);
  assert.strictEqual(s.document.querySelector('.settings-nav-item.active').dataset.tab, 'overview');
});

// ---------------------------------------------------------------------------
// 交互改写 URL
// ---------------------------------------------------------------------------

test('点列表项 → URL 变 /paper/:id；切 tab → /paper/:id/:tab', async () => {
  const ui = await boot('/library');
  ui.document.querySelector('.paper-item').click();
  for (let i = 0; i < 60 && ui.path() === '/library'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/paper/p1');

  for (let i = 0; i < 60 && !ui.document.querySelector('.tab[data-tab="notes"]'); i++) await sleep(20);
  ui.document.querySelector('.tab[data-tab="notes"]').click();
  for (let i = 0; i < 60 && ui.path() === '/paper/p1'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/paper/p1/notes');
});

test('点顶栏导航段「概念」「公式」→ URL 与视图同步', async () => {
  const ui = await boot('/library');
  nav(ui, 'concepts').click();
  for (let i = 0; i < 60 && view(ui) !== 'concepts'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/concepts');

  nav(ui, 'formulas').click();
  for (let i = 0; i < 60 && view(ui) !== 'formulas'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/formulas');

  ui.$('btn-settings').click();
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/settings/overview');
});

test('设置左侧导航切换 → /settings/:tab', async () => {
  const ui = await boot('/settings/overview');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  ui.document.querySelector('.settings-nav-item[data-tab="ingest"]').click();
  for (let i = 0; i < 60 && ui.path() === '/settings/overview'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/settings/ingest');
});

// v3.56 导航 14 → 8 项：老 tab 变成深链别名，落到新页并展开对应子项。
// 别人分享出去的 /settings/summary 链接不能因为一次重构就死掉。
test('老设置深链走别名：/settings/summary → 提示词页并展开总结条目', async () => {
  const ui = await boot('/settings/summary');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  assert.strictEqual(
    ui.document.querySelector('.settings-nav-item.active').dataset.tab,
    'prompts',
    '左侧高亮落在「提示词」',
  );
  const panel = ui.document.querySelector('.settings-panel[data-panel="prompts"]');
  assert.strictEqual(panel.hidden, false, '提示词面板可见');
  assert.strictEqual(ui.document.getElementById('prompt-index').hidden, true, '直接进编辑态，不停在列表');
  assert.strictEqual(
    ui.document.querySelector('.prompt-pane[data-prompt-pane="summary"]').hidden,
    false,
    '展开的是总结提示词',
  );
});

test('老设置深链走别名：/settings/scan → 入库与解析页', async () => {
  const ui = await boot('/settings/scan');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  assert.strictEqual(ui.document.querySelector('.settings-nav-item.active').dataset.tab, 'ingest');
  assert.strictEqual(ui.document.querySelector('.settings-panel[data-panel="ingest"]').hidden, false);
  assert.ok(ui.$('scan-interval'), '扫描间隔输入框在入库页里');
});

test('导航只剩 8 项，且每一项都有对应面板', async () => {
  const ui = await boot('/settings/overview');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  const items = [...ui.document.querySelectorAll('.settings-nav-item')];
  assert.strictEqual(items.length, 8, '左导航 8 项');
  for (const it of items) {
    assert.ok(
      ui.document.querySelector(`.settings-panel[data-panel="${it.dataset.tab}"]`),
      `导航项 ${it.dataset.tab} 有对应面板`,
    );
  }
});

test('提示词页：列表点行进编辑态，返回钮回列表', async () => {
  const ui = await boot('/settings/prompts');
  for (let i = 0; i < 60 && view(ui) !== 'settings'; i++) await sleep(20);
  for (let i = 0; i < 60 && !ui.document.querySelector('[data-prompt-open]'); i++) await sleep(20);
  const rows = ui.document.querySelectorAll('#prompt-rows [data-prompt-open]');
  // v3.58：笔记骨架 / 论文聊天 / 划线翻译三条从「后端有回退但页面改不了」补齐进来
  assert.strictEqual(rows.length, 9, '9 条提示词各占一行');
  const keys = [...rows].map((r) => r.dataset.promptOpen);
  for (const k of ['summary', 'tags', 'notes', 'concept', 'conceptMap', 'formula', 'chat', 'translate', 'mineruNaming']) {
    assert.ok(keys.includes(k), `提示词列表应含 ${k}`);
    assert.ok(
      ui.document.querySelector(`.prompt-pane[data-prompt-pane="${k}"] .ps[data-ps="${k}"]`),
      `${k} 应有对应的编辑工作台`,
    );
  }
  assert.strictEqual(ui.document.getElementById('prompt-index').hidden, false, '默认停在列表');

  ui.document.querySelector('[data-prompt-open="tags"]').click();
  assert.strictEqual(ui.document.getElementById('prompt-index').hidden, true);
  assert.strictEqual(ui.document.querySelector('.prompt-pane[data-prompt-pane="tags"]').hidden, false);

  ui.document.querySelector('.prompt-pane[data-prompt-pane="tags"] [data-prompt-back]').click();
  assert.strictEqual(ui.document.getElementById('prompt-index').hidden, false, '返回列表');
  assert.strictEqual(ui.document.querySelector('.prompt-pane[data-prompt-pane="tags"]').hidden, true);
});

// ---------------------------------------------------------------------------
// 筛选状态 ↔ query
// ---------------------------------------------------------------------------

test('筛选写入 query，且等于默认值的键不进 URL', async () => {
  const ui = await boot('/library');
  const inp = ui.$('search');
  inp.value = 'attention';
  inp.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  for (let i = 0; i < 80 && !ui.url().includes('q='); i++) await sleep(20);
  assert.ok(ui.url().includes('q=attention'), 'q 进 URL：' + ui.url());
  assert.ok(!ui.url().includes('sort='), '默认排序不写进 URL：' + ui.url());
  assert.ok(!ui.url().includes('starred='), '未加星标不写进 URL：' + ui.url());
});

test('深链带筛选 query：还原筛选并写回搜索框', async () => {
  const ui = await boot('/library?q=bert&tags=llm&starred=1');
  await sleep(60);
  assert.strictEqual(ui.$('search').value, 'bert', '搜索框回填');
  // 经 DOM 断言筛选已还原（window.pwState 桥已于「退役 window 桥」一并移除，
  // 测试不再伸手进模块内部——这些控件的状态本就是筛选还原的对外契约）。
  // 仅星标 checkbox 已退役（v3.18）：starred 筛选还原的对外契约改为侧栏「星标」视图 active 态。
  const starItem = ui.document.querySelector('.side-item[data-mode="starred"]');
  assert.ok(starItem.classList.contains('active'), '侧栏星标视图激活');
  const tagTrigger = ui.$('filter-tag-trigger');
  assert.ok(tagTrigger.classList.contains('active'), '标签筛选触发器进 active 态');
  assert.strictEqual(tagTrigger.querySelector('.ft-count').textContent.trim(), '1', '标签计数徽标为 1');
});

test('筛选 query 在「列表 → 详情」导航中保留', async () => {
  const ui = await boot('/library?q=bert');
  await sleep(60);
  ui.document.querySelector('.paper-item').click();
  for (let i = 0; i < 60 && !ui.path().startsWith('/paper'); i++) await sleep(20);
  assert.ok(ui.url().includes('q=bert'), '详情 URL 仍带筛选：' + ui.url());
});

// ---------------------------------------------------------------------------
// 前进 / 后退
// ---------------------------------------------------------------------------

test('后退：/paper/:id → /library，详情面板关闭', async () => {
  const ui = await boot('/library');
  ui.document.querySelector('.paper-item').click();
  for (let i = 0; i < 60 && ui.path() === '/library'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/paper/p1');

  await ui.back(120);
  for (let i = 0; i < 60 && ui.path() !== '/library'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/library', '后退回列表');
  assert.strictEqual(ui.document.querySelector('.paper-item.active'), null, '列表选中已清空');
  assert.ok(ui.$('detail').querySelector('.empty'), '详情面板回到空态');
});

test('后退跨视图：/formulas → /concepts，视图跟着回退', async () => {
  const ui = await boot('/concepts');
  for (let i = 0; i < 60 && view(ui) !== 'concepts'; i++) await sleep(20);
  nav(ui, 'formulas').click();
  for (let i = 0; i < 60 && view(ui) !== 'formulas'; i++) await sleep(20);

  await ui.back(120);
  for (let i = 0; i < 60 && view(ui) !== 'concepts'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/concepts');
  assert.strictEqual(view(ui), 'concepts');
});

test('前进：后退之后可再前进回原视图', async () => {
  const ui = await boot('/library');
  nav(ui, 'concepts').click();
  for (let i = 0; i < 60 && view(ui) !== 'concepts'; i++) await sleep(20);
  await ui.back(120);
  for (let i = 0; i < 60 && view(ui) !== 'library'; i++) await sleep(20);
  assert.strictEqual(view(ui), 'library');

  await ui.forward(120);
  for (let i = 0; i < 60 && view(ui) !== 'concepts'; i++) await sleep(20);
  assert.strictEqual(ui.path(), '/concepts');
  assert.strictEqual(view(ui), 'concepts');
});

// ---------------------------------------------------------------------------
// space 全局 query
// ---------------------------------------------------------------------------

test('?space= 深链：注入 API 请求，且跨导航自动携带', async () => {
  const urls = [];
  const ui = await bootUi({
    listItems: LIST,
    details: { p1: detailOf('p1'), p2: detailOf('p2') },
    // 空间列表须包含 cv，否则 loadSpaces 会认定「本地记忆的空间已不存在」而回退 active——
    // 这层校验是有意的（空间被删后旧链接不该把请求打到不存在的空间）。
    routes: {
      ...EXTRA_ROUTES,
      '/api/spaces': () =>
        json({
          activeSpaceId: 'default',
          spaces: [
            {
              id: 'default',
              name: 'LLM',
              papersDir: 'LLM',
              createdAt: 1,
              scanIntervalMinutes: 5,
              lastScanAt: 0,
              paperCount: 2,
            },
            {
              id: 'cv',
              name: 'CV',
              papersDir: 'CV',
              createdAt: 1,
              scanIntervalMinutes: 5,
              lastScanAt: 0,
              paperCount: 2,
            },
          ],
        }),
    },
    initialPath: '/library?space=cv',
  });
  await sleep(40);
  // 记录后续 GET
  const orig = ui.backend.fetch;
  ui.window.fetch = globalThis.fetch = async (u, o) => {
    urls.push(String(u));
    return orig(u, o);
  };

  ui.document.querySelector('.paper-item').click();
  // pushState 是同步的、详情请求是异步的——必须等请求真正发出，只等 URL 变会抢跑
  const hit = () => urls.some((u) => u.includes('/api/papers/p1') && u.includes('space=cv'));
  for (let i = 0; i < 80 && !hit(); i++) await sleep(20);

  assert.ok(ui.url().includes('space=cv'), '导航后 URL 仍带 space：' + ui.url());
  assert.ok(hit(), '详情请求带上了 space=cv：' + urls.join(' | '));
});
