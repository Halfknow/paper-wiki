// 搜索框内联补全
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { api, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { triggerSearch, updateSearchModeIndicator } from '../library/list.js';
import { syncAdvancedPanelFromDsl } from './advanced.js';

// ---- 内联补全（tag:/topic:/author:/title: 等 field: 前缀触发）----
let _suggestPop = null;

let _suggestItems = [];

let _suggestActive = 0;

let _suggestField = '';

let _suggestValueStart = 0;

function openSuggest(field, prefix, valueStart) {
  _suggestField = field; _suggestValueStart = valueStart;
  fetch(sp('/api/search/suggest?field=' + encodeURIComponent(field) + '&prefix=' + encodeURIComponent(prefix) + '&limit=10'))
    .then((r) => r.json())
    .then((r) => {
      const items = (r && r.data && r.data.results) || [];
      _suggestItems = items; _suggestActive = 0;
      if (!items.length) { closeSuggest(); return; }
      renderSuggestPop(prefix);
    })
    .catch(() => closeSuggest());
}

function renderSuggestPop(prefix) {
  if (!_suggestPop) {
    _suggestPop = document.createElement('div');
    _suggestPop.className = 'search-suggest-pop';
    document.body.appendChild(_suggestPop);
    _suggestPop.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.ss-item');
      if (!it) return;
      e.preventDefault(); // 防 blur
      confirmSuggest(Number(it.dataset.idx));
    });
    _suggestPop.addEventListener('mouseover', (e) => {
      const it = e.target.closest('.ss-item');
      if (!it) return;
      const idx = Number(it.dataset.idx);
      if (idx !== _suggestActive) { _suggestActive = idx; renderSuggestItems(); }
    });
  }
  _suggestPop.innerHTML = '<div class="ss-head">' + escapeHtml(_suggestField) + ': <span class="ss-prefix">' + escapeHtml(prefix || ' ') + '</span></div><div class="ss-list"></div>';
  renderSuggestItems();
  positionSuggestPop();
  _suggestPop.style.display = 'block';
}

function renderSuggestItems() {
  const list = _suggestPop.querySelector('.ss-list');
  if (!list) return;
  list.innerHTML = _suggestItems.map((it, i) => `<div class="ss-item${i === _suggestActive ? ' active' : ''}" data-idx="${i}"><span class="ss-val"></span><span class="ss-count">${it.count}</span></div>`).join('');
  list.querySelectorAll('.ss-item').forEach((el, i) => { el.querySelector('.ss-val').textContent = _suggestItems[i].value; });
  const active = list.children[_suggestActive];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function positionSuggestPop() {
  const inp = $('search'); if (!inp || !_suggestPop) return;
  const r = inp.getBoundingClientRect();
  const popH = _suggestPop.offsetHeight || 200;
  let top = r.bottom + 4;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 4;
  if (top < 8) top = r.bottom + 4;
  _suggestPop.style.top = top + 'px';
  _suggestPop.style.left = Math.max(8, r.left) + 'px';
  _suggestPop.style.width = Math.min(420, r.width) + 'px';
}

function confirmSuggest(idx) {
  const it = _suggestItems[idx]; if (!it) return;
  const inp = $('search'); if (!inp) return;
  const v = inp.value;
  // 替换 valueStart 到光标的内容为选中值
  const cursor = inp.selectionStart != null ? inp.selectionStart : v.length;
  const before = v.slice(0, _suggestValueStart) + it.value;
  const after = v.slice(cursor);
  inp.value = before + ' ' + after;
  inp.selectionStart = inp.selectionEnd = before.length + 1;
  state.filter.q = inp.value;
  closeSuggest();
  syncAdvancedPanelFromDsl(inp.value);
  updateSearchModeIndicator(inp.value);
  triggerSearch(inp.value, { immediate: true });
  inp.focus();
}

function moveSuggestActive(delta) {
  if (!_suggestItems.length) return;
  _suggestActive = (_suggestActive + delta + _suggestItems.length) % _suggestItems.length;
  renderSuggestItems();
}

export function closeSuggest() {
  if (_suggestPop) { _suggestPop.style.display = 'none'; }
  _suggestItems = []; _suggestField = ''; return false;
}

/** 输入框 keydown 时：若补全浮层打开，路由 ↑↓/Enter/Tab/Esc。返回 true = 已消费。 */
export function handleSuggestKeydown(e) {
  if (!_suggestPop || _suggestPop.style.display === 'none' || !_suggestItems.length) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestActive(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestActive(-1); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmSuggest(_suggestActive); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return true; }
  return false;
}

/** oninput 时检测 field: 前缀，触发补全。 */
export function checkSuggestOnInput() {
  const S = window.PaperWikiSearch;
  const inp = $('search'); if (!inp || !S) return;
  const det = S.detectFieldAtCursor(inp.value, inp.selectionStart != null ? inp.selectionStart : inp.value.length);
  const knownFields = ['tag', 'topic', 'author', 'title', 'status', 'read'];
  if (det && knownFields.includes(det.field)) {
    // 防抖
    clearTimeout(inp._suggestTimer);
    inp._suggestTimer = setTimeout(() => openSuggest(det.field, det.prefix, det.valueStart), 180);
  } else {
    closeSuggest();
  }
}
