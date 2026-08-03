'use strict';

// concept-maps 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { generateConceptMap } = require('../../services/ai');

function register(t, ctx) {
  const { ok, fail, conceptMapMeta, startConceptMapJob, conceptMapJobs } = ctx;

  // ---- 概念地图制品（v3.10）：基于概念清单 AI 生成单文件 HTML 全览图，存为可复用的制品 ----
  // v3.14 起改为后台任务：POST/PUT 立即落库 status:'generating' 占位并返回（不再挂请求等 AI），
  // 生成在后台跑（流式，见 ai.js generateConceptMap），完成/失败更新占位；前端轮询 settings 元信息。
  // POST /api/concepts/map { prompt?, name? }  生成新地图制品（后台任务）
  t.post('/api/concepts/map', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    if (!(store.concepts || []).length) return fail(res, 400, '概念清单为空，先抽取概念再生成概念地图');
    store.settings.conceptMaps = store.settings.conceptMaps || [];
    const item = {
      id: 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name:
        String(op.name || '')
          .trim()
          .slice(0, 80) || '概念地图',
      html: '',
      prompt: (op.prompt && String(op.prompt).trim()) || '',
      status: 'generating',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.settings.conceptMaps.unshift(item); // 新的在前
    store.settings.conceptMaps = store.settings.conceptMaps.slice(0, 50); // 限 50 个
    store.settings.updatedAt = Date.now();
    await save(store);
    startConceptMapJob({ store, save, item });
    return ok(res, conceptMapMeta(item));
  });

  // PUT /api/concepts/map { id, prompt }  基于自定义 prompt 优化已有制品（后台任务；生成期间旧 html 保留可看）
  t.put('/api/concepts/map', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    store.settings.conceptMaps = store.settings.conceptMaps || [];
    const it = store.settings.conceptMaps.find((x) => x.id === op.id);
    if (!it) return fail(res, 404, '制品不存在');
    if (conceptMapJobs.has(it.id)) return fail(res, 409, '该制品正在生成中，请等待完成或先删除取消');
    if (op.prompt) it.prompt = String(op.prompt).trim();
    it.status = 'generating';
    it.error = '';
    it.updatedAt = Date.now();
    store.settings.updatedAt = Date.now();
    await save(store);
    startConceptMapJob({ store, save, item: it, prevHtml: it.html });
    return ok(res, conceptMapMeta(it));
  });

  const h_api_concepts_map_id = async ({ res, method, params, store, save }) => {
    store.settings.conceptMaps = store.settings.conceptMaps || [];
    const it = store.settings.conceptMaps.find((x) => x.id === params.id);
    if (method === 'GET') {
      if (!it) return fail(res, 404, '制品不存在');
      return ok(res, { ...conceptMapMeta(it), html: it.html || '' });
    }
    if (method === 'DELETE') {
      if (!it) return fail(res, 404, '制品不存在');
      const job = conceptMapJobs.get(it.id);
      if (job) job.abort.abort(); // 生成中 → 取消后台任务（任务的 save 在删除之后落库，item 已移除无副作用）
      store.settings.conceptMaps = store.settings.conceptMaps.filter((x) => x.id !== params.id);
      store.settings.updatedAt = Date.now();
      await save(store);
      return ok(res, { deleted: params.id });
    }
  };
  t.get('/api/concepts/map/:id', h_api_concepts_map_id);
  t.delete('/api/concepts/map/:id', h_api_concepts_map_id);
}

module.exports = { register };
