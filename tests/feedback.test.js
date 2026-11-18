'use strict';

// public/js/core/feedback.js（设计系统 §7.1 反馈分级，v3.65 P2）：toast 分级 / 旧签名兼容 /
// 动作按钮（撤销）/ 关闭钮 / 级别时长 / 悬停暂停 / 同屏上限。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="toast-root" aria-live="polite"></div></body></html>', {
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let fb;
test.before(async () => {
  fb = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'feedback.js')).href);
});
test.beforeEach(() => {
  document.getElementById('toast-root').innerHTML = '';
});

const toasts = () => [...document.querySelectorAll('#toast-root .toast')];

test('级别：旧签名 error → danger（role=alert + 关闭钮），info 为 role=status；带级别图标', () => {
  fb.toast('保存失败', 'error');
  fb.toast('已导出');
  const [d, i] = toasts();
  assert.strictEqual(d.dataset.level, 'danger');
  assert.strictEqual(d.getAttribute('role'), 'alert');
  assert.ok(d.querySelector('.toast-close[aria-label]'), 'danger 可手动关闭');
  assert.ok(d.querySelector('svg.toast-ico'), '级别图标');
  assert.strictEqual(i.dataset.level, 'info');
  assert.strictEqual(i.getAttribute('role'), 'status');
  assert.ok(!i.querySelector('.toast-close'), 'info 不带关闭钮');
  assert.strictEqual(d.querySelector('.toast-msg').textContent, '保存失败');
});

test('文案按纯文本写入（不解析 HTML）', () => {
  fb.toast('<img src=x onerror=alert(1)>');
  const t = toasts()[0];
  assert.strictEqual(t.querySelector('img'), null);
  assert.ok(t.textContent.includes('<img'));
});

test('undoToast：点「撤销」执行回调并关闭', async () => {
  let undone = 0;
  const h = fb.undoToast('已删除笔记卡', () => undone++);
  const btn = h.el.querySelector('.toast-action');
  assert.strictEqual(btn.textContent, '撤销');
  btn.click();
  assert.strictEqual(undone, 1);
  await new Promise((r) => setTimeout(r, 220));
  assert.strictEqual(toasts().length, 0, '执行后移除');
});

test('级别时长：info 3.2s 后消失；悬停暂停，移开后继续', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = fb.toast('x', { level: 'info' });
  t.mock.timers.tick(3000);
  h.el.dispatchEvent(new window.Event('mouseenter'));
  t.mock.timers.tick(10000);
  assert.ok(h.el.isConnected, '悬停期间不消失');
  h.el.dispatchEvent(new window.Event('mouseleave'));
  t.mock.timers.tick(1300); // 剩余时间至少保底 1.2s
  t.mock.timers.tick(200); // 淡出
  assert.ok(!h.el.isConnected, '移开后按剩余时间消失');
});

test('duration:0 常驻（带关闭钮）；同屏最多 4 条，超出先移除最早的', async () => {
  const sticky = fb.toast('常驻', { level: 'warning', duration: 0 });
  assert.ok(sticky.el.querySelector('.toast-close'), '常驻必须可手动关闭');
  for (let i = 0; i < 5; i++) fb.toast('t' + i);
  await new Promise((r) => setTimeout(r, 220));
  const left = toasts().map((x) => x.querySelector('.toast-msg').textContent);
  assert.deepStrictEqual(left, ['t1', 't2', 't3', 't4']);
});
