'use strict';

// 阅读架前端测试（v3.21 多论文阅读抽屉）——jsdom 驱动 shelf.js + shelf-drawer.js（不依赖 pdf.js，
// 也不 boot 整个 app：抽屉模块与 pdf.js 解耦正是为了这里能直测）。
//
// 覆盖：
//   · 加载/上架/激活：追加不重排、已在不重复加、徽章计数
//   · 点击切换 onSwitch / 移除当前篇自动切邻居 / 移除非当前不切换 / 移除唯一篇关阅读器
//   · 拖拽重排（dragstart/dragover/drop 合成事件）+ PUT 顺序
//   · [/] 环绕切换（shelfStepId）
//   · 搜索添加（debounce → GET /api/papers?q= → 点击结果 onSwitch）
//   · 清空（PWDialog 确认 → onCloseReader）

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('reader-shelf-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PUB = path.join(__dirname, '..', 'public');

// ---- 假后端 ----
const backend = {
  shelf: { ids: [], items: [] },
  puts: [], // [{ ids }]
  searchResults: [],
  queries: [],
};
function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}
async function fakeFetch(url, opts = {}) {
  const u = new URL(url, 'http://localhost');
  const p = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (p === '/api/reader-shelf' && method === 'GET') return jsonRes({ ids: backend.shelf.ids.slice(), items: backend.shelf.items.filter((it) => backend.shelf.ids.includes(it.id)) });
  if (p === '/api/reader-shelf' && method === 'PUT') {
    backend.puts.push({ ids: (body && body.ids) || [] });
    backend.shelf.ids = (body && body.ids) || [];
    return jsonRes({ ids: backend.shelf.ids.slice(), items: backend.shelf.items.filter((it) => backend.shelf.ids.includes(it.id)) });
  }
  if (p === '/api/papers' && method === 'GET') {
    backend.queries.push(u.searchParams.get('q') || '');
    return jsonRes(backend.searchResults);
  }
  throw new Error('unexpected fetch: ' + method + ' ' + url);
}

const it0 = (id, title) => ({ id, title, year: '2024', status: 'ready', readStatus: 'unread', starred: false, readProgress: { page: 2, total: 10 } });

let dom, drawer, shelfMod, switches, closed, notified;
before(async () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/reader/p1', pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.localStorage = w.localStorage;
  globalThis.fetch = fakeFetch;
  w.fetch = fakeFetch;
  globalThis.PWDialog = w.PWDialog = { confirm: async () => true };
  globalThis.confirm = w.confirm = () => true;

  shelfMod = await import(pathToFileURL(path.join(PUB, 'js', 'reader', 'shelf.js')).href);
  const drawerMod = await import(pathToFileURL(path.join(PUB, 'js', 'reader', 'shelf-drawer.js')).href);
  switches = [];
  closed = 0;
  notified = [];
  drawer = drawerMod.createShelfDrawer({
    onSwitch: (id) => switches.push(id),
    onCloseReader: () => { closed++; },
    notify: (m) => notified.push(m),
  });
});

const $ = (id) => dom.window.document.getElementById(id);
const itemIds = () => [...dom.window.document.querySelectorAll('#reader-shelf-list .rsd-item')].map((n) => n.dataset.id);
const resetShelf = (ids, activeId) => {
  shelfMod.shelfState.ids = ids.slice();
  shelfMod.shelfState.items = {};
  for (const id of ids) shelfMod.shelfState.items[id] = it0(id, '论文 ' + id);
  shelfMod.shelfState.activeId = activeId || '';
  backend.shelf.ids = ids.slice();
  backend.shelf.items = Object.values(shelfMod.shelfState.items);
  backend.puts.length = 0;
  drawer.render();
};

test('初始加载 + 渲染：列表顺序、徽章计数、active 高亮', async () => {
  backend.shelf = { ids: ['p1', 'p2'], items: [it0('p1', 'Attention'), it0('p2', 'BERT')] };
  await shelfMod.ensureShelfLoaded();
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p2']);
  shelfMod.shelfState.activeId = 'p1';
  drawer.render();
  assert.deepStrictEqual(itemIds(), ['p1', 'p2']);
  assert.strictEqual($('reader-shelf-count').textContent, '2');
  assert.strictEqual($('reader-shelf-count').hidden, false);
  const active = dom.window.document.querySelector('#reader-shelf-list .rsd-item.active');
  assert.ok(active && active.dataset.id === 'p1', '当前篇高亮');
  assert.strictEqual(active.querySelector('.rsd-reading').textContent, '阅读中');
  // 标题走 textContent 渲染 + 进度元信息行
  assert.strictEqual(active.querySelector('.rsd-name-text').textContent, 'Attention');
  assert.ok(active.querySelector('.rsd-meta').textContent.includes('2/10'));
});

test('FAB 开合抽屉：shelf-open 类 + 隐藏态', async () => {
  drawer.toggle();
  assert.ok(drawer.isOpen());
  assert.ok($('reader-view').classList.contains('shelf-open'));
  drawer.close();
  assert.ok(!drawer.isOpen());
  assert.ok(!$('reader-view').classList.contains('shelf-open'));
});

test('上架：新论文追加末尾不重排；已在不重复加；PUT 发出全量顺序', async () => {
  resetShelf(['p1', 'p2'], 'p2');
  await shelfMod.shelfAddAndActivate({ id: 'p3', title: 'GPT', year: '2023', readProgress: null });
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p2', 'p3'], '追加到末尾');
  assert.strictEqual(shelfMod.shelfState.activeId, 'p3');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p1', 'p2', 'p3'], 'PUT 全量顺序');
  // 已在架上：只激活，不重复加、顺序不动
  await shelfMod.shelfAddAndActivate({ id: 'p1', title: 'Attention', readProgress: null });
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p2', 'p3']);
  assert.strictEqual(shelfMod.shelfState.activeId, 'p1');
  const putsBefore = backend.puts.length;
  await sleep(10);
  assert.strictEqual(backend.puts.length, putsBefore, '已在上架不再 PUT');
});

test('点击条目 → onSwitch(id)；点当前篇不触发', () => {
  resetShelf(['p1', 'p2', 'p3'], 'p2');
  const el = dom.window.document.querySelector('.rsd-item[data-id="p1"]');
  el.click();
  assert.deepStrictEqual(switches, ['p1']);
  dom.window.document.querySelector('.rsd-item[data-id="p2"]').click();
  assert.deepStrictEqual(switches, ['p1'], '点当前篇无切换');
});

test('移除非当前篇：只移除不切换；PUT 反映删除', async () => {
  resetShelf(['p1', 'p2', 'p3'], 'p2');
  switches.length = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p1"] .rsd-x').click();
  assert.deepStrictEqual(itemIds(), ['p2', 'p3']);
  assert.strictEqual(shelfMod.shelfState.activeId, 'p2');
  assert.deepStrictEqual(switches, [], '移除非当前篇不触发切换');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p2', 'p3']);
});

test('移除当前篇：自动切邻居（优先下一篇）', async () => {
  resetShelf(['p1', 'p2', 'p3'], 'p2');
  switches.length = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p2"] .rsd-x').click();
  assert.deepStrictEqual(itemIds(), ['p1', 'p3']);
  assert.deepStrictEqual(switches, ['p3'], '切到下一篇');
});

test('移除末尾当前篇：切前一篇；移除唯一篇：关阅读器', async () => {
  resetShelf(['p1', 'p2'], 'p2');
  switches.length = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p2"] .rsd-x').click();
  assert.deepStrictEqual(switches, ['p1'], '末尾篇切前一篇');
  // 真实链路里 onSwitch → /reader/:id → openReader 会回设 activeId，此处等价模拟
  shelfMod.shelfState.activeId = 'p1';
  closed = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p1"] .rsd-x').click();
  assert.strictEqual(closed, 1, '架子空了关阅读器');
  assert.deepStrictEqual(itemIds(), []);
  assert.ok($('reader-shelf-list').textContent.includes('架子是空的'), '空态提示');
});

test('拖拽重排：dragstart → dragover → drop（drop 在目标下半 = 插其后）', async () => {
  resetShelf(['p1', 'p2', 'p3'], 'p1');
  const w = dom.window;
  const src = dom.window.document.querySelector('.rsd-item[data-id="p1"]');
  const dst = dom.window.document.querySelector('.rsd-item[data-id="p3"]');
  src.dispatchEvent(new w.Event('dragstart', { bubbles: true }));
  // MouseEvent 才带 clientY（plain Event 无 → 判定落点时 undefined >= 0 为 false 走 above）
  dst.dispatchEvent(new w.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 0 }));
  assert.ok(dst.classList.contains('drop-below'), '落点指示线（jsdom clientY=0 ≥ 中点 → below）');
  dst.dispatchEvent(new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }));
  assert.deepStrictEqual(itemIds(), ['p2', 'p3', 'p1'], 'p1 移到 p3 之后');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p2', 'p3', 'p1'], '重排落库');
});

test('拖拽重排：drop 在列表空白处 = 移到末尾', async () => {
  resetShelf(['p1', 'p2', 'p3'], 'p3');
  const w = dom.window;
  dom.window.document.querySelector('.rsd-item[data-id="p1"]').dispatchEvent(new w.Event('dragstart', { bubbles: true }));
  $('reader-shelf-list').dispatchEvent(new w.Event('dragover', { bubbles: true, cancelable: true }));
  $('reader-shelf-list').dispatchEvent(new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }));
  assert.deepStrictEqual(itemIds(), ['p2', 'p3', 'p1']);
});

test('[/] 环绕切换：shelfStepId + stepSwitch 回调', () => {
  resetShelf(['p1', 'p2', 'p3'], 'p1');
  assert.strictEqual(shelfMod.shelfStepId(1), 'p2');
  assert.strictEqual(shelfMod.shelfStepId(-1), 'p3', '向前回绕到末尾');
  switches.length = 0;
  drawer.stepSwitch(-1);
  assert.deepStrictEqual(switches, ['p3']);
  resetShelf(['only'], 'only');
  switches.length = 0;
  drawer.stepSwitch(1);
  assert.deepStrictEqual(switches, [], '架上只有一篇无可切换');
  assert.ok(notified.length > 0, '无可切换给出提示');
});

test('搜索添加：debounce → GET /api/papers?q= → 点击结果 onSwitch', async () => {
  resetShelf(['p1'], 'p1');
  backend.searchResults = [{ id: 'p9', title: 'ViT', year: '2021' }, { id: 'p1', title: 'Attention', year: '2017' }];
  const input = $('reader-shelf-add');
  input.value = 'vit';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await sleep(320); // debounce 250ms
  assert.strictEqual(backend.queries[backend.queries.length - 1], 'vit');
  assert.ok(!$('reader-shelf-results').hidden, '结果面板显示');
  const rows = [...dom.window.document.querySelectorAll('.rsd-result')];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].querySelector('.rsd-result-title').textContent, 'ViT');
  assert.ok(rows[1].classList.contains('on-shelf'), '已上架的标记不可选');
  switches.length = 0;
  rows[0].click();
  assert.deepStrictEqual(switches, ['p9'], '点结果 → onSwitch（打开即上架）');
  assert.ok($('reader-shelf-results').hidden, '点击后结果收起');
  assert.strictEqual($('reader-shelf-add').value, '', '输入框清空');
});

test('清空：确认后架子清空 + 关阅读器 + PUT 空数组', async () => {
  resetShelf(['p1', 'p2'], 'p1');
  closed = 0;
  $('reader-shelf-clear').click();
  await sleep(10);
  assert.strictEqual(closed, 1, '关阅读器');
  assert.deepStrictEqual(shelfMod.shelfState.ids, []);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, [], 'PUT 空架');
});
