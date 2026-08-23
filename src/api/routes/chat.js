'use strict';

// chat 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { applySettingsOverride, withGlobalAi } = require('../../services/ai');

function register(t, ctx) {
  const { ok, fail, config, scanner, isProd } = ctx;

  const h_api_papers_id_chat = async ({ req, res, body, q, method, params, spaceId, store, gai }) => {
    const id = params.id;
    if (!store.papers[id]) return fail(res, 404, 'Not found');
    if (!scanner.chatPaper) return fail(res, 501, 'scanner.chatPaper unavailable');
    // message 来源：GET 取 query.message，POST 取 body.message
    let message;
    let extraIdsRaw;
    if (method === 'GET') {
      message = typeof q.message === 'string' ? q.message : '';
      // extraIds=id1,id2 （逗号分隔，@ 引用的其它论文）
      extraIdsRaw = typeof q.extraIds === 'string' ? q.extraIds : '';
    } else {
      const op = JSON.parse(body || '{}');
      message = typeof op.message === 'string' ? op.message : '';
      extraIdsRaw = Array.isArray(op.extraIds)
        ? op.extraIds.join(',')
        : typeof op.extraIds === 'string'
          ? op.extraIds
          : '';
    }
    message = message.trim();
    // @ 引用论文 id：白名单过滤（必须存在于 store），scanner.chatPaper 内部会再校验
    const extraIds = extraIdsRaw
      ? extraIdsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && store.papers[s])
      : [];
    // regenerate=1：重新生成最后一轮（message 可为空，scanner 从末尾轮取 user message）
    const regenerate = q.regenerate === '1';
    // truncate=N：编辑重发（截断该 user 之后的历史；与前端本地截断对齐，防服务端历史回灌复活旧消息）
    const truncateRaw = parseInt(q.truncate, 10);
    const truncate = Number.isFinite(truncateRaw) && truncateRaw >= 0 ? truncateRaw : undefined;
    if (!message && !regenerate) return fail(res, 400, 'empty message');

    // —— 流式分支（仅 GET，前端用 EventSource；POST 走原非流式 JSON 向后兼容）——
    if (method === 'GET') {
      // 事件名 token/done/fail，避免 error 防 EventSource 原生 error 误判 + 自动重连
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 反向代理下禁用缓冲，保证逐 token 下发
      });
      const sse = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      // 模型参数：从 query 读取（前端 UI 调节后透传），白名单 + 类型校验
      const chatParams = {};
      // thinking：GLM 对象格式 {type:"enabled"|"disabled"}。前端透传字符串 enabled/disabled，
      // 这里转对象。关键：GLM-5.2/5/4.6 默认即开启思考，故「关」必须显式发 disabled 才能真正停思考。
      if (q.thinking === 'enabled' || q.thinking === 'disabled') {
        chatParams.thinking = { type: q.thinking };
      }
      if (q.temperature != null) {
        const v = Number(q.temperature);
        if (Number.isFinite(v)) chatParams.temperature = v;
      }
      if (q.topP != null) {
        const v = Number(q.topP);
        if (Number.isFinite(v)) chatParams.topP = v;
      }
      if (q.maxTokens != null) {
        const v = parseInt(q.maxTokens, 10);
        if (Number.isFinite(v)) chatParams.maxTokens = v;
      }
      // Phase 2 模型切换：?model=xxx 透传。白名单校验——必须属于可用模型集合（config.ai.model +
      // config.ai.extraModels + 上游 /v1/models），防注入。校验失败静默回退默认模型。
      if (typeof q.model === 'string' && q.model.trim()) {
        const effConfig = applySettingsOverride(config, withGlobalAi(store.settings, gai));
        const allowed = new Set([effConfig.ai && effConfig.ai.model].filter(Boolean));
        const extra = effConfig.ai && Array.isArray(effConfig.ai.extraModels) ? effConfig.ai.extraModels : [];
        for (const m of extra) if (m) allowed.add(m);
        if (allowed.has(q.model)) chatParams.model = q.model;
      }
      try {
        const r = await scanner.chatPaper(spaceId, id, message, {
          regenerate,
          truncate,
          extraIds: extraIds.length ? extraIds : undefined, // @ 引用论文
          chatParams: Object.keys(chatParams).length ? chatParams : undefined,
          onToken: (t, kind) => {
            if (!aborted) sse('token', { t, kind: kind || 'content' });
            return !aborted; // 客户端断开时返回 false，scanner 停止累积/落盘
          },
        });
        if (aborted) return; // 客户端已断：不发 done，直接结束
        sse('done', { reply: r.reply, chat: r.chat });
      } catch (e) {
        sse('fail', { error: isProd ? 'AI 回答失败' : `AI 回答失败：${e.message}` });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }
    // POST：非流式 JSON（向后兼容，现有 POST 调用方继续工作）
    // chatParams：与 GET /chat、POST /chat/vision 同规则（白名单 + 类型校验），协议对称。
    const postOp = JSON.parse(body || '{}');
    const chatParams = {};
    const cpSrc = postOp.chatParams || {};
    if (cpSrc.thinking === 'enabled' || cpSrc.thinking === 'disabled') {
      chatParams.thinking = { type: cpSrc.thinking };
    }
    for (const k of ['temperature', 'topP']) {
      if (cpSrc[k] != null && Number.isFinite(Number(cpSrc[k]))) chatParams[k] = Number(cpSrc[k]);
    }
    if (cpSrc.maxTokens != null && Number.isFinite(parseInt(cpSrc.maxTokens, 10)))
      chatParams.maxTokens = parseInt(cpSrc.maxTokens, 10);
    if (typeof cpSrc.model === 'string' && cpSrc.model.trim()) {
      const effConfig = applySettingsOverride(config, withGlobalAi(store.settings, gai));
      const allowed = new Set([effConfig.ai && effConfig.ai.model].filter(Boolean));
      const extra = effConfig.ai && Array.isArray(effConfig.ai.extraModels) ? effConfig.ai.extraModels : [];
      for (const m of extra) if (m) allowed.add(m);
      if (allowed.has(cpSrc.model)) chatParams.model = cpSrc.model;
    }
    const r = await scanner.chatPaper(spaceId, id, message, {
      regenerate,
      truncate,
      extraIds: extraIds.length ? extraIds : undefined,
      chatParams: Object.keys(chatParams).length ? chatParams : undefined,
    });
    return ok(res, r);
  };
  t.get('/api/papers/:id/chat', h_api_papers_id_chat);
  t.post('/api/papers/:id/chat', h_api_papers_id_chat);

  t.post('/api/papers/:id/chat/vision', async ({ req, res, body, params, spaceId, store, gai }) => {
    const id = params.id;
    if (!store.papers[id]) return fail(res, 404, 'Not found');
    if (!scanner.chatPaper) return fail(res, 501, 'scanner.chatPaper unavailable');
    const op = JSON.parse(body || '{}');
    const message = typeof op.message === 'string' ? op.message.trim() : '';
    const regenerate = !!op.regenerate;
    const truncateRaw = parseInt(op.truncate, 10);
    const truncate = Number.isFinite(truncateRaw) && truncateRaw >= 0 ? truncateRaw : undefined;
    if (!message && !regenerate) return fail(res, 400, 'empty message');
    const extraIds = Array.isArray(op.extraIds)
      ? op.extraIds.filter((s) => s && store.papers[s])
      : typeof op.extraIds === 'string'
        ? op.extraIds
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && store.papers[s])
        : [];
    // 图片白名单：必须是 data:image/* URL，限制 4 张（防滥用 + papers.json 膨胀）
    const images = Array.isArray(op.images)
      ? op.images.filter((s) => typeof s === 'string' && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s)).slice(0, 4)
      : [];
    // chatParams + model 白名单（与 GET /chat 同规则）
    const chatParams = {};
    const cpSrc = op.chatParams || {};
    // thinking：对象格式 {type:"enabled"|"disabled"}（与 GET /chat 一致，GLM 默认开启故 disabled 才停）
    if (cpSrc.thinking === 'enabled' || cpSrc.thinking === 'disabled') {
      chatParams.thinking = { type: cpSrc.thinking };
    }
    for (const k of ['temperature', 'topP']) {
      if (cpSrc[k] != null && Number.isFinite(Number(cpSrc[k]))) chatParams[k] = Number(cpSrc[k]);
    }
    if (cpSrc.maxTokens != null && Number.isFinite(parseInt(cpSrc.maxTokens, 10)))
      chatParams.maxTokens = parseInt(cpSrc.maxTokens, 10);
    if (typeof cpSrc.model === 'string' && cpSrc.model.trim()) {
      const effConfig = applySettingsOverride(config, withGlobalAi(store.settings, gai));
      const allowed = new Set([effConfig.ai && effConfig.ai.model].filter(Boolean));
      const extra = effConfig.ai && Array.isArray(effConfig.ai.extraModels) ? effConfig.ai.extraModels : [];
      for (const m of extra) if (m) allowed.add(m);
      if (allowed.has(cpSrc.model)) chatParams.model = cpSrc.model;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sse = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });
    try {
      const r = await scanner.chatPaper(spaceId, id, message, {
        regenerate,
        truncate,
        extraIds: extraIds.length ? extraIds : undefined,
        chatParams: Object.keys(chatParams).length ? chatParams : undefined,
        images: images.length ? images : undefined,
        onToken: (t, kind) => {
          if (!aborted) sse('token', { t, kind: kind || 'content' });
          return !aborted;
        },
      });
      if (aborted) return;
      sse('done', { reply: r.reply, chat: r.chat });
    } catch (e) {
      sse('fail', { error: isProd ? 'AI 回答失败' : `AI 回答失败：${e.message}` });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  });
}

module.exports = { register };
