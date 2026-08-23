const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeCanonicalName,
  looksLikeFormula,
  normalizeLatex,
  formulaIdFor,
  normalizeFormula,
  normalizeFormulas,
  mergeFormulas,
  deleteFormula,
  removePaperFromFormulas,
  formulasToMarkdown,
  MAX_VARIABLES,
} = require('../src/core/formulas');

// ---------------------------------------------------------------- 归一化

test('looksLikeFormula：关系符/大算符/多行环境是公式，记号噪声不是（v3.27 生产噪声治理）', () => {
  // 真公式：等式/不等式/求和/积分/期望式定义/多行环境
  assert.ok(looksLikeFormula('E = mc^2'));
  assert.ok(looksLikeFormula('a^2 + b^2 = c^2'));
  assert.ok(looksLikeFormula('\\mathcal{L} \\le \\epsilon'));
  assert.ok(looksLikeFormula('L = \\sum_{i=1}^{N} \\log p_i'));
  assert.ok(looksLikeFormula('\\int_0^1 f(x) \\, dx')); // 大算符，无 = 也是公式
  assert.ok(looksLikeFormula('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}'));
  assert.ok(looksLikeFormula('x \\to y'));
  assert.ok(looksLikeFormula('s \\in \\mathcal{S}'));
  // 目标式算子（v3.50）：无关系符的 max/min 目标与 \mid 条件式也是公式（生产清理时曾误杀）
  assert.ok(looksLikeFormula('\\max_{\\pi}\\;\\mathbb{E}_{s,a}[f(s,a)]'));
  assert.ok(looksLikeFormula('\\min_{\\theta}\\; D_{\\mathrm{KL}}(p \\| q)'));
  assert.ok(looksLikeFormula('p_\\theta(a_{t+1}\\mid v_{1:t})'));
  // 生产实际噪声样本（v3.27 default 空间 678 条中的 mineru 记号片段）
  assert.ok(!looksLikeFormula('\\tau'));
  assert.ok(!looksLikeFormula('\\hat { p }'));
  assert.ok(!looksLikeFormula('f _ { t + 1 }'));
  assert.ok(!looksLikeFormula('f _ { 1 } , f _ { 2 } , \\cdots , f _ { t }'));
  assert.ok(!looksLikeFormula('( \\beta _ { 1 } , \\beta _ { 2 } )'));
  assert.ok(!looksLikeFormula('^ { 6 6 } \\mathrm { T } ^ { \\prime \\ }'));
  assert.ok(!looksLikeFormula('p .'));
  assert.ok(!looksLikeFormula('\\Gamma ^ { \\prime }'));
  // 过短/纯数字
  assert.ok(!looksLikeFormula(''));
  assert.ok(!looksLikeFormula('ab'));
  assert.ok(!looksLikeFormula('42'));
  assert.ok(!looksLikeFormula('3.14'));
});

test('normalizeCanonicalName：小写 + 空白/下划线→连字符 + 折叠 + 去首尾', () => {
  assert.strictEqual(normalizeCanonicalName('Scaled Dot Product Attention'), 'scaled-dot-product-attention');
  assert.strictEqual(normalizeCanonicalName('  KL_Divergence  '), 'kl-divergence');
  assert.strictEqual(normalizeCanonicalName('cross--entropy__loss'), 'cross-entropy-loss');
  assert.strictEqual(normalizeCanonicalName('-elbo-'), 'elbo');
  assert.strictEqual(normalizeCanonicalName(null), '');
  assert.strictEqual(normalizeCanonicalName(123), '123');
});

test('normalizeLatex：剥离各种数学环境包裹，保留裸公式体', () => {
  assert.strictEqual(normalizeLatex('$$E=mc^2$$'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('$E=mc^2$'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('\\[E=mc^2\\]'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('\\(E=mc^2\\)'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('\\begin{equation}E=mc^2\\end{equation}'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('\\begin{equation*}\nE=mc^2\n\\end{equation*}'), 'E=mc^2');
  assert.strictEqual(normalizeLatex('```latex\nE=mc^2\n```'), 'E=mc^2');
  // 嵌套包裹逐层剥
  assert.strictEqual(normalizeLatex('$$\\begin{equation}E=mc^2\\end{equation}$$'), 'E=mc^2');
  // align 环境保留（多行公式本体的一部分）
  assert.strictEqual(normalizeLatex('$$\\begin{aligned}a&=b\\end{aligned}$$'), '\\begin{aligned}a&=b\\end{aligned}');
  // 无包裹原样返回（仅 trim）
  assert.strictEqual(normalizeLatex('  E=mc^2  '), 'E=mc^2');
  assert.strictEqual(normalizeLatex(null), '');
});

test('formulaIdFor：同一归一化名稳定，前缀 fm_', () => {
  assert.strictEqual(formulaIdFor('KL Divergence'), formulaIdFor('kl-divergence'));
  assert.strictEqual(formulaIdFor('  ELBO  '), formulaIdFor('elbo'));
  assert.ok(formulaIdFor('softmax').startsWith('fm_'));
  assert.notStrictEqual(formulaIdFor('softmax'), formulaIdFor('sigmoid'));
});

test('normalizeFormula：无 canonicalName / 无 latex 一律返回 null', () => {
  assert.strictEqual(normalizeFormula(null), null);
  assert.strictEqual(normalizeFormula('str'), null);
  assert.strictEqual(normalizeFormula({ latex: 'x=1' }), null); // 缺规范名
  assert.strictEqual(normalizeFormula({ canonicalName: 'foo' }), null); // 缺 latex
  assert.strictEqual(normalizeFormula({ canonicalName: '  ', latex: 'x=1' }), null);
});

test('normalizeFormula：补默认字段 + role 白名单 + 数组兜底', () => {
  const f = normalizeFormula(
    {
      canonicalName: 'Softmax',
      latex: '$$\\sigma(z)_i=\\frac{e^{z_i}}{\\sum_j e^{z_j}}$$',
      name: ' 归一化指数函数 ',
      description: ' 把实向量映射为概率分布 ',
      variables: [
        { symbol: 'z', meaning: '输入向量', role: 'input' },
        { symbol: 'i', meaning: '分量下标', role: 'weird' }, // 非法 role → param
        { symbol: '', meaning: '空符号丢弃' },
        'not-an-object',
      ],
      plottable: 'yes', // 真值化
      plotHint: { variable: 'z', range: [-5, 5], params: { t: 1 } },
      occurrences: [{ paperId: 'p1', rawLatex: '$s_i$', context: '式(2)', symbolMap: { z: 's' } }],
      source: 'weird', // 非法 → ai
    },
    1000,
  );
  assert.strictEqual(f.id, formulaIdFor('softmax'));
  assert.strictEqual(f.canonicalName, 'softmax');
  assert.strictEqual(f.name, '归一化指数函数');
  assert.strictEqual(f.latex, '\\sigma(z)_i=\\frac{e^{z_i}}{\\sum_j e^{z_j}}');
  assert.strictEqual(f.description, '把实向量映射为概率分布');
  assert.strictEqual(f.variables.length, 2);
  assert.strictEqual(f.variables[1].role, 'param');
  assert.strictEqual(f.plottable, true);
  assert.deepStrictEqual(f.plotHint.range, [-5, 5]);
  assert.strictEqual(f.occurrences.length, 1);
  assert.deepStrictEqual(f.paperIds, ['p1']); // 由 occurrences 派生
  assert.strictEqual(f.source, 'ai');
  assert.strictEqual(f.createdAt, 1000);
  assert.strictEqual(f.updatedAt, 1000);
});

test('normalizeFormula：name 缺失时回落 canonicalName；variables 超量截断', () => {
  const many = Array.from({ length: MAX_VARIABLES + 10 }, (_, i) => ({ symbol: 'v' + i, meaning: 'm' }));
  const f = normalizeFormula({ canonicalName: 'foo-bar', latex: 'x', variables: many }, 1);
  assert.strictEqual(f.name, 'foo-bar');
  assert.strictEqual(f.variables.length, MAX_VARIABLES);
});

test('normalizeFormula：plotHint 非法结构降级为 null（v3.29 起含 plotExpr 字段与白名单）', () => {
  const mk = (h) => normalizeFormula({ canonicalName: 'c', latex: 'x', plotHint: h }, 1).plotHint;
  assert.strictEqual(mk(null), null);
  assert.strictEqual(mk('x'), null);
  assert.strictEqual(mk({ range: [1, 2] }), null); // 无 variable
  assert.strictEqual(mk({ variable: 'x', range: [1] }), null); // range 长度不对
  assert.strictEqual(mk({ variable: 'x', range: ['a', 'b'] }), null); // 非数值
  assert.deepStrictEqual(mk({ variable: 'x', range: [0, 1] }), {
    variable: 'x',
    range: [0, 1],
    params: {},
    plotExpr: '',
  });
  // plotExpr：合法保留；脏字符（白名单之外）/超长 → 置空（求值期还有语义级第二道防线）
  assert.strictEqual(mk({ variable: 'x', range: [0, 1], plotExpr: 'exp(-gamma*x)' }).plotExpr, 'exp(-gamma*x)');
  assert.strictEqual(mk({ variable: 'x', range: [0, 1], plotExpr: 'x;bad' }).plotExpr, '', '分号等脏字符被拦');
  assert.strictEqual(mk({ variable: 'x', range: [0, 1], plotExpr: 'x'.repeat(301) }).plotExpr, '', '超长被拦');
});

test('normalizeFormulas：过滤非法项 + 按 canonicalName 去重（先到先得）', () => {
  const list = normalizeFormulas(
    [
      { canonicalName: 'softmax', latex: 'a', description: '第一份' },
      null,
      { canonicalName: 'Softmax', latex: 'b', description: '第二份（重复丢弃）' },
      { canonicalName: 'elbo', latex: 'c' },
    ],
    1,
  );
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].description, '第一份');
});

// ---------------------------------------------------------------- 合并

function baseStore() {
  return {
    version: 2,
    formulas: [],
    concepts: [],
    papers: {
      p1: { id: 'p1', title: '论文一', formulaIds: [] },
      p2: { id: 'p2', title: '论文二', formulaIds: [] },
    },
  };
}

test('conceptTerms（v3.28）：归一化去空去重 + 命中已有条目取并集封顶', () => {
  const store = baseStore();
  mergeFormulas(
    store,
    [
      {
        canonicalName: 'kl-divergence',
        latex: 'A',
        conceptTerms: ['KL Divergence', 'KL Divergence', 'Variational Inference'],
      },
    ],
    'p1',
  );
  let f = store.formulas[0];
  assert.deepStrictEqual(f.conceptTerms, ['KL Divergence', 'Variational Inference'], '去重');
  // 第二篇命中同规范名：关联取并集（不同论文各连到不同概念），不丢旧关联
  mergeFormulas(store, [{ canonicalName: 'kl-divergence', latex: 'B', conceptTerms: ['ELBO'] }], 'p2');
  f = store.formulas[0];
  assert.deepStrictEqual(f.conceptTerms, ['KL Divergence', 'Variational Inference', 'ELBO'], '并集');
  // 归一化边界：非字符串/空串/超长被过滤
  const g = normalizeFormula({ canonicalName: 'x-loss', latex: 'y', conceptTerms: [42, '', 'ok', 'x'.repeat(201)] });
  assert.deepStrictEqual(g.conceptTerms, ['ok']);
  // 非数组兜底空
  assert.deepStrictEqual(
    normalizeFormula({ canonicalName: 'z-loss', latex: 'w', conceptTerms: 'KL' }).conceptTerms,
    [],
  );
});

test('mergeFormulas：首次写入新建条目并回填 occurrence/paperIds', () => {
  const store = baseStore();
  const ids = mergeFormulas(
    store,
    [
      {
        canonicalName: 'Scaled Dot-Product Attention',
        name: '缩放点积注意力',
        latex: '\\mathrm{softmax}(QK^\\top/\\sqrt{d_k})V',
        description: '注意力核心式',
        rawLatex: '\\mathrm{softmax}(QK^T/\\sqrt{d})V',
        context: '式(1)',
        symbolMap: { d_k: 'd' },
      },
    ],
    'p1',
  );
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(store.formulas.length, 1);
  const f = store.formulas[0];
  assert.strictEqual(f.canonicalName, 'scaled-dot-product-attention');
  assert.deepStrictEqual(f.paperIds, ['p1']);
  assert.strictEqual(f.occurrences.length, 1);
  assert.strictEqual(f.occurrences[0].paperId, 'p1');
  assert.strictEqual(f.occurrences[0].rawLatex, '\\mathrm{softmax}(QK^T/\\sqrt{d})V');
  assert.deepStrictEqual(f.occurrences[0].symbolMap, { d_k: 'd' });
});

test('mergeFormulas：第二篇命中同规范名 → 不新增，只追加 occurrence', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'kl-divergence', latex: 'A', description: '好解读' }], 'p1');
  const ids2 = mergeFormulas(
    store,
    [{ canonicalName: 'KL Divergence', latex: 'B', description: '粗糙解读', rawLatex: 'raw2' }],
    'p2',
  );
  assert.strictEqual(ids2.length, 0);
  assert.strictEqual(store.formulas.length, 1);
  const f = store.formulas[0];
  assert.deepStrictEqual(f.paperIds, ['p1', 'p2']);
  assert.strictEqual(f.occurrences.length, 2);
  // 规则 1：不覆盖已有 description / latex
  assert.strictEqual(f.description, '好解读');
  assert.strictEqual(f.latex, 'A');
});

test('mergeFormulas：只补空字段（已有为空时才回填）', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'elbo', latex: 'A' }], 'p1'); // 无 description/variables
  mergeFormulas(
    store,
    [{ canonicalName: 'elbo', latex: 'B', description: '证据下界', variables: [{ symbol: 'q', meaning: '变分分布' }] }],
    'p2',
  );
  const f = store.formulas[0];
  assert.strictEqual(f.latex, 'A'); // latex 已有，不覆盖
  assert.strictEqual(f.description, '证据下界'); // 原为空 → 回填
  assert.strictEqual(f.variables.length, 1); // 原为空 → 回填
});

test('mergeFormulas：同 paperId 重复抽取幂等（occurrence 覆盖而非追加）', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'softmax', latex: 'A', rawLatex: '旧' }], 'p1');
  mergeFormulas(store, [{ canonicalName: 'softmax', latex: 'A', rawLatex: '新', context: '式(7)' }], 'p1');
  const f = store.formulas[0];
  assert.strictEqual(f.occurrences.length, 1);
  assert.strictEqual(f.occurrences[0].rawLatex, '新');
  assert.strictEqual(f.occurrences[0].context, '式(7)');
  assert.deepStrictEqual(f.paperIds, ['p1']);
});

test('mergeFormulas：维持 paperIds === occurrences.map(paperId) 不变式', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'a', latex: 'x' }], 'p1');
  mergeFormulas(store, [{ canonicalName: 'a', latex: 'x' }], 'p2');
  mergeFormulas(store, [{ canonicalName: 'b', latex: 'y' }], 'p2');
  for (const f of store.formulas) {
    assert.deepStrictEqual(
      f.paperIds,
      f.occurrences.map((o) => o.paperId),
    );
  }
});

test('mergeFormulas：跳过非法项、无 paperId 也能建条目、按 canonicalName 排序', () => {
  const store = baseStore();
  const ids = mergeFormulas(
    store,
    [{ canonicalName: 'zeta', latex: 'z' }, null, { latex: '无名' }, { canonicalName: 'alpha', latex: 'a' }],
    null,
  );
  assert.strictEqual(ids.length, 2);
  assert.deepStrictEqual(
    store.formulas.map((f) => f.canonicalName),
    ['alpha', 'zeta'],
  );
  assert.deepStrictEqual(store.formulas[0].paperIds, []);
});

test('mergeFormulas：items 为空/非数组安全返回空数组', () => {
  const store = baseStore();
  assert.deepStrictEqual(mergeFormulas(store, null, 'p1'), []);
  assert.deepStrictEqual(mergeFormulas(store, [], 'p1'), []);
  assert.strictEqual(store.formulas.length, 0);
});

// ---------------------------------------------------------------- 删除

test('deleteFormula：移除条目并清理 paper.formulaIds', () => {
  const store = baseStore();
  const [id] = mergeFormulas(store, [{ canonicalName: 'ppo-clip', latex: 'x' }], 'p1');
  store.papers.p1.formulaIds = [id];
  assert.strictEqual(deleteFormula(store, id), true);
  assert.strictEqual(store.formulas.length, 0);
  assert.deepStrictEqual(store.papers.p1.formulaIds, []);
  assert.strictEqual(deleteFormula(store, id), false); // 已删
});

test('removePaperFromFormulas：删论文清 occurrence；occurrence 空则整条删除', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'shared', latex: 'x' }], 'p1');
  mergeFormulas(store, [{ canonicalName: 'shared', latex: 'x' }], 'p2');
  mergeFormulas(store, [{ canonicalName: 'lonely', latex: 'y' }], 'p1');
  removePaperFromFormulas(store, 'p1');
  assert.deepStrictEqual(
    store.formulas.map((f) => f.canonicalName),
    ['shared'],
  );
  const f = store.formulas[0];
  assert.deepStrictEqual(f.paperIds, ['p2']);
  assert.strictEqual(f.occurrences.length, 1);
});

test('removePaperFromFormulas：不存在的 paperId 是 no-op', () => {
  const store = baseStore();
  mergeFormulas(store, [{ canonicalName: 'a', latex: 'x' }], 'p1');
  removePaperFromFormulas(store, 'nope');
  assert.strictEqual(store.formulas.length, 1);
});

// ---------------------------------------------------------------- 导出

test('formulasToMarkdown：空清单给占位文案', () => {
  const md = formulasToMarkdown({ formulas: [], papers: {} });
  assert.match(md, /# 公式清单/);
  assert.match(md, /暂无公式/);
});

test('formulasToMarkdown：渲染公式块、解读、符号表与出处论文标题', () => {
  const store = baseStore();
  mergeFormulas(
    store,
    [
      {
        canonicalName: 'softmax',
        name: '归一化指数函数',
        latex: '\\sigma(z)',
        description: '映射为概率分布',
        variables: [{ symbol: 'z', meaning: '输入向量', role: 'input' }],
        rawLatex: '\\mathrm{sm}(z)',
      },
    ],
    'p1',
  );
  const md = formulasToMarkdown(store);
  assert.match(md, /## 归一化指数函数/);
  assert.match(md, /softmax/);
  assert.match(md, /\$\$\n\\sigma\(z\)\n\$\$/);
  assert.match(md, /映射为概率分布/);
  assert.match(md, /\| `z` \| 输入向量 \|/);
  assert.match(md, /论文一/);
});
