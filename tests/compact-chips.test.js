'use strict';

// 紧凑视图标签（v3.66）：P0 把紧凑 chip 的 9px 统一到 --fs-xs(11px，规范 §3.3 全站最小字号) 后，
// 一行 4 个 chip 在 ~270px 宽里被挤窄，且 .tag 是 flex 容器——text-overflow:ellipsis 对其无效，
// 文字被硬切（无省略号），「+N」也参与收缩被挤成「+」。本测试锁定：
//   · compactChipList 默认 3 个 + 「+N」，每个 chip 带 title（悬停看全名）
//   · CSS：紧凑 chip 为 block（省略号生效），+N 不收缩

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { document } = dom.window;
globalThis.window = dom.window;
globalThis.document = document;
globalThis.localStorage = dom.window.localStorage;

const load = () => import(pathToFileURL(path.join(__dirname, '../public/js/core/ui-kit.js')).href);

test('compactChipList：默认 3 个 chip + 「+N」，chip 带 title 全名且转义', async () => {
  const { compactChipList } = await load();
  const html = compactChipList({
    topics: ['语言模型', 'AI安全与对齐'],
    tags: ['mechanistic-interpretability', 'a"b<c', 'x', 'y'],
  });
  const box = document.createElement('div');
  box.innerHTML = html;
  const chips = [...box.children];
  assert.strictEqual(chips.length, 4, '3 个 chip + 1 个 +N');
  assert.deepStrictEqual(
    chips.slice(0, 3).map((c) => c.getAttribute('title')),
    ['语言模型', 'AI安全与对齐', 'mechanistic-interpretability'],
  );
  const more = chips[3];
  assert.ok(more.classList.contains('compact-more'));
  assert.strictEqual(more.textContent, '+3');
  assert.match(more.getAttribute('title'), /a"b<c/, '+N 悬停列出被折叠的名字');
  assert.ok(!html.includes('a"b<c'), '原文必须转义');
});

test('compactChipList：不超额时无 +N', async () => {
  const { compactChipList } = await load();
  const box = document.createElement('div');
  box.innerHTML = compactChipList({ topics: ['t1'], tags: ['g1'] });
  assert.strictEqual(box.children.length, 2);
  assert.ok(!box.querySelector('.compact-more'));
});

test('紧凑 chip CSS：block 布局让省略号生效、+N 不收缩、字号不低于 --fs-xs', () => {
  // 统一成 LF：Windows 检出（core.autocrlf）时文件是 CRLF
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const rule = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = css.match(re);
    assert.ok(m, '缺少规则 ' + sel);
    return m[1];
  };
  const chip = rule('.compact-chips .tag,\n.compact-chips .topic');
  assert.match(chip, /display:\s*block/, '.tag 基座是 inline-flex，flex 容器里 text-overflow 不生效');
  assert.match(chip, /text-overflow:\s*ellipsis/);
  assert.match(chip, /white-space:\s*nowrap/);
  assert.match(rule('.compact-chips .compact-more'), /flex:\s*0 0 auto/, '+N 不参与收缩');
  assert.doesNotMatch(css, /\.paper-list\.compact \.topic \{[^}]*font-size:\s*(9|10)(\.5)?px/, '规范 §3.3 禁止 < 11px');
});
