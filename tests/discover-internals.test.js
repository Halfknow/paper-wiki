const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_WEIGHTS,
  normalizePlan,
  tokenSet,
  authorityScore,
  recencyScore,
  scoreOne,
  arxivIdFromDoi,
  toResult,
} = require('../src/services/discover');

// ---------------- normalizePlan ----------------

test('normalizePlan: 合法计划原样通过（queries 截 3、query 取首条）', () => {
  const plan = normalizePlan(
    {
      queries: ['ti:"a"', 'abs:"b"', 'cat:"c"', 'ti:"d"', 'ti:"e"'],
      categories: ['cs.CL'],
      keyterms: ['moe'],
      note: '说明',
    },
    '主题',
  );
  assert.strictEqual(plan.queries.length, 3, 'queries 最多保留 3 条');
  assert.deepStrictEqual(plan.queries, ['ti:"a"', 'abs:"b"', 'cat:"c"']);
  assert.strictEqual(plan.query, 'ti:"a"', 'query 为首条，向后兼容');
  assert.deepStrictEqual(plan.categories, ['cs.CL']);
  assert.deepStrictEqual(plan.keyterms, ['moe']);
  assert.strictEqual(plan.note, '说明');
});

test('normalizePlan: 缺失字段给默认值（categories=[]、keyterms=主题兜底、note 默认文案）', () => {
  const plan = normalizePlan({ queries: ['ti:"x"'] }, '深度学习');
  assert.deepStrictEqual(plan.categories, []);
  assert.deepStrictEqual(plan.keyterms, ['深度学习'], 'claude 没给关键词时用主题兜底');
  assert.strictEqual(plan.note, 'claude 已生成检索式');
});

test('normalizePlan: 兼容旧形态 {query, note}', () => {
  const plan = normalizePlan({ query: '  ti:"rag"  ', note: '旧格式' }, 't');
  assert.deepStrictEqual(plan.queries, ['ti:"rag"'], 'query 应 trim 并包成数组');
  assert.strictEqual(plan.query, 'ti:"rag"');
  assert.strictEqual(plan.note, '旧格式');
});

test('normalizePlan: queries/categories/keyterms 数组净化（去空串、去非字符串、trim）', () => {
  const plan = normalizePlan(
    {
      queries: ['  a  ', '', '   ', 42, null, 'b'],
      categories: [' cs.CL ', 7, ''],
      keyterms: [' k1 ', undefined, 'k2'],
    },
    't',
  );
  assert.deepStrictEqual(plan.queries, ['a', 'b']);
  assert.deepStrictEqual(plan.categories, ['cs.CL']);
  assert.deepStrictEqual(plan.keyterms, ['k1', 'k2']);
});

test('normalizePlan: 非法输入返回 null（上层回退）', () => {
  assert.strictEqual(normalizePlan(null, 't'), null);
  assert.strictEqual(normalizePlan(undefined, 't'), null);
  assert.strictEqual(normalizePlan('ti:"x"', 't'), null, '字符串不是对象');
  assert.strictEqual(normalizePlan({}, 't'), null, '既无 queries 也无 query');
  assert.strictEqual(normalizePlan({ queries: [] }, 't'), null, '空 queries');
  assert.strictEqual(normalizePlan({ queries: ['', '  '] }, 't'), null, '净化后为空');
  assert.strictEqual(normalizePlan({ query: '   ' }, 't'), null, 'query 全空白');
});

// ---------------- authorityScore ----------------

test('authorityScore: 边界值（0 引用→0，负数→0，非数字→0，999→1，超大封顶 1）', () => {
  assert.strictEqual(authorityScore(0), 0, '0 引用 → log10(1)/3 = 0');
  assert.strictEqual(authorityScore(-5), 0, '负数 → 0');
  assert.strictEqual(authorityScore('100'), 0, '非数字 → 0');
  assert.strictEqual(authorityScore(undefined), 0);
  assert.strictEqual(authorityScore(999), 1, '999 引用 → log10(1000)/3 = 1');
  assert.strictEqual(authorityScore(1e9), 1, '超大引用量封顶为 1');
});

test('authorityScore: log 压缩单调递增', () => {
  const a = authorityScore(9); // log10(10)/3 = 1/3
  assert.ok(Math.abs(a - 1 / 3) < 1e-9);
  assert.ok(authorityScore(10) < authorityScore(100));
  assert.ok(authorityScore(100) < authorityScore(500));
});

// ---------------- recencyScore ----------------

test('recencyScore: 边界值（今年→1，窗口边缘→0，超窗→0，未来→1，缺年份→0）', () => {
  assert.strictEqual(recencyScore(2026, 2026, 8), 1, '今年 → 1');
  assert.strictEqual(recencyScore(2018, 2026, 8), 0, '恰好窗口年 → 0');
  assert.strictEqual(recencyScore(2010, 2026, 8), 0, '超出窗口 → 0');
  assert.strictEqual(recencyScore(2030, 2026, 8), 1, '未来年份 age 截断为 0 → 1');
  assert.strictEqual(recencyScore(null, 2026, 8), 0, '缺年份 → 0');
  assert.strictEqual(recencyScore('abc', 2026, 8), 0, '非法年份 → 0');
  assert.strictEqual(recencyScore('2024', 2026, 8), 0.75, '字符串年份可解析：1 - 2/8');
});

test('recencyScore: 随年份单调不减', () => {
  assert.ok(recencyScore(2020, 2026, 8) < recencyScore(2023, 2026, 8));
  assert.ok(recencyScore(2023, 2026, 8) < recencyScore(2026, 2026, 8));
});

// ---------------- scoreOne 权重分配 ----------------

test('scoreOne: rel=1 其余为 0 → 纯相关度分', () => {
  const r = { relevance: 0.8, citationCount: 1e9, year: 2026 };
  const s = scoreOne(r, { weights: { rel: 1, auth: 0, rec: 0 }, nowYear: 2026, recencyWindowYears: 8 });
  assert.strictEqual(s, 0.8, '高引用/新年份不应影响纯相关度权重');
});

test('scoreOne: auth=1 其余为 0 → 纯权威分', () => {
  const r = { relevance: 0.123, citationCount: 999, year: 1990 };
  const s = scoreOne(r, { weights: { rel: 0, auth: 1, rec: 0 }, nowYear: 2026, recencyWindowYears: 8 });
  assert.strictEqual(s, 1);
});

test('scoreOne: rec=1 其余为 0 → 纯新近分', () => {
  const r = { relevance: 0.9, citationCount: 1e9, year: 2024 };
  const s = scoreOne(r, { weights: { rel: 0, auth: 0, rec: 1 }, nowYear: 2026, recencyWindowYears: 8 });
  assert.strictEqual(s, 0.75);
});

test('scoreOne: relevance 缺省按 0 计；默认权重加总合理', () => {
  const s = scoreOne(
    { citationCount: 0, year: 2000 },
    { weights: DEFAULT_WEIGHTS, nowYear: 2026, recencyWindowYears: 8 },
  );
  assert.strictEqual(s, 0, '无 relevance/引用/新年份 → 0');
});

// ---------------- arxivIdFromDoi ----------------

test('arxivIdFromDoi: arXiv DOI 各变体 → id', () => {
  assert.strictEqual(arxivIdFromDoi('10.48550/arXiv.2401.12345'), '2401.12345', '大小写不敏感');
  assert.strictEqual(arxivIdFromDoi('https://doi.org/10.48550/arxiv.2401.12345'), '2401.12345');
  assert.strictEqual(arxivIdFromDoi('10.48550/arxiv.2401.1234'), '2401.1234', '4 位序号也可');
});

test('arxivIdFromDoi: 非 arXiv DOI / 空值 → null', () => {
  assert.strictEqual(arxivIdFromDoi('10.1000/xyz123'), null);
  assert.strictEqual(arxivIdFromDoi(''), null);
  assert.strictEqual(arxivIdFromDoi(null), null);
  assert.strictEqual(arxivIdFromDoi(undefined), null);
  assert.strictEqual(arxivIdFromDoi('10.48550/arxiv.cs/0301001'), null, '旧式分类编号不匹配');
});

// ---------------- tokenSet ----------------

test('tokenSet: 拉丁文本小写化、去标点、按空白分词', () => {
  const s = tokenSet('Deep Learning, Models!');
  assert.deepStrictEqual([...s].sort(), ['deep', 'learning', 'models']);
});

test('tokenSet: CJK 不做字内切分（整段为一个 token），与拉丁混排按空白分隔', () => {
  const s = tokenSet('深度学习 RAG 检索');
  assert.deepStrictEqual([...s].sort(), ['rag', '检索', '深度学习'].sort());
});

test('tokenSet: LaTeX 公式段被剔除；空输入 → 空集合', () => {
  assert.deepStrictEqual([...tokenSet('$x^2$ model')], ['model']);
  assert.strictEqual(tokenSet('').size, 0);
  assert.strictEqual(tokenSet(null).size, 0);
  assert.strictEqual(tokenSet(undefined).size, 0);
});

// ---------------- toResult ----------------

test('toResult: 从 arXiv entry 规整出结果对象（含引用信息）', () => {
  const r = toResult(
    {
      id: 'http://arxiv.org/abs/2401.11111v1',
      title: 'MoE',
      summary: 's',
      published: '2024-01-02T00:00:00Z',
      authors: ['A'],
      primaryCategory: 'cs.LG',
      pdfUrl: 'http://arxiv.org/pdf/2401.11111v1',
    },
    { citationCount: 42, influentialCitationCount: 7 },
  );
  assert.strictEqual(r.arxivId, '2401.11111', '去掉版本号');
  assert.strictEqual(r.arxivUrl, 'https://arxiv.org/abs/2401.11111');
  assert.strictEqual(r.year, '2024', 'published 截前 4 位');
  assert.strictEqual(r.citationCount, 42);
  assert.strictEqual(r.influentialCitationCount, 7);
});

test('toResult: 字段缺省给默认值，无引用信息不带 citationCount 键', () => {
  const r = toResult({}, null);
  assert.strictEqual(r.arxivId, null);
  assert.strictEqual(r.arxivUrl, null, '无 id 时无 arxivUrl');
  assert.strictEqual(r.title, '(无标题)');
  assert.deepStrictEqual(r.authors, []);
  assert.strictEqual(r.year, null);
  assert.strictEqual(r.summary, '');
  assert.strictEqual(r.primaryCategory, null);
  assert.ok(!('citationCount' in r), '无引用信息不应出现 citationCount 键');
});
