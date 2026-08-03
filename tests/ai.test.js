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
  __setBackoffForTests,
} = require('../src/services/ai');

// 全文件禁用真实退避（2s→16s 指数退避会让 429/5xx 重试用例白等 ~30s）；重试次数/语义不受影响
__setBackoffForTests(() => Promise.resolve());

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

// ---- v3.13 多渠道（channels + activeChannelId）----
test('applySettingsOverride 活跃渠道权威覆盖 baseURL/apiKey/model/maxInputTokens', () => {
  const config = { ai: { baseURL: 'http://cfg/v1', apiKey: 'cfg-key', model: 'cfg-model', maxInputTokens: 32000 } };
  const settings = {
    ai: {
      // 旧版顶层覆盖存在时仍被活跃渠道压过（渠道是单一事实源）
      baseURL: 'http://legacy/v1',
      model: 'legacy-model',
      channels: [
        { id: 'ch_a', name: 'A', baseURL: 'http://a/v1', apiKey: 'key-a', model: 'model-a', maxInputTokens: 1000000 },
        { id: 'ch_b', name: 'B', baseURL: 'http://b/v1', apiKey: 'key-b', model: 'model-b' },
      ],
      activeChannelId: 'ch_b',
    },
  };
  const eff = applySettingsOverride(config, settings);
  assert.strictEqual(eff.ai.baseURL, 'http://b/v1');
  assert.strictEqual(eff.ai.apiKey, 'key-b');
  assert.strictEqual(eff.ai.model, 'model-b');
  assert.strictEqual(eff.ai.maxInputTokens, 32000, '渠道未设 tokens 时跟随全局/config');
  // 渠道 model 并入 extraModels（聊天切换器白名单）
  assert.ok(eff.ai.extraModels.includes('model-a'));
  assert.ok(eff.ai.extraModels.includes('model-b'));
  // 原 config 不被修改
  assert.strictEqual(config.ai.model, 'cfg-model');
  assert.strictEqual(config.ai.maxInputTokens, 32000);
});

test('applySettingsOverride 渠道 maxInputTokens 覆盖全局；activeChannelId 未命中则不动三元组', () => {
  const config = { ai: { baseURL: 'http://cfg/v1', apiKey: 'cfg-key', model: 'cfg-model', maxInputTokens: 32000 } };
  const withTokens = applySettingsOverride(config, {
    ai: {
      channels: [{ id: 'ch_a', baseURL: 'http://a/v1', apiKey: 'k', model: 'ma', maxInputTokens: 1000000 }],
      activeChannelId: 'ch_a',
    },
  });
  assert.strictEqual(withTokens.ai.maxInputTokens, 1000000);
  const miss = applySettingsOverride(config, {
    ai: { channels: [{ id: 'ch_a', baseURL: 'http://a/v1', apiKey: 'k', model: 'ma' }], activeChannelId: 'ch_zzz' },
  });
  assert.strictEqual(miss.ai.baseURL, 'http://cfg/v1', 'activeChannelId 未命中时回落 config/旧版字段');
  assert.strictEqual(miss.ai.model, 'cfg-model');
});

test('applySettingsOverride 渠道显式空 apiKey = 无鉴权网关（覆盖 config key）', () => {
  const config = { ai: { baseURL: 'http://cfg/v1', apiKey: 'cfg-key', model: 'm' } };
  const eff = applySettingsOverride(config, {
    ai: {
      channels: [{ id: 'ch_a', baseURL: 'http://local/v1', apiKey: '', model: 'local-model' }],
      activeChannelId: 'ch_a',
    },
  });
  assert.strictEqual(eff.ai.apiKey, '');
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

test('callChat 锁定 temperature 的模型（Kimi k3）：400 提及 temperature → 剥参数重发', async () => {
  const bodies = [];
  const fakeFetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}',
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const out = await callChat({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: fakeFetch,
    jsonMode: false,
  });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(bodies.length, 2, '第一次 400 后重发一次');
  assert.strictEqual(bodies[0].temperature, 0.3, '首发带默认 temperature');
  assert.strictEqual(bodies[1].temperature, undefined, '重发剥掉 temperature');
  assert.strictEqual(bodies[1].top_p, undefined, '重发一并剥掉 top_p');
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
  const fakeFetch = async () => {
    throw new Error('network down');
  };
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', extraModels: ['a'] } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'config');
  assert.deepStrictEqual(
    r.models.map((m) => m.id),
    ['m', 'a'],
  );
});

test('listModels 无 baseURL 时回退静态候选', async () => {
  const r = await listModels({
    config: { ai: { model: 'm' } },
    fetchImpl: async () => {
      throw new Error('x');
    },
  });
  assert.strictEqual(r.source, 'config');
  assert.deepStrictEqual(
    r.models.map((m) => m.id),
    ['m'],
  );
});

// ==================== AI 笔记骨架（generateNotes / buildNotesMessages） ====================

test('buildNotesMessages：默认用 DEFAULT_NOTES_PROMPT，含六段式章节要求', () => {
  const { buildNotesMessages, DEFAULT_NOTES_PROMPT } = require('../src/services/ai');
  const msgs = buildNotesMessages({ title: 'T', abstract: 'A', fulltext: 'F', maxInputChars: 100 });
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[0].content, DEFAULT_NOTES_PROMPT);
  assert.ok(msgs[0].content.includes('## 🎯 研究问题'));
  assert.ok(msgs[0].content.includes('## 🔁 可复用想法'));
  assert.ok(msgs[0].content.includes('（论文未提及）')); // 防幻觉约束
  assert.ok(msgs[1].content.includes('T'));
});

test('buildNotesMessages：自定义 prompt 覆盖 + 全文截断到 maxInputChars', () => {
  const { buildNotesMessages } = require('../src/services/ai');
  const long = 'y'.repeat(500);
  const msgs = buildNotesMessages({
    title: 'T',
    abstract: 'A',
    fulltext: long,
    maxInputChars: 100,
    prompt: '自定义笔记提示词',
  });
  assert.strictEqual(msgs[0].content, '自定义笔记提示词');
  assert.ok(msgs[1].content.length < 500);
  // 空白 prompt 回退默认
  const msgs2 = buildNotesMessages({ title: 'T', fulltext: 'F', prompt: '   ' });
  assert.notStrictEqual(msgs2[0].content, '   ');
});

test('generateNotes 走自由 Markdown 调用（jsonMode:false）并返回原文', async () => {
  const { generateNotes } = require('../src/services/ai');
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '## 🎯 研究问题\nx' } }] }) };
  };
  const md = await generateNotes({ title: 'T', abstract: 'A', fulltext: 'F', config: CFG, fetchImpl: fakeFetch });
  assert.strictEqual(md, '## 🎯 研究问题\nx');
  assert.strictEqual(capturedBody.response_format, undefined); // 不强制 json_object
  assert.strictEqual(capturedBody.messages[0].role, 'system');
});

test('generateNotes 非 2xx 抛错（供路由 502 分支）', async () => {
  const { generateNotes } = require('../src/services/ai');
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => generateNotes({ config: CFG, fetchImpl: fakeFetch }), /500/);
});

// ==================== callChatStream（SSE 流式） ====================

/** 把 SSE 文本包装成 Web ReadableStream（单 chunk 推送后关闭） */
function sseStream(sseText) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sseText));
      c.close();
    },
  });
}

test('callChatStream 消费 SSE 流：delta.content 累积、reasoning 单独回调、[DONE] 结束', async () => {
  const { callChatStream } = require('../src/services/ai');
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"先思考一下"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  let capturedBody;
  const tokens = [];
  const reply = await callChatStream({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, body: sseStream(sse) };
    },
    onToken: (t, kind) => {
      tokens.push([t, kind]);
    },
  });
  assert.strictEqual(reply, '你好，世界', '返回值只累积 content（不含 reasoning）');
  assert.deepStrictEqual(tokens, [
    ['先思考一下', 'reasoning'],
    ['你好', 'content'],
    ['，世界', 'content'],
  ]);
  assert.strictEqual(capturedBody.stream, true, '流式请求带 stream:true');
});

test('callChatStream 无 body.getReader 时回退 parseSseBody（text() 整体解析）', async () => {
  const { callChatStream } = require('../src/services/ai');
  const sse =
    'data: {"choices":[{"delta":{"content":"整段"}}]}\n\ndata: {"choices":[{"delta":{"content":"回复"}}]}\n\ndata: [DONE]\n\n';
  const tokens = [];
  const reply = await callChatStream({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: async () => ({ ok: true, body: null, text: async () => sse }), // 无 getReader
    onToken: (t, kind) => {
      tokens.push([t, kind]);
    },
  });
  assert.strictEqual(reply, '整段回复');
  assert.deepStrictEqual(tokens, [
    ['整段', 'content'],
    ['回复', 'content'],
  ]);
});

test('callChatStream onToken 返回 false 时该块 content 不计入 reply', async () => {
  const { callChatStream } = require('../src/services/ai');
  const sse =
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n';
  const reply = await callChatStream({
    messages: [{ role: 'user', content: 'hi' }],
    config: CFG,
    fetchImpl: async () => ({ ok: true, body: sseStream(sse) }),
    onToken: (t) => t !== 'B', // 对 B 返回 false（模拟客户端中止）
  });
  assert.strictEqual(reply, 'A', 'onToken 返回 false 的块不累积进 reply');
});

// ==================== callChat 重试 / chatParams 透传 ====================

test('callChat 5xx 重试耗尽后抛最后一次错误（1+4 次尝试）', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  // 退避已被文件顶部 __setBackoffForTests 禁用（否则真实退避 ~30s）
  await assert.rejects(
    () => callChat({ messages: [{ role: 'user', content: 'hi' }], config: CFG, fetchImpl: fakeFetch, jsonMode: false }),
    /AI HTTP 500: boom/,
    '重试耗尽后应抛最后一次错误',
  );
  assert.strictEqual(calls, 5, '1 次原始请求 + 4 次重试');
});

test('callChat chatParams 透传 temperature/topP/maxTokens/thinking 到请求体', async () => {
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
    chatParams: { temperature: 0.7, topP: 0.9, maxTokens: 128, thinking: { type: 'enabled' } },
  });
  assert.strictEqual(capturedBody.temperature, 0.7, 'temperature 覆盖默认 0.3');
  assert.strictEqual(capturedBody.top_p, 0.9, 'topP → top_p');
  assert.strictEqual(capturedBody.max_tokens, 128, 'maxTokens → max_tokens');
  assert.deepStrictEqual(capturedBody.thinking, { type: 'enabled' }, 'thinking 原样透传（GLM 格式）');
  // 无 chatParams 时用默认值，且不挂可选字段
  await callChat({ messages: [{ role: 'user', content: 'hi' }], config: CFG, fetchImpl: fakeFetch, jsonMode: false });
  assert.strictEqual(capturedBody.temperature, 0.3, '默认 temperature 0.3');
  assert.ok(!('top_p' in capturedBody), '无 topP 时不挂 top_p');
  assert.ok(!('max_tokens' in capturedBody), '无 maxTokens 时不挂 max_tokens');
  assert.ok(!('thinking' in capturedBody), '无 thinking 时不挂 thinking');
});

// ==================== applySettingsOverride 补充分支 ====================

test('applySettingsOverride 覆盖 translate 段（engine/targetLang，未设透传）', () => {
  const config = { ai: {}, translate: { engine: 'google', targetLang: 'zh' } };
  const eff = applySettingsOverride(config, { translate: { engine: 'ai' } });
  assert.strictEqual(eff.translate.engine, 'ai', 'engine 覆盖');
  assert.strictEqual(eff.translate.targetLang, 'zh', '未设字段透传 config');
  const eff2 = applySettingsOverride(config, { translate: { targetLang: 'en' } });
  assert.strictEqual(eff2.translate.targetLang, 'en', 'targetLang 覆盖');
  assert.strictEqual(eff2.translate.engine, 'google');
  assert.strictEqual(config.translate.engine, 'google', '不改原 config');
});

test('applySettingsOverride ai 段空字符串 baseURL/model 不覆盖（空串=未设置）', () => {
  const config = { ai: { baseURL: 'http://a/v1', model: 'm1', apiKey: 'k' } };
  const eff = applySettingsOverride(config, { ai: { baseURL: '', model: '' } });
  assert.strictEqual(eff.ai.baseURL, 'http://a/v1', 'baseURL 空串不覆盖');
  assert.strictEqual(eff.ai.model, 'm1', 'model 空串不覆盖');
  assert.strictEqual(config.ai.baseURL, 'http://a/v1', '不改原 config');
});

// ==================== listModels 补充分支 ====================

test('listModels 上游 ok 但列表为空 → 回退 config 静态候选', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', extraModels: ['a'] } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'config', '空列表回退 config');
  assert.deepStrictEqual(
    r.models.map((m) => m.id),
    ['m', 'a'],
  );
});

test('listModels 支持 data.models 备选结构（字符串与对象混合）', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ models: ['glm-4', { id: 'gpt-4o', owned_by: 'openai' }] }),
  });
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', extraModels: ['glm-4'] } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'upstream');
  assert.deepStrictEqual(
    r.models.map((m) => m.id),
    ['glm-4', 'gpt-4o'],
    '字符串元素转 {id}，extraModels 去重',
  );
  assert.strictEqual(r.models[1].owned_by, 'openai', '对象元素保留 owned_by');
});

test('listModels 上游非 2xx → 回退 config（不读 body、不抛错）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 502 });
  const r = await listModels({
    config: { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm' } },
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(r.source, 'config');
  assert.deepStrictEqual(
    r.models.map((m) => m.id),
    ['m'],
  );
});

// ==================== buildSummaryMessages / buildTagsMessages 提示词覆盖 ====================

test('buildSummaryMessages 自定义 prompt 覆盖默认总结提示词（空白回退默认）', () => {
  const { buildSummaryMessages, DEFAULT_SUMMARY_PROMPT } = require('../src/services/ai');
  const msgs = buildSummaryMessages({ title: 'T', abstract: 'A', fulltext: 'F', prompt: '自定义总结提示词' });
  assert.strictEqual(msgs[0].content, '自定义总结提示词', '自定义 prompt 作为 system');
  assert.ok(msgs[1].content.includes('T'), 'user 含标题');
  const blank = buildSummaryMessages({ title: 'T', fulltext: 'F', prompt: '   ' });
  assert.strictEqual(blank[0].content, DEFAULT_SUMMARY_PROMPT, '空白 prompt 回退默认');
  const none = buildSummaryMessages({ title: 'T', fulltext: 'F' });
  assert.strictEqual(none[0].content, DEFAULT_SUMMARY_PROMPT, '无 prompt 回退默认');
});

test('buildTagsMessages 自定义 prompt 覆盖默认标签提示词（空白回退默认）', () => {
  const { buildTagsMessages, DEFAULT_TAGS_PROMPT } = require('../src/services/ai');
  const msgs = buildTagsMessages({ title: 'T', abstract: 'A', fulltext: 'F', prompt: '自定义标签提示词' });
  assert.strictEqual(msgs[0].content, '自定义标签提示词');
  assert.ok(msgs[1].content.includes('tags / topics / metadata'), 'user 含 JSON 输出要求');
  const blank = buildTagsMessages({ title: 'T', fulltext: 'F', prompt: '  ' });
  assert.strictEqual(blank[0].content, DEFAULT_TAGS_PROMPT, '空白 prompt 回退默认');
  const none = buildTagsMessages({ title: 'T', fulltext: 'F' });
  assert.strictEqual(none[0].content, DEFAULT_TAGS_PROMPT);
});

// ============================================================================
// v3.9 公式抽取 + 每任务输入预算
// ============================================================================

test('resolveMaxInputChars：任务级 > 全局 > 内置默认', () => {
  const { resolveMaxInputChars, tokensToCharBudget } = require('../src/services/ai');
  // 无任何配置 → v3.11 起内置默认是 tokens(32000)×3.5=112000（旧 24000 字符已废弃）
  assert.strictEqual(resolveMaxInputChars({}, 'summary'), tokensToCharBudget(32000));
  assert.strictEqual(resolveMaxInputChars({ ai: {} }, 'summary'), tokensToCharBudget(32000));
  // 全局 maxInputChars（旧别名，原值直传不折算）
  assert.strictEqual(resolveMaxInputChars({ ai: { maxInputChars: 8000 } }, 'summary'), 8000);
  // 任务级覆盖全局
  const cfg = { ai: { maxInputChars: 8000, taskMaxInputChars: { formulas: 120000 } } };
  assert.strictEqual(resolveMaxInputChars(cfg, 'formulas'), 120000);
  assert.strictEqual(resolveMaxInputChars(cfg, 'summary'), 8000, '未设置的任务跟随全局');
  // null / 空串 = 跟随全局（设置页清空即回落）
  const cfg2 = { ai: { maxInputChars: 8000, taskMaxInputChars: { summary: null, tags: '' } } };
  assert.strictEqual(resolveMaxInputChars(cfg2, 'summary'), 8000);
  assert.strictEqual(resolveMaxInputChars(cfg2, 'tags'), 8000);
  // 未知任务名安全回落
  assert.strictEqual(resolveMaxInputChars(cfg, 'nope'), 8000);
});

test('applySettingsOverride：taskMaxInputChars 深合并且保留未覆盖的任务键', () => {
  const config = { ai: { model: 'm', maxInputChars: 24000, taskMaxInputChars: { formulas: 100000, summary: 30000 } } };
  const eff = applySettingsOverride(config, { ai: { taskMaxInputChars: { formulas: 200000 } } });
  assert.strictEqual(eff.ai.taskMaxInputChars.formulas, 200000, '覆盖生效');
  assert.strictEqual(eff.ai.taskMaxInputChars.summary, 30000, '未覆盖的键保留');
  assert.strictEqual(config.ai.taskMaxInputChars.formulas, 100000, '不改原 config');
  // 显式 null 写回（设置页清空 → 跟随全局）
  const eff2 = applySettingsOverride(config, { ai: { taskMaxInputChars: { summary: null } } });
  assert.strictEqual(eff2.ai.taskMaxInputChars.summary, null);
});

// ---- v3.11：输入上限改 tokens（OpenAI 标准），旧 chars 字段作废弃别名 ----

test('tokensToCharBudget：tokens×3.5 向下取整；非正/NaN→0', () => {
  const { tokensToCharBudget } = require('../src/services/ai');
  assert.strictEqual(tokensToCharBudget(1000), 3500);
  assert.strictEqual(tokensToCharBudget(1000000), 3500000);
  assert.strictEqual(tokensToCharBudget(0), 0);
  assert.strictEqual(tokensToCharBudget(-5), 0);
  assert.strictEqual(tokensToCharBudget(NaN), 0);
  assert.strictEqual(tokensToCharBudget('abc'), 0);
  assert.strictEqual(tokensToCharBudget('1000'), 3500, '数字字符串也接受');
});

test('resolveMaxInputChars：tokens 优先级（taskTokens > globalTokens > taskChars > globalChars > 默认）', () => {
  const { resolveMaxInputChars, tokensToCharBudget } = require('../src/services/ai');
  // 1. 无任何配置 → 默认 tokens（32000×3.5=112000）
  assert.strictEqual(resolveMaxInputChars({}, 'summary'), tokensToCharBudget(32000));
  // 2. 全局 tokens
  assert.strictEqual(resolveMaxInputChars({ ai: { maxInputTokens: 1000000 } }, 'summary'), tokensToCharBudget(1000000));
  // 3. 任务级 tokens 覆盖全局 tokens
  const cfg = { ai: { maxInputTokens: 1000000, taskMaxInputTokens: { formulas: 200000 } } };
  assert.strictEqual(resolveMaxInputChars(cfg, 'formulas'), tokensToCharBudget(200000));
  assert.strictEqual(resolveMaxInputChars(cfg, 'summary'), tokensToCharBudget(1000000), '未设置任务跟随全局 tokens');
  // 4. tokens 优先于旧 chars：同时设了 tokens 和 chars → 走 tokens
  const cfg2 = { ai: { maxInputTokens: 50000, maxInputChars: 8000 } };
  assert.strictEqual(resolveMaxInputChars(cfg2, 'summary'), tokensToCharBudget(50000), 'tokens 优先于 chars');
  // 5. 仅旧 chars（兼容存量 config.json）→ 原值直传（不折算）
  assert.strictEqual(resolveMaxInputChars({ ai: { maxInputChars: 8000 } }, 'summary'), 8000);
  assert.strictEqual(
    resolveMaxInputChars({ ai: { maxInputChars: 8000, taskMaxInputChars: { formulas: 120000 } } }, 'formulas'),
    120000,
    '旧任务级 chars 也原值直传',
  );
  // 6. null / 空串 / 非正数 = 跟随（回落到下一优先级）
  const cfg3 = { ai: { maxInputTokens: 50000, taskMaxInputTokens: { summary: null, tags: '' } } };
  assert.strictEqual(resolveMaxInputChars(cfg3, 'summary'), tokensToCharBudget(50000));
  assert.strictEqual(resolveMaxInputChars(cfg3, 'tags'), tokensToCharBudget(50000));
  // 7. tokens 都没设、chars 设了 → 旧 chars 优先于默认 tokens
  assert.strictEqual(
    resolveMaxInputChars({ ai: { maxInputChars: 8000, maxInputTokens: 0 } }, 'summary'),
    8000,
    'maxInputTokens=0 视为未设→回退 chars',
  );
});

test('applySettingsOverride：maxInputTokens / taskMaxInputTokens 覆盖 + 深合并', () => {
  const config = {
    ai: { model: 'm', maxInputTokens: 32000, taskMaxInputTokens: { formulas: 200000, summary: 50000 } },
  };
  const eff = applySettingsOverride(config, {
    ai: { maxInputTokens: 1000000, taskMaxInputTokens: { formulas: 500000 } },
  });
  assert.strictEqual(eff.ai.maxInputTokens, 1000000, '全局 tokens 覆盖');
  assert.strictEqual(eff.ai.taskMaxInputTokens.formulas, 500000, '任务 tokens 覆盖');
  assert.strictEqual(eff.ai.taskMaxInputTokens.summary, 50000, '未覆盖任务保留');
  assert.strictEqual(config.ai.maxInputTokens, 32000, '不改原 config');
  // 空串视为未设（与 ai.apiKey 语义一致）
  const eff2 = applySettingsOverride(config, { ai: { maxInputTokens: '' } });
  assert.strictEqual(eff2.ai.maxInputTokens, 32000, '空串不覆盖');
});

test('listModels：从网关 /v1/models 抓 context_length（多字段名兜底）', async () => {
  const { listModels } = require('../src/services/ai');
  const config = { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'glm-4.6' } };
  // OpenRouter 风格：顶层 context_length
  const fr = (data) => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => data,
  });
  let r = await listModels({
    config,
    fetchImpl: fr({
      data: [
        { id: 'glm-4.6', context_length: 1000000 },
        { id: 'gpt-4o', context_length: 128000 },
      ],
    }),
  });
  assert.strictEqual(r.models[0].contextLength, 1000000);
  assert.strictEqual(r.models[1].contextLength, 128000);
  // 驼峰 contextLength
  r = await listModels({ config, fetchImpl: fr({ data: [{ id: 'm1', contextLength: 64000 }] }) });
  assert.strictEqual(r.models[0].contextLength, 64000);
  // top_provider.context_length（OpenRouter 嵌套）
  r = await listModels({ config, fetchImpl: fr({ data: [{ id: 'm2', top_provider: { context_length: 131072 } }] }) });
  assert.strictEqual(r.models[0].contextLength, 131072);
  // max_input_tokens 别名
  r = await listModels({ config, fetchImpl: fr({ data: [{ id: 'm3', max_input_tokens: 8192 }] }) });
  assert.strictEqual(r.models[0].contextLength, 8192);
  // OpenAI 原生（无该字段）→ null
  r = await listModels({ config, fetchImpl: fr({ data: [{ id: 'm4', object: 'model', owned_by: 'openai' }] }) });
  assert.strictEqual(r.models[0].contextLength, null);
  // 非正/垃圾值 → null
  r = await listModels({
    config,
    fetchImpl: fr({
      data: [
        { id: 'm5', context_length: 0 },
        { id: 'm6', context_length: 'abc' },
      ],
    }),
  });
  assert.strictEqual(r.models[0].contextLength, null);
  assert.strictEqual(r.models[1].contextLength, null);
  // fallback（上游不可达）也带 contextLength:null
  r = await listModels({
    config,
    fetchImpl: async () => {
      throw new Error('net');
    },
  });
  assert.ok(r.models.every((m) => m.contextLength === null));
});

test('pickMathDenseText：未超预算原样返回', () => {
  const { pickMathDenseText } = require('../src/services/ai');
  const t = 'abc\n\ndef';
  assert.strictEqual(pickMathDenseText(t, 1000), t);
  assert.strictEqual(pickMathDenseText('', 1000), '');
  assert.strictEqual(pickMathDenseText(null, 1000), '');
});

test('pickMathDenseText：超预算时优先保留数学密集段且保持原文顺序', () => {
  const { pickMathDenseText } = require('../src/services/ai');
  const filler = (tag) => `${tag} ` + 'plain narrative words here '.repeat(12);
  // 用真实 Unicode 数学符号 —— pdfjs 抽出的正文正是这个形态（而非 LaTeX 命令）
  const mathy = (tag) => `${tag} L(θ) = ∑ᵢ ∇θ log p ≤ ε ∈ Θ ∏ⱼ αⱼ ⊗ √λ ≥ ∂μ`;
  // 顺序：填充 A / 数学 M1 / 填充 B / 数学 M2 / 填充 C
  const text = [filler('A'), mathy('M1'), filler('B'), mathy('M2'), filler('C')].join('\n\n');
  const out = pickMathDenseText(text, 400);
  assert.ok(out.length <= 400 + 20, '大致落在预算内，实际=' + out.length);
  assert.ok(out.includes('M1'), '保留数学段 M1');
  assert.ok(out.includes('M2'), '保留数学段 M2');
  assert.ok(out.indexOf('M1') < out.indexOf('M2'), '保持原文顺序');
});

test('pickMathDenseText：全篇无数学符号时退化为头部截断（不返回空）', () => {
  const { pickMathDenseText } = require('../src/services/ai');
  const text = 'plain paragraph text here.\n\n'.repeat(60);
  const out = pickMathDenseText(text, 200);
  assert.ok(out.length > 0);
  assert.ok(out.length <= 220);
});

test('parseFormulaResult：容忍 {formulas:[…]} / 裸数组 / 代码块 / 噪声', () => {
  const { parseFormulaResult } = require('../src/services/ai');
  assert.deepStrictEqual(parseFormulaResult('{"formulas":[{"canonicalName":"softmax","latex":"x"}]}'), [
    { canonicalName: 'softmax', latex: 'x' },
  ]);
  assert.deepStrictEqual(parseFormulaResult('[{"canonicalName":"elbo","latex":"y"}]'), [
    { canonicalName: 'elbo', latex: 'y' },
  ]);
  assert.strictEqual(parseFormulaResult('```json\n{"formulas":[{"canonicalName":"a","latex":"b"}]}\n```').length, 1);
  assert.deepStrictEqual(parseFormulaResult('not json'), []);
  assert.deepStrictEqual(parseFormulaResult(''), []);
  assert.deepStrictEqual(parseFormulaResult('{"formulas":"nope"}'), []);
});

test('buildFormulaMessages：注入已有公式清单 + 三级提示词回退', () => {
  const { buildFormulaMessages, DEFAULT_FORMULA_PROMPT } = require('../src/services/ai');
  const msgs = buildFormulaMessages({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    existingFormulas: [
      { canonicalName: 'softmax', latex: '\\sigma(z)' },
      { canonicalName: 'elbo', latex: '\\mathcal{L}' },
    ],
  });
  assert.strictEqual(msgs[0].content, DEFAULT_FORMULA_PROMPT);
  assert.ok(msgs[1].content.includes('softmax'), 'user 含已有规范名');
  assert.ok(msgs[1].content.includes('\\sigma(z)'), 'user 含已有 latex');
  // 自定义 prompt 覆盖；空白回退
  assert.strictEqual(
    buildFormulaMessages({ title: 'T', fulltext: 'F', prompt: '自定义公式提示词' })[0].content,
    '自定义公式提示词',
  );
  assert.strictEqual(
    buildFormulaMessages({ title: 'T', fulltext: 'F', prompt: '  ' })[0].content,
    DEFAULT_FORMULA_PROMPT,
  );
  // 无已有公式时给占位，不炸
  assert.ok(buildFormulaMessages({ title: 'T', fulltext: 'F' })[1].content.includes('（暂无）'));
});

test('buildFormulaMessages：全文经数学密度预筛后受 maxInputChars 约束', () => {
  const { buildFormulaMessages } = require('../src/services/ai');
  const msgs = buildFormulaMessages({ title: 'T', fulltext: 'x'.repeat(5000), maxInputChars: 300 });
  assert.ok(msgs[1].content.length < 1200, '全文被裁剪，实际=' + msgs[1].content.length);
});

test('extractFormulas：走 jsonMode + 注入 fetch，返回公式数组', async () => {
  const { extractFormulas } = require('../src/services/ai');
  let sawBody = null;
  const fakeFetch = async (url, opt) => {
    assert.ok(/\/chat\/completions$/.test(url));
    sawBody = JSON.parse(opt.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              // JSON 里 LaTeX 反斜杠要转义：JS 源 \\\\ → JS 串 \\ → JSON 解析出 \sigma
              content: '{"formulas":[{"canonicalName":"softmax","name":"归一化指数函数","latex":"\\\\sigma(z)"}]}',
            },
          },
        ],
      }),
    };
  };
  const items = await extractFormulas({
    title: 'T',
    abstract: 'A',
    fulltext: 'F',
    existingFormulas: [],
    config: CFG,
    fetchImpl: fakeFetch,
  });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].canonicalName, 'softmax');
  assert.deepStrictEqual(sawBody.response_format, { type: 'json_object' }, '公式抽取必须走 JSON 模式');
});

test('extractFormulas：读 taskMaxInputChars.formulas 而非全局 maxInputChars', async () => {
  const { extractFormulas } = require('../src/services/ai');
  let userMsg = '';
  const fakeFetch = async (_url, opt) => {
    userMsg = JSON.parse(opt.body).messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"formulas":[]}' } }] }) };
  };
  const cfg = { ai: { ...CFG.ai, maxInputChars: 50, taskMaxInputChars: { formulas: 3000 } } };
  await extractFormulas({ title: 'T', fulltext: 'y'.repeat(2000), config: cfg, fetchImpl: fakeFetch });
  assert.ok(userMsg.length > 1500, '应使用任务级 3000 而非全局 50，实际 user 长度=' + userMsg.length);
});

test('callChat：chatParams.timeoutMs 覆盖 config.ai.timeoutMs（单次调用级超时）', async () => {
  // fakeFetch 挂起直到 signal abort；chatParams.timeoutMs=50 应远早于 config 的 1000ms 触发
  const fakeFetch = (_url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const t0 = Date.now();
  await assert.rejects(
    callChat({
      messages: [{ role: 'user', content: 'hi' }],
      config: CFG, // timeoutMs: 1000
      fetchImpl: fakeFetch,
      jsonMode: false,
      chatParams: { timeoutMs: 50, maxRetries: 0 },
    }),
    /aborted/,
  );
  assert.ok(Date.now() - t0 < 900, '应使用 chatParams.timeoutMs=50 而非 config 的 1000ms');
});

test('callChat：chatParams.maxRetries 覆盖默认 4 次重试', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    throw new Error('network down');
  };
  await assert.rejects(
    callChat({
      messages: [{ role: 'user', content: 'hi' }],
      config: CFG,
      fetchImpl: fakeFetch,
      jsonMode: false,
      chatParams: { maxRetries: 0 },
    }),
    /network down/,
  );
  assert.strictEqual(calls, 1, 'maxRetries:0 应只尝试 1 次（默认会 5 次）');
});

test('generateConceptMap：流式自由输出（非 JSON 模式）+ 剥 ```html 围栏', async () => {
  const { generateConceptMap } = require('../src/services/ai');
  let sawBody;
  const sse = (text) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  const fakeFetch = async (_url, opt) => {
    sawBody = JSON.parse(opt.body);
    return { ok: true, text: async () => sse('```html\n<html><body>MAP</body></html>\n```') };
  };
  const html = await generateConceptMap({
    concepts: [{ term: 'Attention', definition: 'd', category: 'model', paperIds: ['p1'] }],
    config: CFG,
    fetchImpl: fakeFetch,
    prompt: '',
  });
  assert.strictEqual(html, '<html><body>MAP</body></html>');
  assert.strictEqual(sawBody.stream, true, '概念地图大产出必须走流式（非流式长请求会被代理空闲超时掐断）');
  assert.strictEqual(sawBody.response_format, undefined, '概念地图是 HTML 产出，不能强制 json_object');
  assert.ok(sawBody.messages[1].content.includes('Attention'), '概念清单应注入 user 消息');
});

test('generateConceptMap：prevHtml 注入（优化模式）', async () => {
  const { generateConceptMap } = require('../src/services/ai');
  let sawBody;
  const sse = (text) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  const fakeFetch = async (_url, opt) => {
    sawBody = JSON.parse(opt.body);
    return { ok: true, text: async () => sse('<html>v2</html>') };
  };
  await generateConceptMap({
    concepts: [{ term: 'X', paperIds: [] }],
    config: CFG,
    fetchImpl: fakeFetch,
    prompt: '改成矩阵图',
    prevHtml: '<html>v1</html>',
  });
  assert.ok(sawBody.messages[1].content.includes('<html>v1</html>'), 'prevHtml 应喂给模型做增量优化');
});
