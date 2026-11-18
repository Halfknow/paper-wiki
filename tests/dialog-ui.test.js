'use strict';

// dialog.js（PWDialog 自定义弹窗）真实 DOM 测试：jsdom + runScripts 直接执行 public/dialog.js。
// 覆盖：confirm 确定/取消/Esc/点遮罩、prompt 输入/Esc、标题与 danger 样式、键盘事件隔离（stopPropagation）。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('dialog-ui')) return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'dialog.js'), 'utf8');
// PWDialog 依赖 PWLayers（public/layers.js，index.html 中先于 dialog.js 加载）
const LAYERS = fs.readFileSync(path.join(__dirname, '..', 'public', 'layers.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(LAYERS);
  dom.window.eval(SRC);
  return dom;
}

function keydown(win, key, target) {
  const e = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target || win.document).dispatchEvent(e);
  return e;
}

test('confirm：点确定 → true；标题/消息/按钮渲染正确', async () => {
  const dom = boot();
  const { document } = dom.window;
  const p = dom.window.PWDialog.confirm('删除论文「X」？\n不可恢复。', {
    title: '删除论文',
    danger: true,
    okText: '删除',
  });
  await sleep(50);
  const mask = document.querySelector('.pwdlg-mask');
  assert.ok(mask, '遮罩渲染');
  assert.strictEqual(document.querySelector('.pwdlg-title').textContent, '删除论文');
  assert.ok(document.querySelector('.pwdlg-title').classList.contains('danger'), 'danger 标题色');
  assert.strictEqual(document.querySelector('.pwdlg-msg').textContent, '删除论文「X」？\n不可恢复。');
  const btns = [...document.querySelectorAll('.pwdlg-actions button')];
  assert.deepStrictEqual(
    btns.map((b) => b.textContent),
    ['取消', '删除'],
  );
  assert.ok(btns[1].classList.contains('danger'), '危险主按钮');
  btns[1].click();
  assert.strictEqual(await p, true);
});

test('confirm：点取消 / Esc / 点遮罩 → false', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  // 取消按钮
  const p1 = PWDialog.confirm('x');
  await sleep(30);
  [...document.querySelectorAll('.pwdlg-actions button')][0].click();
  assert.strictEqual(await p1, false);
  // Esc
  const p2 = PWDialog.confirm('x');
  await sleep(30);
  keydown(dom.window, 'Escape');
  assert.strictEqual(await p2, false);
  // 点遮罩（mousedown 在 mask 本体上）——注意已关闭弹窗的 DOM 有 130ms 淡出才移除，取最后一个（当前）遮罩
  const p3 = PWDialog.confirm('x');
  await sleep(30);
  const masks = document.querySelectorAll('.pwdlg-mask');
  const mask = masks[masks.length - 1];
  mask.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.strictEqual(await p3, false);
});

test('confirm 普通：初始焦点在确定，Enter 直接确认', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  const p = PWDialog.confirm('x');
  await sleep(50);
  const [, ok] = [...document.querySelectorAll('.pwdlg-actions button')];
  assert.strictEqual(document.activeElement, ok, '非危险：焦点在主按钮');
  keydown(dom.window, 'Enter');
  assert.strictEqual(await p, true);
});

test('confirm danger：初始焦点在取消，Enter 不执行危险操作；焦点移到危险按钮后 Enter 才确认', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  // 1) 默认焦点在取消，裸 Enter = 取消
  const p1 = PWDialog.confirm('删除？', { danger: true, okText: '删除' });
  await sleep(50);
  const [cancel1] = [...document.querySelectorAll('.pwdlg-actions button')];
  assert.strictEqual(document.activeElement, cancel1, '危险确认：焦点默认落在取消');
  keydown(dom.window, 'Enter', document.activeElement);
  assert.strictEqual(await p1, false, 'Enter 在取消上 = 取消');
  // 2) 用户主动把焦点移到危险按钮再按 Enter = 确认
  const p2 = PWDialog.confirm('删除？', { danger: true, okText: '删除' });
  await sleep(50);
  const masks = document.querySelectorAll('.pwdlg-mask');
  const ok2 = masks[masks.length - 1].querySelector('.pwdlg-actions button.danger');
  ok2.focus();
  keydown(dom.window, 'Enter', ok2);
  assert.strictEqual(await p2, true, '焦点在危险按钮上 Enter = 确认');
});

test('confirm：弹窗声明 aria-labelledby / aria-describedby 指向标题与正文', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  const p = PWDialog.confirm('正文', { title: '标题' });
  await sleep(30);
  const box = document.querySelector('.pwdlg');
  const t = document.getElementById(box.getAttribute('aria-labelledby'));
  const d = document.getElementById(box.getAttribute('aria-describedby'));
  assert.ok(t && t.textContent === '标题', 'aria-labelledby → 标题');
  assert.ok(d && d.textContent === '正文', 'aria-describedby → 正文');
  keydown(dom.window, 'Escape');
  await p;
});

test('prompt：输入后 Enter 提交返回值；Esc 返回 null', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  const p1 = PWDialog.prompt('命名：', { value: '默认名' });
  await sleep(50);
  const input = document.querySelector('.pwdlg-input');
  assert.ok(input, '输入框渲染');
  assert.strictEqual(input.value, '默认名', '预填值');
  input.value = '注意力论文';
  keydown(dom.window, 'Enter', input);
  assert.strictEqual(await p1, '注意力论文');
  // Esc → null
  const p2 = PWDialog.prompt('命名：');
  await sleep(30);
  keydown(dom.window, 'Escape');
  assert.strictEqual(await p2, null);
});

test('prompt 多行：textarea 里 Enter 不提交（换行），Ctrl+Enter 提交', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  const p = PWDialog.prompt('编辑解释：', { multiline: true, value: '旧解释' });
  await sleep(50);
  const ta = document.querySelector('textarea.pwdlg-input');
  assert.ok(ta, '多行用 textarea');
  // 裸 Enter 不提交
  keydown(dom.window, 'Enter', ta);
  await sleep(20);
  assert.ok(document.querySelector('.pwdlg-mask'), '弹窗仍在');
  // Ctrl+Enter 提交
  const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
  ta.dispatchEvent(e);
  assert.strictEqual(await p, '旧解释');
});

test('键盘隔离：弹窗打开时 Esc 被 stopPropagation，不泄漏到后注册的全局监听', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  let leaked = 0;
  document.addEventListener('keydown', () => leaked++); // 后注册（模拟 app/reader 全局分层）
  const p = PWDialog.confirm('x');
  await sleep(30);
  keydown(dom.window, 'Escape');
  assert.strictEqual(await p, false);
  assert.strictEqual(leaked, 0, 'Esc 不冒泡到全局');
});

test('alert：只有确定按钮，返回 true；连开两个弹窗后者优先响应', async () => {
  const dom = boot();
  const { document, PWDialog } = dom.window;
  const p1 = PWDialog.alert('第一条');
  await sleep(30);
  const btns = [...document.querySelectorAll('.pwdlg-actions button')];
  assert.strictEqual(btns.length, 1, 'alert 无取消按钮');
  // 叠开第二个
  const p2 = PWDialog.confirm('第二条');
  await sleep(30);
  assert.strictEqual(document.querySelectorAll('.pwdlg-mask').length, 2, '支持叠放');
  keydown(dom.window, 'Enter'); // 应只关掉顶层
  assert.strictEqual(await p2, true);
  assert.ok(document.querySelector('.pwdlg-mask'), '底层 alert 仍开着');
  document.querySelector('.pwdlg-actions button').click();
  assert.strictEqual(await p1, true);
});
