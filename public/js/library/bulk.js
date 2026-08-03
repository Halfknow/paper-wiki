// 多选与批量操作
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { renderList } from './list.js';

// ---- 多选 + 抽取概念 ----
export function syncPickUI() {
  const n = state.selected.size;
  const total = state.papers.length;
  $('sel-count').textContent = '已选 ' + n + ' 篇';
  // 全选按钮：全选/取消全选随当前选中态切换文案
  const allBtn = $('btn-pick-all');
  if (allBtn) {
    const allOn = total > 0 && n === total;
    allBtn.textContent = allOn ? '取消全选' : '全选';
    allBtn.classList.toggle('active', allOn);
  }
}

export function togglePick(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  syncPickUI();
  renderList();
}

export function togglePickMode(on) {
  state.pickMode = on;
  $('bulk-bar').classList.toggle('active', on);
  if (!on) { state.selected.clear(); closeBulkMenu(); }
  syncPickUI();
  const pickBtn = $('btn-pick');
  pickBtn.querySelector('.btn-text').textContent = on ? '退出多选' : '多选';
  pickBtn.classList.toggle('active', on);
  pickBtn.classList.toggle('subtle', !on);
  renderList();
}

// 批量操作下拉（底部栏，菜单上弹）。仿 space-menu 模式：触发器 stopPropagation + document 外部关闭。
function openBulkMenu() { const m = $('bulk-menu'); if (m) { m.hidden = false; $('bulk-actions').classList.add('open'); } }

export function closeBulkMenu() { const m = $('bulk-menu'); if (m) { m.hidden = true; $('bulk-actions').classList.remove('open'); } }

export function toggleBulkMenu() { const m = $('bulk-menu'); if (!m) return; m.hidden ? openBulkMenu() : closeBulkMenu(); }

/** 统一 busy 门：开启时给底部栏加 .bulk-busy（CSS 统一禁用菜单项/触发器/删除键的交互）+ 显示进度条 + 关菜单；
 *  结束时恢复。取代每个动作里 5 处手动 disabled。 */
export function setBulkBusy(on, label) {
  const bar = $('bulk-bar');
  if (!bar) return;
  bar.classList.toggle('bulk-busy', on);
  const bp = $('bulk-progress');
  if (bp) {
    bp.hidden = !on;
    if (on && label && $('bp-text')) $('bp-text').textContent = label;
  }
  if (on) closeBulkMenu();
}

/** 真实百分比进度：done/total。批量端点是一次性 await 整批、无流式，故前端逐篇循环拿真实进度。 */
export function updateBulkProgress(done, total, label) {
  const bp = $('bulk-progress'), bpText = $('bp-text'), bpFill = $('bp-fill'), bpPct = $('bp-pct');
  if (bp) bp.hidden = false;
  if (bpText && label) bpText.textContent = label + '（' + done + '/' + total + '）…';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bpFill) { bpFill.style.width = pct + '%'; bpFill.classList.remove('indeterminate'); }
  if (bpPct) bpPct.textContent = pct + '%';
}
