# PostgreSQL 迁移 + Docker 化 + 空间绑定重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pm2 + per-space papers.json → Docker Compose (app + postgres:16)，数据全量入 PG，前端/业务逻辑不变；重设计空间 papersDir 绑定语义（预检→move/rebind→原子执行 + missing 熔断 + filepath 运行时派生）。

**Architecture:** 新增 `lib/db.js`（pg Pool + 编号 migration + repository：hash-diff 事务保存、store 组装、paper_texts）。改造收口在 `lib/spaces.js`（注册表/store 换 repo、filepath 派生、绑定 preview/move/rebind）、scanner/api 的全文 IO 点（注入 textStore）。Docker 侧：Dockerfile + docker-compose + .env；`scripts/migrate-json-to-pg.js` 一次性迁移。

**Tech Stack:** Node 20、pg（生产）、pg-mem（单测）、postgres:16-alpine、docker compose。

**Spec:** `docs/superpowers/specs/2026-07-18-postgres-docker-migration-design.md`

---

## 文件地图

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `lib/db.js` | 新建 | createDb（Pool/migrate/close）+ createRepository（registry/store/texts，hash-diff） |
| `migrations/001-init.sql` | 新建 | 全量 schema（spec 第二节） |
| `lib/spaces.js` | 重写内部 | manager 走 repo；filepath 派生；previewPapersDirChange/applyPapersDirChange；目录校验 |
| `lib/store.js` | 微改 | 纯逻辑保留；文件 IO 仅供迁移/快照；backupStore 改收 store 对象 |
| `lib/scanner.js` | 定点改 | textDir 5 处 → deps.textStore；missing 熔断；pause/resume 复用 stop/drain/start |
| `lib/api.js` | 定点改 | fulltextPath 删除点 → textStore.remove；新增 /api/spaces/:id/dir[/preview] 路由；health 加 missingFuse |
| `server.js` | 定点改 | createDb fail-fast → manager 注入 repo/papersRoot；备份改 PG→JSON 快照 |
| `scripts/migrate-json-to-pg.js` | 新建 | 旧 data/ → PG，幂等 |
| `scripts/backup-pg.sh` | 新建 | pg_dump 包装 |
| `scripts/e2e-bootstrap.js` | 改 | 经 repo 向 PG 预置数据 |
| `Dockerfile` `.dockerignore` `docker-compose.yml` `.env.example` | 新建 | 部署 |
| `public/app.js` `public/index.html` `public/styles.css` | 定点改 | 空间管理模态：文件夹改绑向导（预检→选模式→结果） |
| `tests/db.test.js` | 新建 | pg-mem：migrate/组装/hash-diff/filename 派生/texts |
| `tests/spaces.test.js` `tests/scanner.test.js` `tests/api.test.js` | 改 | 注入 pg-mem repo；新增绑定/熔断用例 |
| `.github/workflows/ci.yml` | 改 | e2e job 加 postgres service；新增 pg 集成冒烟 |
| `AGENTS.md` `README.md` `CHANGELOG.md` `config.example.json` | 改 | 文档与默认值（discover.queryEngine=gateway） |

**贯穿约定（每个 task 都要遵守）：**
- jsonb 参数一律 `JSON.stringify` 后传（node-pg 会把 JS 数组序列化成 PG 数组字面量而非 JSON——直接传数组必炸）。
- 时间戳/文件大小列用 `DOUBLE PRECISION`（避免 BIGINT 经 pg 驱动回来变字符串）。
- papers 表带 `extra JSONB` 兜底列：row 映射未覆盖的未来字段进 extra，读取时合并回 paper 对象，防止字段静默丢失。
- 内存 store 形状 100% 不变；`deps.saveStore(store)` 单参闭包语义不变（陷阱 1）。
- TDD：每个 task 先写失败测试再实现；`node --test` 全绿后 commit（约定式 + emoji + Co-Authored-By）。

---

### Task 1: db 基础设施（createDb + migration runner + schema）

**Files:** Create `lib/db.js`（第一部分）、`migrations/001-init.sql`、`tests/db.test.js`；Modify `package.json`（deps: `pg`；devDeps: `pg-mem`）

- [ ] Step 1 `npm i pg && npm i -D pg-mem`
- [ ] Step 2 写失败测试（tests/db.test.js）：

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');
const { createDb } = require('../lib/db');

function memDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  return createDb({ createPool: () => new Pool() });
}

test('migrate 幂等建表', async () => {
  const db = memDb();
  await db.migrate();
  await db.migrate(); // 第二次不报错
  const r = await db.query('SELECT key FROM app_state');
  assert.ok(Array.isArray(r.rows));
});
```

- [ ] Step 3 实现 `migrations/001-init.sql`（spec 第二节 schema + `schema_migrations(name TEXT PK, applied_at DOUBLE PRECISION)` + papers 加 `extra JSONB`）与 `lib/db.js`：

```js
// lib/db.js（核心骨架）
const fs = require('fs');
const path = require('path');

function createDb({ connectionString, createPool } = {}) {
  const pool = createPool
    ? createPool()
    : new (require('pg').Pool)({ connectionString });
  async function query(text, params) { return pool.query(text, params); }
  async function migrate() {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations
                 (name TEXT PRIMARY KEY, applied_at DOUBLE PRECISION)`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort();
    for (const f of files) {
      const done = await query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean))
          await client.query(stmt);
        await client.query('INSERT INTO schema_migrations(name, applied_at) VALUES($1,$2)', [f, Date.now()]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
  }
  return { query, pool, migrate, close: () => pool.end() };
}
module.exports = { createDb /* , createRepository 见 Task 2 */ };
```

- [ ] Step 4 `node --test tests/db.test.js` 绿 → commit `✨ feat(db): pg 连接与编号 migration 基础设施`

### Task 2: repository（registry + store 组装 + hash-diff 保存 + texts）

**Files:** Modify `lib/db.js`（加 createRepository）、`tests/db.test.js`

- [ ] Step 1 失败测试（追加）：

```js
const { createRepository } = require('../lib/db');
async function repoMem() { const db = memDb(); await db.migrate(); return { db, repo: createRepository(db) }; }

test('registry: 空库返回 null，upsert 后可读', async () => {
  const { repo } = await repoMem();
  assert.equal(await repo.loadRegistry(), null);
  await repo.upsertSpaceMeta({ id: 'default', name: '默认', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  await repo.setActiveSpaceId('default');
  const reg = await repo.loadRegistry();
  assert.equal(reg.activeSpaceId, 'default');
  assert.equal(reg.spaces[0].papersDir, '.');
});

test('store 保存/组装 roundtrip + filepath 不落库 + filename 派生', async () => {
  const { repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = { version: 2, tags: ['llm'], topics: ['大模型'], folders: [{ id: 'f1', name: 'A', color: '#fff', createdAt: 1 }],
    concepts: [{ id: 'c1', term: 'MoE', definition: 'd', paperIds: ['p1'], createdAt: 1, updatedAt: 1 }],
    settings: { summaryPrompt: 'x' },
    papers: { p1: { id: 'p1', filename: 'a.pdf', filepath: '/papers/a.pdf', title: 'T', tags: [], topics: [],
      folders: [], conceptIds: [], readProgress: null, annotations: null, rating: 0, starred: false, chat: [],
      status: 'ready', customFutureField: 42 } } };
  await repo.saveSpaceStore('s1', store);
  const loaded = await repo.loadSpaceStore('s1');
  assert.equal(loaded.papers.p1.filename, 'a.pdf');
  assert.equal(loaded.papers.p1.filepath, undefined);         // 派生字段不落库
  assert.equal(loaded.papers.p1.customFutureField, 42);       // extra 兜底
  assert.deepEqual(loaded.tags, ['llm']);
});

test('hash-diff: 未变更不产生写', async () => {
  const { repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  await repo.saveSpaceStore('s1', store);
  const w1 = repo._stats().rowsWritten;
  await repo.saveSpaceStore('s1', store);
  assert.equal(repo._stats().rowsWritten, w1); // 第二次零写
});

test('删除的论文行与全文一起消失', async () => { /* save 含 p1 → save 不含 p1 → loadSpaceStore 无 p1，getPaperText null */ });
test('texts: save/get/remove roundtrip', async () => { /* savePaperText → getPaperText 相等 → removePaperText → null */ });
```

- [ ] Step 2 实现 `createRepository(db)`。要点（完整逻辑，实现时照此展开）：
  - `PAPER_COLS` 映射表：`fileMtime→file_mtime` 等 camel↔snake；`paperToRow(p)` 取已知字段，剩余（除 `filepath`/`fulltextPath`）收进 `extra`；`rowToPaper(row)` = `{...row.extra, ...已知列}`，`fulltextPath: null`。
  - `snapshots: Map<spaceId, {papers:Map<id,hash>, concepts:Map, folders:Map, tags, topics, settings}>`，`hash = sha1(JSON.stringify(canonical))`；load 与 save 后都刷新快照。
  - `saveSpaceStore(id, store)`：进模块级 `writeChain` 串行；BEGIN → 变化 papers upsert（`INSERT ... ON CONFLICT (space_id,id) DO UPDATE`）、消失 papers `DELETE`（连带 `DELETE FROM paper_texts`）、concepts/folders 同法、tags/topics/settings 变了才 `UPDATE spaces SET ...` → COMMIT；`_stats()` 计数供测试。
  - `loadRegistry()`：`SELECT` spaces meta 列 + `app_state['activeSpaceId']`；无行返回 null。
  - `upsertSpaceMeta` / `deleteSpaceRow`（删 spaces + papers + paper_texts + concepts + folders 五表）/ `setActiveSpaceId`。
  - `savePaperText(spaceId, pid, text)` / `getPaperText` / `removePaperText`。
- [ ] Step 3 `node --test tests/db.test.js` 绿 → commit `✨ feat(db): repository——store 组装/hash-diff 事务保存/paper_texts`

### Task 3: spaces.js 迁到 repository + filepath 派生

**Files:** Modify `lib/spaces.js`、`lib/store.js`、`server.js`、`tests/spaces.test.js`

- [ ] Step 1 改测试基建：`createSpaceManager({ repo, papersRoot, globalConfig })`（对象参数取代 `(dataDir, projectRoot, globalConfig)`）；测试里 repo 用 pg-mem，papersRoot 用 `fs.mkdtempSync`。原 22 例逐个迁移；文件注册表/legacy 迁移相关用例移除（职责转 Task 9 脚本），新增：
  - `getSpaceStore 返回的每篇 paper 带派生 filepath = papersRoot/papersDir/filename`
  - `saveSpaceStore 后 repo 中无 filepath`（复用 Task 2 断言思路）
  - `resolveSpacePapersDir 拒绝越界`：`papersDir: '../evil'` → throw
- [ ] Step 2 实现：
  - 注册表内存态从 repo 装载（`ensureRegistry`：`loadRegistry()` 为 null 时建 default 行 `{id:'default', papersDir:'.'}`）；`saveRegistry` → 逐 space `upsertSpaceMeta` + `setActiveSpaceId`（只在对应操作里调，不整表重写）。
  - `resolvePapersDir(papersRoot, rel)`：`path.resolve` 后强校验 `within(papersRoot)`，否则 throw `文件夹必须在挂载根内`；mkdir recursive 保留。
  - `getSpaceStore`：`repo.loadSpaceStore` → 对每篇 `p.filepath = path.join(resolveSpacePapersDir(id), p.filename || '')` → 缓存；`saveSpaceStore`：直接透传 repo（repo 负责剥 filepath）。
  - `resolveSpaceTextDir` 删除，新增 `textStoreBinder(id)` → `{ load: (pid) => repo.getPaperText(id,pid), save: (pid,t) => repo.savePaperText(id,pid,t), remove: (pid) => repo.removePaperText(id,pid) }`。
  - `createSpace`：默认 papersDir = `<id>`（根内子目录）；`deleteSpace` → `repo.deleteSpaceRow`；`changePapersDir` 保留但标记 `@deprecated`（Task 5 的 applyPapersDirChange 取代，前端不再直连）。
  - `backupAllSpaces` 移到 server.js 侧重写（Task 8），此处暂留调用 repo 版占位实现：序列化 store 写 `<backupsDir>/<spaceId>/papers-YYYYMMDD.json`，保留 7 份（`lib/store.js` 的 `backupStore` 改签名为 `backupStoreObject(dir, store)` 供其调用）。
  - `server.js` 装配同步改（见 Task 8 完整版，此处先让启动能跑：createDb → migrate → createRepository → createSpaceManager({repo, papersRoot: process.env.PAPERS_ROOT || path.join(__dirname,'papers'), globalConfig})）。
- [ ] Step 3 全量 `node --test` 绿 → commit `♻️ refactor(spaces): 注册表与 store 迁 PG repository，filepath 运行时派生`

### Task 4: scanner/api 全文 IO 点 → textStore

**Files:** Modify `lib/scanner.js`（115-135、433-441、479-490、541-557 各处）、`lib/api.js:187`、`tests/scanner.test.js`、`tests/api.test.js`

- [ ] Step 1 失败测试：scanner 单测的 deps 增加 `textStore` mock（`{save,load,remove}` 记录调用），断言 processOne 后 `textStore.save(id, text)` 被调、store.papers[id].fulltextPath === null、extractConcepts/chat 走 `textStore.load`。
- [ ] Step 2 实现：`createScanner({ store, papersDir, textStore, deps })`（去掉 storePath 参数）；5 处 `fsp.readFile(textDir…)` / 写 txt → `textStore.load/save`；`createMultiSpaceScanner` 为每空间注入 `manager.textStoreBinder(spaceId)`；api.js DELETE 路由的 `fulltextPath` 分支 → `ctx.textStore.remove(id)`（resolveSpace 返回值里带 textStore）。
- [ ] Step 3 全量测试绿 → commit `♻️ refactor(scanner/api): 全文 IO 走 repo paper_texts`

### Task 5: 绑定重设计后端（preview / move / rebind + 校验）

**Files:** Modify `lib/spaces.js`、`lib/api.js`、`lib/scanner.js`（导出 fingerprint 复用）、`tests/spaces.test.js`、`tests/api.test.js`

- [ ] Step 1 失败测试（spaces.test.js）：
  - preview：新目录放 2 个 PDF（1 个与库内 p1 同内容、1 个新）→ `{ pdfCount:2, matched:1, willMissing:1, newFiles:1 }`（库内另有 p2 无匹配）
  - move：旧目录 2 个库内 PDF → apply(move) 后文件物理位于新目录、store filename/filepath 更新、旧目录空、papersDir 已改
  - move 撞名：新目录已有同名不同内容文件 → 库文件改名 `name (id).pdf`
  - rebind：文件已手动挪到新目录 → apply(rebind) 后 matched 篇 filepath 指新目录、无匹配篇 status='missing'
  - 校验：newDir 越界根 / 与其他空间目录相同或嵌套 → throw
- [ ] Step 2 实现（lib/spaces.js）：

```js
async function previewPapersDirChange(id, newDir) {
  const sp = mustSpace(id);
  const abs = resolvePapersDir(papersRoot, newDir);           // 越界即 throw
  assertNoDirConflict(id, newDir);                            // 与他空间 相同/父子 → throw
  const store = await getSpaceStore(id);
  const items = await scanDir(abs);                           // 复用 scanner.scanDir（单层 *.pdf）
  const fp = await fingerprintAll(items);                     // [{id, filepath, filename, ...}]
  const inLib = new Set(Object.keys(store.papers));
  const matched = fp.filter((f) => inLib.has(f.id));
  const matchedIds = new Set(matched.map((f) => f.id));
  return { newDir, pdfCount: fp.length, matched: matched.length,
    willMissing: [...inLib].filter((pid) => !matchedIds.has(pid)).length,
    newFiles: fp.length - matched.length,
    missingList: [...inLib].filter((pid) => !matchedIds.has(pid))
      .map((pid) => ({ id: pid, title: store.papers[pid].title, filename: store.papers[pid].filename })) };
}

async function applyPapersDirChange(id, newDir, mode) {       // mode: 'move' | 'rebind'
  const sp = mustSpace(id);
  const newAbs = resolvePapersDir(papersRoot, newDir);
  assertNoDirConflict(id, newDir);
  const store = await getSpaceStore(id);
  const errors = [];
  if (mode === 'move') {
    for (const p of Object.values(store.papers)) {
      if (!p.filepath || !fs.existsSync(p.filepath)) { p.status = 'missing'; continue; }
      let name = p.filename || path.basename(p.filepath);
      let target = path.join(newAbs, name);
      if (fs.existsSync(target) && !sameFile(target, p.filepath))
        { name = withIdSuffix(name, p.id); target = path.join(newAbs, name); }
      try { await moveFile(p.filepath, target);               // rename，EXDEV 回退 copy+unlink
            p.filename = name; }
      catch (e) { errors.push({ id: p.id, error: e.message }); p.status = 'missing'; }
    }
  } else {                                                    // rebind：按 sha1 对账
    const fp = await fingerprintAll(await scanDir(newAbs));
    const byId = new Map(fp.map((f) => [f.id, f]));
    for (const p of Object.values(store.papers)) {
      const hit = byId.get(p.id);
      if (hit) { p.filename = hit.filename; if (p.status === 'missing') p.status = 'ready'; }
      else p.status = 'missing';
    }
  }
  sp.papersDir = String(newDir);
  await repo.upsertSpaceMeta(sp);
  for (const p of Object.values(store.papers))               // filepath 派生刷新
    p.filepath = path.join(newAbs, p.filename || '');
  await saveSpaceStore(id, store);
  return { mode, papersDir: sp.papersDir, errors,
    missing: Object.values(store.papers).filter((p) => p.status === 'missing').length };
}
```

  `assertNoDirConflict`：遍历其他空间 `resolveSpacePapersDir`，`a===b || a.startsWith(b+sep) || b.startsWith(a+sep)` → throw。`fingerprintAll`/`scanDir` 从 `lib/scanner.js` require（已导出）。
- [ ] Step 3 api.js 路由（spaces 路由组内）：`POST /api/spaces/:id/dir/preview {newDir}` → previewPapersDirChange；`POST /api/spaces/:id/dir {newDir, mode}` → 包裹 `scanner.stop(); await scanner.drain(10000);` try `applyPapersDirChange` finally `scanner.start();` 完成后 `scanner.scan().catch(()=>{})`。api.test.js 加两条路由用例。
- [ ] Step 4 全量测试绿 → commit `✨ feat(spaces): papersDir 改绑 预检/move/rebind 原子语义 + 目录冲突校验`

### Task 6: 扫描 missing 熔断

**Files:** Modify `lib/scanner.js`（scan() 内 diffPapers 之后，`for (const m of missing)` 处）、`lib/api.js`（health）、`tests/scanner.test.js`

- [ ] Step 1 失败测试：库内 8 篇、扫描结果空目录 → scan 后所有 status 仍非 missing、返回 `{ missingFuse: true }`；库内 8 篇缺 2 篇 → 正常标 missing、无 fuse。
- [ ] Step 2 实现：

```js
const total = Object.keys(store.papers).length;
const fuse = missing.length > 5 && missing.length > total * 0.5;
if (fuse) log(`[scan] missing 熔断：${missing.length}/${total} 篇同时缺失，疑似目录挂载失效，本轮不翻转状态`);
else for (const m of missing) store.papers[m.id].status = 'missing';
lastFuse = fuse ? { at: Date.now(), missing: missing.length, total } : null;  // scanner 闭包态
// scan 返回值加 missingFuse: fuse；multi scanner 聚合 per-space
```

  api.js `/api/health` 响应加 `missingFuse: scanner.getFuseState()`（multi scanner 暴露 `getFuseState() → {spaceId: fuseInfo}`，无熔断为 {}）。
- [ ] Step 3 全量测试绿 → commit `✨ feat(scanner): missing 大面积缺失熔断（挂载失效防护）`

### Task 7: 前端向导（空间管理模态）

**Files:** Modify `public/index.html`（管理模态）、`public/app.js`、`public/styles.css`

- [ ] Step 1 index.html：管理模态中每空间行的 papersDir `<input>` 改为只读文本 + `更改文件夹…` 按钮；新增向导模态骨架 `#dir-wizard`（三步容器：路径输入 / 预检报告 + 模式单选（`移动文件到新文件夹` / `仅重新绑定（文件已在新位置）`）/ 结果页含 errors/missing 清单）。图标用现有细线 SVG 风格，不用 emoji。
- [ ] Step 2 app.js：`openDirWizard(spaceId)` → step1 输入（placeholder 提示相对挂载根）→ `POST sp('/api/spaces/'+id+'/dir/preview')` 渲染报告（pdfCount/matched/willMissing/newFiles + missingList 前 10 条）→ 选模式 → `POST /dir {newDir, mode}` → 结果页 → `refreshSpaces() + refresh()`。willMissing>0 且选 move 时按钮文案提示「N 篇在旧目录也找不到文件，将标记缺失」。失败（409 冲突/400 越界）在 step1 内联报错。
- [ ] Step 3 styles.css：向导步骤条/报告卡片/危险色提示，贴合现有 Indigo 模态样式。
- [ ] Step 4 手动验证（浏览器）：预检数字正确、move 后文件真的移动、rebind 后列表不再 missing → commit `✨ feat(ui): 文件夹改绑三步向导（预检→模式→结果）`

### Task 8: server.js 装配 + 备份改造

**Files:** Modify `server.js`、`lib/store.js`（backupStoreObject）、`tests/store.test.js`

- [ ] Step 1 失败测试：`backupStoreObject(dir, store)` 写 `papers-YYYYMMDD.json`、同日幂等、超 7 份裁剪最旧。
- [ ] Step 2 server.js `main()`：

```js
const { createDb, createRepository } = require('./lib/db');
const db = createDb({ connectionString: process.env.DATABASE_URL || config.databaseUrl });
try { await db.migrate(); } catch (e) {
  console.error('[fatal] PostgreSQL 不可用：', e.message); process.exit(1);   // Docker restart 兜底重试
}
const repo = createRepository(db);
const papersRoot = process.env.PAPERS_ROOT || path.join(projectRoot, 'papers');
const manager = createSpaceManager({ repo, papersRoot, globalConfig: config });
// backupAllSpaces：遍历空间 getSpaceStore → backupStoreObject(BACKUP_DIR/<id>, store)
// BACKUP_DIR = process.env.BACKUP_DIR || path.join(projectRoot, 'backups')
// shutdown 追加 await db.close()
```

- [ ] Step 3 全量测试绿；本地起 dev postgres（`docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`）冒烟 `DATABASE_URL=... node server.js` → `/api/health` 200 → commit `♻️ refactor(server): PG fail-fast 装配 + JSON 快照备份`

### Task 9: 迁移脚本 scripts/migrate-json-to-pg.js

**Files:** Create `scripts/migrate-json-to-pg.js`；Modify `tests/db.test.js`（迁移函数用例）

- [ ] Step 1 失败测试：构造临时旧结构（spaces.json + spaces/default/{papers.json,text/p1.txt}，papers.json 内 filepath 绝对路径 + papersDir:'papers'）→ `migrateJsonToPg(legacyDir, repo, { papersRoot })` → registry 有 default（papersDir '.'）、paper filename=basename、text 入库、二次执行幂等（rowsWritten 不增）。
- [ ] Step 2 实现：核心函数导出供测试；CLI 入口 `node scripts/migrate-json-to-pg.js [legacyDataDir=./data]`，用 `loadStore`（保留的文件版）逐空间读 → papersDir 映射（`'papers'→'.'`、`papers/xx→xx`、绝对/越界 → warn + `'.'`）→ `repo.upsertSpaceMeta` + `saveSpaceStore` + 逐篇 `savePaperText`；输出逐空间统计。
- [ ] Step 3 测试绿 → commit `✨ feat(scripts): JSON→PG 一次性迁移（幂等）`

### Task 10: Docker 化

**Files:** Create `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.env.example`、`scripts/backup-pg.sh`；Modify `config.example.json`（`discover.queryEngine: "gateway"`、加 `databaseUrl` 注释项）、`package.json`（scripts: `migrate:pg`）

- [ ] Step 1 Dockerfile：

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8888 PAPERS_ROOT=/papers BACKUP_DIR=/app/backups
EXPOSE 8888
USER node
CMD ["node", "server.js"]
```

- [ ] Step 2 docker-compose.yml：

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports: ["127.0.0.1:${APP_PORT:-8888}:8888"]
    environment:
      DATABASE_URL: postgres://paperwiki:${POSTGRES_PASSWORD}@postgres:5432/paperwiki
    volumes:
      - ${PAPERS_ROOT}:/papers
      - ./config.json:/app/config.json:ro
      - backups:/app/backups
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8888/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: paperwiki
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: paperwiki
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperwiki"]
      interval: 5s
      timeout: 3s
      retries: 20
volumes: { pgdata: {}, backups: {} }
```

  `.env.example`：`PAPERS_ROOT=D:/papers_root`、`POSTGRES_PASSWORD=change-me`、`APP_PORT=8888`。`.dockerignore`：node_modules/data/papers/backups/.git/.zcode/.playwright-cli/tests/docs。`backup-pg.sh`：`docker compose exec -T postgres pg_dump -U paperwiki paperwiki | gzip > backup-$(date +%Y%m%d).sql.gz`。
- [ ] Step 3 验证：`docker compose build && docker compose up -d` → `curl 127.0.0.1:8888/api/health` 200 → 迁移 `docker compose run --rm -v ./data:/legacy-data app node scripts/migrate-json-to-pg.js /legacy-data` → 浏览器验证论文列表/阅读器/空间切换 → commit `🐳 feat(deploy): Docker Compose 生产部署（app+postgres）`

### Task 11: e2e/CI 适配

**Files:** Modify `scripts/e2e-bootstrap.js`（经 createDb/repo 预置数据，DATABASE_URL 入参）、`.github/workflows/ci.yml`（e2e job 与新增 pg-smoke job 加 `services: postgres`）

- [ ] Step 1 e2e-bootstrap 改造后本地跑 `npm run test:e2e`（连 dev postgres）全绿。
- [ ] Step 2 ci.yml：两个 job 加 postgres service（`postgres:16-alpine` + health options），env 注入 DATABASE_URL；pg-smoke job：migrate → 起 server → health → 建空间 → CRUD 一轮 curl。
- [ ] Step 3 commit `👷 ci: postgres service + 集成冒烟`

### Task 12: 文档同步

**Files:** Modify `AGENTS.md`（架构图/数据流/陷阱：新增「jsonb 必须 stringify」「filepath 派生不落库」「绑定必须走 preview/apply」「missing 熔断」；删除 pm2 相关，改 docker compose restart）、`README.md`（部署章节）、`CHANGELOG.md`（v3.0.0）、`CLAUDE.md`（重启方式改 `docker compose restart app`）

- [ ] Step 1 全部更新 → `npm run lint && npm run format:check && node --test` 全绿 → commit `📝 docs: v3.0 PG+Docker 架构文档同步`

---

## Self-review 结论

- Spec 覆盖：schema(T1)、repository/hash-diff/extra(T2)、spaces/filepath 派生(T3)、全文 IO(T4)、绑定三步语义+校验(T5)、熔断(T6)、前端向导(T7)、装配+备份双保险(T8+T10 backup-pg.sh)、迁移脚本(T9)、Docker/compose/.env/queryEngine(T10)、e2e/CI(T11)、文档(T12)。无缺口。
- 类型一致性：`textStore {load,save,remove}`、`applyPapersDirChange(id,newDir,mode)`、`repo.upsertSpaceMeta/loadSpaceStore/saveSpaceStore/savePaperText/getPaperText/removePaperText/deleteSpaceRow/setActiveSpaceId/loadRegistry` 全计划统一。
