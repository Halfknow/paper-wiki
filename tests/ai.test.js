const test = require('node:test');
const assert = require('node:assert');
const {
  buildMessages,
  buildConceptMessages,
  buildChatMessages,
  parseAiJson,
  parseConceptResult,
  parseTagsResult,
  buildSummaryMarkdown,
  summarize,
  extractTagsTopics,
  extractConcepts,
  chatPaper,
  applySettingsOverride,
  callChat,
  listModels,
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

test('buildChatMessages 注入论文上下文 + 历史多轮 + 本轮问题 + 截断全文', () => {
  const long = 'y'.repeat(500);
  const history = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
  ];
  const msgs = buildChatMessages({
    title: '我的论文',
    abstract: '摘要',
    fulltext: long,
    history,
    message: '第二问',
    maxInputChars: 100,
  });
  // system（默认提示词）+ 论文上下文 user + 2 条历史 + 本轮问题 = 6 条
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[0].content.length > 0, '系统提示词非空');
  assert.strictEqual(msgs[1].role, 'user');
  assert.ok(msgs[1].content.includes('我的论文'), '论文上下文含标题');
  assert.ok(msgs[1].content.includes('摘要'));
  assert.ok(msgs[1].content.length < 500, '全文截断');
  assert.strictEqual(msgs[2].content, '第一问');
  assert.strictEqual(msgs[3].content, '第一答');
  assert.strictEqual(msgs[4].content, '第二问');
  assert.strictEqual(msgs.length, 5);
});

test('buildChatMessages 支持 extraPapers（@ 引用多论文）注入独立 context 块', () => {
  const history = [{ role: 'user', content: '问' }];
  const extraPapers = [
    { title: '引用论文A', abstract: 'A摘要', fulltext: 'A'.repeat(10000) },
    { title: '引用论文B', abstract: 'B摘要', fulltext: 'B'.repeat(100) },
  ];
  const msgs = buildChatMessages({
    title: '主论文',
    abstract: '主摘要',
    fulltext: '主全文',
    history,
    message: '对比一下',
    maxInputChars: 24000,
    extraPapers,
  });
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[1].role, 'user');
  // 主论文 + 引用块都在第一条 user context 里
  assert.ok(msgs[1].content.includes('主论文'), '上下文含主论文标题');
  assert.ok(msgs[1].content.includes('引用论文A'), '上下文含引用论文A');
  assert.ok(msgs[1].content.includes('引用论文B'), '上下文含引用论文B');
  assert.ok(msgs[1].content.includes('引用了以上 2 篇相关论文'), '提示跨论文对比');
  // 额外论文全文受 budget 约束（单篇≤6000，合计≤maxInputChars*0.6=14400）
  // A 的 10000 字会被 cap 到剩余 budget；B 在 A 之后，至少含摘要
  assert.ok(msgs[1].content.includes('B摘要'), '引用论文B 摘要保留');
  assert.strictEqual(msgs[2].content, '问');
  assert.strictEqual(msgs[3].content, '对比一下');
});

test('buildChatMessages 无 extraPapers 时不注入引用块（向后兼容）', () => {
  const msgs = buildChatMessages({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    history: [],
    message: '问',
    maxInputChars: 100,
  });
  assert.ok(!msgs[1].content.includes('引用论文'), '无引用时不出现引用块');
  assert.ok(!msgs[1].content.includes('相关论文'), '无引用时不出现跨论文提示');
});

test('chatPaper 调注入 fetch 并返回 Markdown（jsonMode:false，多轮消息透传）', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://gw/v1/chat/completions');
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '论文采用了 MoE 架构' } }] }) };
  };
  const reply = await chatPaper({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    history: [{ role: 'user', content: '问' }],
    message: '新问',
    config: CFG,
    systemPrompt: '你是助手',
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(reply, '论文采用了 MoE 架构');
  assert.strictEqual(capturedBody.response_format, undefined, 'jsonMode:false 不含 response_format');
  assert.strictEqual(capturedBody.messages[0].role, 'system');
  assert.strictEqual(capturedBody.messages[0].content, '你是助手', 'systemPrompt 覆盖默认');
  assert.strictEqual(capturedBody.messages[capturedBody.messages.length - 1].content, '新问', '末条为本轮问题');
});

// ===== Phase 2/3 新增：模型覆盖 / 多模态消息 / extraModels / listModels =====

test('applySettingsOverride 覆盖 ai.extraModels（数组，!== undefined 即覆盖）', () => {
  const config = { ai: { baseURL: 'b', apiKey: 'k', model: 'm', extraModels: ['a', 'b'] } };
  const eff = applySettingsOverride(config, { ai: { extraModels: ['x', 'y'] } });
  assert.deepStrictEqual(eff.ai.extraModels, ['x', 'y'], 'store.settings.ai.extraModels 覆盖 config');
  assert.deepStrictEqual(config.ai.extraModels, ['a', 'b'], '原 config 不被修改');
  // 未设 extraModels 透传 config 原值
  const eff2 = applySettingsOverride(config, { ai: { model: 'm2' } });
  assert.deepStrictEqual(eff2.ai.extraModels, ['a', 'b']);
});

test('callChat 用 chatParams.model 覆盖 config.ai.model', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await callChat({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: fakeFetch,
    jsonMode: false,
    chatParams: { model: 'gpt-4o' },
  });
  assert.strictEqual(capturedBody.model, 'gpt-4o', 'chatParams.model 覆盖 config.ai.model');
  // 无 chatParams.model 时用 config.ai.model
  await callChat({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: fakeFetch,
    jsonMode: false,
  });
  assert.strictEqual(capturedBody.model, 'm', '无覆盖时回退 config.ai.model');
});

test('callChat 多模态：messages[i].content 为数组时原样透传（视觉问答）', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const multimodalContent = [
    { type: 'text', text: '解释这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
  ];
  await callChat({
    messages: [{ role: 'user', content: multimodalContent }],
    config: CFG,
    fetchImpl: fakeFetch,
    jsonMode: false,
  });
  assert.ok(Array.isArray(capturedBody.messages[0].content), '数组 content 原样透传');
  assert.strictEqual(capturedBody.messages[0].content[1].type, 'image_url');
});

test('chatPaper 视觉问答：images 把末尾 user 消息升级为多模态数组', async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '图中是 MoE 结构' } }] }) };
  };
  const reply = await chatPaper({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    history: [],
    message: '解释这张图',
    config: CFG,
    fetchImpl: fakeFetch,
    images: ['data:image/png;base64,iVBORw0K'],
  });
  assert.strictEqual(reply, '图中是 MoE 结构');
  const last = capturedBody.messages[capturedBody.messages.length - 1];
  assert.ok(Array.isArray(last.content), '末尾 user content 被升级为数组');
  assert.strictEqual(last.content[0].type, 'text');
  assert.strictEqual(last.content[1].type, 'image_url');
  assert.strictEqual(last.content[1].image_url.url, 'data:image/png;base64,iVBORw0K');
});

test('listModels 上游可达时返回模型列表（合并 extraModels 去重）', async () => {
  const fakeFetch = async (url) => {
    assert.ok(/\/models$/.test(url), '请求 /v1/models');
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'glm-4.5v' }, { id: 'm' }] }),
    };
  };
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', extraModels: ['gpt-4o', 'claude'] } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'upstream');
  const ids = r.models.map((m) => m.id);
  assert.ok(ids.includes('gpt-4o'));
  assert.ok(ids.includes('claude'), 'extraModels 合并进来');
  assert.strictEqual(r.default, 'm');
  // 去重：gpt-4o 在上游和 extraModels 都有，只出现一次
  assert.strictEqual(ids.filter((x) => x === 'gpt-4o').length, 1);
});

test('listModels 上游不可达时回退 config.ai.model + extraModels（永不抛错）', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', extraModels: ['a'] } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'config');
  assert.deepStrictEqual(r.models.map((m) => m.id), ['m', 'a']);
});

test('listModels 无 baseURL 时回退静态候选', async () => {
  const r = await listModels({ config: { ai: { model: 'm' } }, fetchImpl: async () => { throw new Error('x'); } });
  assert.strictEqual(r.source, 'config');
  assert.deepStrictEqual(r.models.map((m) => m.id), ['m']);
});
