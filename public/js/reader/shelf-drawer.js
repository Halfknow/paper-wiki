// 阅读架「书签匣」浮层 UI（v3.21；v3.23 显式策展；v3.24 浮出卡片）：
// 左下角 FAB（计数徽章，可纵向拖动）+ 锚定 FAB 的弹出面板。
//
// 与 pdf.js 完全解耦（DOM 在 index.html #reader-view 内静态声明，本模块只查询接线），
// 由 reader.js 在 PaperReader 构造时创建一次；jsdom 测试可脱离 pdf.js 直接驱动。
//
// 呈现（v3.24）：面板从按钮里「钻出」——transform-origin 指向按钮中心、轻度过冲的
// back-out 曲线；条目 stagger 依次从下方浮现（被收入架上的隐喻）。默认浮在按钮上方，
// 按钮靠上（上方空间不足 240px）时翻到下方（.below 换动画方向与小尖角位置）。
//
// 交互（v3.23）：
//   · 上架是显式动作：工具栏 🔖 / Ctrl+D（reader.js），或本面板的搜索框——
//     点搜索结果**只上架不跳转**（策展清单，不打断当前阅读）
//   · 点条目 → onSwitch(id)（走 /reader/:id 路由整链切换）
//   · 拖拽条目重排（HTML5 DnD，上半/下半决定插前/插后；拖到列表空白 = 移到末尾）
//   · × 移除：**永不切换论文、不关阅读器**——正在读的论文被移出后继续读
//   · 清空（PWDialog 确认）：架子清空，阅读器保持打开（论文本身不动）
//   · 点 PDF 收起（reader.js wirePdfClickClose）；FAB 纵向拖动换位（位置持久化）

import { jget } from '../core/api.js';
import { escapeHtml } from '../core/format.js';
import {
  shelfState, subscribeShelf, refreshShelf, shelfAdd,
  shelfRemove, shelfMove, shelfStepId, shelfClear,
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

  // 面板开合态（isOpen 读它而非 hidden 属性：close 有 130ms 收起动画，语义上应立即算「已关」）
  let openFlag = false;
  let openedAt = 0;        // 打开时刻：订阅驱动的重渲在短窗口内跳过（防 stagger 双播）
  let staggerTimer = null;
  let hideTimer = null;

  /** 锚定定位：面板默认浮在 FAB 上方；上方空间不足 240px 且下方更宽裕时翻到下方（.below）。
   *  同时算好小尖角位置（--rsd-caret-x）与钻出动画的 transform-origin（都指向按钮中心）。 */
  function positionPanel() {
    if (!elBtn || !elDrawer) return;
    const r = elBtn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const BAR_H = 44;                    // = --rdr-bar-h（v3.25），与 reader.js wireFabDrag 同源常量
    const MARGIN = 12;                   // 按钮与面板的间距
    const W = Math.min(318, vw - 28);    // 与 styles.css .reader-shelf-drawer 同宽
    // 水平：与按钮左对齐，右溢出时收进视口
    const left = Math.max(10, Math.min(r.left, vw - W - 10));
    elDrawer.style.left = left + 'px';
    elDrawer.style.right = 'auto';
    const spaceAbove = r.top - BAR_H - MARGIN;
    const spaceBelow = vh - r.bottom - MARGIN;
    const below = spaceAbove < 240 && spaceBelow > spaceAbove;
    elDrawer.classList.toggle('below', below);
    const avail = below ? spaceBelow : spaceAbove;
    elDrawer.style.maxHeight = Math.max(220, Math.min(560, vh * 0.55, avail)) + 'px';
    if (below) {
      elDrawer.style.top = Math.round(r.bottom + MARGIN) + 'px';
      elDrawer.style.bottom = 'auto';
    } else {
      elDrawer.style.bottom = Math.round(vh - r.top + MARGIN) + 'px';
      elDrawer.style.top = 'auto';
    }
    // 小尖角 / transform-origin 对准按钮中心（clamp 进面板内；origin 用底/顶边纯值——
    // calc(100% + 14px) 更精确但 jsdom 的 CSSOM 不解析，且底边原点的钻出观感几乎一致）
    const caretX = Math.max(18, Math.min(W - 18, r.left + r.width / 2 - left));
    elDrawer.style.setProperty('--rsd-caret-x', caretX + 'px');
    elDrawer.style.transformOrigin = below ? `${caretX}px 0%` : `${caretX}px 100%`;
  }

  const drawer = {
    isOpen: () => openFlag,
    resultsShown: () => !!(elResults && !elResults.hidden),
    open() {
      if (!elDrawer) return;
      openFlag = true;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } // 取消上一次 close 的延迟隐藏（快速关→开竞态）
      positionPanel();
      elDrawer.classList.remove('closing');
      elDrawer.hidden = false;
      // stagger 窗口：条目/头部/搜索的入场动画只在打开后的短窗口内生效，
      // 数据驱动的重渲（refreshShelf 回包 emit）不重播动画
      elDrawer.classList.add('just-opened');
      if (staggerTimer) clearTimeout(staggerTimer);
      staggerTimer = setTimeout(() => elDrawer.classList.remove('just-opened'), 700);
      openedAt = Date.now();
      if (elBtn) elBtn.classList.add('active');
      document.getElementById('reader-view').classList.add('shelf-open');
      refreshShelf();          // 每次打开刷新一次（进度/标题以服务端为准）
      render();
    },
    close() {
      if (!elDrawer || !openFlag) return;
      openFlag = false;
      openedAt = 0;
      if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null; }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (elBtn) elBtn.classList.remove('active');
      document.getElementById('reader-view').classList.remove('shelf-open');
      hideResults();
      elDrawer.classList.remove('just-opened');
      elDrawer.classList.add('closing');      // 收起动画（130ms），到点置 hidden
      hideTimer = setTimeout(() => {
        elDrawer.hidden = true;
        elDrawer.classList.remove('closing');
        hideTimer = null;
      }, 130);
    },
    toggle(force) {
      // force 给定 = 显式目标态；否则翻转（注意：isOpen() 是「当前态」，翻转必须取反）
      const target = force != null ? force : !drawer.isOpen();
      if (target) drawer.open(); else drawer.close();
    },
    /** [ / ] 快捷键入口：切上/下一篇（dir=-1|+1）。当前篇不在架上时无可切换。 */
    stepSwitch(dir) {
      const id = shelfStepId(dir);
      if (id && d.onSwitch) d.onSwitch(id);
      else if (d.notify) d.notify('当前论文不在阅读架上（用 🔖 或 Ctrl+D 放入后可切换）', false);
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
      elList.innerHTML = '<div class="rsd-empty">架子是空的<br/><span>点工具栏 🔖（或 Ctrl+D）把当前论文放进来；也可用上方搜索框添加</span></div>';
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

  // ---- 移除（v3.23：永不切换论文、不关阅读器——正在读的论文被移出后继续读） ----
  function handleRemove(id) {
    const removed = shelfRemove(id);
    render();
    if (removed && d.notify) d.notify('已从阅读架移除');
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
    // 点结果 = 只上架不跳转（v3.23：抽屉是策展清单，不打断当前阅读；要读它再点卡片或 [/]）
    elResults.querySelectorAll('.rsd-result:not(.on-shelf)').forEach((el) => {
      el.onclick = async () => {
        const p = rows.find((x) => x.id === el.dataset.id);
        if (!p) return;
        await shelfAdd(p);
        if (d.notify) d.notify('已加入阅读架');
        render();
        const term = elAdd ? elAdd.value.trim() : '';
        if (term) runSearch(term); // 刷新结果行态：刚加入的显示「已在架上」
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

  // ---- 头部按钮 / FAB（可纵向拖动换位，位置持久化——面板随之上下翻转） ----
  let fabJustDragged = false;
  if (elBtn) {
    elBtn.onclick = () => {
      if (fabJustDragged) { fabJustDragged = false; return; } // 拖动过的指针序列吞掉本次 click
      drawer.toggle();
    };
    wireFabDrag();
  }
  if (elClose) elClose.onclick = () => drawer.close();
  if (elClear) {
    elClear.onclick = async () => {
      if (!shelfState.ids.length) { if (d.notify) d.notify('阅读架已是空的'); return; }
      const yes = typeof PWDialog !== 'undefined' && PWDialog.confirm
        ? await PWDialog.confirm('清空阅读架？\n（只是移出阅读架，不删除论文；正在阅读的页面不受影响）', { title: '清空阅读架', danger: true, okText: '清空' })
        : window.confirm('清空阅读架？（不删除论文本身）');
      if (!yes) return;
      shelfClear();
      render();
      drawer.close();
      if (d.notify) d.notify('阅读架已清空');
    };
  }

  // FAB 纵向拖动（与 reader.js 聊天 FAB 同机制：4px 阈值 + clamp 进界 + 位置持久化；
  // 拖到上方后打开的面板自动翻到按钮下方，见 positionPanel 的 below 判定）
  function wireFabDrag() {
    if (elBtn.dataset.wired === '1') return;
    elBtn.dataset.wired = '1';
    const FAB_H = 44, MARGIN = 8, BAR_H = 44;   // 44=按钮高（styles.css）与 --rdr-bar-h（v3.25）
    const KEY = 'reader-shelf-fab-top';
    const clampTop = (t) => Math.max(BAR_H + MARGIN, Math.min(window.innerHeight - FAB_H - MARGIN, t));
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved > 0) elBtn.style.top = clampTop(saved) + 'px';
    elBtn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;   // 仅左键
      e.preventDefault();
      elBtn.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const inlineTop = parseFloat(elBtn.style.top);
      const startTop = Number.isFinite(inlineTop) ? inlineTop : elBtn.getBoundingClientRect().top;
      let moved = false;
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dy) < 4) return;         // 4px 阈值后才算拖动
        if (!moved) { moved = true; elBtn.classList.add('dragging'); if (openFlag) drawer.close(); }
        elBtn.style.top = clampTop(startTop + dy) + 'px';
      };
      const up = (ev) => {
        try { elBtn.releasePointerCapture(ev.pointerId); } catch {}
        elBtn.classList.remove('dragging');
        if (moved) {
          const finalTop = parseFloat(elBtn.style.top);
          if (Number.isFinite(finalTop)) localStorage.setItem(KEY, String(Math.round(finalTop)));
        }
        fabJustDragged = moved;                          // 供 onclick 守卫判断
        elBtn.removeEventListener('pointermove', move);
        elBtn.removeEventListener('pointerup', up);
        elBtn.removeEventListener('pointercancel', up);
      };
      elBtn.addEventListener('pointermove', move);
      elBtn.addEventListener('pointerup', up);
      elBtn.addEventListener('pointercancel', up);
    });
    // 窗口变化：开着的面板重新锚定；FAB 持久化位置重新 clamp 进界
    window.addEventListener('resize', () => {
      const cur = parseFloat(elBtn.style.top);
      if (Number.isFinite(cur)) elBtn.style.top = clampTop(cur) + 'px';
      if (openFlag) positionPanel();
    });
  }

  // 状态变化（上架/移除/重排/加载）自动重渲。打开后的短窗口内 refreshShelf 回包会紧跟一次
  // emit——保留首播 stagger（提前剥掉 .just-opened，列表照常重建但不重播入场动画）
  subscribeShelf(() => {
    if (openFlag && openedAt && Date.now() - openedAt < 650 && elDrawer) {
      elDrawer.classList.remove('just-opened');
    }
    render();
  });
  return drawer;
}
