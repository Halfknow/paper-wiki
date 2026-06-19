const test = require('node:test');
const assert = require('node:assert');
const {
  buildMessages, buildConceptMessages, parseAiJson, parseConceptResult,
  buildSummaryMarkdown, summarize, extractConcepts,
} = require('../lib/ai');

const CFG = { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', maxInputChars: 100, timeoutMs: 1000 } };

test('buildMessages 截断全文到 maxInputChars 并含 system prompt', () => {
  const long = 'x'.repeat(500);
  const msgs = buildMessages({ title: 'T', abstract: 'A', fulltext: long, maxInputChars: 100 });
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('T'));
  assert.ok(msgs[1].content.length < 500);
});

test('parseAiJson 容忍代码块包裹与前后噪声', () => {
  assert.deepStrictEqual(parseAiJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseAiJson('noise {"a":2} trailing'), { a: 2 });
  assert.strictEqual(parseAiJson('not json'), null);
  assert.strictEqual(parseAiJson(''), null);
});

test('buildSummaryMarkdown 组装 TL;DR/贡献/方法', () => {
  const md = buildSummaryMarkdown({ tldr: '短', contributions: ['c1', 'c2'], method: 'M' });
  assert.ok(md.includes('## TL;DR'));
  assert.ok(md.includes('- c1'));
  assert.ok(md.includes('## 方法'));
});

test('buildSummaryMarkdown 处理 null', () => {
  assert.ok(buildSummaryMarkdown(null).includes('失败'));
});

test('summarize 调用注入的 fetch 并解析 JSON 输出', async () => {
  const fakeFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://gw/v1/chat/completions');
    assert.strictEqual(opts.headers.Authorization, 'Bearer k');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"tldr":"t","tags":["a"]}\n```' } }] }),
    };
  };
  const obj = await summarize({ title: 'T', abstract: 'A', fulltext: 'F', config: CFG, fetchImpl: fakeFetch });
  assert.strictEqual(obj.tldr, 't');
  assert.deepStrictEqual(obj.tags, ['a']);
});

test('summarize 非 2xx 抛错', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => summarize({ config: CFG, fetchImpl: fakeFetch }), /401/);
});

test('summarize 对 429 限流做指数退避重试并最终成功', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 429, text: async () => 'rate limit' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"tldr":"ok"}' } }] }) };
  };
  const obj = await summarize({ config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', maxInputChars: 10 } }, fetchImpl: fakeFetch });
  assert.strictEqual(calls, 3);
  assert.strictEqual(obj.tldr, 'ok');
});

test('summarize 400（模型不存在）不重试，立即抛错', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad model' }; };
  await assert.rejects(() => summarize({ config: CFG, fetchImpl: fakeFetch }), /400/);
  assert.strictEqual(calls, 1, '400 不应重试');
});

test('buildConceptMessages 含已有概念列表以避免重复', () => {
  const msgs = buildConceptMessages({ title: 'T', abstract: 'A', fulltext: 'F', existingTerms: ['RLHF', 'PPO'] });
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('已有概念'));
  assert.ok(msgs[1].content.includes('RLHF'));
});

test('parseConceptResult 兼容 {concepts:[...]} 与裸数组', () => {
  assert.deepStrictEqual(parseConceptResult('```json\n{"concepts":[{"term":"a","definition":"b"}]}\n```'),
    [{ term: 'a', definition: 'b' }]);
  assert.deepStrictEqual(parseConceptResult('noise [{"term":"x","definition":"y"}] tail'),
    [{ term: 'x', definition: 'y' }]);
  assert.deepStrictEqual(parseConceptResult('not json'), []);
  assert.deepStrictEqual(parseConceptResult(''), []);
});

test('extractConcepts 调用注入的 fetch 并返回概念数组', async () => {
  const fakeFetch = async (url, opts) => {
    assert.ok(/\/chat\/completions$/.test(url));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"concepts":[{"term":"MoE","definition":"混合专家"}]}' } }] }) };
  };
  const items = await extractConcepts({ title: 'T', abstract: 'A', fulltext: 'F', existingTerms: [], config: CFG, fetchImpl: fakeFetch });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].term, 'MoE');
});
