// 阅读架抽屉 UI（v3.21）：左下角 FAB（计数徽章）+ 左侧抽屉面板。
//
// 与 pdf.js 完全解耦（DOM 在 index.html #reader-view 内静态声明，本模块只查询接线），
// 由 reader.js 在 PaperReader 构造时创建一次；jsdom 测试可脱离 pdf.js 直接驱动。
//
// 交互：
//   · 点条目 → onSwitch(id)（走 /reader/:id 路由整链切换，openReader 自动上架）
//   · 拖拽条目重排（HTML5 DnD，上半/下半决定插前/插后；拖到列表空白 = 移到末尾）
//   · × 移除：移除当前阅读篇 → 自动切邻居（优先下一篇）；架子空 → onCloseReader()
//   · 顶部搜索框从库中添加论文（GET /api/papers?q=），点结果即打开（自动上架）
//   · 清空（PWDialog 确认）：架子清空 + 关阅读器（论文本身不动）

import { jget } from '../core/api.js';
import { escapeHtml } from '../core/format.js';
import {
  shelfState, subscribeShelf, refreshShelf,
  shelfRemove, shelfMove, shelfNeighborAfter, shelfStepId, shelfClear,
} from './shelf.js';

const GRIP_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="none"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';

/** 渲染单条卡片的元信息行：年份 · 阅读进度 ·（状态未就绪时）状态。 */
function metaLine(it) {
  const parts = [];
  if (it.year) parts.push(escapeHtml(String(it.year)));
  if (it.readProgress && it.readProgress.total) {
    const pct = Math.min(100, Math.round(((it.readProgress.page || 1) / it.readProgress.total) * 100));
    parts.push(`读到 ${it.readProgress.page || 1}/${it.readProgress.total} 页（${pct}%）`);
  } else {
    parts.push('未开始');
  }
  if (it.status && it.status !== 'ready') parts.push(escapeHtml(String(it.status)));
  return parts.join(' · ');
}

/**
 * 创建阅读架抽屉。deps：
 *   onSwitch(id)       切换论文（reader-host 注入：路由 /reader/:id replace 导航）
 *   onCloseReader()    架子被清空且当前篇被移除时关阅读器（onBack 语义）
 *   notify(msg, err?)  状态条反馈（reader.setStatus）
 * DOM 要求（index.html 静态声明）：#reader-shelf-btn/-count/-drawer/-close/-clear/
 *   -add/-results/-list。重复创建安全（dataset.wired 守卫）。
 */
export function createShelfDrawer(deps) {
  const d = deps || {};
  const $id = (x) => document.getElementById(x);
  const elBtn = $id('reader-shelf-btn');
  const elCount = $id('reader-shelf-count');
  const elDrawer = $id('reader-shelf-drawer');
  const elClose = $id('reader-shelf-close');
  const elClear = $id('reader-shelf-clear');
  const elAdd = $id('reader-shelf-add');
  const elResults = $id('reader-shelf-results');
  const elList = $id('reader-shelf-list');

  const drawer = {
    isOpen: () => !!(elDrawer && !elDrawer.hidden),
    resultsShown: () => !!(elResults && !elResults.hidden),
    open() {
      if (!elDrawer) return;
      elDrawer.hidden = false;
      document.getElementById('reader-view').classList.add('shelf-open');
      refreshShelf();          // 每次打开刷新一次（进度/标题以服务端为准）
      render();
    },
    close() {
      if (!elDrawer) return;
      elDrawer.hidden = true;
      hideResults();
      document.getElementById('reader-view').classList.remove('shelf-open');
    },
    toggle(force) {
      // force 给定 = 显式目标态；否则翻转（注意：isOpen() 是「当前态」，翻转必须取反）
      const target = force != null ? force : !drawer.isOpen();
      if (target) drawer.open(); else drawer.close();
    },
    /** [ / ] 快捷键入口：切上/下一篇（dir=-1|+1）。 */
    stepSwitch(dir) {
      const id = shelfStepId(dir);
      if (id && d.onSwitch) d.onSwitch(id);
      else if (d.notify) d.notify(dir < 0 ? '阅读架上没有其它论文了' : '阅读架已是最后一篇', false);
    },
    render,
  };
  if (!elBtn || !elDrawer || elDrawer.dataset.wired === '1') return drawer;
  elDrawer.dataset.wired = '1';

  // ---- 列表渲染 ----
  function render() {
    if (elCount) {
      const n = shelfState.ids.length;
      elCount.textContent = String(n);
      elCount.hidden = n === 0;
      elBtn.title = `阅读架（${n} 篇）—— [ / ] 切换上下篇，点此管理`;
    }
    if (!elList) return;
    if (!shelfState.ids.length) {
      elList.innerHTML = '<div class="rsd-empty">架子是空的<br/><span>从库中打开一篇 PDF 会自动上架；也可用上方搜索框添加</span></div>';
      return;
    }
    elList.innerHTML = shelfState.ids
      .map((id) => {
        const it = shelfState.items[id] || { id, title: id, year: '', readProgress: null };
        const active = id === shelfState.activeId;
        return (
          `<div class="rsd-item${active ? ' active' : ''}" data-id="${escapeHtml(id)}" draggable="true">` +
            `<span class="rsd-grip" title="拖拽调整阅读顺序">${GRIP_SVG}</span>` +
            `<div class="rsd-main">` +
              `<div class="rsd-name">${it.starred ? `<span class="rsd-star">${STAR_SVG}</span>` : ''}<span class="rsd-name-text"></span></div>` +
              `<div class="rsd-meta">${metaLine(it)}</div>` +
            `</div>` +
            (active ? '<span class="rsd-reading">阅读中</span>' : '') +
            `<button class="rsd-x" type="button" title="从阅读架移除（不删除论文）">${X_SVG}</button>` +
          `</div>`
        );
      })
      .join('');
    // 标题走 textContent（防 XSS；escapeHtml 只兜 meta 行里的结构化短字段）
    elList.querySelectorAll('.rsd-item').forEach((el) => {
      const it = shelfState.items[el.dataset.id];
      const nameEl = el.querySelector('.rsd-name-text');
      if (nameEl && it) nameEl.textContent = it.title || it.id;
    });
  }

  // ---- 移除（含当前篇自动切邻居） ----
  function handleRemove(id) {
    const wasActive = shelfState.activeId === id;
    const neighbor = shelfNeighborAfter(id); // 移除前取好邻居
    shelfRemove(id);
    render();
    if (!wasActive) { if (d.notify) d.notify('已从阅读架移除'); return; }
    if (neighbor && d.onSwitch) d.onSwitch(neighbor);
    else if (d.onCloseReader) d.onCloseReader(); // 架子空了：当前篇无处可去，关阅读器
  }

  // ---- 列表事件（委托：切换 / 移除） ----
  elList.addEventListener('click', (e) => {
    const item = e.target.closest('.rsd-item');
    if (!item) return;
    if (e.target.closest('.rsd-x')) {
      e.stopPropagation();
      handleRemove(item.dataset.id);
      return;
    }
    if (item.dataset.id !== shelfState.activeId && d.onSwitch) d.onSwitch(item.dataset.id);
  });

  // ---- 拖拽重排（HTML5 DnD） ----
  let dragId = null;
  elList.addEventListener('dragstart', (e) => {
    const item = e.target.closest && e.target.closest('.rsd-item');
    if (!item) return;
    dragId = item.dataset.id;
    item.classList.add('dragging');
    try { if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } } catch { /* jsdom 无 dataTransfer */ }
  });
  elList.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const item = e.target.closest && e.target.closest('.rsd-item');
    e.preventDefault(); // 允许 drop（含列表空白处 → 移到末尾）
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch {} }
    elList.querySelectorAll('.rsd-item.drop-above,.rsd-item.drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below'));
    if (!item) return;
    const rect = item.getBoundingClientRect();
    item.classList.add(e.clientY >= rect.top + rect.height / 2 ? 'drop-below' : 'drop-above');
  });
  const dropAt = (targetItem, clientY) => {
    if (!dragId) return;
    const from = shelfState.ids.indexOf(dragId);
    if (from === -1) return;
    let to;
    if (!targetItem) {
      to = shelfState.ids.length - 1; // 列表空白处 = 移到末尾
    } else {
      const targetIdx = shelfState.ids.indexOf(targetItem.dataset.id);
      if (targetIdx === -1 || targetIdx === from) return;
      const rect = targetItem.getBoundingClientRect();
      const below = clientY >= rect.top + rect.height / 2;
      to = below ? targetIdx + 1 : targetIdx;
      if (from < to) to -= 1; // 移除 from 后目标段左移一位的语义修正
    }
    shelfMove(from, Math.max(0, Math.min(shelfState.ids.length - 1, to)));
    render();
  };
  elList.addEventListener('drop', (e) => {
    e.preventDefault();
    dropAt(e.target.closest && e.target.closest('.rsd-item'), e.clientY);
    cleanupDrag();
  });
  elList.addEventListener('dragend', cleanupDrag);
  elList.addEventListener('dragleave', (e) => {
    // 只清指示线（dragId 保留——dragleave 在经过子元素时也会触发）
    const item = e.target.closest && e.target.closest('.rsd-item');
    if (item) item.classList.remove('drop-above', 'drop-below');
  });
  function cleanupDrag() {
    dragId = null;
    elList.querySelectorAll('.rsd-item.dragging,.rsd-item.drop-above,.rsd-item.drop-below')
      .forEach((n) => n.classList.remove('dragging', 'drop-above', 'drop-below'));
  }

  // ---- 顶部搜索：从库中添加 ----
  let searchTimer = null;
  function hideResults() {
    if (elResults) { elResults.hidden = true; elResults.innerHTML = ''; }
  }
  async function runSearch(term) {
    let rows = [];
    try {
      const r = await jget('/api/papers?q=' + encodeURIComponent(term));
      if (r && r.ok && Array.isArray(r.data)) rows = r.data.slice(0, 8);
    } catch { /* 离线：显示无结果 */ }
    if (!elResults) return;
    if (!rows.length) {
      elResults.innerHTML = '<div class="rsd-result empty">没有匹配的论文</div>';
      elResults.hidden = false;
      return;
    }
    elResults.innerHTML = rows
      .map((p) => {
        const onShelf = shelfState.ids.includes(p.id);
        return (
          `<div class="rsd-result${onShelf ? ' on-shelf' : ''}" data-id="${escapeHtml(p.id)}">` +
            `<span class="rsd-result-title"></span>` +
            `<span class="rsd-result-meta">${p.year ? escapeHtml(String(p.year)) : ''}${onShelf ? ' · 已在架上' : ''}</span>` +
          `</div>`
        );
      })
      .join('');
    elResults.querySelectorAll('.rsd-result').forEach((el) => {
      const p = rows.find((x) => x.id === el.dataset.id);
      const t = el.querySelector('.rsd-result-title');
      if (t && p) t.textContent = p.title || p.filename || p.id;
    });
    elResults.hidden = false;
    elResults.querySelectorAll('.rsd-result:not(.on-shelf)').forEach((el) => {
      el.onclick = () => {
        hideResults();
        if (elAdd) elAdd.value = '';
        if (d.onSwitch) d.onSwitch(el.dataset.id); // 打开（openReader 链路自动上架）
      };
    });
  }
  if (elAdd) {
    elAdd.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      const term = elAdd.value.trim();
      if (!term) { hideResults(); return; }
      searchTimer = setTimeout(() => runSearch(term), 250);
    });
    // 搜索框键盘事件不外泄（阅读器级 [ / ] 等快捷键在 typing 守卫下本就跳过，双保险）
    elAdd.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { elAdd.value = ''; hideResults(); e.stopPropagation(); }
    });
  }

  // ---- 头部按钮 / FAB ----
  if (elBtn) elBtn.onclick = () => drawer.toggle();
  if (elClose) elClose.onclick = () => drawer.close();
  if (elClear) {
    elClear.onclick = async () => {
      if (!shelfState.ids.length) { if (d.notify) d.notify('阅读架已是空的'); return; }
      const yes = typeof PWDialog !== 'undefined' && PWDialog.confirm
        ? await PWDialog.confirm('清空阅读架？\n（只是移出阅读架，不删除论文本身；正在阅读的页面会关闭）', { title: '清空阅读架', danger: true, okText: '清空' })
        : window.confirm('清空阅读架？（不删除论文本身）');
      if (!yes) return;
      shelfClear();
      render();
      drawer.close();
      if (d.onCloseReader) d.onCloseReader();
    };
  }

  // 状态变化（打开论文上架/移除/重排/加载）自动重渲
  subscribeShelf(render);
  return drawer;
}
