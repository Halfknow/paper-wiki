const test = require('node:test');
const assert = require('node:assert');
const { parseAtom, extractArxivId, pickBest, searchArxiv, searchArxivMulti } = require('../src/services/arxiv');

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

test('searchArxiv 向后兼容数字第三参（minIntervalMs=0）', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => SAMPLE });
  const { entries, query } = await searchArxiv('survey', fakeFetch, 0);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(query, 'survey');
});

test('searchArxiv 对 5xx 重试，最终成功', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, text: async () => 'err' };
    return { ok: true, text: async () => SAMPLE };
  };
  const { entries } = await searchArxiv('survey', fakeFetch, { maxRetries: 3 });
  assert.strictEqual(calls, 3); // 前 2 次 503 + 第 3 次成功
  assert.strictEqual(entries.length, 2);
});

test('searchArxiv 对持续失败重试 maxRetries 次后抛错', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    // 模拟网络层错误（fetch reject），全部可重试
    throw new TypeError('network error');
  };
  await assert.rejects(() => searchArxiv('survey', fakeFetch, { maxRetries: 2 }), /network error/);
  assert.strictEqual(calls, 3); // maxRetries + 1 次
});

test('searchArxiv 对不可重试的 4xx 立即抛错，不重试', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  await assert.rejects(() => searchArxiv('survey', fakeFetch, { maxRetries: 3 }), /arxiv HTTP 400/);
  assert.strictEqual(calls, 1); // 4xx 不重试，只调一次
});

test('searchArxiv 加 AbortSignal.timeout 超时信号', async () => {
  // 超时后会 abort，fetchImpl 收到 signal 应观察到 signal 存在
  let sawSignal = false;
  const fakeFetch = async (url, opt) => {
    sawSignal = !!(opt && opt.signal);
    return { ok: true, text: async () => SAMPLE };
  };
  await searchArxiv('survey', fakeFetch, { timeoutMs: 15000 });
  assert.ok(sawSignal, 'fetch 调用应带上 signal');
});

test('searchArxiv 不传新参时 URL 保持旧行为（max_results=3, relevance, descending）', async () => {
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return { ok: true, text: async () => SAMPLE };
  };
  await searchArxiv('survey', fakeFetch, { minIntervalMs: 0 });
  assert.match(seenUrl, /max_results=3/);
  assert.match(seenUrl, /sortBy=relevance/);
  assert.match(seenUrl, /sortOrder=descending/);
  assert.match(seenUrl, /start=0/);
});

test('searchArxiv 支持 maxResults/sortBy/sortOrder/start 新参', async () => {
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return { ok: true, text: async () => SAMPLE };
  };
  await searchArxiv('moe', fakeFetch, { maxResults: 5, sortBy: 'submittedDate', sortOrder: 'ascending', start: 10 });
  assert.match(seenUrl, /max_results=5/);
  assert.match(seenUrl, /sortBy=submittedDate/);
  assert.match(seenUrl, /sortOrder=ascending/);
  assert.match(seenUrl, /start=10/);
  // 确认不再有硬编码的 max_results=3
  assert.doesNotMatch(seenUrl, /max_results=3/);
});

test('searchArxivMulti 默认按提交时间倒序拉 20 条', async () => {
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return { ok: true, text: async () => SAMPLE };
  };
  await searchArxivMulti('rag', fakeFetch, { minIntervalMs: 0 });
  assert.match(seenUrl, /max_results=20/);
  assert.match(seenUrl, /sortBy=submittedDate/);
  assert.match(seenUrl, /sortOrder=descending/);
});
