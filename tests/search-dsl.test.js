// public/search-dsl.js（浏览器镜像）与 src/core/search-query.js（Node 源）的**一致性测试**：
// 两份解析器必须产出一致结构（AGENTS 陷阱 28：改语法要同步两份）。
// 镜像经 vm 在 window 沙箱里执行（零构建 classic script，挂 window.PaperWikiSearch）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = require('../src/core/search-query');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'search-dsl.js'), 'utf8'), sandbox);
const FE = sandbox.window.PaperWikiSearch;

// parseSearchQuery 返回含 ast（嵌套对象），统一 JSON 序列化后比较（剥离 undefined/函数）
const norm = (x) => JSON.parse(JSON.stringify(x));

const QUERIES = [
  '',
  'transformer',
  '扩散模型 图像生成',
  'title:attention',
  'title:"vision transformer"',
  'tag:moe tag:icl',
  '(tag:moe OR tag:icl)',
  '-tag:draft',
  'year:>=2020',
  'year:2020-2022',
  'year:<2019',
  'status:ready read:reading starred:1',
  'author:Vaswani',
  'notes:复现 abstract:diffusion summary:transformer',
  'body:gradient title:attention',
  'in:body transformer',
  '"unclosed phrase',
  'field:',
  '-(tag:x OR tag:y)',
  'notes:.',
  '中文标题:强化学习 “引号短语”',
];

test('镜像 parseSearchQuery 与后端结构一致（20 组查询）', () => {
  assert.ok(FE && typeof FE.parseSearchQuery === 'function', 'window.PaperWikiSearch 已挂载');
  for (const q of QUERIES) {
    assert.deepStrictEqual(norm(FE.parseSearchQuery(q)), norm(BE.parseSearchQuery(q)), `查询不一致: ${JSON.stringify(q)}`);
  }
});

test('镜像 parse（{ast,tokens}）与 parseSearchQuery 的 ast 一致', () => {
  for (const q of ['title:attention', 'body:grad', '(tag:a OR -tag:b) year:>=2020']) {
    assert.deepStrictEqual(norm(FE.parse(q).ast), norm(FE.parseSearchQuery(q).ast), q);
  }
});

test('镜像 buildDslFromPanel 与后端一致', () => {
  const panels = [
    { text: 'transformer' },
    { title: 'attention', author: 'Vaswani', yearFrom: '2017', yearTo: '2020' },
    { tags: ['moe', 'icl'], excludeTags: ['draft'], topics: ['推理'], excludeTopics: ['视觉'] },
    { status: 'ready', readStatus: 'reading', starred: true, hasNotes: true },
    { scope: 'body', bodyText: 'gradient descent' },
    { scope: 'body', bodyText: '' }, // 无 bodyText → in:body
    { abstract: 'diffusion', summary: 'tl;dr', notes: '复现' },
    {},
  ];
  for (const p of panels) {
    assert.strictEqual(FE.buildDslFromPanel(p), BE.buildDslFromPanel(p), `面板不一致: ${JSON.stringify(p)}`);
  }
});

test('镜像 parseToPanel 与后端一致（DSL → 面板回填）', () => {
  const dsls = [
    'transformer',
    'title:attention author:Vaswani year:>=2017 year:<=2020',
    'tag:moe -tag:draft topic:推理',
    'status:ready read:reading starred:1 notes:.',
    'body:gradient',
    'in:body',
    'abstract:diffusion summary:x notes:y',
    'year:2020',
    '(tag:a OR tag:b)',
  ];
  for (const d of dsls) {
    assert.deepStrictEqual(norm(FE.parseToPanel(d)), norm(BE.parseToPanel(d)), `回填不一致: ${d}`);
  }
});

test('镜像 isBodySearch：含 body:/in:body 判定与后端口径一致', () => {
  const cases = { 'body:grad': true, 'in:body x': true, 'title:body': false, transformer: false, 'tag:body:': false };
  for (const [q, want] of Object.entries(cases)) {
    assert.strictEqual(FE.isBodySearch(q), want, q);
    // 与后端 parseSearchQuery 的 bodyQuery 判定一致
    assert.strictEqual(FE.isBodySearch(q), BE.parseSearchQuery(q).bodyQuery !== null, `口径不一致: ${q}`);
  }
});

test('detectFieldAtCursor：光标处字段识别（前端独有，补全用）', () => {
  // cursorPos 须在 field: 之后（before 串里含完整 "field:" 前缀才命中）
  const cases = [
    ['tag:', 4, 'tag'],
    ['title:att', 9, 'title'],
    ['hello tag:', 10, 'tag'],
    ['topic:推', 7, 'topic'],
    ['year:', 5, 'year'],
    ['status:', 7, 'status'],
    ['read:', 5, 'read'],
    ['notes:', 6, 'notes'],
    ['abstract:', 9, 'abstract'],
    ['summary:', 8, 'summary'],
    ['author:', 7, 'author'],
    ['body:', 5, 'body'],
  ];
  for (const [text, pos, field] of cases) {
    const r = FE.detectFieldAtCursor(text, pos);
    assert.ok(r, `应识别字段: ${text}@${pos}`);
    assert.strictEqual(r.field, field, `${text}@${pos}`);
  }
  // 非字段位置返回 null
  assert.strictEqual(FE.detectFieldAtCursor('hello world', 5), null);
  assert.strictEqual(FE.detectFieldAtCursor('', 0), null);
  assert.strictEqual(FE.detectFieldAtCursor('tag', 3), null); // 无冒号
});

test('FIELD_ALIASES 与后端字段集合一致', () => {
  const beFields = ['title', 'abstract', 'summary', 'notes', 'author', 'tag', 'topic', 'year', 'status', 'read', 'starred', 'body'];
  for (const f of beFields) {
    const probe = FE.parseSearchQuery(`${f === 'read' ? 'read' : f}:x`);
    assert.ok(probe, `${f} 可解析`);
  }
  assert.ok(FE.FIELD_ALIASES && typeof FE.FIELD_ALIASES === 'object', 'FIELD_ALIASES 导出');
});
