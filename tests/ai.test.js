const test = require('node:test');
const assert = require('node:assert');
const {
  buildMessages,
  buildConceptMessages,
  parseAiJson,
  parseConceptResult,
  parseTagsResult,
  buildSummaryMarkdown,
  summarize,
  extractTagsTopics,
  extractConcepts,
  applySettingsOverride,
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

test('buildSummaryMarkdown 直接返回字符串内容（剥围栏）', () => {
  const md = buildSummaryMarkdown('## TL;DR\n短\n\n## 方法\nM');
  assert.ok(md.includes('## TL;DR'));
  assert.ok(md.includes('## 方法'));
});

test('buildSummaryMarkdown 剥除偶发的 ```markdown 围栏', () => {
  const md = buildSummaryMarkdown('```markdown\n## TL;DR\n短\n```');
  assert.ok(md.startsWith('## TL;DR'));
  assert.ok(!md.includes('```'));
});

test('buildSummaryMarkdown 处理 null/空', () => {
  assert.ok(buildSummaryMarkdown(null).includes('失败'));
  assert.ok(buildSummaryMarkdown('').includes('失败'));
  assert.ok(buildSummaryMarkdown('   ').includes('失败'));
});

test('parseTagsResult 解析 {tags,topics,metadata}', () => {
  const r = parseTagsResult('{"tags":["a","B"],"topics":["推理"],"metadata":{"title":"T","authors":[],"year":2024}}');
  assert.deepStrictEqual(r.tags, ['a', 'B']);
  assert.deepStrictEqual(r.topics, ['推理']);
  assert.strictEqual(r.metadata.title, 'T');
});

test('parseTagsResult 解析失败返回空结构（不抛）', () => {
  const r = parseTagsResult('not json');
  assert.deepStrictEqual(r.tags, []);
  assert.deepStrictEqual(r.topics, []);
  assert.strictEqual(r.metadata, null);
});

test('applySettingsOverride 用 store.settings.ai 覆盖 config.ai，不改原 config', () => {
  const config = { ai: { baseURL: 'http://a/v1', apiKey: 'orig', model: 'm1', maxInputChars: 100 } };
  const settings = { ai: { model: 'm2', apiKey: 'new' } };
  const eff = applySettingsOverride(config, settings);
  assert.strictEqual(eff.ai.model, 'm2'); // 覆盖
  assert.strictEqual(eff.ai.apiKey, 'new'); // 覆盖
  assert.strictEqual(eff.ai.baseURL, 'http://a/v1'); // 未覆盖，保留原值
  // 原 config 未被修改
  assert.strictEqual(config.ai.model, 'm1');
  assert.strictEqual(config.ai.apiKey, 'orig');
});

test('applySettingsOverride 空字符串 apiKey 视为未设置（不覆盖，保留原值）', () => {
  const config = { ai: { apiKey: 'orig' } };
  const eff = applySettingsOverride(config, { ai: { apiKey: '' } });
  assert.strictEqual(eff.ai.apiKey, 'orig');
});

test('applySettingsOverride 无 settings 时返回 config 副本', () => {
  const config = { ai: { model: 'm' } };
  const eff = applySettingsOverride(config, null);
  assert.strictEqual(eff.ai.model, 'm');
  assert.notStrictEqual(eff, config); // 是副本
});

test('applySettingsOverride 覆盖 scanIntervalMinutes（允许 0 关闭定时扫描）', () => {
  const config = { ai: {}, scanIntervalMinutes: 5 };
  assert.strictEqual(applySettingsOverride(config, { scanIntervalMinutes: 0 }).scanIntervalMinutes, 0);
  assert.strictEqual(applySettingsOverride(config, {}).scanIntervalMinutes, 5); // 未覆盖透传
  assert.strictEqual(config.scanIntervalMinutes, 5); // 不改原 config
});

test('applySettingsOverride 覆盖 arxiv 字段（布尔 false 生效，未设字段透传）', () => {
  const config = { ai: {}, arxiv: { enabled: true, titleSimilarityThreshold: 0.75, minIntervalMs: 3000 } };
  const eff = applySettingsOverride(config, { arxiv: { enabled: false, titleSimilarityThreshold: 0.9 } });
  assert.strictEqual(eff.arxiv.enabled, false); // 布尔 false 必须生效（不能被 !== '' 吞掉）
  assert.strictEqual(eff.arxiv.titleSimilarityThreshold, 0.9);
  assert.strictEqual(eff.arxiv.minIntervalMs, 3000); // 未覆盖透传
  assert.strictEqual(config.arxiv.enabled, true); // 不改原 config
});

test('applySettingsOverride 覆盖 discover（含 weights 深合并、数值 0、未设透传）', () => {
  const config = {
    ai: {},
    discover: {
      maxResults: 40,
      perAxis: 25,
      semanticScholar: true,
      openAlex: true,
      weights: { rel: 0.45, auth: 0.35, rec: 0.2 },
    },
  };
  const eff = applySettingsOverride(config, {
    discover: { maxResults: 10, semanticScholar: false, weights: { rec: 0 } },
  });
  assert.strictEqual(eff.discover.maxResults, 10);
  assert.strictEqual(eff.discover.semanticScholar, false); // 布尔 false 生效
  assert.strictEqual(eff.discover.perAxis, 25); // 未覆盖透传
  assert.strictEqual(eff.discover.openAlex, true);
  assert.strictEqual(eff.discover.weights.rec, 0); // 数值 0 生效
  assert.strictEqual(eff.discover.weights.rel, 0.45); // weights 深合并保留未改项
  assert.strictEqual(config.discover.weights.rec, 0.2); // 不改原 config
});

test('applySettingsOverride 密钥类空串不覆盖（沿用 ai.apiKey 语义，回退 config）', () => {
  const config = { ai: {}, discover: { semanticScholarApiKey: 'cfg-key' } };
  const eff = applySettingsOverride(config, { discover: { semanticScholarApiKey: '' } });
  assert.strictEqual(eff.discover.semanticScholarApiKey, 'cfg-key');
});

test('applySettingsOverride 缺省 config 段时不抛错', () => {
  const eff = applySettingsOverride({ ai: {} }, { arxiv: { enabled: false }, discover: { maxResults: 5 } });
  assert.strictEqual(eff.arxiv.enabled, false);
  assert.strictEqual(eff.discover.maxResults, 5);
});

test('summarize 调用注入的 fetch 并返回 Markdown 字符串（jsonMode:false）', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://gw/v1/chat/completions');
    assert.strictEqual(opts.headers.Authorization, 'Bearer k');
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '## TL;DR\n短\n\n## 方法\nM' } }] }),
    };
  };
  const md = await summarize({ title: 'T', abstract: 'A', fulltext: 'F', config: CFG, fetchImpl: fakeFetch });
  assert.strictEqual(md, '## TL;DR\n短\n\n## 方法\nM');
  // 总结调用不应强制 json_object
  assert.strictEqual(capturedBody.response_format, undefined);
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
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const md = await summarize({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', maxInputChars: 10 } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(calls, 3);
  assert.strictEqual(md, 'ok');
});

test('summarize 400（模型不存在）不重试，立即抛错', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return { ok: false, status: 400, text: async () => 'bad model' };
  };
  await assert.rejects(() => summarize({ config: CFG, fetchImpl: fakeFetch }), /400/);
  assert.strictEqual(calls, 1, '400 不应重试');
});

test('extractTagsTopics 强制 json_object 并解析 {tags,topics}', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"tags":["moe","in-context-learning"],"topics":["推理"]}' } }],
      }),
    };
  };
  const tt = await extractTagsTopics({ title: 'T', abstract: 'A', fulltext: 'F', config: CFG, fetchImpl: fakeFetch });
  assert.deepStrictEqual(tt.tags, ['moe', 'in-context-learning']);
  assert.deepStrictEqual(tt.topics, ['推理']);
  assert.strictEqual(tt.metadata, null);
  // 标签/主题调用应强制 json_object
  assert.deepStrictEqual(capturedBody.response_format, { type: 'json_object' });
});

test('extractTagsTopics 解析失败返回空结构', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) });
  const tt = await extractTagsTopics({ config: CFG, fetchImpl: fakeFetch });
  assert.deepStrictEqual(tt.tags, []);
  assert.deepStrictEqual(tt.topics, []);
});

test('buildConceptMessages 含已有概念列表以避免重复', () => {
  const msgs = buildConceptMessages({ title: 'T', abstract: 'A', fulltext: 'F', existingTerms: ['RLHF', 'PPO'] });
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('已有概念'));
  assert.ok(msgs[1].content.includes('RLHF'));
});

test('parseConceptResult 兼容 {concepts:[...]} 与裸数组', () => {
  assert.deepStrictEqual(parseConceptResult('```json\n{"concepts":[{"term":"a","definition":"b"}]}\n```'), [
    { term: 'a', definition: 'b' },
  ]);
  assert.deepStrictEqual(parseConceptResult('noise [{"term":"x","definition":"y"}] tail'), [
    { term: 'x', definition: 'y' },
  ]);
  assert.deepStrictEqual(parseConceptResult('not json'), []);
  assert.deepStrictEqual(parseConceptResult(''), []);
});

test('extractConcepts 调用注入的 fetch 并返回概念数组', async () => {
  const fakeFetch = async (url) => {
    assert.ok(/\/chat\/completions$/.test(url));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"concepts":[{"term":"MoE","definition":"混合专家"}]}' } }],
      }),
    };
  };
  const items = await extractConcepts({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    existingTerms: [],
    config: CFG,
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].term, 'MoE');
});
