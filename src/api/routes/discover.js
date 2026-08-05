'use strict';

// discover 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { applySettingsOverride, withGlobalAi } = require('../../services/ai');

function discoverOpts(topic, { config, store, gai }) {
  const cfg = config.discover || {};
  const arx = config.arxiv || {};
  const { planViaGateway } = require('../../services/discover');
  // discover 的「网关规划」走 AI 调用，需用生效配置（store.settings.ai 覆盖 config.ai）
  const effConfig = applySettingsOverride(config, withGlobalAi(store.settings, gai));
  return {
    topic,
    store,
    maxResults: cfg.maxResults ?? 40,
    perAxis: cfg.perAxis ?? 25,
    claudeTimeoutMs: cfg.claudeTimeoutMs ?? 60000,
    enableCitations: cfg.semanticScholar !== false,
    openAlex: cfg.openAlex !== false,
    s2ApiKey: cfg.semanticScholarApiKey || null,
    minIntervalMs: arx.minIntervalMs ?? 3000, // arXiv 礼貌限速，多轴多 query 时尤其重要
    weights: cfg.weights || undefined,
    recencyWindowYears: cfg.recencyWindowYears ?? undefined,
    titleSimThreshold: cfg.titleSimThreshold ?? undefined,
    // 查询理解引擎：默认 auto（claude → GLM 网关 → 原始）。claude 无头鉴权失败时用网关兜底。
    queryEngine: cfg.queryEngine || 'auto',
    generateViaGateway: (t) => planViaGateway(t, { config: effConfig }),
  };
}

function register(t, ctx) {
  // 注意：discoverOpts 用本文件的模块级函数——ctx 里没有它；此前 `const { discoverOpts } = ctx`
  // 把它遮蔽成 undefined，是 v3.15 重构引入的潜在 bug（调用即 TypeError）。
  const { ok, fail, config, isProd } = ctx;

  // POST /api/discover  { topic }  —— 非流式发现（一次性返回候选；保留作兜底/脚本调用）
  // 只返回候选列表；勾选后由前端逐个 POST /api/import 走已有下载+入库链路。
  t.post('/api/discover', async ({ res, body, store, gai }) => {
    const op = JSON.parse(body || '{}');
    const topic = typeof op.topic === 'string' ? op.topic.trim() : '';
    if (!topic) return fail(res, 400, '请输入主题');
    const { discoverPapers } = require('../../services/discover');
    try {
      const data = await discoverPapers(discoverOpts(topic, { config, store, gai }));
      return ok(res, data);
    } catch (e) {
      return fail(res, 502, isProd ? '发现失败：arXiv / Semantic Scholar 检索出错' : `发现失败：${e.message}`);
    }
  });

  // GET /api/discover/stream?topic=...  —— SSE 流式发现，逐阶段推送进度
  // 事件：event:progress（每阶段）/ event:done（含 results）/ event:error
  t.get('/api/discover/stream', async ({ req, res, q, store, gai }) => {
    const topic = typeof q.topic === 'string' ? q.topic.trim() : '';
    if (!topic) return fail(res, 400, '请输入主题');
    const { discoverPapers } = require('../../services/discover');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 反向代理（nginx）下禁用缓冲，保证逐条下发
    });
    const sse = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });
    sse('progress', { stage: 'start', message: '开始发现…' });
    try {
      const data = await discoverPapers({
        ...discoverOpts(topic, { config, store, gai }),
        onProgress: (ev) => {
          if (!aborted) sse('progress', ev);
        },
      });
      sse('done', data);
    } catch (e) {
      // 用自定义事件名 'fail'（而非 'error'）：EventSource 的原生 'error' 用于连接层，混用会触发前端误判与自动重连
      sse('fail', { error: isProd ? '发现失败：arXiv / Semantic Scholar 检索出错' : `发现失败：${e.message}` });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  });
}

module.exports = { register };
