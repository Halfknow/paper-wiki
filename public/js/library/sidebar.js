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

  // 高亮当前视图（展开态侧栏项 + 收起态 rail 图标并行处理）
  const isAll = !state.filter.mode && !state.filter.starred && !state.filter.folder && !state.filter.readStatus;
  const isStarred = !!state.filter.starred;
  const isUnread = state.filter.mode === 'unread' || state.filter.readStatus === 'unread';
  const modeActive = (m) => (m === 'all' && isAll) || (m === 'starred' && isStarred) || (m === 'unread' && isUnread);
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => el.classList.toggle('active', modeActive(el.dataset.mode)));
  document.querySelectorAll('.sidebar-rail .rail-btn[data-mode]').forEach((el) => el.classList.toggle('active', modeActive(el.dataset.mode)));

  // 收藏夹列表
  const fl = $('folder-list');
  fl.innerHTML = '';
  $('folder-empty').hidden = state.folders.length > 0;
  // 收起态 rail 收藏夹色点（与展开态列表并行渲染）
  const rfl = $('rail-folder-list');
  if (rfl) rfl.innerHTML = '';
  for (const fo of state.folders) {
    const el = document.createElement('div');
    el.className = 'side-item' + (state.filter.folder === fo.id ? ' active' : '');
    el.dataset.folderId = fo.id;
    // v3.22：行内 hover 铅笔退役——收藏夹的新建/改名/换色/排序/删除统一走标题行 ⚙ 的管理面板
    el.innerHTML = `<span class="swatch" style="background:${escapeHtml(fo.color)}"></span>
      <span>${escapeHtml(fo.name)}</span>
      <span class="count">${fo.count || ''}</span>`;
    el.onclick = () => setView({ folder: fo.id, mode: '', starred: false, readStatus: '', status: '' });
    setupFolderDropTarget(el, fo);
    fl.appendChild(el);
    // rail 收藏夹按钮：外层 .rail-btn（与视图按钮同款药丸），内含 .swatch 方形色块（与展开态一致）
    if (rfl) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'rail-btn rail-folder-dot' + (state.filter.folder === fo.id ? ' active' : '');
      dot.title = fo.name + (fo.count ? `（${fo.count}）` : '');
      dot.setAttribute('aria-label', '收藏夹：' + fo.name);
      dot.dataset.folderId = fo.id;
      dot.innerHTML = `<span class="swatch" style="background:${escapeHtml(fo.color)}"></span>`;
      // mousedown preventDefault：阻止 button 获得焦点时浏览器自动 scrollIntoView
      // （点击列表底部收藏夹会触发焦点元素滚进可视区 → #rail-folder-list 出现可见滚动反馈）。
      // 键盘可达性保留：键盘 Tab/Enter 仍可正常聚焦触发，:focus-visible 在 CSS 里给轮廓。
      dot.onmousedown = (e) => e.preventDefault();
      dot.onclick = () => setView({ folder: fo.id, mode: '', starred: false, readStatus: '', status: '' });
      setupFolderDropTarget(dot, fo);
      rfl.appendChild(dot);
    }
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
