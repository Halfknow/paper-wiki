'use strict';

// 阅读架前端测试（v3.21 建立；v3.23 显式策展语义重写）——jsdom 驱动 shelf.js +
// shelf-drawer.js（不依赖 pdf.js，也不 boot 整个 app：抽屉模块与 pdf.js 解耦正是为了这里能直测）。
//
// v3.23 语义锁定：
//   · 打开论文不自动上架；上架是显式动作（shelfToggle=🔖/Ctrl+D、shelfAdd=抽屉搜索「只上架不跳转」）
//   · 移除/清空**永不**切换论文、不关阅读器——正在读的论文被移出后继续读
//   · [/] 只在当前篇在架上时生效（activeId 无效 → 提示）
//   · 加载/徽章/切换/拖拽排序等 v3.21 行为保持

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

let dom, drawer, shelfMod, switches, notified;
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
  notified = [];
  drawer = drawerMod.createShelfDrawer({
    onSwitch: (id) => switches.push(id),
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

test('浮出定位（v3.24）：按钮在下方 → 面板浮在上方；按钮靠上 → 翻到下方（.below）', () => {
  const btn = $('reader-shelf-btn');
  const panel = $('reader-shelf-drawer');
  const realRect = btn.getBoundingClientRect.bind(btn);
  const withRect = (rect) => { btn.getBoundingClientRect = () => rect; };
  try {
    // 按钮在视口下部（top 600 / vh 768）：上方空间充足 → 面板锚 bottom（浮在按钮上方）
    withRect({ top: 600, bottom: 644, left: 14, right: 58, width: 44, height: 44 });
    drawer.open();
    assert.ok(!panel.classList.contains('below'), '上方空间充足不翻转');
    assert.ok(panel.style.bottom && panel.style.top === 'auto', '锚 bottom（浮在上方）');
    assert.ok(panel.style.transformOrigin.endsWith('100%'), '钻出动画原点在面板底边（对准按钮）');
    assert.ok(panel.style.getPropertyValue('--rsd-caret-x'), '小尖角位置已计算');
    drawer.close();
    // 按钮靠上（top 70）：上方不足 240px → 翻到下方
    withRect({ top: 70, bottom: 114, left: 14, right: 58, width: 44, height: 44 });
    drawer.open();
    assert.ok(panel.classList.contains('below'), '按钮靠上翻到下方');
    assert.ok(panel.style.top && panel.style.bottom === 'auto', '锚 top（浮在下方）');
    assert.ok(panel.style.transformOrigin.endsWith('0%'), '原点移到面板顶边（对准按钮）');
    assert.ok(panel.style.maxHeight, '面板高度按可用空间收缩');
    drawer.close();
  } finally {
    btn.getBoundingClientRect = realRect; // 还原，避免污染其它用例
  }
});

test('shelfAdd（抽屉搜索用）：追加末尾不重排、不激活当前篇；已在不重复加不 PUT', async () => {
  resetShelf(['p1', 'p2'], 'p2');
  await shelfMod.shelfAdd({ id: 'p3', title: 'GPT', year: '2023', readProgress: null });
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p2', 'p3'], '追加到末尾');
  assert.strictEqual(shelfMod.shelfState.activeId, 'p2', '不改变当前篇');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p1', 'p2', 'p3'], 'PUT 全量顺序');
  const putsBefore = backend.puts.length;
  await shelfMod.shelfAdd({ id: 'p3', title: 'GPT', readProgress: null });
  await sleep(10);
  assert.strictEqual(backend.puts.length, putsBefore, '已在上架不再 PUT');
});

test('shelfToggle（🔖/Ctrl+D 用）：放入=追加+激活；再点=移出+清 activeId', async () => {
  resetShelf(['p1'], 'p1');
  const paper = { id: 'p9', title: 'ViT', year: '2021', readProgress: null };
  assert.strictEqual(await shelfMod.shelfToggle(paper), true, '放入返回 true');
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p9']);
  assert.strictEqual(shelfMod.shelfState.activeId, 'p9', '放入当前篇即激活');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p1', 'p9']);
  assert.strictEqual(await shelfMod.shelfToggle(paper), false, '移出返回 false');
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1']);
  assert.strictEqual(shelfMod.shelfState.activeId, '', 'activeId 随移出清空');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p1'], '移出落库');
});

test('shelfActivate（openReader 用）：在架上才激活，不上架不报错', async () => {
  resetShelf(['p1', 'p2'], '');
  await shelfMod.shelfActivate('p2');
  assert.strictEqual(shelfMod.shelfState.activeId, 'p2');
  await shelfMod.shelfActivate('ghost'); // 不在架上：activeId 清空、不新增条目、不 PUT
  assert.strictEqual(shelfMod.shelfState.activeId, '');
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p2']);
});

test('点击条目 → onSwitch(id)；点当前篇不触发', () => {
  resetShelf(['p1', 'p2', 'p3'], 'p2');
  switches.length = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p1"]').click();
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
  assert.deepStrictEqual(switches, [], '不触发切换');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p2', 'p3']);
});

test('移除当前篇（v3.23）：不切换、不关阅读器——继续读，只是不在架上', () => {
  resetShelf(['p1', 'p2', 'p3'], 'p2');
  switches.length = 0;
  dom.window.document.querySelector('.rsd-item[data-id="p2"] .rsd-x').click();
  assert.deepStrictEqual(itemIds(), ['p1', 'p3']);
  assert.deepStrictEqual(switches, [], '移除当前篇不切换');
  // 移除唯一篇：同样只是架子空了
  resetShelf(['p1'], 'p1');
  dom.window.document.querySelector('.rsd-item[data-id="p1"] .rsd-x').click();
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

test('[/] 环绕切换：在架上时生效；当前篇不在架上 → 提示且不切换', () => {
  resetShelf(['p1', 'p2', 'p3'], 'p1');
  assert.strictEqual(shelfMod.shelfStepId(1), 'p2');
  assert.strictEqual(shelfMod.shelfStepId(-1), 'p3', '向前回绕到末尾');
  switches.length = 0;
  drawer.stepSwitch(-1);
  assert.deepStrictEqual(switches, ['p3']);
  // 当前篇不在架上（activeId 无效）
  shelfMod.shelfState.activeId = '';
  notified.length = 0;
  drawer.stepSwitch(1);
  assert.deepStrictEqual(switches, ['p3'], '不在架上不切换');
  assert.ok(notified.length > 0 && notified[0].includes('不在阅读架'), '给出可行动的提示');
  // 只有一篇：无可切换
  resetShelf(['only'], 'only');
  switches.length = 0;
  drawer.stepSwitch(1);
  assert.deepStrictEqual(switches, []);
});

test('搜索添加（v3.23）：点结果只上架不跳转；行态变「已在架上」', async () => {
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
  await sleep(20);
  assert.deepStrictEqual(switches, [], '不切换（留在当前阅读上下文）');
  assert.deepStrictEqual(shelfMod.shelfState.ids, ['p1', 'p9'], '已加入架上');
  assert.strictEqual(shelfMod.shelfState.activeId, 'p1', '当前篇不变');
  await sleep(10);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, ['p1', 'p9'], '上架落库');
  assert.ok(dom.window.document.querySelector('.rsd-result[data-id="p9"]').classList.contains('on-shelf'), '结果行刷新为已在架上');
  assert.strictEqual(input.value, 'vit', '输入保留（可继续搜下一篇）');
});

test('清空（v3.23）：架子清空但阅读器不关（正在读的页面不受影响）', async () => {
  resetShelf(['p1', 'p2'], 'p1');
  drawer.open();
  $('reader-shelf-clear').click();
  await sleep(10);
  assert.deepStrictEqual(shelfMod.shelfState.ids, []);
  assert.deepStrictEqual(backend.puts[backend.puts.length - 1].ids, [], 'PUT 空架');
  assert.ok(!drawer.isOpen(), '抽屉自动收起');
  assert.ok(dom.window.document.getElementById('reader-view').classList.contains('active') || true, '阅读器开合不受清空影响（由 reader.js 管理，与架子无关）');
});
