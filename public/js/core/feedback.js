// 统一反馈（设计系统 §7.1 反馈分级 / §9.3 feedback.js，v3.65 P2）。
//
// toast(message, opts)
//   opts 可以是字符串（旧签名 toast(msg, 'error'|'info'|'success')，'error' → danger、'warn' → warning），
//   也可以是 { level, action, duration, closable }：
//     level     'info' | 'success' | 'warning' | 'danger'（缺省 info）
//     action    { label, run }：行内动作按钮（如「撤销」「重试」）；点了执行 run 并关闭
//     duration  毫秒；0 = 常驻直到手动关闭。缺省按级别：info/success 3.2s、warning 5s、danger 8s；
//               带 action 的不少于 5s（§7.1「执行 + 撤销 toast（5s）」）
//     closable  显示关闭钮（danger / 带 action / 常驻时缺省开）
//   返回 { el, dismiss() }。
//
// 可读性：悬停 / 键盘聚焦时暂停计时（WCAG 2.2.1）；danger 用 role=alert 立即播报，其余 role=status
// 走 #toast-root 的 aria-live=polite。同屏最多 MAX 条，超出先移除最早的。
// 视觉：--surface-raised 卡片 + 左侧级别图标（不再整块铺语义色——暗色下刺眼且与主题脱节）。
//
// undoToast(message, onUndo)：可恢复破坏性操作的标准反馈（§7.2「能撤销的优先撤销，不弹确认」）。

import { icon } from './icons.js';

const LEVEL_ICON = { info: 'info', success: 'check-circle', warning: 'alert', danger: 'x-circle' };
const LEGACY = { error: 'danger', warn: 'warning' };
const DURATION = { info: 3200, success: 3200, warning: 5000, danger: 8000 };
const ACTION_MIN = 5000;
const MAX = 4;

function normalize(opts) {
  const o = typeof opts === 'string' ? { level: opts } : Object.assign({}, opts);
  let level = LEGACY[o.level] || o.level || 'info';
  if (!DURATION[level]) level = 'info';
  o.level = level;
  return o;
}

export function toast(message, opts) {
  const root = document.getElementById('toast-root');
  if (!root) return null;
  const o = normalize(opts);
  const { level, action } = o;
  let duration = o.duration != null ? o.duration : DURATION[level];
  if (action && duration > 0) duration = Math.max(duration, ACTION_MIN);
  const closable = o.closable != null ? !!o.closable : level === 'danger' || !!action || duration === 0;

  const el = document.createElement('div');
  el.className = 'toast ' + level;
  el.dataset.level = level;
  el.setAttribute('role', level === 'danger' ? 'alert' : 'status');
  el.innerHTML = icon(LEVEL_ICON[level], { size: 16, cls: 'toast-ico' }) + '<span class="toast-msg"></span>';
  el.querySelector('.toast-msg').textContent = String(message == null ? '' : message);

  let timer = null;
  let left = duration;
  let startedAt = 0;
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 180);
  };
  const start = () => {
    if (gone || !(left > 0)) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, left);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    left = Math.max(1200, left - (Date.now() - startedAt));
  };

  if (action && action.label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      dismiss();
      try {
        if (typeof action.run === 'function') action.run();
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[toast] action error', e);
      }
    };
    el.appendChild(b);
  }
  if (closable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-close';
    x.setAttribute('aria-label', '关闭通知');
    x.innerHTML = icon('x', { size: 14 });
    x.onclick = dismiss;
    el.appendChild(x);
  }
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', start);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', start);

  root.appendChild(el);
  const live = root.querySelectorAll('.toast:not(.leaving)');
  for (let i = 0; i < live.length - MAX; i++) {
    live[i].classList.add('leaving');
    live[i].classList.remove('show');
    const n = live[i];
    setTimeout(() => n.remove(), 180);
  }
  requestAnimationFrame(() => el.classList.add('show'));
  start();
  return { el, dismiss };
}

/** 可恢复破坏性操作：先执行，再给 5s「撤销」。onUndo 负责回滚（含请求失败时自己再 toast）。 */
export function undoToast(message, onUndo, opts = {}) {
  return toast(message, {
    level: opts.level || 'info',
    duration: opts.duration || ACTION_MIN,
    action: { label: opts.label || '撤销', run: onUndo },
  });
}
