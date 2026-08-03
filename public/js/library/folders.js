// 收藏夹模态与首页
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $, PALETTE } from '../core/dom.js';
import { router } from '../core/nav.js';
import { filterToQuery } from '../core/routes.js';
import { state } from '../core/state.js';
import { reader } from '../detail/info-tab.js';
import { syncAdvancedPanelFromDsl } from '../search/advanced.js';
import { showView } from '../views/view-switch.js';

// ---- 收藏夹模态 ----
export let editingFolder = null;

export let pickedColor = PALETTE[0];

export function openFolderModal(folder) {
  editingFolder = folder || null;
  $('folder-modal-title').textContent = folder ? '编辑收藏夹' : '新建收藏夹';
  $('folder-name-input').value = folder ? folder.name : '';
  pickedColor = folder ? folder.color : PALETTE[0];
  const cp = $('folder-color-picks');
  cp.innerHTML = PALETTE.map((c) => `<span class="${c === pickedColor ? 'sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
  cp.querySelectorAll('span').forEach((s) => s.onclick = () => {
    pickedColor = s.dataset.c;
    cp.querySelectorAll('span').forEach((x) => x.classList.toggle('sel', x === s));
  });
  $('folder-modal-delete').style.display = folder ? '' : 'none';
  $('folder-modal').classList.add('active');
  setTimeout(() => $('folder-name-input').focus(), 30);
}

// ---- 视图切换（概念/库/设置） ----
export function showLibrary() { showView('library'); }

/** 点击左上角 logo：回到初始页面（库视图 + 全部论文 + 清筛选/搜索/选中）。
 *  - 阅读器开着先关掉（不强制落盘外的副作用）
 *  - 切回 library 视图（沿用 settings/concepts 的「← 返回」同等语义）
 *  - 重置筛选为「全部论文」（与侧栏「全部论文」项一致），保留 sort
 *  - 清空搜索框 / 退出全文检索模式 / 取消选中论文
 *  空间不变（与 switchSpace 的清场逻辑区分）。 */
export function goHome() {
  if (reader && $('reader-view').classList.contains('active')) reader.close();
  state.selected = new Set();
  state.pickMode = false;
  state.filter = { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: state.filter.sort };
  $('search').value = '';
  syncAdvancedPanelFromDsl('');
  if (state.ft) { state.ft = null; }
  // 导航到干净的 /library（sort 不是默认值时才进 query）——清空 current/detail 与重拉数据
  // 都由 enterLibrary 完成，这里不再手工 refresh + renderDetail。
  router.navigate('/library', { query: filterToQuery(state.filter) });
}
