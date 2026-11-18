/* PWLayers —— 统一浮层层级管理器（设计系统 §6.8 / §9.3，v3.65 P2）。
 *
 * 所有 Dialog / Drawer / Sheet / Popover 打开时登记到同一个栈，由这里统一负责：
 *   · Esc 只关闭**最上层**（层可用 onEscape 自定义；返回 false = 不处理、事件照常传播）
 *   · 焦点：打开时移入层内（可关），Tab / Shift+Tab 在层内循环（焦点陷阱），关闭时还给触发器
 *   · 模态期间背景 `inert` + <html>.pw-has-modal（滚动锁）；toast 区（aria-live）保持可读
 *   · 全局快捷键：registerShortcut(fn, { phase }) 注册；模态层打开时一律让位
 *
 * 全站 document 级 keydown 监听**只有这里的两处**：
 *   capture —— 最上层的 onKey 钩子、Tab 焦点陷阱、capture 期快捷键（阅读器）；
 *   bubble  —— 最上层的 Esc、普通快捷键。Esc 放在冒泡期：层内元素（改名输入框、下拉菜单）
 *              可先处理自己的 Esc（stopPropagation / preventDefault 即表示已消费），不会连带关掉整层。
 * 模块里禁止再 document.addEventListener('keydown')（tests/design-lint.test.js 硬约束）。
 *
 * 经典脚本（index.html 中先于 dialog.js 加载）：挂 window.PWLayers，ESM 侧经
 * public/js/core/layers.js 薄封装使用。状态挂在各自的 window 上（jsdom 多实例测试互不串）。
 *
 * API：
 *   const h = PWLayers.open({ el, root?, kind?, modal?, trap?, trigger?, initialFocus?, restoreFocus?,
 *                             onEscape?(e), onKey?(e) })
 *     el           层的内容框（焦点范围 / 焦点陷阱范围），一般是 role=dialog 的那个元素
 *     root         body 直接子节点（不被 inert 的部分），缺省从 el 向上找
 *     kind         'dialog' | 'drawer' | 'sheet' | 'popover' | 'fullscreen'（缺省 dialog）
 *     modal        缺省：popover 为 false，其余 true
 *     initialFocus false = 调用方自己管焦点；元素 / 选择器 = 指定；缺省 = 层内首个可聚焦元素
 *     onKey        层内按键钩子，先于 Esc / Tab 处理；返回 true = 已消费（阻断传播）
 *   h.close()  h.isOpen  h.isTop()
 *   PWLayers.registerShortcut(fn, { phase: 'bubble' | 'capture' }) -> 注销函数
 *   PWLayers.depth()  PWLayers.top()  PWLayers.hasModal()  PWLayers.isOpen(el)
 */
(function (w) {
  'use strict';
  if (w.PWLayers) return;
  const doc = w.document;

  const stack = [];
  const shortcuts = { capture: [], bubble: [] };
  const inerted = new Set(); // 只记录本管理器加上的 inert，恢复时不误删别人的

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

  function rootOf(el) {
    let n = el;
    while (n && n.parentElement && n.parentElement !== doc.body) n = n.parentElement;
    return n;
  }

  function isShown(n, scope) {
    for (let x = n; x && x !== scope.parentElement; x = x.parentElement) {
      if (x.hidden) return false;
      const cs = w.getComputedStyle(x);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }

  function focusables(scope) {
    return Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), (n) => isShown(n, scope));
  }

  function focusInto(layer) {
    const want = layer.initialFocus;
    if (want === false) return;
    if (layer.el.contains(doc.activeElement) && doc.activeElement !== layer.el) return;
    let t = null;
    if (want && typeof want === 'object') t = want;
    else if (typeof want === 'string') t = layer.el.querySelector(want);
    if (!t) t = layer.el.querySelector('[autofocus]') || focusables(layer.el)[0] || null;
    if (!t) {
      if (!layer.el.hasAttribute('tabindex')) layer.el.setAttribute('tabindex', '-1');
      t = layer.el;
    }
    try { t.focus(); } catch { /* ignore */ }
  }

  function topModalIndex() {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].modal) return i;
    return -1;
  }

  /** 同步 inert 与滚动锁：最上层模态（及其上方的层）之外的 body 子节点全部 inert。 */
  function sync() {
    const ti = topModalIndex();
    const want = new Set();
    if (ti >= 0) {
      const keep = new Set();
      for (let i = ti; i < stack.length; i++) keep.add(stack[i].root);
      for (const c of Array.prototype.slice.call(doc.body.children)) {
        if (keep.has(c) || c.id === 'toast-root' || c.tagName === 'SCRIPT' || c.hasAttribute('data-layer-keep')) continue;
        want.add(c);
      }
    }
    for (const n of Array.from(inerted)) {
      if (!want.has(n)) {
        n.removeAttribute('inert');
        inerted.delete(n);
      }
    }
    for (const n of want) {
      if (!n.hasAttribute('inert')) {
        n.setAttribute('inert', '');
        inerted.add(n);
      }
    }
    doc.documentElement.classList.toggle('pw-has-modal', ti >= 0);
  }

  function close(layer) {
    if (layer.closed) return;
    layer.closed = true;
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    sync();
    if (!layer.restoreFocus) return;
    const a = doc.activeElement;
    const focusLost = !a || a === doc.body || layer.el.contains(a) || !a.isConnected;
    const t = layer.trigger;
    if (focusLost && t && t.isConnected && typeof t.focus === 'function') {
      try { t.focus(); } catch { /* ignore */ }
    }
  }

  function open(o) {
    if (!o || !o.el) throw new Error('PWLayers.open: 缺少 el');
    const existing = stack.find((l) => l.el === o.el);
    if (existing) return existing.handle;
    const kind = o.kind || 'dialog';
    const modal = o.modal != null ? !!o.modal : kind !== 'popover';
    const layer = {
      el: o.el,
      root: o.root || rootOf(o.el),
      kind,
      modal,
      trap: o.trap != null ? !!o.trap : modal,
      trigger: o.trigger !== undefined ? o.trigger : doc.activeElement,
      initialFocus: o.initialFocus,
      restoreFocus: o.restoreFocus !== false,
      onEscape: o.onEscape,
      onKey: o.onKey,
      closed: false,
    };
    layer.handle = {
      el: o.el,
      kind,
      close: () => close(layer),
      isTop: () => stack[stack.length - 1] === layer,
      get isOpen() { return !layer.closed; },
    };
    stack.push(layer);
    sync();
    if (layer.initialFocus !== false) w.setTimeout(() => { if (!layer.closed) focusInto(layer); }, 0);
    return layer.handle;
  }

  function trapTab(e, layer) {
    const f = focusables(layer.el);
    if (!f.length) {
      e.preventDefault();
      focusInto(Object.assign({}, layer, { initialFocus: undefined }));
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const a = doc.activeElement;
    const inside = layer.el.contains(a);
    if (e.shiftKey) {
      if (!inside || a === first || a === layer.el) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || a === last || a === layer.el) {
      e.preventDefault();
      first.focus();
    }
  }

  function runShortcuts(phase, e) {
    for (const fn of shortcuts[phase].slice()) {
      try {
        if (fn(e) === true) return;
      } catch (err) {
        if (w.console) w.console.error('[PWLayers] shortcut error', err);
      }
    }
  }

  function onCapture(e) {
    const top = stack[stack.length - 1];
    if (top) {
      if (top.onKey && top.onKey(e) === true) {
        e.stopPropagation();
        return;
      }
      if (e.key === 'Tab' && top.trap) {
        trapTab(e, top);
        return;
      }
      if (e.key === 'Escape') return; // 有层时 Esc 归层（冒泡期），capture 期快捷键不抢
    }
    if (topModalIndex() >= 0) return;
    runShortcuts('capture', e);
  }

  function onBubble(e) {
    const top = stack[stack.length - 1];
    if (top && e.key === 'Escape') {
      if (e.defaultPrevented || e.isComposing) return; // 层内元素已消费（或输入法组字中）
      const r = top.onEscape ? top.onEscape(e) : (top.handle.close(), true);
      if (r !== false) {
        // 已消费：截断同阶段后注册的监听（含 pdf.js 挂在 window 冒泡期的 KeyboardManager）
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    if (topModalIndex() >= 0) return;
    runShortcuts('bubble', e);
  }

  function registerShortcut(fn, opts) {
    const phase = opts && opts.phase === 'capture' ? 'capture' : 'bubble';
    shortcuts[phase].push(fn);
    return () => {
      const i = shortcuts[phase].indexOf(fn);
      if (i >= 0) shortcuts[phase].splice(i, 1);
    };
  }

  doc.addEventListener('keydown', onCapture, true);
  doc.addEventListener('keydown', onBubble, false);

  w.PWLayers = {
    open,
    registerShortcut,
    depth: () => stack.length,
    top: () => (stack.length ? stack[stack.length - 1].handle : null),
    hasModal: () => topModalIndex() >= 0,
    isOpen: (el) => stack.some((l) => l.el === el),
    focusables,
  };
})(window);
