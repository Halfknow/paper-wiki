'use strict';

// renderMd 数学公式管线单测（public/js/core/markdown.js）——v3.53 修复的回归锁定。
//
// 背景：旧管线先跑 marked/DOMPurify 再抽 $…$ 喂 KaTeX，公式源被污染（< > 实体化、
// \{ \_ 被 CommonMark 转义吃掉、_ 配成 <em>、多行 $$ 插 <br>），生产 177 篇总结
// 曾 107 处红字。现管线：protectMath 在 marked 前占位 → sanitize → 原始 LaTeX 回填。
// 本文件保持快套件：不 require jsdom，DOMPurify 用恒等桩（保护/回填逻辑不依赖它）。

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let M;
before(async () => {
  // vendor 全局（浏览器由 index.html 注入；chat-ui.test.js 同款装法）
  globalThis.marked = require('marked').marked;
  globalThis.DOMPurify = { sanitize: (x) => x };
  globalThis.katex = require('katex');
  M = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'markdown.js')).href);
});

const noRed = (html) => assert.ok(!/katex-error/.test(html), '不应有红字公式: ' + html.slice(0, 300));
const noPh = (html) => assert.ok(!/pwMth/.test(html), '占位符不应残留: ' + html.slice(0, 300));

// ---------------------------------------------------------------------------
// protectMath：提取 / 跳过 / 转义
// ---------------------------------------------------------------------------

test('protectMath：常规 $…$ / $$…$$ 提取，tex 为原始 LaTeX', () => {
  const { text, spans } = M.protectMath('前 $a<b$ 中\n\n$$x \\{ y \\}$$ 后');
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(spans[0].tex, 'a<b');
  assert.strictEqual(spans[0].display, false);
  assert.strictEqual(spans[1].tex, 'x \\{ y \\}');
  assert.strictEqual(spans[1].display, true);
  assert.ok(!text.includes('$'));
});

test('protectMath：多行 display 公式整体提取（含换行与 \\\\）', () => {
  const md = '$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$';
  const { spans } = M.protectMath(md);
  assert.strictEqual(spans.length, 1);
  assert.ok(spans[0].tex.includes('\n'));
});

test('protectMath：行内码与 fenced code 里的 $ 是字面量，不提取', () => {
  const md = '行内 `$x_1$` 不渲染\n\n```latex\n$y_2$\n```\n正文 $z$ 尾';
  const { spans } = M.protectMath(md);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].tex, 'z');
});

test('protectMath：\\$ 转义与不成对的 $ 保持字面量', () => {
  const { spans, text } = M.protectMath('价格 \\$5 与 \\$10，孤例 $ 井号');
  assert.strictEqual(spans.length, 0);
  assert.ok(text.includes('\\$5'));
});

test('protectMath：公式跨入行内码边界不成对（数学不吞代码）', () => {
  const md = 'a $x`code`y$ b';
  const { spans } = M.protectMath(md);
  assert.strictEqual(spans.length, 0);
});

// ---------------------------------------------------------------------------
// renderMd：真实失败模式回归（均曾红显于生产总结）
// ---------------------------------------------------------------------------

test('renderMd：含 < > 的比较式（旧管线 &lt; 实体化致红）', () => {
  const html = M.renderMd('$MIWV > 0$ 且 $i<j$ 与 $K(\\omega) <^+ K(p)$');
  noRed(html);
  noPh(html);
  assert.ok((html.match(/class="katex"/g) || []).length === 3);
});

test('renderMd：x_{<t} 记号（旧管线 < 配 _ 成 <em> 致红）', () => {
  const html = M.renderMd('自回归 $P(x_t \\mid x_{<t})$，另一处 $h_{<t}$ 也渲染');
  noRed(html);
  noPh(html);
  assert.ok((html.match(/class="katex"/g) || []).length === 2);
});

test('renderMd：\\{ \\_ 转义保留（旧管线被 CommonMark 反斜杠转义吃掉致红）', () => {
  const html = M.renderMd('集合 $\\{a, b\\}$ 与 $a\\_b$');
  noRed(html);
  noPh(html);
  assert.ok((html.match(/class="katex"/g) || []).length === 2);
});

test('renderMd：多行 aligned display（旧管线被插 <br> 致红）', () => {
  const md = '## 公式\n\n$$\nJ_{\\theta} = \\mathbb{E}\\left[ r_t \\right]\n$$';
  const html = M.renderMd(md);
  noRed(html);
  noPh(html);
  assert.ok(html.includes('katex-display'));
});

test('renderMd：代码块里的 $ 保持字面量（不出 KaTeX）', () => {
  const html = M.renderMd('`$x_1$` 与\n\n```\n$y_2$\n```');
  assert.ok(!html.includes('class="katex"'));
  assert.ok(html.includes('$x_1$'));
});

test('renderMd：公式内的 ** 不再被 marked 吃掉', () => {
  const html = M.renderMd('$a * b * c$ 卷积');
  noRed(html);
  noPh(html);
});

// ---------------------------------------------------------------------------
// renderTex：双下标/双上标自动修复 + 降级
// ---------------------------------------------------------------------------

test('renderTex：h_d_i 双下标自动修复（生产真实案例）', () => {
  const tex = 'e^{h_q \\cdot h_d_i}';
  const html = M.renderTex(tex, false);
  noRed(html);
  assert.ok(html.includes('class="katex"'));
});

test('renderTex：x^a^b 双上标自动修复', () => {
  const html = M.renderTex('x^a^b', false);
  noRed(html);
  assert.ok(html.includes('class="katex"'));
});

test('renderTex：正常输入不进修复路径（幂等）', () => {
  const html = M.renderTex('\\frac{a}{b} < 1', true);
  noRed(html);
  assert.ok(html.includes('katex-display'));
});

test('renderTex：无 katex 全局时回退转义 code（不注入 HTML）', () => {
  const k = globalThis.katex;
  globalThis.katex = undefined;
  try {
    const html = M.renderTex('<script>x</script>', false);
    assert.ok(html.startsWith('<code>'));
    assert.ok(!html.includes('<script>'));
  } finally {
    globalThis.katex = k;
  }
});
