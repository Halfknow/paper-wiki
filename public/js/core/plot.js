// 公式绘图引擎（v3.29）：把 plotHint.plotExpr（模型/人工给出的数学表达式）变成公式卡上的
// 函数曲线 SVG。零依赖、纯函数、可独立单测。
//
// 安全模型（为什么不用 eval/Function）：
//   tokenizer 只产出白名单 token（数字/标识符/运算符/括号/逗号），解析器对任何未知标识符、
//   语法错误直接抛错；求值阶段只有算术运算与固化的纯函数表——不存在属性访问、任意调用、
//   或把字符串当代码执行的路径。plotExpr 经后端 normalizePlotHint 的字符集白名单预过滤，
//   这里再做语义级校验，双层防线。
//
// 语法：y = f(x) 型表达式。支持 + - * / ^（幂，右结合）、一元负号、括号、函数调用、
//   常量 pi/e；自变量名来自 plotHint.variable（通常是 x），其余标识符查 plotHint.params。

/** 白名单函数表（求值期固化，模型/用户无法注入新名字）。 */
const FN = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  log: Math.log, // 自然对数（数学惯例）
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: { arity: [2, 8], fn: (...a) => Math.min(...a) },
  max: { arity: [2, 8], fn: (...a) => Math.max(...a) },
};

// ---- tokenizer ----

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i, dots = 0;
      while (j < n && /[0-9.]/.test(src[j])) { if (src[j] === '.') dots++; j++; }
      if (dots > 1) throw new Error('bad number');
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error('bad number');
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z_0-9]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      tokens.push({ t: c });
      i++;
      continue;
    }
    throw new Error('bad char ' + c);
  }
  return tokens;
}

// ---- 递归下降 parser → AST ----
// expr := add ; add := mul (('+'|'-') mul)* ; mul := unary (('*'|'/') unary)*
// unary := ('-'|'+') unary | pow ; pow := atom ('^' unary)?   （右结合）
// atom := num | '(' expr ')' | id | id '(' expr (',' expr)* ')'

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t) throw new Error('expect ' + t);
    pos++;
    return tok;
  };
  const atom = () => {
    const tok = peek();
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'num') { pos++; return { k: 'num', v: tok.v }; }
    if (tok.t === '(') { pos++; const e = add(); eat(')'); return e; }
    if (tok.t === 'id') {
      pos++;
      if (peek() && peek().t === '(') {
        pos++;
        const args = [add()];
        while (peek() && peek().t === ',') { pos++; args.push(add()); }
        eat(')');
        return { k: 'call', name: tok.v, args };
      }
      return { k: 'var', name: tok.v };
    }
    throw new Error('unexpected ' + tok.t);
  };
  const pow = () => {
    const base = atom();
    if (peek() && peek().t === '^') { pos++; return { k: 'bin', op: '^', l: base, r: unary() }; }
    return base;
  };
  const unary = () => {
    const tok = peek();
    if (tok && (tok.t === '-' || tok.t === '+')) {
      pos++;
      const e = unary();
      return tok.t === '-' ? { k: 'neg', e } : e;
    }
    return pow();
  };
  const mul = () => {
    let l = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = tokens[pos++].t;
      l = { k: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const add = () => {
    let l = mul();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[pos++].t;
      l = { k: 'bin', op, l, r: mul() };
    }
    return l;
  };
  const ast = add();
  if (pos !== tokens.length) throw new Error('trailing tokens');
  return ast;
}

function evaluate(node, scope) {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': {
      if (!(node.name in scope)) throw new Error('unknown ident ' + node.name);
      return scope[node.name];
    }
    case 'neg': return -evaluate(node.e, scope);
    case 'bin': {
      const l = evaluate(node.l, scope);
      const r = evaluate(node.r, scope);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') return l / r;
      return Math.pow(l, r); // '^'
    }
    case 'call': {
      const entry = FN[node.name];
      if (!entry) throw new Error('unknown fn ' + node.name);
      const arity = entry.arity || [1, 1];
      if (node.args.length < arity[0] || node.args.length > arity[1]) throw new Error('bad arity ' + node.name);
      const fn = entry.fn || entry;
      return fn(...node.args.map((a) => evaluate(a, scope)));
    }
    default: throw new Error('bad node');
  }
}

/** 编译表达式 → f(x)。任何错误（未知标识符/语法/求值非有限）返回 null。
 *  @param {string} expr 表达式，自变量固定名为 varName
 *  @param {object} params 其余符号取值 {name: number}
 *  @param {string} varName 自变量名（plotHint.variable，默认 'x'） */
export function compilePlotExpr(expr, params = {}, varName = 'x') {
  let ast;
  try {
    ast = parse(tokenize(String(expr || '')));
  } catch {
    return null;
  }
  // scope 用无原型对象：`'constructor' in {}` 这类原型链命中必须杜绝——
  // 未知标识符（含 Object.prototype 上的名字）一律按解析失败拒绝
  const base = Object.create(null);
  base.pi = Math.PI;
  base.e = Math.E;
  for (const [k, v] of Object.entries(params || {})) {
    const num = Number(v);
    if (Number.isFinite(num)) base[k] = num;
  }
  const makeScope = (x) => {
    const scope = Object.assign(Object.create(null), base);
    scope[varName] = x;
    return scope;
  };
  // 预检：试求一次，未知标识符/求值异常立即拒绝（NaN/Inf 允许——采样时按断线处理）
  try {
    evaluate(ast, makeScope(1));
  } catch {
    return null;
  }
  return (x) => {
    try {
      return evaluate(ast, makeScope(x));
    } catch {
      return NaN;
    }
  };
}

/** 采样曲线：等距取 n 点，收集有限值点；y 显示范围用 2%~98% 分位（防 tan 类爆点压扁全图）。
 *  超出显示范围的点按断线处理（段落切分）。返回 {segments, xLo, xHi, yLo, yHi} 或 null。 */
export function sampleCurve(f, lo, hi, n = 160) {
  if (typeof f !== 'function' || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || n < 2) return null;
  const pts = [];
  const step = (hi - lo) / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = lo + i * step;
    const y = f(x);
    if (Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 2) return null;
  const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const at = (q) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
  let yLo = at(0.02);
  let yHi = at(0.98);
  if (yLo === yHi) { yLo -= 1; yHi += 1; } // 常函数给一点高度
  const span = yHi - yLo;
  yLo -= span * 0.06;
  yHi += span * 0.06;
  // 段落切分：y 出界即断线（含 NaN 由 pts 过滤自然断开）
  const segments = [];
  let cur = [];
  for (const [x, y] of pts) {
    if (y >= yLo && y <= yHi) cur.push([x, y]);
    else if (cur.length) { segments.push(cur); cur = []; }
  }
  if (cur.length) segments.push(cur);
  const kept = segments.filter((s) => s.length >= 2);
  if (!kept.length) return null;
  return { segments: kept, xLo: lo, xHi: hi, yLo, yHi };
}

/** 数值的紧凑展示（轴刻度用）：3 位有效数字，过大/过小走科学计数。 */
function fmtNum(v) {
  if (!Number.isFinite(v)) return '∞';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
  return String(Math.round(v * 1000) / 1000);
}

/** 组合入口：plotHint → 曲线 SVG 字符串。编译/采样任一失败返回 null（调用方静默降级）。 */
export function plotSvg(plotHint, w = 480, h = 150) {
  if (!plotHint || typeof plotHint !== 'object') return null;
  const variable = String(plotHint.variable || 'x') || 'x';
  const f = compilePlotExpr(plotHint.plotExpr, plotHint.params, variable);
  if (!f) return null;
  const range = plotHint.range;
  const curve = sampleCurve(f, Number(range && range[0]), Number(range && range[1]));
  if (!curve) return null;
  const padL = 10, padR = 10, padT = 10, padB = 18;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const px = (x) => padL + ((x - curve.xLo) / (curve.xHi - curve.xLo)) * iw;
  const py = (y) => padT + (1 - (y - curve.yLo) / (curve.yHi - curve.yLo)) * ih;
  const paths = curve.segments
    .map((seg) => seg.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(''))
    .join('');
  // 零线（y=0 在视野内时画出，帮助读形）
  const zeroY = py(0);
  const zeroLine =
    zeroY >= padT && zeroY <= padT + ih
      ? `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w - padR}" y2="${zeroY.toFixed(1)}" class="zp" />`
      : '';
  return (
    `<svg viewBox="0 0 ${w} ${h}" class="fc-plot-svg" role="img" aria-label="函数曲线 ${variable} ∈ [${fmtNum(curve.xLo)}, ${fmtNum(curve.xHi)}]">` +
    `<rect x="${padL}" y="${padT}" width="${iw}" height="${ih}" class="zb" />${zeroLine}` +
    `<path d="${paths}" class="zc" />` +
    `<text x="${padL}" y="${h - 5}" class="zt">${fmtNum(curve.xLo)}</text>` +
    `<text x="${w - padR}" y="${h - 5}" text-anchor="end" class="zt">${fmtNum(curve.xHi)}</text>` +
    `<text x="${padL + 2}" y="${padT + 9}" class="zt">${fmtNum(curve.yHi)}</text>` +
    `<text x="${padL + 2}" y="${padT + ih}" class="zt">${fmtNum(curve.yLo)}</text>` +
    `<text x="${w - padR}" y="${padT + 9}" text-anchor="end" class="zt ztv">${variable}</text>` +
    `</svg>`
  );
}
