'use strict';

// 收藏夹管理面板测试（v3.22）——jsdom 直驱 folder-manager.js（真实 index.html DOM + 假后端）。
//
// 覆盖：
//   · 打开面板：列表行（名称/计数/顺序）、空态
//   · 行内编辑：✏️ 展开编辑行（回填名称/选中色）→ 改名换色保存 → PATCH + refresh 全链
//   · 新建：fm-new → 顶部编辑行 → 保存 → POST
//   · 删除：PWDialog 确认 → DEL；当前筛选指向被删夹时清筛选
//   · 拖拽排序：dragstart/dragover/drop → PUT /api/folders/order + 侧栏即时重排
//   · 编辑行取消恢复原行

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('folder-manager-ui')) return;

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
  folders: [], // [{id,name,color,createdAt}]（count 由 GET 现算）
  papers: [{ id: 'pa', folders: ['f2'], tags: [], topics: [] }],
  calls: [], // [{ method, path, body }]
};
function folderCounts() {
  const counts = {};
  for (const p of backend.papers) for (const f of p.folders || []) counts[f] = (counts[f] || 0) + 1;
  return counts;
}
function folderView() {
  const counts = folderCounts();
  return backend.folders.map((f) => ({ ...f, count: counts[f.id] || 0 }));
}
function jsonRes(data) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) };
}
async function fakeFetch(url, opts = {}) {
  const u = new URL(url, 'http://localhost');
  const p = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  backend.calls.push({ method, path: p, body });
  if (p === '/api/folders') {
    if (method === 'GET') return jsonRes(folderView());
    if (method === 'POST') {
      const f = { id: 'f_new', name: body.name, color: body.color, createdAt: Date.now() };
      backend.folders.push(f);
      return jsonRes(f);
    }
  }
  const fm = /^\/api\/folders\/([\w.-]+)$/.exec(p);
  if (fm) {
    const f = backend.folders.find((x) => x.id === fm[1]);
    if (method === 'PATCH' && f) { f.name = body.name; f.color = body.color; return jsonRes(f); }
    if (method === 'DELETE') {
      backend.folders = backend.folders.filter((x) => x.id !== fm[1]);
      for (const pp of backend.papers) pp.folders = (pp.folders || []).filter((x) => x !== fm[1]);
      return jsonRes({ deleted: fm[1] });
    }
  }
  if (p === '/api/folders/order' && method === 'PUT') {
    const byId = new Map(backend.folders.map((f) => [f.id, f]));
    const next = [];
    for (const id of body.ids || []) { const f = byId.get(id); if (f && !next.includes(f)) next.push(f); }
    for (const f of backend.folders) if (!next.includes(f)) next.push(f);
    backend.folders = next;
    return jsonRes(folderView());
  }
  if (p === '/api/papers' && method === 'GET') return jsonRes(backend.papers);
  if (p === '/api/tags') return jsonRes([]);
  if (p === '/api/topics') return jsonRes([]);
  if (p === '/api/stats') return jsonRes({ total: 1, ready: 1, processing: 0, error: 0, concepts: 0, formulas: 0, starred: 1, unread: 0 });
  throw new Error('unexpected fetch: ' + method + ' ' + url);
}

let dom, fmMod, state;
const $ = (id) => dom.window.document.getElementById(id);
const rows = () => [...dom.window.document.querySelectorAll('#fm-list .fm-row')];
const rowIds = () => rows().map((r) => r.dataset.id).filter(Boolean);
const sidebarIds = () => [...dom.window.document.querySelectorAll('#folder-list .side-item')].map((n) => n.dataset.folderId);
const callsOf = (method, path) => backend.calls.filter((c) => c.method === method && c.path === path);

before(async () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/library', pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.localStorage = w.localStorage;
  globalThis.fetch = fakeFetch;
  w.fetch = fakeFetch;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.PWDialog = w.PWDialog = { confirm: async () => true };
  globalThis.confirm = w.confirm = () => true;

  fmMod = await import(pathToFileURL(path.join(PUB, 'js', 'library', 'folder-manager.js')).href);
  ({ state } = await import(pathToFileURL(path.join(PUB, 'js', 'core', 'state.js')).href));
});

/** 重置：三个夹（f1 精读 / f2 待复现 / f3 综述），f2 计 1 篇。 */
function resetFolders(activeFilterId = '') {
  backend.folders = [
    { id: 'f1', name: '精读', color: '#2563eb', createdAt: 1 },
    { id: 'f2', name: '待复现', color: '#4f46e5', createdAt: 2 },
    { id: 'f3', name: '综述', color: '#0891b2', createdAt: 3 },
  ];
  state.folders = folderView();
  state.filter.folder = activeFilterId;
  backend.calls.length = 0;
  fmMod.openFolderManager();
}

test('打开面板：按序渲染名称/计数/色块；空态提示', () => {
  resetFolders();
  assert.ok($('folder-manager').classList.contains('active'));
  assert.deepStrictEqual(rowIds(), ['f1', 'f2', 'f3'], '顺序与 state.folders 一致');
  const r2 = rows()[1];
  assert.strictEqual(r2.querySelector('.fm-name').textContent, '待复现');
  assert.strictEqual(r2.querySelector('.fm-count').textContent, '1 篇');
  assert.strictEqual(r2.querySelector('.fm-swatch').style.background, 'rgb(79, 70, 229)');
  // 侧栏行内铅笔已退役（v3.22）
  assert.ok(!$('#folder-list [data-edit]'), '侧栏行内不再有编辑铅笔');
});

test('行内编辑：回填名称 → 改名换色保存 → PATCH + 列表/侧栏更新', async () => {
  resetFolders();
  rows()[0].querySelector('[data-act="edit"]').click();
  const editor = dom.window.document.querySelector('#fm-list .fm-row.fm-editing');
  assert.ok(editor, '编辑行替换原行');
  const input = editor.querySelector('.fm-name-input');
  assert.strictEqual(input.value, '精读', '回填当前名称');
  assert.ok(editor.querySelector('.fm-colors span.sel'), '当前色选中');
  // 改名 + 换第 2 个色
  input.value = '每日精读';
  editor.querySelectorAll('.fm-colors span')[1].click();
  editor.querySelector('.fm-save').click();
  await sleep(20);
  const patch = callsOf('PATCH', '/api/folders/f1');
  assert.strictEqual(patch.length, 1);
  assert.strictEqual(patch[0].body.name, '每日精读');
  assert.strictEqual(patch[0].body.color, '#7c3aed');
  // refresh 全链：state.folders 从假后端拉回，面板 + 侧栏同步
  assert.strictEqual(state.folders[0].name, '每日精读');
  assert.strictEqual(rows()[0].querySelector('.fm-name').textContent, '每日精读');
  const sideSwatch = dom.window.document.querySelector('#folder-list .side-item .swatch');
  assert.strictEqual(sideSwatch.style.background, 'rgb(124, 58, 237)', '侧栏色块同步换色（#7c3aed）');
  assert.ok(!dom.window.document.querySelector('#fm-list .fm-row.fm-editing'), '编辑行收起');
});

test('编辑行取消：恢复原行不发请求', () => {
  resetFolders();
  rows()[2].querySelector('[data-act="edit"]').click();
  dom.window.document.querySelector('#fm-list .fm-cancel').click();
  assert.deepStrictEqual(rowIds(), ['f1', 'f2', 'f3']);
  assert.strictEqual(callsOf('PATCH', '/api/folders/f3').length, 0);
});

test('新建：fm-new → 顶部编辑行 → 保存 POST', async () => {
  resetFolders();
  $('fm-new').click();
  const editor = dom.window.document.querySelector('#fm-list .fm-row.fm-editing');
  assert.ok(editor);
  assert.strictEqual(rows()[0], editor, '新建编辑行置顶');
  editor.querySelector('.fm-name-input').value = '经典必读';
  editor.querySelectorAll('.fm-colors span')[4].click(); // PALETTE[4] = #db2777
  editor.querySelector('.fm-save').click();
  await sleep(20);
  const posts = callsOf('POST', '/api/folders');
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(posts[0].body, { name: '经典必读', color: '#db2777' });
  assert.ok(state.folders.some((f) => f.name === '经典必读'), 'refresh 后 state.folders 含新夹');
});

test('新建空名：提示且不落库', async () => {
  resetFolders();
  $('fm-new').click();
  const editor = dom.window.document.querySelector('#fm-list .fm-row.fm-editing');
  editor.querySelector('.fm-save').click();
  await sleep(10);
  assert.strictEqual(callsOf('POST', '/api/folders').length, 0);
  assert.ok(dom.window.document.querySelector('#fm-list .fm-row.fm-editing'), '编辑行保持');
});

test('删除：确认后 DEL + 解绑；筛选指向被删夹时清筛选', async () => {
  resetFolders('f2'); // 当前正在看 f2 视图
  rows()[1].querySelector('[data-act="del"]').click();
  await sleep(20);
  assert.strictEqual(callsOf('DELETE', '/api/folders/f2').length, 1);
  assert.strictEqual(state.filter.folder, '', '筛选指向被删夹 → 清筛选');
  assert.deepStrictEqual(state.folders.map((f) => f.id), ['f1', 'f3']);
});

test('拖拽排序：drop 目标下半 = 插其后 → PUT order + 侧栏即时重排', async () => {
  resetFolders();
  const w = dom.window;
  const src = rows()[0]; // f1
  const dst = rows()[2]; // f3
  src.dispatchEvent(new w.Event('dragstart', { bubbles: true }));
  dst.dispatchEvent(new w.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 0 }));
  assert.ok(dst.classList.contains('drop-below'), '落点指示线（clientY=0 ≥ 中点 → below）');
  dst.dispatchEvent(new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }));
  await sleep(20);
  assert.deepStrictEqual(rowIds(), ['f2', 'f3', 'f1'], 'f1 移到 f3 之后');
  const puts = callsOf('PUT', '/api/folders/order');
  assert.strictEqual(puts.length, 1);
  assert.deepStrictEqual(puts[0].body.ids, ['f2', 'f3', 'f1']);
  assert.deepStrictEqual(sidebarIds(), ['f2', 'f3', 'f1'], '侧栏即时按新序重渲（不等 refresh）');
});

test('空态：无收藏夹时给出引导文案', () => {
  backend.folders = [];
  state.folders = [];
  fmMod.openFolderManager();
  assert.ok($('fm-list').textContent.includes('还没有收藏夹'));
});
