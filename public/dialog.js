/* PWDialog —— 项目内自定义弹窗（替代浏览器原生 alert/confirm/prompt）。
 * 与 Indigo 主题模态（.modal）同一套视觉语言：居中卡片 + 半透明遮罩 + ghost/主按钮。
 * Promise 化 API：
 *   await PWDialog.confirm(message, opts?)  -> boolean        （取消/Esc/点遮罩 = false）
 *   await PWDialog.prompt(message, opts?)   -> string | null  （取消/Esc/点遮罩 = null）
 *   await PWDialog.alert(message, opts?)    -> true
 * opts: { title, okText, cancelText, danger, value, placeholder, multiline }
 * message 中的 \n 以换行渲染（textContent + pre-line，无注入风险）。
 * danger：初始焦点落在「取消」，Enter 仅在焦点位于危险按钮时确认（否则 = 取消）。
 * 键盘分层：常驻 document capture 监听，仅在弹窗打开时消费 Esc/Enter 并 stopPropagation，
 * 不会干扰阅读器/app 的全局 Esc 分层（见 AGENTS.md 陷阱 31）。
 */
(function () {
  'use strict';

  const openStack = []; // 当前打开的弹窗（支持嵌套/连发，后开者在上）
  let seq = 0; // aria-labelledby / aria-describedby 的唯一 id 后缀

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 常驻 capture 键盘监听：弹窗打开时接管 Esc（取消）与 Enter（确认），并阻断冒泡到阅读器/全局分层。 */
  document.addEventListener(
    'keydown',
    (e) => {
      const top = openStack[openStack.length - 1];
      if (!top) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        top.cancel();
      } else if (e.key === 'Enter' && top.enterOk) {
        // 多行输入框里 Enter 换行、Ctrl/Cmd+Enter 提交；单行输入与确认框 Enter 直接提交
        const t = e.target;
        const inMultiline = t && t.tagName === 'TEXTAREA' && top.multiline;
        if (inMultiline && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        // 危险确认：Enter 只在焦点确实落在危险按钮上时才确认，其余一律当取消——
        // 防止「习惯性回车」误删（规范 §7 危险操作）
        if (top.danger && t !== top.okBtn) top.cancel();
        else top.ok();
      }
    },
    true
  );

  /**
   * 打开一个弹窗。kind: 'confirm' | 'prompt' | 'alert'
   * 返回 Promise：confirm/alert 归一为 boolean，prompt 为 string|null。
   */
  function openDialog(kind, message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;

      const mask = el('div', 'pwdlg-mask');
      const box = el('div', 'pwdlg');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      // 标题：confirm 默认「确认」，prompt 默认「输入」，alert 默认「提示」
      const defaultTitle = kind === 'prompt' ? '输入' : kind === 'alert' ? '提示' : '请确认';
      const title = el('h3', 'pwdlg-title' + (opts.danger ? ' danger' : ''), opts.title || defaultTitle);
      box.appendChild(title);

      const body = el('div', 'pwdlg-msg', String(message == null ? '' : message));
      box.appendChild(body);
      const uid = ++seq;
      title.id = 'pwdlg-t' + uid;
      body.id = 'pwdlg-d' + uid;
      box.setAttribute('aria-labelledby', title.id);
      box.setAttribute('aria-describedby', body.id);

      // prompt 输入区（单行 input / 多行 textarea）
      let input = null;
      if (kind === 'prompt') {
        input = opts.multiline ? el('textarea', 'pwdlg-input pwdlg-textarea') : el('input', 'pwdlg-input');
        if (!opts.multiline) input.type = 'text';
        input.value = opts.value != null ? String(opts.value) : '';
        if (opts.placeholder) input.placeholder = String(opts.placeholder);
        input.rows = 4;
        box.appendChild(input);
      }

      const actions = el('div', 'pwdlg-actions');
      let cancelBtn = null;
      if (kind !== 'alert') {
        cancelBtn = el('button', 'btn ghost sm', opts.cancelText || '取消');
        cancelBtn.type = 'button';
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', 'btn sm' + (opts.danger ? ' danger' : ''), opts.okText || '确定');
      okBtn.type = 'button';
      actions.appendChild(okBtn);
      box.appendChild(actions);

      mask.appendChild(box);

      let settled = false;
      const entry = {
        multiline: !!opts.multiline,
        enterOk: true,
        danger: !!opts.danger && !!cancelBtn,
        okBtn,
        ok: () => settle(kind === 'prompt' ? input.value : true),
        cancel: () => settle(kind === 'prompt' ? null : false),
      };
      function settle(value) {
        if (settled) return;
        settled = true;
        const i = openStack.indexOf(entry);
        if (i >= 0) openStack.splice(i, 1);
        mask.classList.remove('show');
        // 等淡出动画结束再移除 DOM
        setTimeout(() => mask.remove(), 130);
        if (prevFocus && prevFocus.focus) {
          try { prevFocus.focus(); } catch { /* ignore */ }
        }
        resolve(value);
      }

      okBtn.onclick = entry.ok;
      if (cancelBtn) cancelBtn.onclick = entry.cancel;
      // 点遮罩 = 取消（与收藏夹模态行为一致）
      mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) entry.cancel();
      });

      document.body.appendChild(mask);
      openStack.push(entry);
      // 下一帧加 .show 触发进场动画
      requestAnimationFrame(() => mask.classList.add('show'));
      // 初始焦点：prompt 聚焦输入框并全选；危险确认聚焦「取消」（Enter = 取消）；
      // 其余 confirm/alert 聚焦主按钮（Enter 即确认）
      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        } else if (entry.danger) {
          cancelBtn.focus();
        } else {
          okBtn.focus();
        }
      }, 30);
    });
  }

  window.PWDialog = {
    confirm: (message, opts) => openDialog('confirm', message, opts),
    prompt: (message, opts) => openDialog('prompt', message, opts),
    alert: (message, opts) => openDialog('alert', message, opts),
  };
})();
