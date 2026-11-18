// 管理收藏夹面板（v3.22）：入口在侧栏「收藏夹」标题行右侧 ⚙（bind.js 接线）。
//
// 收藏夹完整生命周期一处收口，取代旧的 folder-modal（新建/编辑弹窗）与侧栏行内 hover 铅笔：
//   · 新建 —— 底部「＋ 新建收藏夹」→ 顶部插入行内编辑行（名称 + 8 色色板）
//   · 改名/换色 —— 行内 ✏️ 展开编辑行（不嵌套二级弹窗），保存 PATCH
//   · 拖拽排序 —— HTML5 DnD（上半/下半定插前/插后；拖到列表空白 = 移到末尾），
//     落库 PUT /api/folders/order，侧栏即时按新序重渲
//   · 删除 —— PWDialog 确认后 DEL；当前筛选正指向被删夹时顺手清筛选
// 侧栏行为不变：行点击切视图、拖论文入夹照旧（见 sidebar.js）。

import { DEL, PATCH, POST, PUT } from '../core/api.js';
import { $, PALETTE } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { refresh } from './refresh.js';
import { renderSidebar } from './sidebar.js';

const GRIP_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
const PEN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/** 行内编辑态：null=无；{ isNew:true, color } 新建；{ id, color } 编辑已有。 */
let editing = null;

export function openFolderManager() {
  editing = null;
  renderList();
  wire();
  $('folder-manager').classList.add('active');
}

export function closeFolderManager() {
  editing = null;
  $('folder-manager').classList.remove('active');
}

// ---- 渲染 ----

function renderList() {
  const list = $('fm-list');
  const folders = state.folders || [];
  if (!folders.length && !editing) {
    list.innerHTML = '<div class="fm-empty">还没有收藏夹，点下方按钮新建一个</div>';
    return;
  }
  list.replaceChildren();
  if (editing && editing.isNew) list.appendChild(editorRow()); // 新建行置顶：保存后即见即用
  for (const fo of folders) {
    if (editing && !editing.isNew && editing.id === fo.id) {
      list.appendChild(editorRow());
      continue;
    }
    const row = document.createElement('div');
    row.className = 'fm-row';
    row.dataset.id = fo.id;
    row.draggable = true;
    row.title = fo.name;
    row.innerHTML =
      `<span class="fm-grip" title="拖拽调整顺序">${GRIP_SVG}</span>` +
      `<span class="fm-swatch" style="background:${escapeHtml(fo.color || '#2563eb')}"></span>` +
      `<span class="fm-name"></span>` +
      `<span class="fm-count">${fo.count || 0} 篇</span>` +
      `<span class="fm-acts">` +
        `<button class="fm-act" type="button" data-act="edit" title="改名 / 换色">${PEN_SVG}</button>` +
        `<button class="fm-act fm-act-del" type="button" data-act="del" title="删除收藏夹（论文不受影响）">${TRASH_SVG}</button>` +
      `</span>`;
    row.querySelector('.fm-name').textContent = fo.name; // textContent 防 XSS
    list.appendChild(row);
  }
}

/** 行内编辑行（新建/编辑共用）：名称输入 + 色板 + 保存/取消。 */
function editorRow() {
  const div = document.createElement('div');
  div.className = 'fm-row fm-editing';
  div.innerHTML =
    `<span class="fm-grip">${GRIP_SVG}</span>` +
    `<div class="fm-editor">` +
      `<input class="fm-name-input" type="text" maxlength="30" placeholder="收藏夹名称，如：精读 / 待复现 / 综述" />` +
      `<div class="fm-colors">${PALETTE.map((c) => `<span class="${c === editing.color ? 'sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('')}</div>` +
      `<div class="fm-editor-acts">` +
        `<button class="btn sm fm-save" type="button">保存</button>` +
        `<button class="btn secondary sm fm-cancel" type="button">取消</button>` +
      `</div>` +
    `</div>`;
  const input = div.querySelector('.fm-name-input');
  if (!editing.isNew) {
    const fo = (state.folders || []).find((f) => f.id === editing.id);
    if (fo) input.value = fo.name;
  }
  div.querySelectorAll('.fm-colors span').forEach((s) => {
    s.onclick = () => {
      editing.color = s.dataset.c;
      div.querySelectorAll('.fm-colors span').forEach((x) => x.classList.toggle('sel', x === s));
    };
  });
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEditing(div); }
    if (e.key === 'Escape') { e.stopPropagation(); editing = null; renderList(); }
  };
  setTimeout(() => input.focus(), 20);
  return div;
}

// ---- 保存 / 删除 ----

async function saveEditing(editorEl) {
  const input = editorEl.querySelector('.fm-name-input');
  const name = (input && input.value || '').trim();
  if (!name) { toast('收藏夹名称不能为空', 'error'); input && input.focus(); return; }
  if (editing.isNew) {
    const r = await POST('/api/folders', { name, color: editing.color });
    if (!r.ok) { toast(r.error || '收藏夹创建失败', 'error'); return; }
    toast('收藏夹已创建');
  } else {
    const r = await PATCH('/api/folders/' + encodeURIComponent(editing.id), { name, color: editing.color });
    if (!r.ok) { toast(r.error || '收藏夹保存失败', 'error'); return; }
    toast('收藏夹已更新');
  }
  editing = null;
  await refresh();      // 拉回最新 folders/counts，侧栏随 refresh 重渲
  renderList();
}

async function handleDelete(fo) {
  const yes = await PWDialog.confirm(`删除收藏夹「${fo.name}」？\n收藏关系会一并移除，论文本身不会被删除。`, { title: '删除收藏夹', danger: true, okText: '删除' });
  if (!yes) return;
  const r = await DEL('/api/folders/' + encodeURIComponent(fo.id));
  if (!r.ok) { toast(r.error || '收藏夹删除失败', 'error'); return; }
  if (state.filter.folder === fo.id) state.filter.folder = ''; // 筛选正指向被删夹：清掉避免空视图
  toast('收藏夹已删除');
  await refresh();
  renderList();
}

// ---- 拖拽排序（与阅读架抽屉同一套交互语义） ----

let dragId = null;

function handleReorder(targetRow, clientY) {
  if (!dragId) return;
  const ids = (state.folders || []).map((f) => f.id);
  const from = ids.indexOf(dragId);
  if (from === -1) return;
  let to;
  if (!targetRow) {
    to = ids.length - 1; // 列表空白处 = 移到末尾
  } else {
    const targetIdx = ids.indexOf(targetRow.dataset.id);
    if (targetIdx === -1 || targetIdx === from) return;
    const rect = targetRow.getBoundingClientRect();
    const below = clientY >= rect.top + rect.height / 2;
    to = below ? targetIdx + 1 : targetIdx;
    if (from < to) to -= 1;
  }
  to = Math.max(0, Math.min(ids.length - 1, to));
  if (from === to) return;
  // 本地立即重排 + 落库（纯排序不必全量 refresh，侧栏单点重渲）
  const [moved] = state.folders.splice(from, 1);
  state.folders.splice(to, 0, moved);
  renderList();
  renderSidebar();
  PUT('/api/folders/order', { ids: state.folders.map((f) => f.id) }).catch(() => {});
}

// ---- 一次性接线（dataset 守卫） ----

function wire() {
  const manager = $('folder-manager');
  const list = $('fm-list');
  if (manager.dataset.wired === '1') return;
  manager.dataset.wired = '1';

  list.addEventListener('click', (e) => {
    const actBtn = e.target.closest('.fm-act');
    if (actBtn) {
      const row = actBtn.closest('.fm-row');
      const fo = (state.folders || []).find((f) => f.id === row.dataset.id);
      if (!fo) return;
      if (actBtn.dataset.act === 'edit') { editing = { id: fo.id, color: fo.color || PALETTE[0] }; renderList(); }
      else handleDelete(fo);
      return;
    }
    if (e.target.closest('.fm-save')) { saveEditing(e.target.closest('.fm-row')); return; }
    if (e.target.closest('.fm-cancel')) { editing = null; renderList(); }
  });

  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.fm-row:not(.fm-editing)');
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add('dragging');
    try { if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } } catch { /* jsdom 无 dataTransfer */ }
  });
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch {} }
    const row = e.target.closest && e.target.closest('.fm-row:not(.fm-editing)');
    list.querySelectorAll('.fm-row.drop-above,.fm-row.drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
    if (!row) return;
    const rect = row.getBoundingClientRect();
    row.classList.add(e.clientY >= rect.top + rect.height / 2 ? 'drop-below' : 'drop-above');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    handleReorder(e.target.closest && e.target.closest('.fm-row:not(.fm-editing)'), e.clientY);
    cleanupDrag(list);
  });
  list.addEventListener('dragend', () => cleanupDrag(list));
  list.addEventListener('dragleave', (e) => {
    const row = e.target.closest && e.target.closest('.fm-row');
    if (row) row.classList.remove('drop-above', 'drop-below');
  });

  $('fm-new').onclick = () => {
    editing = { isNew: true, color: PALETTE[0] };
    renderList();
  };
  // 点遮罩关闭（模态本体外的区域）
  manager.onclick = (e) => { if (e.target === manager) closeFolderManager(); };
}

function cleanupDrag(list) {
  dragId = null;
  list.querySelectorAll('.fm-row.dragging,.fm-row.drop-above,.fm-row.drop-below')
    .forEach((n) => n.classList.remove('dragging', 'drop-above', 'drop-below'));
}
