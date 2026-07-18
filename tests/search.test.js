const test = require('node:test');
const assert = require('node:assert');
const { hasCjk, splitTerms, buildSnippets } = require('../lib/search');

test('hasCjk 判定中日韩字符', () => {
  assert.strictEqual(hasCjk('attention'), false);
  assert.strictEqual(hasCjk('注意力机制'), true);
  assert.strictEqual(hasCjk('mixed 混合'), true);
  assert.strictEqual(hasCjk(''), false);
});

test('splitTerms：英文按空白切分小写去重；过滤单字母；CJK 整串保留', () => {
  assert.deepStrictEqual(splitTerms('Attention  Mechanism attention'), ['attention', 'mechanism']);
  assert.deepStrictEqual(splitTerms('"scaling law" x'), ['scaling', 'law']);
  assert.deepStrictEqual(splitTerms('注意力 机制'), ['注意力 机制']);
  assert.deepStrictEqual(splitTerms('  '), []);
});

test('buildSnippets：命中高亮 + 上下文窗口 + 省略号', () => {
  const text = 'A'.repeat(200) + ' the attention mechanism is key ' + 'B'.repeat(200);
  const { snippets, matches } = buildSnippets(text, ['attention'], { window: 20 });
  assert.strictEqual(matches, 1);
  assert.strictEqual(snippets.length, 1);
  assert.ok(snippets[0].includes('<mark>attention</mark>'));
  assert.ok(snippets[0].startsWith('…') && snippets[0].endsWith('…'), '中段片段应有省略号');
  assert.ok(!snippets[0].includes('A'.repeat(50)), '窗口应截断上下文');
});

test('buildSnippets：多词命中、相邻窗口合并、片段数上限', () => {
  const text =
    'transformer uses attention. ' +
    'x'.repeat(300) +
    ' attention again. ' +
    'y'.repeat(300) +
    ' attention 3rd. ' +
    'z'.repeat(300) +
    ' attention 4th.';
  const r = buildSnippets(text, ['transformer', 'attention'], { window: 30, maxSnippets: 3 });
  assert.strictEqual(r.matches, 5);
  assert.strictEqual(r.snippets.length, 3, '片段数不超过 maxSnippets');
  // 首片段中 transformer 与第一个 attention 相邻 → 合并进同一片段
  assert.ok(r.snippets[0].includes('<mark>transformer</mark>') && r.snippets[0].includes('<mark>attention</mark>'));
});

test('buildSnippets：HTML 转义（原文含标签不注入）+ 大小写不敏感', () => {
  const text = 'evil <script>alert(1)</script> Attention here';
  const { snippets } = buildSnippets(text, ['attention'], { window: 60 });
  assert.ok(snippets[0].includes('&lt;script&gt;'), '原文标签应被转义');
  assert.ok(snippets[0].includes('<mark>Attention</mark>'), '保留原文大小写、匹配不敏感');
  assert.ok(!snippets[0].includes('<script>'));
});

test('buildSnippets：中文子串命中', () => {
  const text = '本文提出一种新的注意力机制，用于长序列建模。注意力机制的复杂度为线性。';
  const { snippets, matches } = buildSnippets(text, ['注意力机制'], { window: 10 });
  assert.strictEqual(matches, 2);
  assert.ok(snippets[0].includes('<mark>注意力机制</mark>'));
});

test('buildSnippets：无命中/空输入', () => {
  assert.deepStrictEqual(buildSnippets('abc', ['zzz']), { snippets: [], matches: 0 });
  assert.deepStrictEqual(buildSnippets('', ['a']), { snippets: [], matches: 0 });
  assert.deepStrictEqual(buildSnippets('abc', []), { snippets: [], matches: 0 });
});
