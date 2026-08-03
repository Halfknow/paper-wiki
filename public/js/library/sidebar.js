// 侧栏（收藏夹拖放 / 视图切换）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { gotoLibraryRoute, router } from '../core/nav.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { patch } from '../detail/info-tab.js';
import { openFolderModal } from './folders.js';
import { refresh } from './refresh.js';

// ---- 侧栏 ----
export function renderSidebar() {
  // 计数：全部/星标/未读 —— 必须用「全局统计(state.stats)」而非「当前筛选列表(state.papers)」，
  // 否则点未读/星标/收藏夹视图后 state.papers 被缩小，徽标会显示成筛选后的子集数（而非全局总数）。
  const st = state.stats || {};
  // 全局计数优先用 state.stats（全局统计，不随筛选变）。stats 缺 starred/unread 字段时
  // （旧后端未重启）回退到 state.globalCounts（前端独立 fetch 的全局计数）。
  const gc = state.globalCounts || {};
  const allCount = st.total != null ? st.total : (gc.total != null ? gc.total : state.papers.length);
  const starCount = st.starred != null ? st.starred : (gc.starred || 0);
  const unreadCount = st.unread != null ? st.unread : (gc.unread || 0);
  $('cnt-all').textContent = allCount != null ? allCount : '';
  $('cnt-star').textContent = starCount || '';
  $('cnt-unread').textContent = unreadCount || '';

  // 高亮当前视图
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => {
    const m = el.dataset.mode;
    // 仅星标特殊：starred 模式
    el.classList.toggle('active',
      (m === 'starred' && state.filter.starred) ||
      (m === 'all' && !state.filter.mode && !state.filter.starred && !state.filter.folder && !state.filter.readStatus) ||
      (m === 'unread' && (state.filter.mode === 'unread' || state.filter.readStatus === 'unread')));
  });

  // 收藏夹列表
  const fl = $('folder-list');
  fl.innerHTML = '';
  $('folder-empty').hidden = state.folders.length > 0;
  for (const fo of state.folders) {
    const el = document.createElement('div');
    el.className = 'side-item' + (state.filter.folder === fo.id ? ' active' : '');
    el.dataset.folderId = fo.id;
    el.innerHTML = `<span class="swatch" style="background:${escapeHtml(fo.color)}"></span>
      <span>${escapeHtml(fo.name)}</span>
      <span class="count">${fo.count || ''}</span>
      <span class="ico folder-edit" data-edit="${fo.id}" title="编辑收藏夹" aria-label="编辑收藏夹"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>`;
    el.onclick = (e) => {
      // 点编辑入口（铅笔图标）：e.target 可能是 svg/path，需 closest 向上找 data-edit
      if (e.target.closest('[data-edit]')) { openFolderModal(fo); return; }
      setView({ folder: fo.id, mode: '', starred: false, readStatus: '', status: '' });
    };
    setupFolderDropTarget(el, fo);
    fl.appendChild(el);
  }
}

/** 把论文拖入收藏夹：dragover 高亮目标，drop 把 id 加入该收藏夹（去重），批量多选一次性处理。 */
function setupFolderDropTarget(el, fo) {
  const readIds = (e) => {
    try { return JSON.parse(e.dataTransfer.getData('text/paperwiki-ids') || '[]'); }
    catch { return []; }
  };
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/paperwiki-ids')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    const ids = readIds(e);
    if (!ids.length) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    await addPapersToFolder(ids, fo.id);
  });
}

/** 把若干论文加入收藏夹（合并去重，仅 PATCH 真正变动的论文）。 */
async function addPapersToFolder(ids, folderId) {
  const toUpdate = [];
  for (const id of ids) {
    const p = state.papers.find((x) => x.id === id);
    if (!p) continue;
    const cur = new Set(p.folders || []);
    if (cur.has(folderId)) continue; // 已在该夹，跳过
    cur.add(folderId);
    toUpdate.push({ id, folders: [...cur] });
  }
  if (!toUpdate.length) { toast('这些论文已在该收藏夹'); return; }
  let okN = 0;
  for (const u of toUpdate) {
    const r = await PATCH('/api/papers/' + encodeURIComponent(u.id), { folders: u.folders });
    if (r.ok) okN++;
  }
  toast(okN === toUpdate.length ? `已把 ${okN} 篇加入收藏夹` : `已加入 ${okN}/${toUpdate.length} 篇（部分失败）`, okN === toUpdate.length ? 'success' : 'error');
  refresh();
}

function setView(patch) {
  // 切视图时清掉与之互斥的筛选
  state.filter = { ...state.filter, ...patch };
  if (patch.folder !== undefined || patch.mode !== undefined || patch.starred !== undefined) {
    // 选中具体视图时，重置这些维度
  }
  // 侧栏项可能在概念/公式/设置视图下点击 → 统一导航回库视图并把筛选写进 URL
  const cur = router.current();
  if (cur && ['library', 'paper', 'paper-tab'].includes(cur.name)) refresh();
  else gotoLibraryRoute();
}
