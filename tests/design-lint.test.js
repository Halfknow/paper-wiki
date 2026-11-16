'use strict';

// 设计规范护栏（docs/DESIGN_SYSTEM.md §9.4）：纯文本扫描，毫秒级，进快速套件。
//
// 两类规则：
//   · 硬约束（HARD）：必须为 0，出现即失败。
//   · 棘轮（RATCHET）：记录当前违规数为基线，只许减不许增。计数下降时本测试同样失败，
//     提示把 BASELINE 改成新值——这样每一次改进都会被锁住，不会悄悄回退。
//
// 范围：public/ 下自有 CSS（tokens.css 是唯一允许写原始色值的地方，排除）与自有 JS / index.html
// （vendor/ 排除）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');

function walk(dir, exts, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'vendor' || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(ent.name))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(PUB, p).replace(/\\/g, '/');

const CSS_FILES = walk(PUB, ['.css']).filter((p) => rel(p) !== 'tokens.css');
const JS_FILES = walk(PUB, ['.js', '.mjs']);
const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** 粗略剥离 JS 注释（块注释 + 整行 // 注释）。只服务于计数，不追求语法级精确。 */
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 遍历 CSS 声明（只看最内层 {…} 的 body，选择器里的 #id / :hover 不会被误算）。 */
function* cssDecls(css) {
  const body = /\{([^{}]*)\}/g;
  let m;
  while ((m = body.exec(css))) {
    const decl = /([a-zA-Z-]+)\s*:\s*([^;]+)/g;
    let d;
    while ((d = decl.exec(m[1]))) yield { prop: d[1].toLowerCase(), value: d[2].trim() };
  }
}

// ---------------------------------------------------------------- 计数器

const metrics = {};
function count(name, fn) {
  metrics[name] = fn();
  return metrics[name];
}

const cssAll = CSS_FILES.map((f) => ({ file: rel(f), css: stripCssComments(fs.readFileSync(f, 'utf8')) }));
const jsAll = JS_FILES.map((f) => ({ file: rel(f), src: stripJsComments(fs.readFileSync(f, 'utf8')) }));

// 原始色值：#hex / rgb(数字…) / rgba(数字…) / hsl(…)。rgba(var(--ink), .1) 这种派生写法不算。
const COLOR_LIT = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/g;
count('css.colorLiteral', () => {
  let n = 0;
  for (const { css } of cssAll) for (const { value } of cssDecls(css)) n += (value.match(COLOR_LIT) || []).length;
  return n;
});

// 半像素字号（9.5px / 12.5px …）：CJK 字体在 Windows 下没有对应 hinting
count('css.halfPxFontSize', () => {
  let n = 0;
  for (const { css } of cssAll)
    for (const { prop, value } of cssDecls(css)) {
      if (prop === 'font-size' && /^\d+\.\d+px/.test(value)) n++;
      if (prop === 'font' && /(^|\s)\d+\.\d+px/.test(value)) n++;
    }
  return n;
});

// 字号未走 --fs-* token（px 字面量）
count('css.rawFontSizePx', () => {
  let n = 0;
  for (const { css } of cssAll)
    for (const { prop, value } of cssDecls(css)) if (prop === 'font-size' && /^\d+(\.\d+)?px/.test(value)) n++;
  return n;
});

// z-index：只能是 var(--z-*)（可 calc 偏移）、0/auto，或局部 1–9
const zBad = [];
count('css.zIndexLiteral', () => {
  for (const { file, css } of cssAll)
    for (const { prop, value } of cssDecls(css)) {
      if (prop !== 'z-index') continue;
      const v = value.replace(/\s*!important$/, '');
      if (/var\(--z-[a-z]+\)/.test(v) || /^(auto|0|[1-9]|-1)$/.test(v)) continue;
      zBad.push(`${file}: z-index:${v}`);
    }
  return zBad.length;
});

// 断点只允许 1240 / 1100 / 860（P2 收敛前先棘轮）
const MEDIA_OK = new Set(['1240', '1100', '860']);
count('css.offScaleMedia', () => {
  let n = 0;
  for (const { css } of cssAll) {
    const re = /@media[^{]*?\((?:max|min)-width\s*:\s*(\d+)px\)/g;
    let m;
    while ((m = re.exec(css))) if (!MEDIA_OK.has(m[1])) n++;
  }
  return n;
});

// 关键帧数量（规范 §3.8：收敛到 pw-* 共享关键帧，最终只在 base.css 定义）
count('css.keyframes', () => cssAll.reduce((n, { css }) => n + (css.match(/@keyframes\s+[\w-]+/g) || []).length, 0));

// 原生弹窗
const nativeDlg = [];
count('js.nativeDialog', () => {
  for (const { file, src } of jsAll) {
    const re = /\bwindow\.(confirm|alert|prompt)\s*\(|(?<![.\w$])(confirm|alert|prompt)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      // 排除本地函数定义 / 方法名（function confirm(…)、confirm: (…) 、.confirm(…)）
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      if (/function\s+$/.test(before)) continue;
      nativeDlg.push(`${file}: ${m[0]}`);
    }
  }
  return nativeDlg.length;
});

// emoji / 字符图标（UI 统一用细线 SVG）
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}]|\u{FE0F}/gu;
count('ui.emoji', () => {
  let n = 0;
  for (const { src } of jsAll) n += (src.match(EMOJI) || []).length;
  n += (HTML.replace(/<!--[\s\S]*?-->/g, '').match(EMOJI) || []).length;
  return n;
});

// 内联 style 写死色值（style="color:#…"、el.style.color = 'rgba(…)'）
count('ui.inlineStyleColor', () => {
  const attr = /style\s*=\s*(["'`])[^"'`]*?(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)[^"'`]*?\1/g;
  const prop = /\.style\.(?:color|background|backgroundColor|borderColor)\s*=\s*['"`](#|rgba?\(\s*\d)/g;
  let n = (HTML.match(attr) || []).length;
  for (const { src } of jsAll) n += (src.match(attr) || []).length + (src.match(prop) || []).length;
  return n;
});

// 仅图标按钮缺 aria-label（title 不等于可访问名称）
count('html.iconButtonNoLabel', () => {
  let n = 0;
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(HTML))) {
    const attrs = m[1];
    const text = m[2]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text && !/aria-label(ledby)?\s*=/.test(attrs)) n++;
  }
  return n;
});

// ---------------------------------------------------------------- 基线

const HARD = ['css.zIndexLiteral', 'js.nativeDialog'];

// 只许减不许增。降下来后把这里改成新值（测试会提示）。基线取自 v3.63 P0 落地时。
const BASELINE = {
  'css.colorLiteral': 296, //       P1：暗色补丁与散落字面量逐步收进 tokens.css
  'css.halfPxFontSize': 127, //     P1：字号归一到 --fs-*（规范 §3.3 映射表）
  'css.rawFontSizePx': 466, //      P1/P2：px 字号改 --fs-*
  'css.offScaleMedia': 2, //        P2：断点收敛到 1240 / 1100 / 860，届时改硬约束
  'css.keyframes': 40, //           P3：收敛到 pw-* 共享关键帧
  'ui.emoji': 21, //                P1：换细线 SVG 图标
  'ui.inlineStyleColor': 7, //      P1
  'html.iconButtonNoLabel': 14, //  P1：补 aria-label
};

// ---------------------------------------------------------------- 断言

test('design-lint 硬约束：z-index 只用 --z-* token 或局部 1–9', () => {
  assert.deepStrictEqual(zBad, [], '出现裸 z-index（请用 tokens.css 的 --z-* 层级）');
});

test('design-lint 硬约束：不用浏览器原生 confirm / alert / prompt（走 PWDialog）', () => {
  assert.deepStrictEqual(nativeDlg, [], '出现原生弹窗调用');
});

test('design-lint 硬约束：role="dialog" 必须带 aria-modal 与 aria-labelledby / aria-label', () => {
  const bad = [];
  const re = /<[a-z]+\b[^>]*\brole\s*=\s*"dialog"[^>]*>/g;
  let m;
  while ((m = re.exec(HTML))) {
    const tag = m[0];
    if (!/aria-modal\s*=\s*"true"/.test(tag) || !/aria-label(ledby)?\s*=/.test(tag)) bad.push(tag.slice(0, 120));
  }
  assert.deepStrictEqual(bad, []);
});

test('design-lint 硬约束：每个 .modal 模态都声明 role="dialog"', () => {
  const bad = (HTML.match(/<div class="modal(?:\s[^"]*)?"[^>]*>/g) || []).filter((t) => !/role="dialog"/.test(t));
  assert.ok((HTML.match(/<div class="modal(?:\s[^"]*)?"/g) || []).length >= 5, '前置：能扫到 .modal 容器');
  assert.deepStrictEqual(bad, []);
});

test('design-lint 硬约束：tokens.css 在 styles.css 之前加载，且定义了全部层级 token', () => {
  const iTok = HTML.indexOf('href="/tokens.css"');
  const iSty = HTML.indexOf('href="/styles.css"');
  assert.ok(iTok > 0 && iTok < iSty, 'tokens.css 必须先于 styles.css');
  const tokens = fs.readFileSync(path.join(PUB, 'tokens.css'), 'utf8');
  for (const t of [
    '--z-chrome',
    '--z-view',
    '--z-dropdown',
    '--z-drawer',
    '--z-modal',
    '--z-dialog',
    '--z-toast',
    '--font-mono',
    '--scrim',
    '--dur-fast',
  ])
    assert.match(tokens, new RegExp(t + '\\s*:'), `tokens.css 缺少 ${t}`);
  // 组件 CSS 引用到的 --z-* 必须都已定义
  for (const { css } of cssAll)
    for (const [, name] of css.matchAll(/var\((--z-[a-z]+)\)/g))
      assert.match(tokens, new RegExp(name + '\\s*:'), `未定义 ${name}`);
});

for (const [name, base] of Object.entries(BASELINE)) {
  test(`design-lint 棘轮：${name} 不超过基线 ${base}`, () => {
    const n = metrics[name];
    assert.ok(
      n <= base,
      `${name} = ${n}，超过基线 ${base}：新代码引入了违规，请改用 token / 组件（docs/DESIGN_SYSTEM.md）`,
    );
    assert.ok(
      n === base,
      `${name} 已降到 ${n}（基线 ${base}）——干得好，请把 tests/design-lint.test.js 的 BASELINE['${name}'] 改成 ${n} 锁住进度`,
    );
  });
}

test('design-lint：硬约束与棘轮覆盖全部计数器', () => {
  for (const k of Object.keys(metrics)) assert.ok(HARD.includes(k) || k in BASELINE, `计数器 ${k} 未登记`);
});
