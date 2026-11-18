// 空间切换与管理模态
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { _stopConceptMapPolling } from '../concepts/concepts.js';
import { DEL, PATCH, POST, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { router } from '../core/nav.js';
import { chatState, flushPendingNotes, set_chatState, state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { hideModal, showModal } from '../core/layers.js';
import { reader } from '../detail/info-tab.js';
import { refresh } from '../library/refresh.js';
import { openDirWizard, resetSpaceCreateForm } from './dir-wizard.js';

/** 拉取空间列表，校验 state.space 仍存在（被删则回 active），渲染切换器。启动 + 切换后调用。 */
export async function loadSpaces() {
  const r = await jget('/api/spaces');
  if (!r || !r.ok) return;
  const view = r.data || {};
  state.spaces = Array.isArray(view.spaces) ? view.spaces : [];
  // 校验本地记忆的空间仍存在；不存在则回 active
  const active = view.activeSpaceId;
  const stillExists = state.spaces.find((s) => s.id === state.space);
  if (!stillExists) {
    state.space = active || (state.spaces[0] && state.spaces[0].id) || '';
    localStorage.setItem('pw-space', state.space);
  }
  renderSpaceSwitcher();
}

/** 渲染顶部空间切换器（当前名 + 下拉列表）。
 *  当前空间名写入 localStorage：刷新时在 /api/spaces 返回前先回显缓存名，避免闪「默认」。 */
function renderSpaceSwitcher() {
  const cur = state.spaces.find((s) => s.id === state.space) || state.spaces[0];
  if (cur) localStorage.setItem('pw-space-name', cur.name);
  const spaceName = cur ? cur.name : localStorage.getItem('pw-space-name') || '空间';
  $('space-name').textContent = spaceName;
  $('space-current')?.setAttribute('aria-label', '切换空间（当前：' + spaceName + '）');
  const list = $('space-list');
  list.innerHTML = '';
  for (const s of state.spaces) {
    const btn = document.createElement('button');
    btn.className = 'space-opt' + (s.id === state.space ? ' active' : '');
    btn.type = 'button';
    // 选中标记由 .space-opt.active::after 的 SVG 勾承担（下拉内容统一规格），此处不再手写 ✓
    btn.innerHTML = `<span class="space-opt-name">${escapeHtml(s.name)}</span>`
      + `<span class="space-opt-dir">${escapeHtml(s.papersDir || 'papers')}</span>`;
    btn.onclick = () => { switchSpace(s.id); closeSpaceMenu(); };
    list.appendChild(btn);
  }
}

function openSpaceMenu() {
  $('space-menu').hidden = false;
  $('space-switcher').classList.add('open');
}

export function closeSpaceMenu() {
  $('space-menu').hidden = true;
  $('space-switcher').classList.remove('open');
}

export function toggleSpaceMenu() {
  if ($('space-menu').hidden) openSpaceMenu(); else closeSpaceMenu();
}

/** 切换空间：激活 → teardown 流式状态 → 清空选中/筛选 → refresh + 重渲染详情。
 *  沿用 chat 切论文的 teardown 模式：关闭 EventSource、flush notes，避免旧流串入新空间。 */
async function switchSpace(id) {
  if (id === state.space) return;
  // teardown：关闭进行中的聊天流 + 落盘笔记
  if (chatState && typeof chatState.closeStream === 'function') { try { chatState.closeStream(); } catch {} }
  set_chatState(null);
  try { await flushPendingNotes(); } catch {}
  _stopConceptMapPolling(); // 概念地图轮询随空间切换停止（后台任务在服务端继续，回该空间时 showConcepts 会重启轮询）
  // 关阅读器（若开着）
  if (reader && typeof reader.close === 'function') { try { reader.close(); } catch {} }
  // 切换
  state.space = id;
  localStorage.setItem('pw-space', id);
  try { await POST('/api/spaces/' + encodeURIComponent(id) + '/activate'); } catch {}
  // 清空选中/筛选/详情（隔离：新空间的论文/标签不同）
  state.current = null;
  state.detail = null;
  state.selected = new Set();
  state.pickMode = false;
  state.filter = { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: state.filter.sort };
  $('search').value = '';
  renderSpaceSwitcher();
  // 空间进 URL（?space=<id>，路由器跨导航自动携带）：链接可分享到正确空间。
  // 同时回到干净的 /library——上一空间的论文 id 在新空间不存在，停在 /paper/:id 会 404。
  await router.navigate('/library', { query: { space: id } });
  toast('已切换到空间：' + ((state.spaces.find((s) => s.id === id) || {}).name || ''), 'info');
}

// ---- 空间管理模态（展示优先 + 行内编辑）----
export function openSpaceModal() {
  closeSpaceMenu();
  resetSpaceCreateForm();
  renderSpaceAdmin();
  showModal($('space-modal'), { onClose: closeSpaceModal });
}

export function closeSpaceModal() {
  hideModal($('space-modal'));
}

/** 把 s.scanIntervalMinutes 渲染成「每 N 分钟扫描」/「已关闭」的副文案。 */
function scanIntervalText(min) {
  if (!min || min <= 0) return '定时扫描已关闭';
  return `每 ${min} 分钟扫描`;
}

/** 渲染空间管理列表：默认展示态卡片（点名/文件夹/论文数/活跃标记），点编辑就地展开输入框。 */
export function renderSpaceAdmin() {
  const root = $('space-admin-list');
  root.innerHTML = '';
  for (const s of state.spaces) {
    const isDefault = s.id === 'default';
    const isActive = s.id === state.space;
    const card = document.createElement('div');
    card.className = 'sa-card' + (isActive ? ' is-active' : '');
    card.dataset.id = s.id;
    card.innerHTML = `
      <span class="sa-dot"></span>
      <div class="sa-card-main">
        <span class="sa-card-name">${escapeHtml(s.name)}</span>
        <span class="sa-card-dir" title="${escapeHtml(s.papersDir || 'papers')}">${escapeHtml(s.papersDir || 'papers')}</span>
      </div>
      <div class="sa-card-meta">
        <span class="sa-count" title="${escapeHtml(scanIntervalText(s.scanIntervalMinutes))}">${s.paperCount != null ? s.paperCount : 0} 篇</span>
        ${isActive ? '<span class="sa-badge">当前</span>' : ''}
        <div class="sa-card-actions">
          ${isActive ? '' : `<button class="btn secondary sm sa-btn" data-act="switch">切换</button>`}
          <button class="btn secondary sm sa-btn" data-act="edit">编辑</button>
        </div>
      </div>`;
    const switchBtn = card.querySelector('[data-act="switch"]');
    if (switchBtn) switchBtn.onclick = async () => { closeSpaceModal(); await switchSpace(s.id); };
    card.querySelector('[data-act="edit"]').onclick = () => {
      // 编辑态互斥：先整体重渲染取消其他卡片的编辑态（未保存的改动丢弃），再展开本卡片
      renderSpaceAdmin();
      const fresh = root.querySelector(`.sa-card[data-id="${CSS.escape(s.id)}"]`);
      if (fresh) renderSpaceAdminEdit(fresh, s, isDefault);
    };
    root.appendChild(card);
  }
}

/** 把某张展示卡片就地替换为编辑态（名称可改；文件夹只读展示 + 「更改文件夹…」进向导）。
 *  v3：文件夹改绑不再是「改字符串即生效」——必须走 预检→选模式（移动/重绑）→原子执行 的向导，
 *  否则会出现「绑定改了但文件和库数据不同步」的历史 bug。 */
function renderSpaceAdminEdit(card, s, isDefault) {
  card.className = 'sa-edit';
  card.innerHTML = `
    <div class="sa-edit-field">
      <span class="lbl">名称</span>
      <input type="text" data-k="name" value="${escapeHtml(s.name)}" />
    </div>
    <div class="sa-edit-field dir">
      <span class="lbl">文件夹</span>
      <span class="sa-dir-ro" title="${escapeHtml(s.papersDir || '')}">${escapeHtml(s.papersDir || '')}</span>
      <button class="btn secondary sm sa-btn" data-act="chdir" title="预检 → 移动文件或仅重新绑定 → 原子执行">更改文件夹…</button>
    </div>
    <div class="sa-edit-actions">
      ${isDefault ? '' : '<button class="btn secondary sm danger sa-btn" data-act="del">删除</button>'}
      <button class="btn secondary sm sa-btn" data-act="cancel">取消</button>
      <button class="btn secondary sm sa-btn" data-act="save">保存</button>
    </div>`;
  const nameInput = card.querySelector('[data-k="name"]');
  const saveBtn = card.querySelector('[data-act="save"]');
  const cancelBtn = card.querySelector('[data-act="cancel"]');
  const delBtn = card.querySelector('[data-act="del"]');
  card.querySelector('[data-act="chdir"]').onclick = () => openDirWizard(s);

  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('空间名不能为空', 'error'); return; }
    saveBtn.disabled = true;
    try {
      const r = await PATCH('/api/spaces/' + encodeURIComponent(s.id), { name });
      if (r && r.ok) {
        toast('已保存', 'success');
        await loadSpaces();
        renderSpaceAdmin();
      } else {
        toast((r && r.error) || '保存失败', 'error');
      }
    } catch (e) { toast(e.message || '保存失败', 'error'); }
    saveBtn.disabled = false;
  };
  cancelBtn.onclick = () => renderSpaceAdmin();
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!(await PWDialog.confirm(`确认删除空间「${s.name}」？\n\n仅删除该空间的论文/标签/概念等数据，保留物理 PDF 文件夹（${s.papersDir}）。此操作不可撤销。`, { title: '删除空间', danger: true, okText: '删除空间' }))) return;
      try {
        const r = await DEL('/api/spaces/' + encodeURIComponent(s.id));
        if (r && r.ok) {
          toast('已删除空间（物理 PDF 已保留）', 'success');
          await loadSpaces();
          if (state.space === s.id) { state.space = ''; await loadSpaces(); await refresh(); }
          renderSpaceAdmin();
        } else {
          toast((r && r.error) || '删除失败', 'error');
        }
      } catch (e) { toast(e.message || '删除失败', 'error'); }
    };
  }
  // 自动聚焦名称输入框并全选，便于快速改名
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 20);
  // 回车保存、Esc 取消
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
  };
  nameInput.addEventListener('keydown', onKey);
}
