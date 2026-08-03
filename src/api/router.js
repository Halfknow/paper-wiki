'use strict';

// API 路由装配层（v3.15 路由化重构）。
//
// 此前这里是一条约 1800 行的 `if (pathname === X && method === Y)` 长链；现在拆成：
//   - src/api/route-table.js  声明式路由表（纯函数匹配，静态段优先于参数段）
//   - src/api/routes/*.js     按领域分文件的 handler，各自导出 register(t, ctx)
//   - src/api/views.js        只读视图与共享 store 助手
// 本文件只负责：构造请求上下文（ok/fail/resolveSpace/概念地图任务）→ 注册 → 分发。
//
// 对外 HTTP 契约与旧实现逐字一致，handler 体是原样迁移的。

const { createRouteTable } = require('./route-table');
const { summaryView, detailView } = require('./views');
const { applySettingsOverride, generateConceptMap, DEFAULT_CONCEPT_MAP_PROMPT } = require('../services/ai');

const ROUTE_MODULES = [
  require('./routes/spaces'),
  require('./routes/system'),
  require('./routes/search'),
  require('./routes/papers'),
  require('./routes/chat'),
  require('./routes/ingest'),
  require('./routes/discover'),
  require('./routes/taxonomy'),
  require('./routes/settings'),
  require('./routes/settings-ai'),
  require('./routes/translate'),
  require('./routes/concepts'),
  require('./routes/concept-maps'),
  require('./routes/formulas'),
];

function createApiRouter(ctx) {
  const { manager, scanner, globalConfig } = ctx;
  const config = globalConfig; // 别名：保持各 routes 模块内既有代码可读（config 即全局 config）
  const isProd = process.env.NODE_ENV === 'production';

  function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  const ok = (res, data) => send(res, 200, { ok: true, data });
  const fail = (res, code, error) => send(res, code, { ok: false, error });

  // ---- 概念地图后台生成任务（v3.14）----
  // 生成单文件 HTML 是大产出 AI 调用（流式也需数分钟~数十分钟），不能让 HTTP 请求挂着等——
  // 客户端断开/切页/刷新都会丢结果。改为任务化：POST/PUT 立即落库一个 status:'generating'
  // 占位制品并返回，AI 生成在后台跑，完成/失败后更新占位再落库；前端轮询 settings 元信息。
  // 任务句柄只活在内存（AbortController 不可序列化）；服务重启后占位变「僵尸 generating」，
  // 由 conceptMapMeta 在读路径解析为 error（服务重启，生成中断）。
  /** key=制品 id，value={ abort } */
  const conceptMapJobs = new Map();

  /** 制品 → 元信息（读路径统一走这里）：解析僵尸 generating（任务句柄不存在=进程已重启）为 error。 */
  function conceptMapMeta(m) {
    const stale = m.status === 'generating' && !conceptMapJobs.has(m.id);
    return {
      id: m.id,
      name: m.name,
      prompt: m.prompt,
      status: stale ? 'error' : m.status || 'ready',
      error: stale ? '服务重启，生成中断' : m.error || '',
      hasHtml: !!m.html,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  /** 启动/后台执行概念地图生成任务。item 是已落库的占位制品（status:'generating'）。
   *  完成后就地更新 item（共享 store 引用）并 save——store 是 manager 内存缓存，与后续请求共享。 */
  function startConceptMapJob({ store, save, item, prevHtml }) {
    const abort = new AbortController();
    conceptMapJobs.set(item.id, { abort });
    (async () => {
      try {
        const effConfig = applySettingsOverride(config, store.settings || {});
        const prompt =
          (item.prompt && String(item.prompt).trim()) || store.settings.conceptMapPrompt || DEFAULT_CONCEPT_MAP_PROMPT;
        const html = await generateConceptMap({
          concepts: store.concepts,
          config: effConfig,
          prompt,
          prevHtml,
          signal: abort.signal,
        });
        item.html = String(html || '');
        item.error = '';
        // 截断检测：完整 HTML 必含 </html>；缺失=被模型输出上限截断。半成品仍保留（可查看/再优化补全）。
        item.status = /<\/html\s*>/i.test(item.html) ? 'ready' : 'error';
        if (item.status === 'error')
          item.error = '输出不完整（可能被模型输出上限截断）——已保留半成品，可查看后点「优化」补全';
      } catch (e) {
        item.status = 'error';
        // 错误信息直接展示（自托管单用户场景，AI HTTP 401/429 等细节对排查至关重要）
        item.error = abort.signal.aborted ? '已手动取消' : `概念地图生成失败：${(e && e.message) || e}`;
        // 优化失败时 item.html 仍是旧制品内容，不丢
      }
      item.updatedAt = Date.now();
      store.settings.updatedAt = Date.now();
      conceptMapJobs.delete(item.id);
      try {
        await save(store);
      } catch {
        /* 空间被删等场景：任务结果无处可写，静默丢弃 */
      }
    })();
  }

  /** 解析当前请求的空间上下文：?space=<id> 指定空间，无参回 active 空间。
   *  返回 { spaceId, space, store, save }。store 是 manager 内存缓存的引用（与 scanner 共享）。
   *  SSE 路由（chat/discover）EventSource 无法设 header，spaceId 走 URL query。 */
  async function resolveSpace(q) {
    const spaceId = (q && q.space) || manager.getActiveSpaceId();
    const space = manager.getSpace(spaceId);
    if (!space) {
      // 容错：回退 active（空间被删后旧引用等情况）
      const activeId = manager.getActiveSpaceId();
      return {
        spaceId: activeId,
        space: manager.getActiveSpace(),
        store: await manager.getSpaceStore(activeId),
        save: manager.saveStoreBinder(activeId),
      };
    }
    const store = await manager.getSpaceStore(spaceId);
    return { spaceId, space, store, save: manager.saveStoreBinder(spaceId) };
  }

  // ---- 注册 ----
  const routerCtx = {
    ok,
    fail,
    send,
    config,
    manager,
    scanner,
    isProd,
    resolveSpace,
    conceptMapMeta,
    startConceptMapJob,
    conceptMapJobs,
  };
  const table = createRouteTable();
  for (const mod of ROUTE_MODULES) mod.register(table, routerCtx);

  // ---- 分发 ----
  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;

    const hit = table.match(method, pathname);
    if (!hit) return fail(res, 404, 'No route');

    // 空间上下文：论文/标签/主题/概念/设置/收藏夹路由都基于此。
    // 空间管理路由（/api/spaces*）声明 { space: false }，不解析（与旧链中它们位于 resolveSpace 之前一致）。
    const spaceCtx = hit.opts.space === false ? {} : await resolveSpace(q);

    return hit.handler({ req, res, body, url, pathname, q, method, params: hit.params, ...spaceCtx });
  }

  return { handle, routes: () => table.routes() };
}

module.exports = { createApiRouter, summaryView, detailView };
