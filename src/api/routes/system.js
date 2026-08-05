'use strict';

// system 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const { applySettingsOverride, withGlobalAi, listModels } = require('../../services/ai');

function register(t, ctx) {
  const { ok, fail, config, manager, scanner, isProd } = ctx;

  // GET /api/health — 探活（pm2 / 反向代理用），无需鉴权。返回 active 空间篇数 + 总空间数。
  t.get('/api/health', async ({ res, store }) => {
    return ok(res, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      spaces: manager.listSpaces().length,
      activeSpaceId: manager.getActiveSpaceId(),
      papers: Object.keys(store.papers).length,
      // missing 熔断状态（{spaceId: {at, missing, total}}，空对象=正常）：挂载失效可观测
      missingFuse: scanner.getFuseState ? scanner.getFuseState() : {},
    });
  });

  // GET /api/ai/models  返回可用模型列表（Phase 2 模型切换器用）。
  //   优先调上游 /v1/models；失败回退 config.ai.model + config.ai.extraModels。
  //   永不抛错——上游不可达时返回静态候选，保证前端切换器总能渲染。
  t.get('/api/ai/models', async ({ res, store, gai }) => {
    const effConfig = applySettingsOverride(config, withGlobalAi(store.settings || {}, gai));
    try {
      const r = await listModels({ config: effConfig });
      return ok(res, r);
    } catch (e) {
      return fail(res, 500, isProd ? '列出模型失败' : `列出模型失败：${e.message}`);
    }
  });

  // GET /api/stats
  t.get('/api/stats', async ({ res, store }) => {
    const all = Object.values(store.papers);
    return ok(res, {
      total: all.length,
      ready: all.filter((p) => p.status === 'ready').length,
      error: all.filter((p) => p.status === 'error').length,
      processing: all.filter((p) => ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)).length,
      // 全局星标/未读计数（不随筛选变，供侧栏「全部/星标/未读」徽标用，避免被当前视图筛选污染）
      starred: all.filter((p) => p.starred).length,
      unread: all.filter((p) => (p.readStatus || 'unread') === 'unread').length,
      folders: (store.folders || []).length,
      topics: (store.topics || []).length,
      concepts: (store.concepts || []).length,
      formulas: (store.formulas || []).length,
    });
  });
}

module.exports = { register };
