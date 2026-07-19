const test = require('node:test');
const assert = require('node:assert');
const {
  tokenize,
  parseSearchQuery,
  parseYearValue,
  applyMetadataQuery,
  buildDslFromPanel,
  parseToPanel,
} = require('../src/core/search-query');

// 造论文样本（字段与 store.papers 一致）
const P = (over) =>
  Object.assign(
    {
      id: 'x',
      title: 'Attention Is All You Need',
      abstract: 'We propose the Transformer',
      summary: '## TL;DR\nTransformer 架构',
      notes: '复现要点',
      authors: ['Vaswani', 'Shazeer'],
      year: '2017',
      tags: ['transformer', 'attention'],
      topics: ['NLP'],
      status: 'ready',
      readStatus: 'done',
      starred: false,
    },
    over,
  );
const LIST = [
  P({ id: 'a', title: 'Attention Is All You Need', tags: ['transformer', 'attention'], year: '2017', starred: true }),
  P({
    id: 'b',
    title: 'Diffusion Models Beat GANs',
    abstract: 'image generation via diffusion',
    tags: ['diffusion', 'image'],
    year: '2022',
  }),
  P({ id: 'c', title: 'Mixture of Experts', tags: ['moe'], topics: ['推理'], year: '2020', notes: '' }),
  P({ id: 'd', title: '强化学习导论', tags: ['rl'], topics: ['强化学习'], year: '2019' }),
];

test('tokenize: 裸词 / 短语 / 字段 / 排除 / 操作符', () => {
  const t = tokenize('title:attn "vision transformer" -notes:draft AND word');
  assert.strictEqual(t.length, 5);
  assert.strictEqual(t[0].type, 'field');
  assert.strictEqual(t[0].field, 'title');
  assert.strictEqual(t[0].value, 'attn');
  assert.strictEqual(t[1].type, 'phrase');
  assert.strictEqual(t[1].value, 'vision transformer');
  assert.strictEqual(t[2].type, 'field');
  assert.strictEqual(t[2].exclude, true);
  assert.strictEqual(t[3].type, 'op');
  assert.strictEqual(t[3].value, 'AND');
  assert.strictEqual(t[4].type, 'word');
});

test('tokenize: 中文引号与括号', () => {
  const t = tokenize('(tag:moe OR topic:推理) “exact”');
  assert.strictEqual(t[0].type, 'lparen');
  assert.strictEqual(t[1].field, 'tag');
  assert.strictEqual(t[2].value, 'OR');
  assert.strictEqual(t[3].field, 'topic');
  assert.strictEqual(t[3].value, '推理');
  assert.strictEqual(t[4].type, 'rparen');
  assert.strictEqual(t[5].type, 'phrase');
  assert.strictEqual(t[5].value, 'exact');
});

test('parseSearchQuery: 裸词分词 AND（修单子串 bug）', () => {
  const r = parseSearchQuery('transformer attention');
  assert.deepStrictEqual(r.metadata.text.words.sort(), ['attention', 'transformer']);
  // list a 同时含两词；list b 只含 diffusion
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  assert.ok(out.includes('a'));
  assert.ok(!out.includes('b'));
});

test('parseSearchQuery: title: 字段限定', () => {
  const r = parseSearchQuery('title:diffusion');
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  assert.deepStrictEqual(out, ['b']);
});

test('parseSearchQuery: tag: 多值 OR + 显式 AND', () => {
  const rOr = parseSearchQuery('tag:transformer tag:moe');
  const outOr = applyMetadataQuery(LIST, rOr)
    .map((p) => p.id)
    .sort();
  assert.deepStrictEqual(outOr, ['a', 'c']);
  const rAnd = parseSearchQuery('tag:transformer AND tag:attention');
  const outAnd = applyMetadataQuery(LIST, rAnd).map((p) => p.id);
  assert.deepStrictEqual(outAnd, ['a']);
});

test('parseSearchQuery: -tag: 排除', () => {
  const r = parseSearchQuery('tag:transformer -tag:attention');
  // a 同时有 transformer 和 attention → 被排除
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  assert.deepStrictEqual(out, []);
});

test('parseSearchQuery: year: 比较与范围', () => {
  assert.deepStrictEqual(parseYearValue('>=2020'), { op: '>=', value: 2020 });
  assert.deepStrictEqual(parseYearValue('2020-2022'), { op: 'range', from: 2020, to: 2022 });
  assert.deepStrictEqual(parseYearValue('2017'), { op: '=', value: 2017 });
  const r = parseSearchQuery('year:>=2020');
  const out = applyMetadataQuery(LIST, r)
    .map((p) => p.id)
    .sort();
  assert.deepStrictEqual(out, ['b', 'c']);
});

test('parseSearchQuery: status / read / starred', () => {
  assert.strictEqual(applyMetadataQuery(LIST, parseSearchQuery('status:ready')).length, 4);
  assert.deepStrictEqual(
    applyMetadataQuery(LIST, parseSearchQuery('read:done')).map((p) => p.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepStrictEqual(
    applyMetadataQuery(LIST, parseSearchQuery('star:1')).map((p) => p.id),
    ['a'],
  );
});

test('parseSearchQuery: "phrase" 精确匹配', () => {
  const r = parseSearchQuery('"vision transformer"');
  assert.deepStrictEqual(r.metadata.text.phrases, ['vision transformer']);
  // 没有论文含此连续短语
  assert.strictEqual(applyMetadataQuery(LIST, r).length, 0);
});

test('parseSearchQuery: body: 提取正文查询词', () => {
  const r = parseSearchQuery('body:in-context-learning topic:推理');
  assert.strictEqual(r.bodyQuery, 'in-context-learning');
  // 元数据部分只剩 topic:推理
  assert.deepStrictEqual(r.metadata.fields.topic, [{ value: '推理', exclude: false }]);
});

test('parseSearchQuery: in:body 标记正文模式（无具体词）', () => {
  const r = parseSearchQuery('topic:推理 in:body');
  assert.strictEqual(r.bodyQuery, '');
  assert.strictEqual(r.metadata.fields.topic[0].value, '推理');
});

test('parseSearchQuery: 中文裸词整串匹配（不切分）', () => {
  const r = parseSearchQuery('强化学习');
  assert.deepStrictEqual(r.metadata.text.words, ['强化学习']);
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  assert.deepStrictEqual(out, ['d']);
});

test('parseSearchQuery: OR 分组', () => {
  const r = parseSearchQuery('(tag:moe OR tag:diffusion)');
  assert.strictEqual(r.metadata.hasOr, true);
  const out = applyMetadataQuery(LIST, r)
    .map((p) => p.id)
    .sort();
  assert.deepStrictEqual(out, ['b', 'c']);
});

test('parseSearchQuery: 复合 — title + year + tag -notes', () => {
  const r = parseSearchQuery('title:diffusion year:>=2020 tag:image');
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  assert.deepStrictEqual(out, ['b']);
});

test('parseSearchQuery: 未知字段回退为裸词', () => {
  const r = parseSearchQuery('foobar:xyz');
  // foobar 非已知字段 → 当裸词 'foobar:xyz'
  assert.ok(r.metadata.text.words.includes('foobar:xyz'));
});

test('parseSearchQuery: 空查询返回全集', () => {
  const r = parseSearchQuery('');
  assert.strictEqual(applyMetadataQuery(LIST, r).length, 4);
});

test('parseSearchQuery: author 字段（数组）', () => {
  const r = parseSearchQuery('author:vaswani');
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  // 所有论文 authors 都含 Vaswani
  assert.strictEqual(out.length, 4);
});

test('英文词边界：cat 不命中 category（词边界匹配）', () => {
  const list = [P({ id: 'e', title: 'Categorization of methods' })];
  const r = parseSearchQuery('cat');
  assert.strictEqual(applyMetadataQuery(list, r).length, 0);
});

test('buildDslFromPanel: 面板 → DSL 字符串', () => {
  const dsl = buildDslFromPanel({
    title: 'attn',
    tags: ['moe', 'icl'],
    yearFrom: 2020,
    yearTo: 2024,
    starred: true,
    text: 'hello',
  });
  assert.ok(dsl.includes('title:attn'));
  assert.ok(dsl.includes('tag:moe'));
  assert.ok(dsl.includes('tag:icl'));
  assert.ok(dsl.includes('year:2020-2024'));
  assert.ok(dsl.includes('star:1'));
  assert.ok(dsl.includes('hello'));
});

test('parseToPanel: DSL → 面板（往返）', () => {
  const panel = parseToPanel('title:diffusion year:>=2022 tag:image');
  assert.strictEqual(panel.title, 'diffusion');
  assert.strictEqual(panel.yearFrom, 2022);
  assert.deepStrictEqual(panel.tags, ['image']);
});

test('parseToPanel: body: → scope=body + bodyText', () => {
  const panel = parseToPanel('topic:推理 body:in-context');
  assert.strictEqual(panel.scope, 'body');
  assert.strictEqual(panel.bodyText, 'in-context');
  assert.deepStrictEqual(panel.topics, ['推理']);
});

test('parseToPanel: OR 分支回退原文到 text', () => {
  const panel = parseToPanel('(tag:moe OR tag:icl)');
  assert.strictEqual(panel.text, '(tag:moe OR tag:icl)');
});
