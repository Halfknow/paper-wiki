'use strict';

// public/layers.js（PWLayers 统一浮层层级管理器，设计系统 §6.8 / §9.3 P2）真实 DOM 测试：
// Esc 只关最上层、焦点陷阱、焦点归还、背景 inert、全局快捷键注册与模态屏蔽、document 级监听恰 2 处。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'layers.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

function boot() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <header id="top"><button id="trigger">open</button></header>
      <div id="toast-root"></div>
      <main id="app"><input id="search" /></main>
      <div id="m1" class="mask"><div class="box" role="dialog"><button id="a1">a1</button><input id="a2" /><button id="a3">a3</button></div></div>
      <div id="m2" class="mask"><div class="box" role="dialog"><button id="b1">b1</button></div></div>
    </body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  dom.window.eval(SRC);
  return dom;
}

function key(win, k, target, extra) {
  const e = new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
  (target || win.document.activeElement || win.document.body).dispatchEvent(e);
  return e;
}

test('Esc 只关最上层；关闭后焦点还给触发器', async () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  d.getElementById('trigger').focus();
  const closed = [];
  const h1 = L.open({ el: d.querySelector('#m1 .box'), onEscape: () => { closed.push('m1'); h1.close(); } });
  await tick();
  assert.strictEqual(d.activeElement.id, 'a1', '默认焦点落在首个可聚焦元素');
  const h2 = L.open({ el: d.querySelector('#m2 .box'), onEscape: () => { closed.push('m2'); h2.close(); } });
  await tick();
  assert.strictEqual(L.depth(), 2);
  const e = key(w, 'Escape');
  assert.ok(e.defaultPrevented, 'Esc 被层消费');
  assert.deepStrictEqual(closed, ['m2'], '只关最上层');
  assert.strictEqual(d.activeElement.id, 'a1', '焦点归还到下层里的触发点');
  key(w, 'Escape');
  assert.deepStrictEqual(closed, ['m2', 'm1']);
  assert.strictEqual(d.activeElement.id, 'trigger', '最外层关闭后焦点回到最初的触发器');
  assert.strictEqual(L.depth(), 0);
});

test('onEscape 返回 false = 不处理（事件照常传播，层不关）', () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  L.open({ el: d.querySelector('#m1 .box'), onEscape: () => false });
  const e = key(w, 'Escape', d.getElementById('a2'));
  assert.ok(!e.defaultPrevented);
  assert.strictEqual(L.depth(), 1);
});

test('模态打开期间背景 inert（toast 区除外），关闭后恢复；嵌套时下层也 inert', () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  const h1 = L.open({ el: d.querySelector('#m1 .box') });
  assert.ok(d.getElementById('app').hasAttribute('inert'), '主体 inert');
  assert.ok(d.getElementById('top').hasAttribute('inert'), '顶栏 inert');
  assert.ok(!d.getElementById('toast-root').hasAttribute('inert'), 'toast 区保持可读（aria-live）');
  assert.ok(!d.getElementById('m1').hasAttribute('inert'), '自身根节点不 inert');
  assert.ok(d.documentElement.classList.contains('pw-has-modal'), '滚动锁');
  const h2 = L.open({ el: d.querySelector('#m2 .box') });
  assert.ok(d.getElementById('m1').hasAttribute('inert'), '上面再叠一层：下层模态也 inert');
  h2.close();
  assert.ok(!d.getElementById('m1').hasAttribute('inert'), '上层关掉后下层恢复');
  h1.close();
  assert.ok(!d.getElementById('app').hasAttribute('inert'));
  assert.ok(!d.documentElement.classList.contains('pw-has-modal'));
});

test('不碰别人设置的 inert；popover 不 inert 背景', () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  d.getElementById('m2').setAttribute('inert', '');
  const h = L.open({ el: d.querySelector('#m1 .box') });
  h.close();
  assert.ok(d.getElementById('m2').hasAttribute('inert'), '原有 inert 保留');
  const p = L.open({ el: d.querySelector('#m1 .box'), kind: 'popover' });
  assert.ok(!d.getElementById('app').hasAttribute('inert'), 'popover 非模态');
  p.close();
});

test('焦点陷阱：Tab / Shift+Tab 在层内首尾循环', async () => {
  const { window: w } = boot();
  const d = w.document;
  w.PWLayers.open({ el: d.querySelector('#m1 .box') });
  await tick();
  d.getElementById('a3').focus();
  let e = key(w, 'Tab');
  assert.ok(e.defaultPrevented);
  assert.strictEqual(d.activeElement.id, 'a1', '末尾 Tab → 回到首个');
  e = key(w, 'Tab', null, { shiftKey: true });
  assert.ok(e.defaultPrevented);
  assert.strictEqual(d.activeElement.id, 'a3', '首个 Shift+Tab → 末尾');
  d.getElementById('a2').focus();
  e = key(w, 'Tab');
  assert.ok(!e.defaultPrevented, '中间位置交给浏览器原生 Tab');
});

test('onKey 钩子先于 Esc 处理，返回 true 即消费并阻断传播', () => {
  const { window: w } = boot();
  const d = w.document;
  const seen = [];
  d.getElementById('a2').addEventListener('keydown', () => seen.push('inner'));
  w.PWLayers.open({
    el: d.querySelector('#m1 .box'),
    onKey: (e) => (e.key === 'Enter' ? (e.preventDefault(), true) : false),
  });
  const e = key(w, 'Enter', d.getElementById('a2'));
  assert.ok(e.defaultPrevented);
  assert.deepStrictEqual(seen, [], '已消费的键不再下发到元素');
  key(w, 'x', d.getElementById('a2'));
  assert.deepStrictEqual(seen, ['inner'], '未消费的键照常到达层内元素');
});

test('全局快捷键：无模态时运行（bubble 晚于元素、capture 早于元素），模态打开时屏蔽', () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  const order = [];
  const offB = L.registerShortcut(() => order.push('bubble'));
  const offC = L.registerShortcut(() => order.push('capture'), { phase: 'capture' });
  d.getElementById('search').addEventListener('keydown', (e) => order.push('el:' + e.defaultPrevented));
  key(w, 'k', d.getElementById('search'));
  assert.deepStrictEqual(order, ['capture', 'el:false', 'bubble']);
  order.length = 0;
  const h = L.open({ el: d.querySelector('#m1 .box') });
  key(w, 'k', d.getElementById('a2'));
  assert.deepStrictEqual(order, [], '模态期间全局快捷键全部让位');
  h.close();
  offB();
  offC();
  key(w, 'k', d.getElementById('search'));
  assert.deepStrictEqual(order, ['el:false'], '注销后不再触发');
});

test('同一元素重复 open 幂等（返回同一 handle，不重复入栈）', () => {
  const { window: w } = boot();
  const d = w.document;
  const el = d.querySelector('#m1 .box');
  const a = w.PWLayers.open({ el });
  const b = w.PWLayers.open({ el });
  assert.strictEqual(a, b);
  assert.strictEqual(w.PWLayers.depth(), 1);
  assert.strictEqual(w.PWLayers.isOpen(el), true);
  a.close();
  assert.strictEqual(w.PWLayers.isOpen(el), false);
});

test('document 级 keydown 监听恰好 2 处（capture + bubble），重复加载不叠加', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  let n = 0;
  const orig = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, fn, opt) => {
    if (type === 'keydown') n += 1;
    return orig(type, fn, opt);
  };
  w.eval(SRC);
  w.eval(SRC);
  assert.strictEqual(n, 2);
});

test('层内元素先处理自己的 Esc（preventDefault / stopPropagation）时层不关；层消费后截断后注册的监听', () => {
  const { window: w } = boot();
  const d = w.document;
  const L = w.PWLayers;
  const a2 = d.getElementById('a2');
  let consume = 'prevent';
  a2.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (consume === 'prevent') e.preventDefault(); // 如：@ 浮层、搜索建议
    else if (consume === 'stop') e.stopPropagation(); // 如：行内改名输入框
  });
  let leaked = 0;
  d.addEventListener('keydown', () => leaked++); // 后注册的同阶段监听（模拟 pdf.js 等第三方）
  const h = L.open({ el: d.querySelector('#m1 .box') });
  key(w, 'Escape', a2);
  assert.strictEqual(h.isOpen, true, '元素已 preventDefault：层不关');
  consume = 'stop';
  key(w, 'Escape', a2);
  assert.strictEqual(h.isOpen, true, '元素已 stopPropagation：层收不到');
  consume = null;
  leaked = 0;
  const e = key(w, 'Escape', a2);
  assert.strictEqual(h.isOpen, false, '元素未处理：层关闭');
  assert.ok(e.defaultPrevented);
  assert.strictEqual(leaked, 0, '层消费的 Esc 不再传给后注册的监听');
});
