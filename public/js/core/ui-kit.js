// toast / 忙碌态 / 文案映射 / chip 列表 / 统计条
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from './dom.js';
import { chipClass, escapeHtml } from './format.js';
import { icon } from './icons.js';
import { state } from './state.js';

const STATUS_ICON = { success: 'check-circle', danger: 'x-circle', warning: 'alert', info: 'info' };

/** 就地状态（设计系统 §6.11 Inline status）：level 图标 + 文案，替代 ✓ / ✗ 字符前缀。
 *  只写内容与 data-level，颜色由调用方既有的 class（good/bad 等）或 .inline-status[data-level] 决定。 */
export function inlineStatus(el, level, text) {
  if (!el) return;
  const name = STATUS_ICON[level];
  el.dataset.level = level;
  el.innerHTML = (name ? icon(name, { size: 14 }) : '') + '<span>' + escapeHtml(String(text == null ? '' : text)) + '</span>';
}

// toast 实现迁至 feedback.js（v3.65 P2：分级 + 动作/撤销 + 悬停暂停）；此处转出保持既有 import 不变。
export { toast, undoToast } from './feedback.js';

export function setBusy(el, busy, label) {
  if (!el) return;
  if (busy) {
    el.dataset.prevText = el.textContent;
    // 钉住当前宽度：busy 文案（如「复制中…」）比原文案短时按钮先坍缩再恢复，造成布局抖动
    if (!el.style.minWidth) el.style.minWidth = el.offsetWidth + 'px';
    el.textContent = label || '处理中…';
    el.disabled = true;
    el.classList.add('is-busy');
  } else {
    el.textContent = el.dataset.prevText || el.textContent;
    el.disabled = false;
    el.classList.remove('is-busy');
    el.style.minWidth = '';
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
    return `<span class="${cls}${extra} ${chipClass(t)}">${escapeHtml(t)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted">+${rest}</span>` : '');
}

// 紧凑行宽约 270px：字号统一到 --fs-xs(11px) 后放 4 个会把每个都挤成截断，默认 3 个（v3.66）。
// 截断时 title 给出全名；+N 的 title 列出被折叠的名字，信息不丢。
export function compactChipList(p, limit = 3) {
  const items = [
    ...(p.topics || []).map((name) => ({ name, cls: 'topic' })),
    ...(p.tags || []).map((name) => ({ name, cls: 'tag' })),
  ];
  const shown = items.slice(0, limit);
  const hidden = items.slice(limit);
  return shown.map((it) => {
    const name = escapeHtml(it.name);
    return `<span class="${it.cls} ${chipClass(it.name)}" title="${name}">${name}</span>`;
  }).join('') +
    (hidden.length
      ? `<span class="tag muted compact-more" title="${escapeHtml(hidden.map((it) => it.name).join('、'))}">+${hidden.length}</span>`
      : '');
}

/** 全局统计 → 顶栏状态胶囊 + 一级导航计数徽标（v3.17）。
 *
 *  设计取舍：正常时胶囊只剩一个灰点（不占顶栏宽度），但**处理中 / 出错时把文案顶出来**。
 *  把异常也折叠进 hover 会让后台失败完全静默，那是可用性红线。明细与「立即扫描」进 popover。 */
export function renderStats(stats) {
  state.stats = stats; // 缓存全局统计，供 renderSidebar 读「全部/星标/未读」计数（不随筛选变）

  // 一级导航的计数徽标（取代旧 stats 里重复的「N 概念 / N 公式」pill）
  setCount('vn-count-papers', stats.total);
  setCount('vn-count-concepts', stats.concepts);
  setCount('vn-count-formulas', stats.formulas);

  // 处理中时，把当前在跑的阶段从 state.papers 聚合出来，让批量首扫不再是黑盒
  let detail = '';
  if (stats.processing > 0) {
    const stageCount = {};
    for (const p of state.papers) {
      if (['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)) {
        const label = statusLabel(p.status);
        stageCount[label] = (stageCount[label] || 0) + 1;
      }
    }
    detail = Object.entries(stageCount).map(([k, v]) => `${k} ${v}`).join(' · ');
  }

  // 胶囊等级：错误 > 处理中 > 空闲（错误更需要被看见，故优先级最高）
  const level = stats.error ? 'error' : stats.processing > 0 ? 'busy' : 'idle';
  const chip = $('status-chip');
  if (chip) {
    chip.dataset.level = level;
    const parts = [];
    if (stats.processing > 0) parts.push(`${stats.processing} 处理中`);
    if (stats.error) parts.push(`${stats.error} 错误`);
    $('sc-text').textContent = parts.join(' · ');
    chip.title = level === 'idle'
      ? `${stats.ready}/${stats.total} 就绪`
      : [`${stats.ready}/${stats.total} 就绪`, detail].filter(Boolean).join(' · ');
  }

  const rows = $('sp-rows');
  if (rows) {
    rows.innerHTML = `
      <div class="sp-row"><span class="sp-k">就绪</span><span class="sp-v good">${stats.ready}/${stats.total}</span></div>
      ${stats.processing > 0
        ? `<div class="sp-row"><span class="sp-k"><span class="pulse"></span>处理中</span><span class="sp-v busy">${stats.processing}</span></div>
           ${detail ? `<div class="sp-detail">${escapeHtml(detail)}</div>` : ''}`
        : ''}
      ${stats.error ? `<div class="sp-row"><span class="sp-k">出错</span><span class="sp-v bad">${stats.error}</span></div>` : ''}
      <div class="sp-row"><span class="sp-k">概念</span><span class="sp-v">${stats.concepts || 0}</span></div>
      <div class="sp-row"><span class="sp-k">公式</span><span class="sp-v">${stats.formulas || 0}</span></div>`;
  }
}

/** 导航徽标：0 或缺失时留空（不显示「0」，避免空库时三个刺眼的零）。 */
function setCount(id, n) {
  const el = $(id);
  if (!el) return;
  el.textContent = n > 0 ? String(n) : '';
}
