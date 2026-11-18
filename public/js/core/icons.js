// 图标注册表（设计系统 §4，v3.64 P1）——全站线性图标的唯一来源。
//
// 规格：viewBox 0 0 24 24、stroke-width 1.75、round 端点/拐角、fill none、currentColor。
// 尺寸只用 14（卡内微钮 / 徽章内）/ 16（默认）/ 20（阅读器工具栏、大按钮）/ 36（空态插图）。
// UI 中禁止 emoji 与字符图标（✓ ✗ ☑ ☐ ⚙ 🔖 …），一律从这里取（tests/design-lint 守 emoji 计数）。
//
// 用法：
//   icon('check')                       → 16px、aria-hidden 的 SVG 字符串
//   icon('sparkles', { size: 14 })
//   icon('x', { label: '关闭' })          → 带 role="img" + aria-label（独立表达含义时用）
//   icon('alert', { cls: 'is-warn' })    → 追加 class

const PATHS = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 15.5 9.5"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  'message-circle': '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  'notebook-pen': '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M18.4 2.6a2 2 0 1 1 3 3L16 11l-4 1 1-4z"/>',
  'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  'check-square': '<rect x="4" y="4" width="16" height="16" rx="3"/><polyline points="8.5 12 11 14.5 15.5 9.5"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

/** 返回 SVG 字符串。未知名返回空串（并在控制台告警），不抛错——图标缺失不应阻断渲染。 */
export function icon(name, { size = 16, label, cls } = {}) {
  const body = PATHS[name];
  if (!body) {
    if (typeof console !== 'undefined') console.warn('[icons] unknown icon:', name);
    return '';
  }
  const a11y = label ? ` role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : ' aria-hidden="true"';
  const klass = 'pw-icon' + (cls ? ' ' + cls : '');
  return (
    `<svg class="${klass}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"` +
    ` stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${a11y}>${body}</svg>`
  );
}
