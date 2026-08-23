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

// ==================== 笔记卡片 haystack（noteCards 可搜索） ====================

test('裸词命中 noteCards 卡片 title/body（全局 haystack 合并）', () => {
  const papers = [
    P({ id: 'nc1', noteCards: [{ type: 'qa', title: 'Q: zyk-token 是什么', body: '解释正文' }] }),
    P({ id: 'nc2' }),
  ];
  const r = applyMetadataQuery(papers, parseSearchQuery('zyk-token'));
  assert.deepStrictEqual(r.map((p) => p.id), ['nc1']);
});

test('notes: 字段同时命中旧 notes 文本与 noteCards 内容', () => {
  const papers = [
    P({ id: 'old', notes: '旧文本里的 uniqkw-old', noteCards: [] }),
    P({ id: 'new', notes: '', noteCards: [{ type: 'manual', title: 't', body: '卡片里的 uniqkw-new' }] }),
    P({ id: 'none', notes: '' }),
  ];
  const r1 = applyMetadataQuery(papers, parseSearchQuery('notes:uniqkw-old'));
  assert.deepStrictEqual(r1.map((p) => p.id), ['old']);
  const r2 = applyMetadataQuery(papers, parseSearchQuery('notes:uniqkw-new'));
  assert.deepStrictEqual(r2.map((p) => p.id), ['new']);
});

test('notes:.（高级面板 hasNotes）在仅有 noteCards 时也命中', () => {
  const papers = [
    P({ id: 'with', notes: '', noteCards: [{ type: 'skeleton', title: '研究问题', body: 'x' }] }),
    P({ id: 'without', notes: '' }),
    P({ id: 'legacy', notes: '旧笔记', noteCards: [] }),
  ];
  const r = applyMetadataQuery(papers, parseSearchQuery('notes:.'));
  assert.deepStrictEqual(r.map((p) => p.id).sort(), ['legacy', 'with']);
});

test('noteCards 里非对象条目不炸（自愈容错）', () => {
  const papers = [P({ id: 'bad', noteCards: [null, 'x', { body: 'validkw' }] })];
  const r = applyMetadataQuery(papers, parseSearchQuery('notes:validkw'));
  assert.deepStrictEqual(r.map((p) => p.id), ['bad']);
});

// ==================== 追加：year 解析边界 / 面板构建与回填 / tokenizer 边界 ====================

test('parseYearValue：不完整比较符与垃圾输入返回 null', () => {
  assert.strictEqual(parseYearValue('>'), null);
  assert.strictEqual(parseYearValue('<'), null);
  assert.strictEqual(parseYearValue('<='), null);
  assert.strictEqual(parseYearValue('>='), null);
  assert.strictEqual(parseYearValue('abcd'), null);
  assert.strictEqual(parseYearValue('2024-'), null, '不完整范围 → null');
  assert.strictEqual(parseYearValue(''), null);
  assert.strictEqual(parseYearValue(null), null);
  // 三位年份不匹配 \d{4} → null
  assert.strictEqual(parseYearValue('202'), null);
});

test('buildDslFromPanel：hasNotes→notes:.、scope=body 无词→in:body、单侧年份', () => {
  assert.strictEqual(buildDslFromPanel({ hasNotes: true }), 'notes:.');
  assert.strictEqual(buildDslFromPanel({ scope: 'body' }), 'in:body');
  assert.strictEqual(buildDslFromPanel({ scope: 'body', bodyText: '  ' }), 'in:body', '空白 bodyText 视同无词');
  assert.strictEqual(buildDslFromPanel({ yearFrom: 2020 }), 'year:>=2020');
  assert.strictEqual(buildDslFromPanel({ yearTo: 2024 }), 'year:<=2024');
});

test('parseToPanel：notes:.→hasNotes、author 回填、year 等值填满 From/To', () => {
  const p1 = parseToPanel('notes:.');
  assert.strictEqual(p1.hasNotes, true);
  assert.strictEqual(p1.notes, '');
  const p2 = parseToPanel('author:vaswani');
  assert.strictEqual(p2.author, 'vaswani');
  const p3 = parseToPanel('year:2020');
  assert.strictEqual(p3.yearFrom, 2020, 'year 等值回填 yearFrom');
  assert.strictEqual(p3.yearTo, 2020, 'year 等值回填 yearTo');
  const p4 = parseToPanel('year:<2022');
  assert.strictEqual(p4.yearFrom, '', '严格小于无法回填到 From/To');
  assert.strictEqual(p4.yearTo, '');
});

test('tokenize：- 后接括号不构成排除；未闭合引号容错', () => {
  const t = tokenize('-(a b)');
  assert.strictEqual(t[0].type, 'word', '- 后接 ( 不构成排除前缀，- 本身成裸词');
  assert.strictEqual(t[0].value, '-');
  assert.strictEqual(t[0].exclude, false);
  assert.strictEqual(t[1].type, 'lparen');
  assert.strictEqual(t[2].value, 'a');
  // 未闭合引号：读到行尾，按 phrase 收尾不抛错
  const u = tokenize('"未闭合短语');
  assert.strictEqual(u.length, 1);
  assert.strictEqual(u[0].type, 'phrase');
  assert.strictEqual(u[0].value, '未闭合短语');
});

test('evalAst：OR 组内 -tag:moe 排除（非排除项命中即入）', () => {
  const r = parseSearchQuery('(tag:rl OR -tag:moe)');
  assert.strictEqual(r.metadata.hasOr, true, 'OR 组走 AST 求值路径');
  const out = applyMetadataQuery(LIST, r).map((p) => p.id);
  // a/b 无 moe → -tag:moe 命中；d 有 rl；c 只有 moe → 两边都不满足被排除
  assert.deepStrictEqual(out, ['a', 'b', 'd']);
});

test('parseSearchQuery: field:"引号短语" —— 字段值含空格短语（不再劣化为恒零结果）', () => {
  // 旧 tokenizer 把 title:"all you need" 拆成裸词 `title:`（要求标题含字面冒号）+ 全局短语，
  // AND 语义下恒零命中且不报错——用户最自然的写法直接查空
  const r = parseSearchQuery('title:"all you need"');
  assert.deepStrictEqual(r.metadata.fields.title, [{ value: 'all you need', exclude: false }]);
  assert.deepStrictEqual(r.metadata.text.phrases, [], '短语归属字段，不再进全局 phrases');
  const hit = applyMetadataQuery(LIST, r);
  assert.deepStrictEqual(hit.map((p) => p.id), ['a'], '按标题子串命中 Attention Is All You Need');
  // 排除形：-title:"all you need"
  const r2 = parseSearchQuery('-title:"all you need"');
  assert.ok(r2.metadata.fields.title[0].exclude, '排除前缀随字段短语透传');
});
