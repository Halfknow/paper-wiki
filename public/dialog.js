/* PWDialog —— 项目内自定义弹窗（替代浏览器原生 alert/confirm/prompt）。
 * 与 Indigo 主题模态（.modal）同一套视觉语言：居中卡片 + 半透明遮罩 + ghost/主按钮。
 * Promise 化 API：
 *   await PWDialog.confirm(message, opts?)  -> boolean        （取消/Esc/点遮罩 = false）
 *   await PWDialog.confirmCheck(message, opts?) -> { ok, checked }  （带勾选框；取消 = { ok:false, checked:false }）
 *   await PWDialog.prompt(message, opts?)   -> string | null  （取消/Esc/点遮罩 = null）
 *   await PWDialog.alert(message, opts?)    -> true
 * opts: { title, okText, cancelText, danger, value, placeholder, multiline, checkbox: { label, checked } }
 * message 中的 \n 以换行渲染（textContent + pre-line，无注入风险）。
 * danger：初始焦点落在「取消」，Enter 仅在焦点位于危险按钮时确认（否则 = 取消）。
 * 键盘分层（v3.65 P2）：每个弹窗登记为 PWLayers（public/layers.js）的一层——Esc 只关最上层、
 * Tab 焦点陷阱、背景 inert、关闭后焦点还给触发器；Enter 走层的 onKey 钩子并阻断传播，
 * 不会干扰阅读器/app 的全局 Esc 分层（见 AGENTS.md 陷阱 31）。
 */
(function () {
  'use strict';

  let seq = 0; // aria-labelledby / aria-describedby 的唯一 id 后缀

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * 打开一个弹窗。kind: 'confirm' | 'prompt' | 'alert'
   * 返回 Promise：confirm/alert 归一为 boolean，prompt 为 string|null。
   */
  function openDialog(kind, message, opts) {
    opts = opts || {};
    if (!window.PWLayers) throw new Error('PWDialog 依赖 /layers.js（须先于 dialog.js 加载）');
    return new Promise((resolve) => {

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

      // confirm 可选勾选框（confirmCheck）：opts.checkbox = { label, checked }
      // settle 结果从 boolean 变为 { ok, checked }，调用方据 r.ok / r.checked 分支
      let checkbox = null;
      if (kind === 'confirm' && opts.checkbox) {
        checkbox = el('input', 'pwdlg-check-box');
        checkbox.type = 'checkbox';
        checkbox.checked = !!opts.checkbox.checked;
        const lab = el('label', 'pwdlg-check');
        lab.appendChild(checkbox);
        lab.appendChild(el('span', null, String(opts.checkbox.label || '')));
        box.appendChild(lab);
      }

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
        cancelBtn = el('button', 'btn secondary sm', opts.cancelText || '取消');
        cancelBtn.type = 'button';
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', 'btn sm' + (opts.danger ? ' danger' : ''), opts.okText || '确定');
      okBtn.type = 'button';
      actions.appendChild(okBtn);
      box.appendChild(actions);

      mask.appendChild(box);

      let settled = false;
      const okValue = () => {
        if (kind === 'prompt') return input.value;
        if (checkbox) return { ok: true, checked: checkbox.checked };
        return true;
      };
      const cancelValue = () => {
        if (kind === 'prompt') return null;
        if (checkbox) return { ok: false, checked: false };
        return false;
      };
      const danger = !!opts.danger && !!cancelBtn;
      const entry = {
        ok: () => settle(okValue()),
        cancel: () => settle(cancelValue()),
      };
      let layer = null;
      function settle(value) {
        if (settled) return;
        settled = true;
        // 先出栈（焦点归还给打开前的触发器），再等淡出动画结束移除 DOM
        if (layer) layer.close();
        mask.classList.remove('show');
        setTimeout(() => mask.remove(), 130);
        resolve(value);
      }
      /** Enter：单行输入与确认框直接提交；多行输入框里 Enter 换行、Ctrl/Cmd+Enter 提交。
       *  危险确认：Enter 只在焦点确实落在危险按钮上时才确认，其余一律当取消——防止「习惯性回车」误删。 */
      function onKey(e) {
        if (e.key !== 'Enter' || e.isComposing) return false;
        const t = e.target;
        if (t && t.tagName === 'TEXTAREA' && opts.multiline && !(e.ctrlKey || e.metaKey)) return false;
        e.preventDefault();
        if (danger && t !== okBtn) entry.cancel();
        else entry.ok();
        return true;
      }

      okBtn.onclick = entry.ok;
      if (cancelBtn) cancelBtn.onclick = entry.cancel;
      // 点遮罩 = 取消（与收藏夹模态行为一致）
      mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) entry.cancel();
      });

      document.body.appendChild(mask);
      layer = window.PWLayers.open({ el: box, root: mask, kind: 'dialog', initialFocus: false, onEscape: entry.cancel, onKey });
      // 下一帧加 .show 触发进场动画
      requestAnimationFrame(() => mask.classList.add('show'));
      // 初始焦点：prompt 聚焦输入框并全选；危险确认聚焦「取消」（Enter = 取消）；
      // 其余 confirm/alert 聚焦主按钮（Enter 即确认）
      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        } else if (danger) {
          cancelBtn.focus();
        } else {
          okBtn.focus();
        }
      }, 30);
    });
  }

  window.PWDialog = {
    confirm: (message, opts) => openDialog('confirm', message, opts),
    // 带勾选框的确认（opts.checkbox = { label, checked }）：resolve { ok, checked }，取消/Esc = { ok:false, checked:false }
    confirmCheck: (message, opts) => openDialog('confirm', message, opts),
    prompt: (message, opts) => openDialog('prompt', message, opts),
    alert: (message, opts) => openDialog('alert', message, opts),
  };
})();
