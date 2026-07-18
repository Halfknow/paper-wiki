# PaperWiki 生产化重构设计：PostgreSQL 迁移 + Docker 化 + 空间绑定语义重设计

> 日期：2026-07-18　状态：已确认（用户逐项决策）
> 目标：pm2 + 本地 JSON → Docker Compose + PostgreSQL，前端与业务逻辑不变，生产级可运维。

## 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 部署环境 | 本机 Docker Desktop (Windows)，papers 目录 bind mount |
| 存储粒度 | 关系表 + JSONB 混合（papers 每篇一行，嵌套结构 JSONB 列） |
| 论文全文 | 进库，独立 `paper_texts` 表 |
| 目录挂载 | 单一挂载根：宿主 `PAPERS_ROOT`（如 `D:\papers_root`）→ 容器 `/papers`，所有空间 papersDir 为根内相对路径 |
| PG 实例 | compose 内置 `postgres:16-alpine`，named volume，不对宿主暴露端口 |
| 绑定语义 | 预检 → 明确意图（移动/重绑）→ 原子执行；filepath 改为运行时派生（根因修复） |

## 一、总体架构

```
docker-compose.yml
├─ app        node:20 镜像，node server.js（pm2 退役，守护交给 Docker restart: unless-stopped）
│    ├─ ports: 127.0.0.1:8888:8888（保持不对局域网暴露语义）
│    ├─ bind:  ${PAPERS_ROOT} → /papers（读写：扫描改名/导入下载/删除）
│    ├─ bind:  ./config.json → /app/config.json:ro（AI key 等业务配置）
│    ├─ volume: backups → /app/backups（每日 JSON 快照逃生通道）
│    ├─ env:  DATABASE_URL / HOST=0.0.0.0 / PORT / PAPERS_ROOT=/papers
│    └─ healthcheck: GET /api/health
└─ postgres   postgres:16-alpine
     ├─ volume: pgdata → /var/lib/postgresql/data
     └─ healthcheck: pg_isready；app depends_on: service_healthy
```

- 「单实例保写锁」由单容器单进程天然满足；进程内串行写锁语义保留在 repository 层。
- 容器内不装 claude CLI：`config.discover.queryEngine` 默认 `gateway`（兜底链不动，跳过必败 spawn）。
- `.env`（gitignore）+ `.env.example` 管理部署参数：`PAPERS_ROOT`、`POSTGRES_PASSWORD`、`APP_PORT`。

## 二、数据库 Schema

不引 ORM；启动时幂等执行编号 migration（`migrations/*.sql` + `schema_migrations` 表）。

```sql
app_state    (key TEXT PK, value JSONB)          -- activeSpaceId 等原 spaces.json 元数据
spaces       (id TEXT PK, name TEXT, papers_dir TEXT,       -- papers_dir: 相对 /papers 根
              scan_interval_minutes INT, last_scan_at BIGINT, created_at BIGINT,
              tags JSONB, topics JSONB, settings JSONB)
papers       (space_id TEXT, id TEXT, PRIMARY KEY(space_id, id),
              filename TEXT,                                 -- 相对 papersDir；不存绝对 filepath
              file_mtime DOUBLE PRECISION, file_size BIGINT,
              added_at BIGINT, updated_at BIGINT,
              title TEXT, year INT, abstract TEXT,
              arxiv_id TEXT, arxiv_url TEXT, primary_category TEXT,
              meta_source TEXT, meta_confidence REAL,
              fulltext_chars INT,
              summary TEXT, summary_model TEXT, summary_at BIGINT,
              notes TEXT, rating INT, starred BOOL, read_status TEXT,
              status TEXT, error TEXT,
              authors JSONB, tags JSONB, topics JSONB, concept_ids JSONB,
              folders JSONB, read_progress JSONB, annotations JSONB, chat JSONB)
paper_texts  (space_id TEXT, paper_id TEXT, PRIMARY KEY(space_id, paper_id), fulltext TEXT)
concepts     (space_id TEXT, id TEXT, PRIMARY KEY(space_id, id),
              term TEXT, definition TEXT, paper_ids JSONB, created_at BIGINT, updated_at BIGINT)
folders      (space_id TEXT, id TEXT, PRIMARY KEY(space_id, id),
              name TEXT, color TEXT, created_at BIGINT)
```

- paper id 语义不变：内容 sha1 前 16 位；同 PDF 跨空间是独立行（PK 含 space_id）。
- 全文独立表：papers 列表查询不拖大行；未来可加 tsvector / pgvector 不动架构。
- `fulltextPath` 字段废弃（内存 store 兼容保留 null）。

## 三、持久化适配层（上层零改动）

新增 **`lib/db.js`**：pg Pool、migrate、repository。改造严格收口三处：

1. **`lib/spaces.js`**：注册表与 store 读写内部实现换成 repository；对外签名全部不变。
   `deps.saveStore(store)` 仍是单参闭包（陷阱 1 继续成立）；内存 store 仍是 v2 形状。
2. **`lib/store.js`**：`emptyStore`/`migrateStore`/`normalizePaper` 纯逻辑保留；
   文件 load/save 保留仅供迁移脚本与 JSON 快照使用。
3. **scanner/api 的全文 IO 点**：读写 `data/text/<id>.txt` 处改为 `repo.savePaperText`/`repo.getPaperText`。

**写放大 → hash-diff**：`saveSpaceStore(id, store)` 语义仍是「整库保存」。repository 缓存上次保存时
每篇论文（及 concepts/folders/tags/topics/settings）的序列化 hash，保存时逐项比对，**只把变化行放进
一个事务** upsert/delete。scanner `processOne` 每次实际只改一篇 → 每次事务 1-2 行。
事务原子性替代原「临时文件 + rename」原子写；`writeChain` 串行锁语义保留在 repository 内。

**filepath 派生（绑定 desync 根因修复）**：数据库只存 `filename`；load 组装 store 时合成
`p.filepath = path.join(resolveSpacePapersDir(id), filename)`，save 时丢弃 filepath。
上层（scanner extractText/rename、api serve PDF/删除）照旧读 `p.filepath`，不改。
scanner 内改名文件后照旧写 `cur.filepath`，save 时由 repository 从 filepath 提取 basename 存 filename。

## 四、空间绑定语义重设计

### 现状 bug（根因分析）

`changePapersDir` 只改注册表字符串：已入库论文 filepath 仍指旧目录 → 下轮扫描全库标 missing、
阅读/删除/改名指向旧路径；无预检；允许绑定重复/嵌套目录（两个扫描器 rename 竞争）；
挂载失效（容器看到空目录）会静默把全库翻 missing。

### 新设计

**① 预检 API**：`POST /api/spaces/:id/dir/preview { newDir }` → 对账报告：

```jsonc
{ "newDir": "...", "pdfCount": 12,          // 新目录（单层）PDF 数
  "matched": 8,                              // sha1 与本空间已入库论文匹配
  "willMissing": 3,                          // 库内论文在新目录无匹配
  "newFiles": 4,                             // 新目录中未入库的文件
  "conflicts": [] }                          // 与其他空间目录 相同/嵌套 冲突
```

**② 执行 API**：`POST /api/spaces/:id/dir { newDir, mode }`，`mode ∈ { move, rebind }`：

- `move`（搬移库文件）：把本空间所有已入库且存在的 PDF 从旧目录 rename（跨设备回退 copy+unlink）
  到新目录，撞名加 ` (id)` 后缀；全部搬完后一个事务更新 filename + papers_dir。
  单篇失败记入结果 `errors[]` 并标该篇 missing，不中断整体。
- `rebind`（仅重新绑定）：改 papers_dir 后立即对新目录做 sha1 对账：匹配的更新 filename，
  不匹配的标 missing（明确返回清单），新文件交给随后触发的 scan 正常入库。
- 两种模式执行期间该空间扫描暂停（复用 scanner busy 锁），完成后主动触发一次 scan。
- 校验：newDir 必须在 `/papers` 根内（拒绝越界/绝对宿主路径）；不得与其他空间目录相同或互为父子。

**③ 扫描 missing 熔断**：单轮 scan 中 `missing 数 > 5 且 > 库内 50%` 视为异常
（典型：挂载失效、目录被清空），本轮不翻转任何 missing 状态，仅记录告警日志 +
在 `/api/health` 与 scan 结果中暴露 `missingFuse: true`。正常少量 missing 照旧标记。

**④ 前端向导**（空间管理模态）：文件夹字段改为只读展示 + 「更改文件夹…」按钮 →
三步向导：输入新路径（提示相对 /papers 根）→ 展示预检报告 → 选「移动文件到新文件夹」或
「仅重新绑定（文件已在新位置）」→ 执行 → 展示结果（成功/失败/缺失清单）→ 刷新列表。
新建空间时 papersDir 默认 `<space-id>`（根内子目录）。

## 五、数据迁移与备份

- **一次性迁移**：`scripts/migrate-json-to-pg.js` 读旧 `data/spaces.json` +
  `data/spaces/<id>/{papers.json, text/*.txt}` 全量 upsert 进 PG，幂等可重跑。
  旧绝对 Windows papersDir → 转换为 /papers 根内相对路径（无法转换的打警告，
  需在 `.env` 设 PAPERS_ROOT 后手动确认映射）；filepath → basename 存 filename。
  运行：`docker compose run --rm -v ./data:/legacy-data app node scripts/migrate-json-to-pg.js /legacy-data`。
- **备份双保险**：
  1. 保留「每日备份」语义：app 启动 + 每 6h 检查，把每空间 store 从 PG 导出 JSON 快照
     到 backups volume（按天去重，保留 7 份）——兼容现有格式，也是 PG→JSON 逃生通道；
  2. `scripts/backup-pg.sh`：pg_dump 供宿主定时任务调用。
- 「papers.json 损坏自愈」在 PG 时代自然消失；从 JSON 快照恢复保留为手动工具（迁移脚本可复用）。

## 六、测试与工程化

- **单测**：store.test.js 纯逻辑部分照旧；新增 `tests/db.test.js` 用 **pg-mem** 跑 repository
  （schema/组装/hash-diff/事务/filename 派生），`node --test` 本地无需真实 PG。
- **spaces/scanner/api 测试**：deps 注入点不变，注入 pg-mem repository 或 mock；
  新增绑定 preview/move/rebind、missing 熔断用例（TDD：先写失败用例）。
- **CI**：现有 lint+unit / e2e 两 job 保留；新增 `services: postgres` 集成 job
  （migrate + 启动 + /api/health + CRUD 冒烟）。
- **e2e**：Playwright 走 HTTP 层不变；`scripts/e2e-bootstrap.js` 改为向 PG 预置数据。
- **文档**：AGENTS.md / README / CHANGELOG 同步（部署方式、绑定语义、陷阱更新）。

## 错误处理

- PG 不可用：启动 fail-fast（清晰日志）+ Docker restart 重试；运行中查询失败沿用现有 try/catch。
- 迁移脚本失败：逐空间事务，失败空间报错不影响已迁空间；可重跑。
- move 模式单篇搬移失败：记录 errors[]，该篇标 missing，整体不回滚已成功篇（文件操作不可事务化，
  以「每篇完成即一致」为准则：文件先动、DB 后记，重跑 rebind 可对账修复）。

## 非目标（YAGNI）

- 不做多实例/水平扩展（写锁模型不变）；不加鉴权（继续 127.0.0.1）；
- 不做 tsvector/pgvector（schema 已预留可能性）；不改任何前端交互（绑定向导除外）；
- 不做 PDF 文件本身进库（继续文件系统 + bind mount）。
