// toast / 忙碌态 / 文案映射 / chip 列表 / 统计条
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from './dom.js';
import { chipOf, escapeHtml } from './format.js';
import { state } from './state.js';

export function toast(message, type = 'info') {
  const root = $('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 180);
  }, type === 'error' ? 5200 : 3200);
}

export function setBusy(el, busy, label) {
  if (!el) return;
  if (busy) {
    el.dataset.prevText = el.textContent;
    el.textContent = label || '处理中…';
    el.disabled = true;
    el.classList.add('is-busy');
  } else {
    el.textContent = el.dataset.prevText || el.textContent;
    el.disabled = false;
    el.classList.remove('is-busy');
    delete el.dataset.prevText;
  }
}

export function statusLabel(status) {
  return ({ ready: '就绪', error: '出错', missing: '缺失', pending: '排队', parsing: '解析中', enriching: '补元数据', summarizing: '总结中' }[status] || '处理中');
}

export function readStatusLabel(status) {
  return ({ unread: '未读', reading: '在读', done: '已读' }[status || 'unread'] || '未读');
}

export function shortAuthors(p, limit = 2) {
  const authors = p.authors || [];
  if (!authors.length) return '未知作者';
  const base = authors.slice(0, limit).join(', ');
  return authors.length > limit ? base + ' 等' : base;
}

export function progressPercent(p) {
  return (p.readProgress && p.readProgress.total)
    ? Math.min(100, Math.max(0, Math.round(100 * p.readProgress.page / p.readProgress.total)))
    : null;
}

export function chipList(items, cls, limit = 4, clsFor) {
  const shown = (items || []).slice(0, limit);
  const rest = Math.max(0, (items || []).length - shown.length);
  // 统一内联配色：主题/标签按名 hash 落到同一套柔和 8 色，告别单调灰标签。
  return shown.map((t) => {
    const extra = clsFor ? ' ' + clsFor(t) : '';
    const p = chipOf(t);
    return `<span class="${cls}${extra}" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(t)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted">+${rest}</span>` : '');
}

export function compactChipList(p, limit = 4) {
  const items = [
    ...(p.topics || []).map((name) => ({ name, cls: 'topic' })),
    ...(p.tags || []).map((name) => ({ name, cls: 'tag' })),
  ];
  const shown = items.slice(0, limit);
  const rest = Math.max(0, items.length - shown.length);
  return shown.map((it) => {
    const p = chipOf(it.name);
    return `<span class="${it.cls}" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(it.name)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted compact-more">+${rest}</span>` : '');
}

export function renderStats(stats) {
  state.stats = stats; // 缓存全局统计，供 renderSidebar 读「全部/星标/未读」计数（不随筛选变）
  // 处理中时，把当前在跑的阶段从 state.papers 聚合出来，让批量首扫不再是黑盒
  let processingHtml = '';
  if (stats.processing > 0) {
    const stageCount = {};
    for (const p of state.papers) {
      if (['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)) {
        const label = statusLabel(p.status);
        stageCount[label] = (stageCount[label] || 0) + 1;
      }
    }
    const detail = Object.entries(stageCount)
      .map(([k, v]) => `${k} ${v}`).join(' · ');
    processingHtml = `<span class="stat-pill busy" title="${escapeHtml(detail || '处理中')}">
      <span class="pulse"></span>${stats.processing} 处理中${detail ? ' · ' + escapeHtml(detail) : ''}</span>`;
  }
  $('stats').innerHTML = `
    <span class="stat-pill good">${stats.ready}/${stats.total} 就绪</span>
    ${processingHtml}
    ${stats.error ? `<span class="stat-pill bad">${stats.error} 错误</span>` : ''}
    <span class="stat-pill">${stats.concepts} 概念</span>
    ${stats.formulas ? `<span class="stat-pill">${stats.formulas} 公式</span>` : ''}`;
}
