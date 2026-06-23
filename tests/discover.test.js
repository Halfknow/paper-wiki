const test = require('node:test');
const assert = require('node:assert');
const {
  buildDiscoveryQuery,
  enrichWithCitations,
  enrichWithOpenAlex,
  discoverPapers,
  parseClaudeOutput,
  computeRelevance,
  planViaGateway,
} = require('../lib/discover');

// 两条假 arXiv entry，第一条已在库里（用来验证去重）
const ENTRY_A = {
  title: 'Mixture of Experts',
  id: 'http://arxiv.org/abs/2401.11111v1',
  summary: 'We study sparse mixture of experts.',
  published: '2024-01-02T00:00:00Z',
  authors: ['Alice'],
  primaryCategory: 'cs.LG',
  pdfUrl: 'http://arxiv.org/pdf/2401.11111v1',
};
const ENTRY_B = {
  title: 'A Survey of RAG',
  id: 'http://arxiv.org/abs/2502.22222v1',
  summary: 'Retrieval augmented generation survey.',
  published: '2025-02-03T00:00:00Z',
  authors: ['Bob'],
  primaryCategory: 'cs.CL',
  pdfUrl: 'http://arxiv.org/pdf/2502.22222v1',
};

// 构造 claude --output-format json 的输出（外层 {result}，result 是模型说的 JSON 串）。
// 用 JSON.stringify 串两层，避免手写多层 \" 转义出错。
function claudeStdout(obj, { fenced = false } = {}) {
  let inner = JSON.stringify(obj);
  if (fenced) inner = '```json\n' + inner + '\n```';
  return JSON.stringify({ result: inner });
}

// 多数 discover 测试不关心引用量，给个「整批失败」的假 fetch 占位
const failFetch = async () => ({ ok: false, status: 500, json: async () => [] });

test('parseClaudeOutput 解析 claude --output-format json 的双层结构', () => {
  const r = parseClaudeOutput(claudeStdout({ query: 'ti:"rag" OR abs:"retrieval"', note: '检索 RAG' }));
  assert.strictEqual(r.query, 'ti:"rag" OR abs:"retrieval"');
  assert.strictEqual(r.note, '检索 RAG');
});

test('parseClaudeOutput 容忍 ```json 围栏', () => {
  const r = parseClaudeOutput(claudeStdout({ query: 'abs:"moe"', note: 'x' }, { fenced: true }));
  assert.strictEqual(r.query, 'abs:"moe"');
});

test('parseClaudeOutput 非法输出返回 null', () => {
  assert.strictEqual(parseClaudeOutput(''), null);
  assert.strictEqual(parseClaudeOutput('not json at all'), null);
});

test('parseClaudeOutput 解析新版数组消息格式（取 result 消息里的 JSON）', () => {
  const arr = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: {} },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({ queries: ['ti:"x"'], keyterms: ['x'], note: 'n' }),
    },
  ];
  const r = parseClaudeOutput(JSON.stringify(arr));
  assert.deepStrictEqual(r.queries, ['ti:"x"']);
});

test('parseClaudeOutput 数组中 is_error 的 result 视为失败(null)', () => {
  const arr = [{ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401' }];
  assert.strictEqual(parseClaudeOutput(JSON.stringify(arr)), null);
});

// ---------------- 网关(GLM)兜底查询理解 ----------------

test('planViaGateway: 用注入的 ai 网关生成并解析计划', async () => {
  const fakeAi = { callChat: async () => JSON.stringify({ queries: ['ti:"moe"'], keyterms: ['moe'], note: 'n' }) };
  const r = await planViaGateway('混合专家', { config: { ai: {} }, ai: fakeAi });
  assert.deepStrictEqual(r.queries, ['ti:"moe"']);
});

test('planViaGateway: 网关报错返回 null', async () => {
  const fakeAi = {
    callChat: async () => {
      throw new Error('500');
    },
  };
  const r = await planViaGateway('x', { config: { ai: {} }, ai: fakeAi });
  assert.strictEqual(r, null);
});

test('buildDiscoveryQuery: claude 失败时用网关(gateway)兜底生成计划', async () => {
  const fakeClaude = async () => ({ ok: false, reason: 'nonzero', stdout: '', code: 1 });
  const fakeGateway = async () => ({
    queries: ['ti:"rag"'],
    keyterms: ['rag'],
    categories: ['cs.CL'],
    note: '网关生成',
  });
  const r = await buildDiscoveryQuery('检索增强', { runClaude: fakeClaude, generateViaGateway: fakeGateway });
  assert.strictEqual(r.usedClaude, false);
  assert.strictEqual(r.engine, 'gateway');
  assert.deepStrictEqual(r.queries, ['ti:"rag"']);
  assert.strictEqual(r.claudeFailReason, 'nonzero', '保留 claude 失败原因供提示');
});

test('buildDiscoveryQuery: claude 成功时不调用网关，engine=claude', async () => {
  let gwCalled = false;
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['ti:"a"'], keyterms: ['a'], note: 'n' }),
    code: 0,
    reason: null,
  });
  const r = await buildDiscoveryQuery('t', {
    runClaude: fakeClaude,
    generateViaGateway: async () => {
      gwCalled = true;
      return { queries: ['x'] };
    },
  });
  assert.strictEqual(r.engine, 'claude');
  assert.strictEqual(r.usedClaude, true);
  assert.strictEqual(gwCalled, false);
});

test('buildDiscoveryQuery: queryEngine=gateway 时跳过 claude 直接用网关', async () => {
  let claudeCalled = false;
  const fakeClaude = async () => {
    claudeCalled = true;
    return { ok: true, stdout: claudeStdout({ queries: ['x'] }), code: 0, reason: null };
  };
  const fakeGateway = async () => ({ queries: ['ti:"g"'], keyterms: ['g'], note: 'n' });
  const r = await buildDiscoveryQuery('t', {
    runClaude: fakeClaude,
    generateViaGateway: fakeGateway,
    queryEngine: 'gateway',
  });
  assert.strictEqual(claudeCalled, false, 'queryEngine=gateway 不应调用 claude');
  assert.strictEqual(r.engine, 'gateway');
});

test('buildDiscoveryQuery: claude 与网关都失败时回退原始主题，engine=fallback', async () => {
  const r = await buildDiscoveryQuery('foo bar', {
    runClaude: async () => ({ ok: false, reason: 'not_found', stdout: '', code: 127 }),
    generateViaGateway: async () => null,
  });
  assert.strictEqual(r.query, 'all:"foo bar"');
  assert.strictEqual(r.engine, 'fallback');
  assert.strictEqual(r.claudeFailReason, 'not_found');
});

test('buildDiscoveryQuery: claude 成功时用其 query（旧单 query 形态向后兼容）', async () => {
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ query: 'ti:"moe"', note: '混合专家' }),
    stderr: '',
    code: 0,
    reason: null,
  });
  const r = await buildDiscoveryQuery('混合专家', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, true);
  assert.strictEqual(r.query, 'ti:"moe"');
  assert.deepStrictEqual(r.queries, ['ti:"moe"']);
  assert.strictEqual(r.note, '混合专家');
  assert.strictEqual(r.claudeFailReason, null);
});

test('buildDiscoveryQuery: 解析结构化查询计划(queries/categories/keyterms)', async () => {
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({
      queries: ['ti:"moe"', 'abs:"mixture of experts"'],
      categories: ['cs.LG', 'cs.CL'],
      keyterms: ['mixture of experts', 'moe'],
      note: '混合专家相关',
    }),
    code: 0,
    reason: null,
  });
  const r = await buildDiscoveryQuery('混合专家', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, true);
  assert.deepStrictEqual(r.queries, ['ti:"moe"', 'abs:"mixture of experts"']);
  assert.strictEqual(r.query, 'ti:"moe"', 'query 为首条，向后兼容');
  assert.deepStrictEqual(r.categories, ['cs.LG', 'cs.CL']);
  assert.ok(r.keyterms.includes('moe'));
  assert.ok(r.keyterms.includes('mixture of experts'));
});

test('buildDiscoveryQuery: claude 不可用(not_found)回退原始主题', async () => {
  const fakeClaude = async () => ({ ok: false, stdout: '', stderr: 'not found', code: 127, reason: 'not_found' });
  const r = await buildDiscoveryQuery('mixture of experts', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, false);
  assert.strictEqual(r.query, 'all:"mixture of experts"');
  assert.strictEqual(r.claudeFailReason, 'not_found');
});

test('buildDiscoveryQuery: 回退时也给出 queries 与 keyterms', async () => {
  const fakeClaude = async () => ({ ok: false, stdout: '', stderr: '', code: 127, reason: 'not_found' });
  const r = await buildDiscoveryQuery('mixture of experts', { runClaude: fakeClaude });
  assert.deepStrictEqual(r.queries, ['all:"mixture of experts"']);
  assert.ok(r.keyterms.includes('mixture of experts'), '回退也要有 keyterms 供相关度打分');
});

test('buildDiscoveryQuery: claude 超时回退', async () => {
  const fakeClaude = async () => ({ ok: false, stdout: '', stderr: '', code: null, reason: 'timeout' });
  const r = await buildDiscoveryQuery('rag', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, false);
  assert.strictEqual(r.query, 'all:"rag"');
  assert.strictEqual(r.claudeFailReason, 'timeout');
});

test('buildDiscoveryQuery: claude 输出非法回退', async () => {
  const fakeClaude = async () => ({ ok: true, stdout: 'garbage', stderr: '', code: 0, reason: null });
  const r = await buildDiscoveryQuery('rag', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, false);
  assert.strictEqual(r.claudeFailReason, 'bad_output');
});

test('buildDiscoveryQuery: 空主题回退（不调用 claude）', async () => {
  let called = false;
  const fakeClaude = async () => {
    called = true;
    return { ok: true, stdout: claudeStdout({ query: 'x' }), code: 0, reason: null };
  };
  const r = await buildDiscoveryQuery('   ', { runClaude: fakeClaude });
  assert.strictEqual(r.usedClaude, false);
  assert.strictEqual(called, false, '空主题不应调用 claude');
  assert.strictEqual(r.query, 'all:""');
});

// ---------------- 相关度打分 ----------------

test('computeRelevance: 关键词全命中=1，无命中=0，部分命中=比例', () => {
  assert.strictEqual(computeRelevance(['mixture of experts'], 'Sparse Mixture of Experts', 'experts mixture model'), 1);
  assert.strictEqual(computeRelevance(['diffusion'], 'foo bar', 'baz qux'), 0);
  assert.strictEqual(computeRelevance([], 'foo', 'bar'), 0, '无关键词→0');
  assert.strictEqual(computeRelevance(['mixture', 'diffusion'], 'mixture model', 'x'), 0.5, '命中一半→0.5');
});

// ---------------- 引用量补全 ----------------

test('enrichWithCitations: S2 成功时给每个 entry 补 citationCount', async () => {
  const fakeFetch = async (url, opt) => {
    assert.match(url, /paper\/batch/);
    const body = JSON.parse(opt.body);
    assert.deepStrictEqual(body.ids, ['ArXiv:2401.11111', 'ArXiv:2502.22222']);
    return {
      ok: true,
      json: async () => [
        { citationCount: 100, year: 2024 },
        { citationCount: 5, year: 2025 },
      ],
    };
  };
  const r = await enrichWithCitations([ENTRY_A, ENTRY_B], { fetchImpl: fakeFetch });
  assert.strictEqual(r[0].citationCount, 100);
  assert.strictEqual(r[1].citationCount, 5);
});

test('enrichWithCitations: 带 apiKey 时附加 x-api-key 头', async () => {
  let seenKey = null;
  const fakeFetch = async (url, opt) => {
    seenKey = opt.headers['x-api-key'];
    return { ok: true, json: async () => [{ citationCount: 1 }] };
  };
  await enrichWithCitations([ENTRY_A], { fetchImpl: fakeFetch, apiKey: 'SECRET' });
  assert.strictEqual(seenKey, 'SECRET');
});

test('enrichWithCitations: S2 整批失败时不抛、citationCount 缺省', async () => {
  const fakeFetch = async () => {
    throw new TypeError('network error');
  };
  const r = await enrichWithCitations([ENTRY_A, ENTRY_B], { fetchImpl: fakeFetch, maxRetries: 0 });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].citationCount, undefined);
  assert.strictEqual(r[1].citationCount, undefined);
});

test('enrichWithCitations: S2 返回 null（未收录）时该条缺省', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [null, { citationCount: 7 }],
  });
  const r = await enrichWithCitations([ENTRY_A, ENTRY_B], { fetchImpl: fakeFetch });
  assert.strictEqual(r[0].citationCount, undefined);
  assert.strictEqual(r[1].citationCount, 7);
});

test('enrichWithCitations: 无 arxivId 的 entry 被跳过', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, json: async () => [] };
  };
  const r = await enrichWithCitations([{ id: 'garbage', title: 'x' }], { fetchImpl: fakeFetch });
  assert.strictEqual(called, false, '没有有效 arxivId 时不应调 S2');
  assert.strictEqual(r.length, 1);
});

test('enrichWithOpenAlex: 按 arXiv DOI 补 cited_by_count', async () => {
  const fakeFetch = async (url) => {
    assert.match(url, /openalex\.org\/works/);
    return {
      ok: true,
      json: async () => ({
        results: [{ doi: 'https://doi.org/10.48550/arxiv.2401.11111', cited_by_count: 42 }],
      }),
    };
  };
  const r = await enrichWithOpenAlex([ENTRY_A], { fetchImpl: fakeFetch });
  assert.strictEqual(r[0].citationCount, 42);
});

test('enrichWithOpenAlex: 整批失败降级不抛', async () => {
  const r = await enrichWithOpenAlex([ENTRY_A], {
    fetchImpl: async () => {
      throw new Error('net');
    },
  });
  assert.strictEqual(r[0].citationCount, undefined);
});

// ---------------- 主流程：召回 / 去重 / 排序 / 进度 ----------------

test('discoverPapers: 去重 + 复合排序（库内已有的剔除）', async () => {
  // ENTRY_A (2401.11111) 已在库里 → 应被过滤，只剩 B
  const store = { papers: { p1: { arxivId: '2401.11111', title: 'Mixture of Experts' } } };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['ti:"moe" OR ti:"rag"'], keyterms: [], note: '检索' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async () => ({ entries: [ENTRY_A, ENTRY_B], query: 'ti:"moe"' });
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [{ citationCount: 100 }, { citationCount: 5 }],
  });

  const r = await discoverPapers({
    topic: 'moe and rag',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
  });

  assert.strictEqual(r.usedClaude, true);
  assert.strictEqual(r.results.length, 1, '已导入的 A 应被去重，只剩 B');
  assert.strictEqual(r.results[0].arxivId, '2502.22222');
  assert.strictEqual(r.results[0].arxivUrl, 'https://arxiv.org/abs/2502.22222');
  assert.strictEqual(r.results[0].year, '2025');
});

test('discoverPapers: 多轴召回（relevance + submittedDate）合并去重', async () => {
  const store = { papers: {} };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q1'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  const REL = { ...ENTRY_A, id: 'http://arxiv.org/abs/2410.10101v1', title: 'Relevant classic' };
  const NEW = { ...ENTRY_B, id: 'http://arxiv.org/abs/2506.20202v1', title: 'Newest paper' };
  const axes = [];
  const fakeSearch = async (query, _f, opts) => {
    axes.push(opts.sortBy);
    return { entries: opts.sortBy === 'relevance' ? [REL] : [NEW], query };
  };
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: failFetch,
    enableCitations: false,
    nowYear: 2026,
  });
  assert.ok(axes.includes('relevance'), '应按相关度轴检索');
  assert.ok(axes.includes('submittedDate'), '应按提交时间轴检索');
  const ids = r.results.map((x) => x.arxivId).sort();
  assert.deepStrictEqual(ids, ['2410.10101', '2506.20202'], '两轴结果应合并');
});

test('discoverPapers: 两轴命中同一篇时去重为一条', async () => {
  const store = { papers: {} };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async () => ({ entries: [ENTRY_B], query: 'q' });
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: failFetch,
    enableCitations: false,
    nowYear: 2026,
  });
  assert.strictEqual(r.results.length, 1);
});

test('discoverPapers: 相关度参与排序（同引用同年，相关者在前）', async () => {
  const store = { papers: {} };
  const P = {
    ...ENTRY_B,
    id: 'http://arxiv.org/abs/2501.00001v1',
    title: 'Mixture of Experts routing',
    summary: 'sparse mixture of experts model',
  };
  const Q = {
    ...ENTRY_B,
    id: 'http://arxiv.org/abs/2501.00002v1',
    title: 'Unrelated diffusion imaging',
    summary: 'medical imaging methods',
  };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: ['mixture of experts'], note: 'n' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async (query, _f, opts) => ({ entries: opts.sortBy === 'relevance' ? [P, Q] : [], query });
  const fakeFetch = async () => ({ ok: true, json: async () => [{ citationCount: 10 }, { citationCount: 10 }] });
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
    nowYear: 2025,
  });
  assert.strictEqual(r.results[0].arxivId, '2501.00001', '相关论文应排前');
  assert.ok(r.results[0].relevance > r.results[1].relevance);
});

test('discoverPapers: 引用量参与排序（同相关同年，高引在前）+ citationsAvailable', async () => {
  const store = { papers: {} };
  const P = { ...ENTRY_B, id: 'http://arxiv.org/abs/2501.00003v1', title: 'foo', summary: 'bar' };
  const Q = { ...ENTRY_B, id: 'http://arxiv.org/abs/2501.00004v1', title: 'foo', summary: 'bar' };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: ['zzz'], note: 'n' }), // keyterm 不命中 → rel 同为 0
    code: 0,
    reason: null,
  });
  const fakeSearch = async (query, _f, opts) => ({ entries: opts.sortBy === 'relevance' ? [P, Q] : [], query });
  const fakeFetch = async () => ({ ok: true, json: async () => [{ citationCount: 5 }, { citationCount: 900 }] });
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
    nowYear: 2025,
  });
  assert.strictEqual(r.results[0].arxivId, '2501.00004');
  assert.strictEqual(r.results[0].citationCount, 900);
  assert.strictEqual(r.citationsAvailable, true);
});

test('discoverPapers: 新近度参与排序（同相关无引用，新者在前）', async () => {
  const store = { papers: {} };
  const OLD = {
    ...ENTRY_A,
    id: 'http://arxiv.org/abs/2001.00001v1',
    published: '2020-01-01T00:00:00Z',
    title: 'foo',
    summary: 'bar',
  };
  const NEW = {
    ...ENTRY_A,
    id: 'http://arxiv.org/abs/2505.00001v1',
    published: '2025-05-01T00:00:00Z',
    title: 'foo',
    summary: 'bar',
  };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: ['zzz'], note: 'n' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async (query, _f, opts) => ({ entries: opts.sortBy === 'relevance' ? [OLD, NEW] : [], query });
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: failFetch,
    nowYear: 2025,
    openAlex: false,
  });
  assert.strictEqual(r.results[0].arxivId, '2505.00001', '同相关无引用时新论文排前');
  assert.strictEqual(r.results[0].citationCount, undefined);
  assert.strictEqual(r.citationsAvailable, false);
});

test('discoverPapers: S2 缺失时用 OpenAlex 兜底引用量', async () => {
  const store = { papers: {} };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async (query, _f, opts) => ({ entries: opts.sortBy === 'relevance' ? [ENTRY_B] : [], query });
  const fakeFetch = async (url) => {
    if (/semanticscholar/.test(url)) return { ok: false, status: 429, json: async () => [] };
    if (/openalex/.test(url))
      return {
        ok: true,
        json: async () => ({ results: [{ doi: 'https://doi.org/10.48550/arxiv.2502.22222', cited_by_count: 77 }] }),
      };
    return { ok: false, json: async () => ({}) };
  };
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
    nowYear: 2026,
    openAlex: true,
    s2MaxRetries: 0,
  });
  assert.strictEqual(r.results[0].citationCount, 77);
  assert.strictEqual(r.citationsAvailable, true);
});

test('discoverPapers: onProgress 逐阶段回调', async () => {
  const store = { papers: {} };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  const fakeSearch = async () => ({ entries: [ENTRY_B], query: 'q' });
  const fakeFetch = async () => ({ ok: true, json: async () => [{ citationCount: 3 }] });
  const stages = [];
  await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
    nowYear: 2026,
    onProgress: (e) => stages.push(e.stage),
  });
  assert.strictEqual(stages[0], 'understanding', '首阶段=理解主题');
  assert.ok(stages.includes('searching'), '应有检索阶段');
  assert.ok(stages.includes('citations'), '应有引用量阶段');
  assert.ok(stages.includes('ranking'), '应有排序阶段');
  assert.strictEqual(stages[stages.length - 1], 'done', '末阶段=完成');
});

test('discoverPapers: enableCitations=false 跳过引用量补全', async () => {
  const store = { papers: {} };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  let fetchCalled = false;
  const fakeSearch = async () => ({ entries: [ENTRY_A], query: 'q' });
  const fakeFetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => [] };
  };
  const r = await discoverPapers({
    topic: 'x',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: fakeFetch,
    enableCitations: false,
  });
  assert.strictEqual(fetchCalled, false, '禁用引用量时不应调外部引用 API');
  assert.strictEqual(r.results[0].citationCount, undefined);
});

test('discoverPapers: 标题高度相似的库内论文也去重', async () => {
  const store = { papers: { p1: { arxivId: '9999.99999', title: 'A Survey of RAG' } } };
  const fakeClaude = async () => ({
    ok: true,
    stdout: claudeStdout({ queries: ['q'], keyterms: [], note: 'n' }),
    code: 0,
    reason: null,
  });
  // ENTRY_B 标题 'A Survey of RAG' 与库内同名但 arxivId 不同 → 应按标题相似度去重
  const fakeSearch = async () => ({ entries: [ENTRY_B], query: 'q' });
  const r = await discoverPapers({
    topic: 't',
    store,
    runClaude: fakeClaude,
    searchArxiv: fakeSearch,
    fetchImpl: failFetch,
    enableCitations: false,
    nowYear: 2026,
  });
  assert.strictEqual(r.results.length, 0, '标题相同应被去重');
});
