'use strict';

// translate 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { applySettingsOverride, callChatStream, TRANSLATE_SYSTEM_PROMPT } = require('../../services/ai');
const { proxyFetchJson } = require('../../core/util');
const { LANG_NAMES, GL_LANG_MAP } = require('../views');

function register(t, ctx) {
  const { ok, fail, config, isProd } = ctx;

  // GET /api/translate?text=&engine=  划线翻译（浮窗内显示译文，不跳转外链）。
  //   ?text= 选中文本（URL 编码，≤8000 字符）&engine= ai | google（bing 由前端走外链，不到这）。
  //   - engine=ai（默认）：流式 SSE（EventSource，与 chat 同款），复用 callChatStream + TRANSLATE_SYSTEM_PROMPT。
  //   - engine=google：RESTful JSON（调用 Google 免费端点 translate.googleapis.com，无需 Key，秒回）。
  //     Google 端点返回 [[["译文","原文",...],...]]，拼接 data[0][*][0] 得完整译文。
  //   用 GET：浏览器 EventSource 只支持 GET（ai 分支）；google 分支也走 GET 保持统一。
  t.get('/api/translate', async ({ req, res, q, store }) => {
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!text) return fail(res, 400, 'empty text');
    const effConfig = applySettingsOverride(config, store.settings || {});
    // engine 优先取 query（前端按用户所选引擎传），回退 config 设置
    const engine =
      q.engine === 'ai' || q.engine === 'google'
        ? q.engine
        : (effConfig.translate && effConfig.translate.engine) || 'ai';
    const targetLang = (effConfig.translate && effConfig.translate.targetLang) || 'zh-CN';

    // —— Google 免费端点：RESTful JSON（非流式），秒回 ——
    // 端点 translate.googleapis.com/translate_a/single?client=gtx&dt=t，无需 Key。
    // 非官方端点（网页版内部用），可能被限流/变动，故 try/catch 兜底 + 超时。
    // 用 proxyFetchJson（零依赖 https + 代理隧道）：Node 原生 fetch 不读 HTTP_PROXY 环境变量，
    // 用户有代理（如 Clash）时原生 fetch 会超时；proxyFetchJson 自动尊崇 HTTPS_PROXY。
    if (engine === 'google') {
      const glu = GL_LANG_MAP[targetLang] || targetLang;
      const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(glu)}&q=${encodeURIComponent(text.slice(0, 5000))}`;
      try {
        const gj = await proxyFetchJson(gUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 PaperWiki' } });
        // gj[0] = [[译文片段, 原文片段, ...], ...]；拼接所有译文片段
        const reply = Array.isArray(gj && gj[0]) ? gj[0].map((seg) => (seg && seg[0]) || '').join('') : '';
        if (!reply) throw new Error('Google 返回为空');
        return ok(res, { reply, engine: 'google' });
      } catch (e) {
        return fail(res, 502, isProd ? 'Google 翻译失败（需代理访问 Google）' : `Google 翻译失败：${e.message}`);
      }
    }

    // —— AI 引擎：流式 SSE（EventSource）——
    const langName = LANG_NAMES[targetLang] || targetLang;
    const messages = [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: `请将以下文本翻译为「${langName}」，只输出译文：\n\n${text.slice(0, 8000)}` },
    ];
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
      const reply = await callChatStream({
        messages,
        config: effConfig,
        jsonMode: false,
        onToken: (t, kind) => {
          if (!aborted && kind !== 'reasoning') sse('token', { t });
          return !aborted;
        },
      });
      if (aborted) return;
      sse('done', { reply });
    } catch (e) {
      sse('fail', { error: isProd ? '翻译失败' : `翻译失败：${e.message}` });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  });
}

module.exports = { register };
