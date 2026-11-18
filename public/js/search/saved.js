// 保存的搜索
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { icon } from '../core/icons.js';
import { PUT, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { triggerSearch, updateSearchModeIndicator } from '../library/list.js';
import { syncAdvancedPanelFromDsl, toggleAdvancedPanel } from './advanced.js';
import { toggleSearchHelp } from './help.js';
import { checkSuggestOnInput } from './suggest.js';
import { loadSettingsData } from '../settings/settings.js';

// ---- 保存的搜索（per-space，存 store.settings.savedSearches，经 PUT /api/settings/saved-searches）----
let _savedSearches = null; // null=未拉取；数组=已拉取

function getSavedSearches() {
  if (Array.isArray(_savedSearches)) return _savedSearches;
  return (_savedSearches = []);
}

export function setSavedSearches(arr) { _savedSearches = Array.isArray(arr) ? arr : []; }

export async function saveCurrentSearch() {
  const dsl = ($('search').value || '').trim();
  if (!dsl) { toast('请先输入搜索条件', 'info'); return; }
  const name = await PWDialog.prompt('为这个搜索命名：', { title: '保存搜索', value: dsl.slice(0, 30), placeholder: '搜索名称', okText: '保存' });
  if (!name) return;
  const arr = getSavedSearches().slice();
  arr.push({ name: name.trim() || dsl.slice(0, 20), dsl, createdAt: Date.now() });
  try {
    const r = await PUT('/api/settings/saved-searches', { value: arr });
    setSavedSearches((r && r.savedSearches) || arr);
    renderSavedSearches();
    toast('已保存');
  } catch (e) { toast(e.message || '保存失败', 'error'); }
}

async function deleteSavedSearch(idx) {
  const arr = getSavedSearches().slice();
  arr.splice(idx, 1);
  try {
    const r = await PUT('/api/settings/saved-searches', { value: arr });
    setSavedSearches((r && r.savedSearches) || arr);
    renderSavedSearches();
  } catch (e) { toast(e.message || '删除失败', 'error'); }
}

export function renderSavedSearches() {
  const root = $('saved-searches'); if (!root) return;
  const arr = getSavedSearches();
  root.hidden = !arr.length;
  if (!arr.length) { root.innerHTML = ''; return; }
  root.innerHTML = arr.map((s, i) => `<button class="saved-chip" data-i="${i}" title="${escapeHtml(s.dsl)}">${escapeHtml(s.name)}<span class="saved-chip-x" data-i="${i}" role="button" aria-label="删除">${icon('x', { size: 12 })}</span></button>`).join('');
  root.querySelectorAll('.saved-chip').forEach((b) => {
    b.onclick = (e) => {
      // 点 × 删除（不触发应用）
      const del = e.target.closest('.saved-chip-x'); // × 现在是 SVG，点中的可能是 svg/path
      if (del) { e.stopPropagation(); deleteSavedSearch(Number(del.dataset.i)); return; }
      const s = getSavedSearches()[Number(b.dataset.i)];
      if (!s) return;
      $('search').value = s.dsl;
      state.filter.q = s.dsl;
      syncAdvancedPanelFromDsl(s.dsl);
      updateSearchModeIndicator(s.dsl);
      triggerSearch(s.dsl, { immediate: true });
    };
  });
  positionSavedSearches();
}

/** 把保存的搜索 chip 行定位到搜索框下方左侧（fixed 浮层）。 */
export function positionSavedSearches() {
  const root = $('saved-searches');
  const inp = $('search');
  if (!root || !inp || root.hidden) return;
  const r = inp.getBoundingClientRect();
  root.style.top = (r.bottom + 4) + 'px';
  root.style.left = Math.max(8, r.left) + 'px';
  // 面板打开时往下让位
  const adv = $('advanced-search');
  if (adv && !adv.hidden) {
    const advR = adv.getBoundingClientRect();
    root.style.top = (advR.bottom + 4) + 'px';
  }
}

// 接线高级/帮助/补全按钮（bind() 之外，因为这些元素在 topbar）
function bindSearchGui() {
  const advBtn = $('search-advanced-toggle');
  if (advBtn) advBtn.onclick = (e) => { e.stopPropagation(); toggleAdvancedPanel(); };
  const helpBtn = $('search-help');
  if (helpBtn) helpBtn.onclick = (e) => { e.stopPropagation(); toggleSearchHelp(); };
  // 搜索框 oninput 也触发补全检测（在 bind() 的 oninput 之上叠加）
  const inp = $('search');
  if (inp) inp.addEventListener('input', () => checkSuggestOnInput());
  // 点高级面板/帮助/补全/保存搜索外部 → 关闭它们（浮层都是 fixed，需手动点外关闭）
  document.addEventListener('mousedown', (e) => {
    const adv = $('advanced-search');
    if (adv && !adv.hidden && !adv.contains(e.target) && e.target !== advBtn && !advBtn.contains(e.target)) {
      toggleAdvancedPanel(false);
    }
  }, true);
}

bindSearchGui();

// 启动后拉设置（含 savedSearches，loadSettingsData 内已调 renderSavedSearches）
loadSettingsData().then(() => { setTimeout(positionSavedSearches, 100); }).catch(() => {});

// 暴露给调试/reader 复用
window.PaperWikiSearchGUI = { triggerSearch, toggleAdvancedPanel, syncAdvancedPanelFromDsl, positionSavedSearches };
