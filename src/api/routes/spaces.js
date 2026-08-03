'use strict';

// spaces 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

function register(t, ctx) {
  const { ok, fail, manager, scanner } = ctx;

  // ---- 空间管理路由（不依赖具体空间）----
  // GET /api/spaces  列出所有空间 + activeId（含每空间论文数）
  t.get(
    '/api/spaces',
    async ({ res }) => {
      return ok(res, await manager.spacesView());
    },
    { space: false },
  );

  // POST /api/spaces  body: { name, papersDir? }  创建新空间
  t.post(
    '/api/spaces',
    async ({ res, body }) => {
      const op = JSON.parse(body || '{}');
      try {
        const sp = await manager.createSpace({ name: op.name, papersDir: op.papersDir });
        return ok(res, sp);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    },
    { space: false },
  );

  t.patch(
    '/api/spaces/:id',
    async ({ res, body, params }) => {
      const id = params.id;
      const op = JSON.parse(body || '{}');
      try {
        if (typeof op.name === 'string') {
          // 改名可能物理 rename 空间目录：暂停扫描（防目录半路消失）→ 执行 → 失效子扫描器缓存 → 恢复
          if (scanner.stop) scanner.stop();
          if (scanner.drain) await scanner.drain(10000);
          try {
            await manager.renameSpace(id, op.name);
            if (scanner.invalidate) scanner.invalidate(id);
          } finally {
            if (scanner.start) scanner.start();
          }
        }
        if (typeof op.papersDir === 'string') await manager.changePapersDir(id, op.papersDir);
        return ok(res, manager.getSpace(id));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    },
    { space: false },
  );

  // DELETE /api/spaces/:id  删空间（default 不可删；保留物理 PDF 文件夹）
  t.delete(
    '/api/spaces/:id',
    async ({ res, params }) => {
      try {
        const r = await manager.deleteSpace(params.id);
        scanner.invalidate(params.id);
        return ok(res, r);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    },
    { space: false },
  );

  t.post(
    '/api/spaces/:id/dir/preview',
    async ({ res, body, params }) => {
      const op = JSON.parse(body || '{}');
      try {
        return ok(res, await manager.previewPapersDirChange(params.id, op.newDir));
      } catch (e) {
        return fail(res, 400, e.message);
      }
    },
    { space: false },
  );

  t.post(
    '/api/spaces/:id/dir',
    async ({ res, body, params }) => {
      const op = JSON.parse(body || '{}');
      const id = params.id;
      try {
        if (scanner.stop) scanner.stop();
        if (scanner.drain) await scanner.drain(10000);
        const r = await manager.applyPapersDirChange(id, op.newDir, op.mode);
        if (scanner.invalidate) scanner.invalidate(id);
        return ok(res, r);
      } catch (e) {
        return fail(res, 400, e.message);
      } finally {
        if (scanner.start) scanner.start();
      }
    },
    { space: false },
  );

  t.post(
    '/api/spaces/:id/activate',
    async ({ res, params }) => {
      try {
        const sp = await manager.setActiveSpace(params.id);
        return ok(res, sp);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    },
    { space: false },
  );
}

module.exports = { register };
