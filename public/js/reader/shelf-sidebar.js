// 侧栏阅读架（v3.59）
//
// 此前阅读架只有阅读器内的浮动 FAB 一个入口——退出阅读器就再也看不到「我放了什么进去」，
// 而阅读架的用途恰恰是「下次接着读」，需要在开始读之前就能看到。
//
// 这里不复用 reader/shelf-drawer.js：那套浮层的 DOM（#reader-shelf-btn/-drawer）挂在
// #reader-view 里，退出阅读器整棵树 display:none；它的定位逻辑还锚定阅读器 FAB 并按
// --rdr-bar-h 做垂直避让。搬出来要动的比重写多。侧栏这份只做「看 + 进入 + 移出」，
// 排序/搜索加入仍留在阅读器那份里，各自服务各自的场景。
//
// 数据源是共享的 shelfState（reader/shelf.js），通过 subscribeShelf 与阅读器双向同步：
// 在阅读器里加/删，侧栏列表与计数即时跟着变，反之亦然。

import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { undoToast } from '../core/feedback.js';
import { ensureShelfLoaded, refreshShelf, shelfRemoveUndoable, shelfState, subscribeShelf } from './shelf.js';

const REMOVE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

let _open = false;

/** 阅读进度短句：有进度显示「12/34 页」，否则「未开始」。 */
function progressText(it) {
  const p = it && it.readProgress;
  if (p && p.total) return `${p.page || 1}/${p.total} 页`;
  return '未开始';
}

/** 计数徽标：空架时不显示（`.count:empty` 收缩），非空显示条数。 */
function renderCount() {
  const el = $('shelf-count');
  if (!el) return;
  const n = (shelfState.ids || []).length;
  el.textContent = n ? String(n) : '';
}

function renderList() {
  const box = $('side-shelf-list');
  if (!box) return;
  const ids = shelfState.ids || [];
  if (!ids.length) {
    box.innerHTML = '<div class="side-shelf-empty">阅读架是空的。在阅读器顶栏点「放入阅读架」，论文会留在这里等你接着读。</div>';
    return;
  }
  box.innerHTML = ids
    .map((id) => {
      const it = shelfState.items[id] || { id };
      const active = id === shelfState.activeId;
      return (
        `<div class="side-shelf-item${active ? ' active' : ''}" data-shelf-open="${escapeHtml(id)}" tabindex="0" role="button" title="${escapeHtml(it.title || id)}">` +
        `<span class="ssi-main"><span class="ssi-title">${escapeHtml(it.title || '(未命名)')}</span>` +
        `<span class="ssi-meta">${escapeHtml(progressText(it))}</span></span>` +
        `<button class="ssi-x" type="button" data-shelf-rm="${escapeHtml(id)}" title="移出阅读架" aria-label="移出阅读架">${REMOVE_SVG}</button>` +
        `</div>`
      );
    })
    .join('');
}

function render() {
  renderCount();
  if (_open) renderList();
}

/** 展开/收起列表。展开时刷一次进度（读到第几页会在阅读中变化）。 */
async function toggle(force) {
  const box = $('side-shelf-list');
  const btn = $('btn-shelf');
  if (!box || !btn) return;
  _open = force === undefined ? !_open : !!force;
  btn.setAttribute('aria-expanded', _open ? 'true' : 'false');
  btn.classList.toggle('active', _open);
  box.hidden = !_open;
  if (!_open) return;
  renderList();
  await refreshShelf(); // 进度可能已变；失败静默（refreshShelf 内部兜底）
  renderList();
}

/** bind() 时调用一次。DOM 缺省（如测试精简页面）时静默跳过。 */
export function initShelfSidebar(onOpenPaper) {
  const btn = $('btn-shelf');
  const box = $('side-shelf-list');
  if (!btn || !box) return;

  btn.onclick = () => toggle();
  box.onclick = (e) => {
    const rm = e.target.closest('[data-shelf-rm]');
    if (rm) {
      e.stopPropagation();
      const undo = shelfRemoveUndoable(rm.dataset.shelfRm); // 内部会 emit → 订阅重渲
      if (undo) undoToast('已从阅读架移除', undo);
      return;
    }
    const open = e.target.closest('[data-shelf-open]');
    if (open && onOpenPaper) onOpenPaper(open.dataset.shelfOpen);
  };
  box.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const open = e.target.closest('[data-shelf-open]');
    if (!open) return;
    e.preventDefault();
    if (onOpenPaper) onOpenPaper(open.dataset.shelfOpen);
  };

  subscribeShelf(render);
  // 徽标要在「还没点开过」时就准确，故进页面即拉一次
  ensureShelfLoaded().then(render);
}

/** 关闭列表（切空间 / 进阅读器时收起，避免留一个过期的展开态）。 */
export function closeShelfSidebar() {
  if (_open) toggle(false);
}
