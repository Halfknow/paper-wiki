const test = require('node:test');
const assert = require('node:assert');
const { buildMessages, parseAiJson, buildSummaryMarkdown, summarize } = require('../lib/ai');

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
