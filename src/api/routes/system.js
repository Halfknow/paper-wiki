'use strict';

// system 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const fsp = require('fs/promises');
const { applySettingsOverride, withGlobalAi, listModels } = require('../../services/ai');

/** DB 连通性探测：SELECT 1 带 timeoutMs 超时。返回 { status, latencyMs?, error? }。
 *  status: 'ok' | 'down'（异常）| 'timeout'（超时）。失败不抛——探活语义。 */
async function probeDb(query, timeoutMs = 2000) {
  if (!query) return { status: 'down', error: 'db 未注入' };
  const start = Date.now();
  let timer;
  try {
    const probe = query('SELECT 1', []);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('db 探测超时')), timeoutMs);
    });
    await Promise.race([probe, timeout]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (e) {
    const elapsed = Date.now() - start;
    const isTimeout = e && /超时|timeout/i.test(e.message);
    return {
      status: isTimeout ? 'timeout' : 'down',
      latencyMs: elapsed,
      error: e && e.message ? e.message : String(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 磁盘剩余空间探测：statfs 取可用字节，低于阈值标 degraded。
 *  返回 { status, freeMb }；status: 'ok' | 'degraded' | 'unknown'（statfs 不可用/路径不存在）。 */
async function probeDisk(dir, minDiskMb) {
  const minMb = minDiskMb || 100;
  if (!dir) return { status: 'unknown', error: '路径未配置' };
  try {
    // Node ≥18 内置 fs/promises.statfs；项目要求 Node ≥20
    const s = await fsp.statfs(dir);
    // bavail = 普通用户可用块数；bsize = 块大小（字节）
    const freeBytes = (s.bavail || 0) * (s.bsize || 0);
    const freeMb = Math.floor(freeBytes / (1024 * 1024));
    return { status: freeMb < minMb ? 'degraded' : 'ok', freeMb, minMb };
  } catch (e) {
    return { status: 'unknown', error: e && e.message ? e.message : String(e) };
  }
}

function register(t, ctx) {
  const { ok, fail, config, manager, scanner, isProd, healthDeps } = ctx;

  // GET /api/health — 探活（pm2 / 反向代理用），无需鉴权。
  //   旧契约保留（status/uptime/spaces/activeSpaceId/papers/missingFuse），新增 checks 子结构：
  //   db（SELECT 1 连通性 + latencyMs）、disk（papersDir/backupsDir 剩余空间）。
  //   子探测失败不整体 500——HTTP 仍 200，只在 payload 里标 degraded/down。
  //   status='degraded' 当任一子项 degraded/down/timeout；AI 上游可达性走独立 /api/health/ai（慢探测隔离）。
  t.get('/api/health', async ({ res, store }) => {
    const hd = healthDeps || {};
    const dbCheck = await probeDb(hd.query, 2000);
    const diskPapers = await probeDisk(hd.papersDir, hd.minDiskMb);
    const diskBackups = await probeDisk(hd.backupsDir, hd.minDiskMb);
    // 任一关键子项异常 → 总体 degraded（unknown 不计入，statfs 不可用时不应误报）
    const degraded =
      dbCheck.status !== 'ok' ||
      diskPapers.status === 'degraded' ||
      diskBackups.status === 'degraded';
    return ok(res, {
      status: degraded ? 'degraded' : 'ok',
      uptime: Math.round(process.uptime()),
      spaces: manager.listSpaces().length,
      activeSpaceId: manager.getActiveSpaceId(),
      papers: Object.keys(store.papers).length,
      // missing 熔断状态（{spaceId: {at, missing, total}}，空对象=正常）：挂载失效可观测
      missingFuse: scanner.getFuseState ? scanner.getFuseState() : {},
      checks: {
        db: dbCheck,
        disk: {
          papersDir: { status: diskPapers.status, freeMb: diskPapers.freeMb, ...(diskPapers.error ? { error: diskPapers.error } : {}) },
          backupsDir: { status: diskBackups.status, freeMb: diskBackups.freeMb, ...(diskBackups.error ? { error: diskBackups.error } : {}) },
        },
      },
    });
  });

  // GET /api/health/ai — AI 上游可达性探测（慢探测，与主 health 隔离，不拖累探活响应）。
  //   复用 listModels（已有 8s 超时 + 永不抛错语义）；source='upstream' 表示真正打到上游，
  //   'config' 表示回退静态候选（上游不可达/未配置）。
  t.get('/api/health/ai', async ({ res, store, gai }) => {
    const effConfig = applySettingsOverride(config, withGlobalAi(store.settings || {}, gai));
    const start = Date.now();
    try {
      const r = await listModels({ config: effConfig });
      // source='config' 意味着上游不可达（listModels 内部已回退）→ degraded
      const status = r && r.source === 'upstream' ? 'ok' : 'degraded';
      return ok(res, {
        status,
        source: (r && r.source) || 'config',
        latencyMs: Date.now() - start,
        modelCount: r && r.models ? r.models.length : 0,
        ...(status === 'degraded' ? { note: '上游不可达，回退静态候选（config.ai.model + extraModels）' } : {}),
      });
    } catch (e) {
      // listModels 永不抛错，此分支几乎不可达；兜底
      return ok(res, {
        status: 'degraded',
        source: 'config',
        latencyMs: Date.now() - start,
        error: isProd ? 'AI 上游探测失败' : `AI 上游探测失败：${e.message}`,
      });
    }
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

module.exports = { register, probeDb, probeDisk };
