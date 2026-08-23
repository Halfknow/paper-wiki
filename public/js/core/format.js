// 标签配色 / 状态点 / 星级 / HTML 转义
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from './dom.js';

// ---- 统一标签/主题配色（文章 chips + 设置中心分类管理 共用）----
// 8 色柔和配色：name 稳定 hash → 下标 → {主色, 柔底, 柔边}，全文统一、告别单调灰标签。
// indigo/violet/cyan/blue/pink/amber 六色延续旧主题视觉，新增 green/rose 扩展多样性。
const CHIP_PALETTE = [
  { c: '#4f46e5', s: '#eef2ff', b: '#c7d2fe' }, // indigo
  { c: '#7c3aed', s: '#f3e8ff', b: '#ddd6fe' }, // violet
  { c: '#0891b2', s: '#cffafe', b: '#a5f3fc' }, // cyan
  { c: '#2563eb', s: '#dbeafe', b: '#bfdbfe' }, // blue
  { c: '#db2777', s: '#fce7f3', b: '#fbcfe8' }, // pink
  { c: '#d97706', s: '#fef3c7', b: '#fde68a' }, // amber
  { c: '#16a34a', s: '#dcfce7', b: '#bbf7d0' }, // green
  { c: '#e11d48', s: '#ffe4e6', b: '#fecdd3' }, // rose
];

/** 名字 → 稳定下标（djb2-like hash mod 8，保证同名 chip 永远同色）。 */
function chipIndex(name) {
  let h = 0;
  for (const ch of String(name ?? '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % CHIP_PALETTE.length;
}

/** 返回某 name 的配色对象 {c 主色, s 柔底, b 柔边}。 */
export function chipOf(name) {
  return CHIP_PALETTE[chipIndex(name)];
}

export function statusDot(p) {
  if (p.status === 'ready') return 'ready';
  if (p.status === 'error') return 'error';
  if (p.status === 'missing') return 'missing';
  // pending/parsing/enriching/summarizing 都属「处理中」，归 busy（琥珀色闪烁）。
  // 显式列出，避免「pending 不在 isBusy 判断里时圆点无样式」的疑虑。
  return 'busy';
}

export { chipIndex };
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 星级评分（1–5）----
// 线性 SVG 星形：filled 表示实心，否则描边。统一替换原 emoji ⭐ / ★ ☆。
const STAR_PATH = 'M12 2.6l2.9 6.05 6.6.78-4.9 4.5 1.32 6.52L12 17.9l-5.92 3.07 1.32-6.52-4.9-4.5 6.6-.78z';

export function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
}

/** 紧凑角标：列表标题后跟单颗星 + 数字。 */
export function starBadge(rating) {
  const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return r ? `<span class="star-badge"><i class="star on">${starSvg(true)}</i>${r}</span>` : '';
}

/** marked(CommonMark) 对 CJK 语境的加粗解析兜底：
 *  「的**“引用”**的」「的**$公式$**的」中，** 紧贴中文引号/标点时按 CommonMark 侧翼规则
 *  （定界符后接标点则前邻必须是空白/标点）被判为非法 → 原样输出字面 **（marked 14 已复现）。
 *  在 sanitize 之后、KaTeX 之前把残留的字面 **...** 转成 <strong>：
 *  - 跳过 <pre>/<code> 段（代码里的 ** 保持字面）；
 *  - 内容不跨标签/换行（[^<\n]），避免吞掉 HTML 结构或跨段落误匹配；
 *  - 必须在 KaTeX 替换之前执行（否则 $x$ 先变成 <span> 会阻断 [^<] 匹配）。 */
export function fixCjkStrong(html) {
  return html
    .split(/(<(?:pre|code)(?:\s[^>]*)?>[\s\S]*?<\/(?:pre|code)>)/g)
    .map((seg, i) => (i % 2 ? seg : seg.replace(/\*\*(\S(?:[^<\n]*?\S)?)\*\*/g, '<strong>$1</strong>')))
    .join('');
}

/** 名字 → 双主题 chip 类名（v3.39）：颜色由 CSS `.chip-N` 规则承载（浅/深两套），
 *  取代旧的内联 style 硬编码浅色——内联样式压过任何暗色覆盖，是深色下标签刺眼的根因。 */
export function chipClass(name) {
  return 'chip-' + chipIndex(name);
}
