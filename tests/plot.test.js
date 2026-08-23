'use strict';

// 公式绘图引擎单测（public/js/core/plot.js）——纯函数，无 DOM 依赖。
// 覆盖：求值器正确性（运算符优先级/右结合幂/函数/常量/params）、安全防线（未知标识符/
// 危险语法拒绝）、采样（有限点过滤/分位截断/断段）、SVG 输出形状。

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let P;
before(async () => {
  P = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'plot.js')).href);
});

// ---------------------------------------------------------------------------
// compilePlotExpr：求值正确性
// ---------------------------------------------------------------------------

test('compilePlotExpr：四则运算与优先级', () => {
  assert.strictEqual(P.compilePlotExpr('1+2*3')(), 7);
  assert.strictEqual(P.compilePlotExpr('(1+2)*3')(), 9);
  assert.strictEqual(P.compilePlotExpr('10/4')(), 2.5);
  assert.strictEqual(P.compilePlotExpr('-3+1')(), -2); // 一元负号
  assert.strictEqual(P.compilePlotExpr('2*-3')(), -6); // 乘后一元负
});

test('compilePlotExpr：幂运算右结合，^ 是乘方不是异或', () => {
  assert.strictEqual(P.compilePlotExpr('2^3')(), 8);
  assert.strictEqual(P.compilePlotExpr('2^3^2')(), 512); // 2^(3^2)，右结合
  assert.strictEqual(P.compilePlotExpr('-2^2')(), -4); // -(2^2)：一元负号作用于 pow 之后
});

test('compilePlotExpr：函数与常量', () => {
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(approx(P.compilePlotExpr('sin(pi/2)')(), 1));
  assert.ok(approx(P.compilePlotExpr('exp(0)')(), 1));
  assert.ok(approx(P.compilePlotExpr('log(e)')(), 1)); // log = ln（数学惯例）
  assert.ok(approx(P.compilePlotExpr('sqrt(16)')(), 4));
  assert.ok(approx(P.compilePlotExpr('min(3,1,2)')(), 1)); // 多参函数
  assert.ok(approx(P.compilePlotExpr('tanh(0)')(), 0));
  assert.ok(approx(P.compilePlotExpr('abs(0-5)+floor(1.9)')(), 6));
});

test('compilePlotExpr：自变量与 params', () => {
  const f = P.compilePlotExpr('exp(-gamma*x)', { gamma: 2 });
  assert.ok(f);
  assert.ok(Math.abs(f(0) - 1) < 1e-12);
  assert.ok(Math.abs(f(1) - Math.exp(-2)) < 1e-12);
  // 非默认自变量名
  const g = P.compilePlotExpr('t^2', {}, 't');
  assert.strictEqual(g(3), 9);
});

// ---------------------------------------------------------------------------
// compilePlotExpr：安全防线（任何未知输入 → null，绝不抛出）
// ---------------------------------------------------------------------------

test('compilePlotExpr：未知标识符/危险语法一律拒绝返回 null', () => {
  const bad = [
    'alert(1)',
    'constructor',
    '__proto__',
    'x.constructor',
    'window.x',
    'foo(x)',
    '1..2',
    '1 2',
    '(1',
    '1)',
    'sin)',
    '',
    'x^',
    ',',
    'x;delete y',
    'var x = 1',
  ];
  for (const s of bad) assert.strictEqual(P.compilePlotExpr(s), null, `应拒绝: ${s}`);
});

test('compilePlotExpr：NaN/Inf 点不炸（采样期按断线处理）', () => {
  const f = P.compilePlotExpr('log(x)'); // x<=0 时 -Inf/NaN
  assert.ok(f);
  assert.ok(Number.isNaN(f(-1)) || !Number.isFinite(f(-1)));
});

// ---------------------------------------------------------------------------
// sampleCurve
// ---------------------------------------------------------------------------

test('sampleCurve：线性函数采样出单段与正确范围', () => {
  const c = P.sampleCurve((x) => 2 * x + 1, 0, 10);
  assert.ok(c);
  assert.strictEqual(c.segments.length, 1);
  assert.strictEqual(c.segments[0].length, 160);
  assert.ok(c.yLo <= 1 && c.yHi >= 21);
});

test('sampleCurve：爆点（tan 类）被分位截断 + 超界断段', () => {
  const c = P.sampleCurve(Math.tan, -2, 2, 2000); // 区间含渐近线 ±π/2
  assert.ok(c);
  // tan 在 ±π/2 处爆到 ±1e16——显示范围必须远小于真实极值（分位截断生效）
  assert.ok(Math.abs(c.yHi) < 1e6, `yHi=${c.yHi}`);
  assert.ok(c.segments.length >= 2, '渐近线两侧断段');
});

test('sampleCurve：常函数给一点高度；非法输入返回 null', () => {
  const c = P.sampleCurve(() => 5, 0, 1);
  assert.ok(c && c.yLo < 5 && c.yHi > 5);
  assert.strictEqual(
    P.sampleCurve(() => NaN, 0, 1),
    null,
  ); // 全 NaN 无有效点
  assert.strictEqual(
    P.sampleCurve((x) => x, 1, 1),
    null,
  ); // 空区间
  assert.strictEqual(
    P.sampleCurve((x) => x, 1, 0),
    null,
  ); // 倒区间
  assert.strictEqual(P.sampleCurve(null, 0, 1), null);
});

// ---------------------------------------------------------------------------
// plotSvg（组合入口）
// ---------------------------------------------------------------------------

test('plotSvg：sigmoid 产出多段 path 的 SVG；坏输入静默 null', () => {
  const svg = P.plotSvg({ variable: 'x', range: [-6, 6], params: {}, plotExpr: '1/(1+exp(-x))' });
  assert.ok(svg && svg.startsWith('<svg'), 'svg 字符串');
  assert.ok(svg.includes('<path'), '有曲线 path');
  assert.ok(svg.includes('aria-label'), '无障碍标签');
  assert.strictEqual(P.plotSvg({ variable: 'x', range: [0, 1], plotExpr: 'alert(1)' }), null);
  assert.strictEqual(P.plotSvg({ variable: 'x', range: [0, 1], plotExpr: '' }), null);
  assert.strictEqual(P.plotSvg(null), null);
});
