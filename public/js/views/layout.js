// 系统健康刷新 / 侧栏收起 / 列表宽度分隔条
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { loadSettingsData } from '../settings/settings.js';

// ---- 系统信息：刷新服务状态（重载设置数据，更新运行时长 / 概览）----
export async function refreshSystemHealth() {
  await loadSettingsData();
  toast('服务状态已刷新');
}

// ---- 侧栏收起 ----
export function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  localStorage.setItem('pw-sidebar', collapsed ? 'collapsed' : 'open');
  document.getElementById('library-view').classList.toggle('sidebar-collapsed', collapsed);
}

function clampListWidth(width) {
  const layout = $('library-view');
  const listPane = document.querySelector('.list-pane');
  if (!layout || !listPane) return Math.max(320, Math.min(520, width));
  const layoutRect = layout.getBoundingClientRect();
  const listLeft = listPane.getBoundingClientRect().left;
  const detailMin = 420;
  const max = Math.max(320, layoutRect.right - listLeft - detailMin - 8);
  return Math.round(Math.max(320, Math.min(max, width)));
}

export function applyListWidth(width, persist = false) {
  const next = clampListWidth(Number(width) || 410);
  state.listWidth = next;
  $('library-view')?.style.setProperty('--list-width', next + 'px');
  if (persist) localStorage.setItem('pw-list-width', String(next));
}

export function bindListSplitter() {
  const splitter = $('list-detail-splitter');
  const layout = $('library-view');
  const listPane = document.querySelector('.list-pane');
  if (!splitter || !layout || !listPane) return;

  splitter.onpointerdown = (e) => {
    if (window.innerWidth <= 860) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    layout.classList.add('resizing');
    document.body.classList.add('is-resizing');
    const move = (ev) => applyListWidth(ev.clientX - listPane.getBoundingClientRect().left);
    const up = (ev) => {
      applyListWidth(ev.clientX - listPane.getBoundingClientRect().left, true);
      layout.classList.remove('resizing');
      document.body.classList.remove('is-resizing');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  };

  splitter.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    applyListWidth(state.listWidth + (e.key === 'ArrowRight' ? 24 : -24), true);
  };
}
