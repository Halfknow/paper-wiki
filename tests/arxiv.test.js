const test = require('node:test');
const assert = require('node:assert');
const { parseAtom, extractArxivId, pickBest, searchArxiv } = require('../lib/arxiv');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2303.18223v1</id>
    <title>A Survey of Large Language Models</title>
    <summary>Language is essentially a complex, intricate system...</summary>
    <published>2023-03-31T17:59:45Z</published>
    <author><name>Wayne Xin Zhao</name></author>
    <author><name>Kun Zhou</name></author>
    <link href="http://arxiv.org/pdf/2303.18223v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1234.56789v1</id>
    <title>Unrelated Paper About Quantum Gravity</title>
    <summary>zzz</summary>
    <published>2020-01-01T00:00:00Z</published>
    <author><name>Nobody</name></author>
  </entry>
</feed>`;

test('parseAtom 解析 entries，提取 title/authors/summary/pdfUrl', () => {
  const entries = parseAtom(SAMPLE);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].title, 'A Survey of Large Language Models');
  assert.deepStrictEqual(entries[0].authors, ['Wayne Xin Zhao', 'Kun Zhou']);
  assert.ok(entries[0].summary.startsWith('Language is'));
  assert.strictEqual(entries[0].pdfUrl, 'http://arxiv.org/pdf/2303.18223v1');
});

test('extractArxivId 从 abs URL 抽取 id', () => {
  assert.strictEqual(extractArxivId({ id: 'http://arxiv.org/abs/2303.18223v2' }), '2303.18223');
  assert.strictEqual(extractArxivId({ id: 'garbage' }), null);
});

test('pickBest 选相似度最高且过阈值的条目', () => {
  const entries = parseAtom(SAMPLE);
  const r = pickBest('A Survey of Large Language Models', entries, { threshold: 0.5 });
  assert.ok(r.best);
  assert.strictEqual(r.best.title, 'A Survey of Large Language Models');
  assert.ok(r.confidence >= 0.5);
  assert.strictEqual(r.source, 'arxiv');
});

test('pickBest 无匹配时返回 source none', () => {
  const entries = parseAtom(SAMPLE);
  const r = pickBest('Cat Photosynthesis', entries, { threshold: 0.75 });
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.source, 'none');
});

test('searchArxiv 用注入的 fetch 并解析', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => SAMPLE });
  const { entries } = await searchArxiv('survey', fakeFetch, 0);
  assert.strictEqual(entries.length, 2);
});
