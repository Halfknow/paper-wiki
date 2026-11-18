// 命令面板 + 快捷键帮助（v3.32 R8）：键盘效率中心。
//
// 设计动机：研究者高频键盘流（搜索 → 选论文 → 切视图），且应用散落多处快捷键
// （/ 聚焦搜索、阅读器 [/]/Ctrl+D…）但无处可发现。两个入口：
//   · Ctrl/Cmd+K 命令面板：论文/概念/公式即时跳转 + 常用动作（导航/扫描/新增/设置）
//   · ? 快捷键帮助：诚实列出**实际存在**的键位（与本模块同源的静态表）
//
// 交互：↑↓ 选择、Enter 执行、Esc 关闭；输入即过滤（前缀命中优先于包含命中）。
// 索引打开时从 state 现算（数据全在内存），不维护缓存。

import { router } from './nav.js';
import { state } from './state.js';
import { toast } from './ui-kit.js';

const ACTIONS = [
  { id: 'a:library', label: '去：论文库', hint: '导航', run: () => router.navigate('/library', { keepQuery: false }) },
  { id: 'a:concepts', label: '去：概念清单', hint: '导航', run: () => router.navigate('/concepts', { keepQuery: false }) },
  { id: 'a:formulas', label: '去：公式清单', hint: '导航', run: () => router.navigate('/formulas', { keepQuery: false }) },
  { id: 'a:settings', label: '去：设置', hint: '导航', run: () => router.navigate('/settings', { keepQuery: false }) },
  {
    id: 'a:scan',
    label: '扫描论文目录',
    hint: '动作',
    run: () => {
      const btn = document.getElementById('btn-scan');
      if (btn) btn.click();
      else toast('扫描按钮不可用', 'error');
    },
  },
  {
    id: 'a:add-concept',
    label: '新增概念',
    hint: '动作',
    run: () => import('../concepts/concepts.js').then((m) => m.createConcept()),
  },
  {
    id: 'a:add-formula',
    label: '新增公式',
    hint: '动作',
    run: () => import('../formulas/editor-drawer.js').then((m) => m.openFormulaEditor(null)),
  },
];

/** 快捷键表（? 帮助 + 面板底部提示共用）。只列实际接线存在的键位。 */
export const SHORTCUTS = [
  { keys: 'Ctrl/⌘ + K', desc: '命令面板（论文 / 概念 / 公式跳转 + 动作）' },
  { keys: '?', desc: '快捷键帮助（本面板）' },
  { keys: '/', desc: '聚焦顶栏搜索框' },
  { keys: '↑ ↓ / Enter', desc: '命令面板内导航与执行' },
  { keys: 'Esc', desc: '分层关闭：弹窗 → 抽屉 → 面板 → 阅读器' },
  { keys: '[ / ]', desc: '阅读器内：阅读架上一篇 / 下一篇（当前篇在架上时）' },
  { keys: 'Ctrl/⌘ + D', desc: '阅读器内：当前论文加入 / 移出阅读架' },
];

let _root = null;
let _active = 0;
let _items = [];
let _closeHandler = null;

/** 输入框正在打字时全局快捷键让位（面板自身输入除外）。 */
export function isTypingTarget(t) {
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function openCommandPalette() {
  if (_root) return; // 已开（幂等）
  _buildIndex();
  _active = 0;
  _root = document.createElement('div');
  _root.className = 'pwdlg-mask cp-mask';
  _root.innerHTML = `
    <div class="pwdlg cp" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="cp-input-row">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" class="cp-input" placeholder="跳转到论文 / 概念 / 公式，或执行动作…" autocomplete="off" spellcheck="false" />
        <kbd class="cp-kbd">Esc</kbd>
      </div>
      <div class="cp-list" role="listbox"></div>
      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 执行</span>
        <span><kbd>?</kbd> 全部快捷键</span>
      </div>
    </div>`;
  document.body.appendChild(_root);
  const input = _root.querySelector('.cp-input');
  input.addEventListener('input', () => { _filter(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); _runActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
    else if (e.key === '?' && input.value === '') { e.preventDefault(); closeCommandPalette(); openShortcutsHelp(); }
  });
  _root.addEventListener('mousedown', (e) => { if (e.target === _root) closeCommandPalette(); });
  _closeHandler = (e) => { if (e.key === 'Escape') closeCommandPalette(); };
  document.addEventListener('keydown', _closeHandler, true);
  _filter('');
  requestAnimationFrame(() => _root.classList.add('show'));
  setTimeout(() => input.focus(), 20);
}

export function closeCommandPalette() {
  if (!_root) return;
  const el = _root;
  _root = null;
  if (_closeHandler) { document.removeEventListener('keydown', _closeHandler, true); _closeHandler = null; }
  el.classList.remove('show');
  setTimeout(() => el.remove(), 130);
}

function _buildIndex() {
  const idx = [];
  for (const p of state.papers || []) {
    idx.push({
      id: 'p:' + p.id,
      label: p.title || p.filename,
      sub: p.year ? String(p.year) : '论文',
      kind: '论文',
      run: () => router.navigate('/paper/' + p.id, { keepQuery: false }),
    });
  }
  for (const c of state.concepts || []) {
    idx.push({
      id: 'c:' + c.id,
      label: c.term,
      sub: (c.paperIds || []).length + ' 篇 · 概念',
      kind: '概念',
      run: () => import('../concepts/detail-drawer.js').then((m) => m.openConceptDetail(c.id)),
    });
  }
  for (const f of state.formulas || []) {
    idx.push({
      id: 'f:' + f.id,
      label: f.name || f.canonicalName,
      sub: f.canonicalName + ' · 公式',
      kind: '公式',
      run: () => router.navigate('/formulas', { keepQuery: false }).then(() => import('../formulas/editor-drawer.js').then((m) => m.openFormulaEditor(f))),
    });
  }
  for (const a of ACTIONS) idx.push({ ...a, sub: a.hint, kind: '动作' });
  _all = idx;
}

let _all = [];

/** 过滤 + 排序：动作在前（少量、可发现性优先），条目前缀命中 > 包含命中 > 字母序。 */
function _filter(q) {
  const needle = q.trim().toLowerCase();
  let hits;
  if (!needle) {
    hits = [..._all.filter((x) => x.kind === '动作'), ..._all.filter((x) => x.kind !== '动作')];
  } else {
    const scored = [];
    for (const x of _all) {
      const hay = (x.label + ' ' + (x.sub || '')).toLowerCase();
      const li = x.label.toLowerCase();
      let score = -1;
      if (li.startsWith(needle)) score = 0;
      else if (li.includes(needle)) score = 1;
      else if (hay.includes(needle)) score = 2;
      if (score >= 0) scored.push({ x, score });
    }
    scored.sort((a, b) => a.score - b.score || a.x.label.localeCompare(b.x.label));
    hits = scored.map((s) => s.x);
  }
  _items = hits.slice(0, 30);
  _active = 0;
  _renderList();
}

function _renderList() {
  const list = _root.querySelector('.cp-list');
  list.innerHTML = _items.length
    ? _items
        .map(
          (x, i) =>
            `<div class="cp-item${i === _active ? ' active' : ''}" role="option" aria-selected="${i === _active}" data-i="${i}">
              <span class="cp-kind badge ${x.kind === '论文' ? 'info' : x.kind === '概念' ? 'violet' : x.kind === '公式' ? 'cyan' : 'success'}">${x.kind}</span>
              <span class="cp-label" title="${String(x.label).replace(/"/g, '&quot;')}"></span>
              <span class="cp-sub">${x.sub || ''}</span>
            </div>`,
        )
        .join('')
    : '<div class="cp-empty">没有匹配项</div>';
  // label 用 textContent 填（免转义）
  list.querySelectorAll('.cp-item').forEach((el) => {
    const x = _items[Number(el.dataset.i)];
    el.querySelector('.cp-label').textContent = x.label;
    el.onclick = () => { _active = Number(el.dataset.i); _runActive(); };
    el.onmousemove = () => {
      if (_active !== Number(el.dataset.i)) { _active = Number(el.dataset.i); list.querySelectorAll('.cp-item').forEach((e2) => e2.classList.remove('active')); el.classList.add('active'); }
    };
  });
  const act = list.children[_active];
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function _move(d) {
  if (!_items.length) return;
  _active = (_active + d + _items.length) % _items.length;
  const list = _root.querySelector('.cp-list');
  list.querySelectorAll('.cp-item').forEach((el, i) => {
    el.classList.toggle('active', i === _active);
    el.setAttribute('aria-selected', String(i === _active));
  });
  const act = list.children[_active];
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function _runActive() {
  const x = _items[_active];
  if (!x) return;
  closeCommandPalette();
  try { x.run(); } catch (e) { toast('执行失败：' + (e && e.message ? e.message : e), 'error'); }
}

/** ? 帮助：静态快捷键总览（与 SHORTCUTS 表同源，保证不撒谎）。 */
export function openShortcutsHelp() {
  const mask = document.createElement('div');
  mask.className = 'pwdlg-mask';
  mask.innerHTML = `
    <div class="pwdlg cp-help" role="dialog" aria-modal="true" aria-label="快捷键">
      <h3 class="pwdlg-title">快捷键</h3>
      <table class="cp-help-table">
        ${SHORTCUTS.map((s) => `<tr><td><kbd>${s.keys}</kbd></td><td>${s.desc}</td></tr>`).join('')}
      </table>
      <div class="pwdlg-actions"><button type="button" class="btn sm cp-help-ok">知道了</button></div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.classList.remove('show'); setTimeout(() => mask.remove(), 130); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.cp-help-ok').onclick = close;
  requestAnimationFrame(() => mask.classList.add('show'));
  setTimeout(() => mask.querySelector('.cp-help-ok').focus(), 20);
}
