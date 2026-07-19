# CLAUDE.md

本项目面向 AI agent / Claude Code 的指南**以 [`AGENTS.md`](./AGENTS.md) 为单一事实源**（架构、数据流、关键约定与陷阱），避免两份文档分叉。请先读它。

人类向的功能介绍见 [`README.md`](./README.md)；逐版本变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 最重要的几条（详见 AGENTS.md「关键约定 / 陷阱」）

- **v3 跑在 Docker 里**：任何代码改动（含前端 public/，都打进镜像）须 `docker compose up -d --build app` 重建生效；只改 `config.json`（挂载文件）`docker compose restart app` 即可。本地 `node server.js` 开发需 `DATABASE_URL` 指向一个 PG（dev 实例见 AGENTS.md「运行/测试」）。
- **双 PG 设计（生产 + 测试，compose 同文件维护）**：`postgres`（生产，端口 25432，持久卷，存真实论文）+ `postgres-test`（测试，端口 15432，无持久卷，密码 dev）。两者用 compose profile 隔离：`docker compose up` 只起生产；测试 PG 用 `docker compose --profile test up -d postgres-test` 起。**勿直连生产 PG 跑 e2e**（会在 default 空间注入假 sample + 高亮测试数据污染真实库）；**勿手动 `docker run` 制造游离 PG**。详见 AGENTS.md「工程化」。
- **持久化在 PostgreSQL**（src/db repository，hash-diff 事务保存）：内存 store 仍是 v2 形状；**filepath 运行时派生不落库**（papersDir+filename）；jsonb 参数必须 JSON.stringify；全文 NUL 剥离。
- **`deps.saveStore(store)` 单参**：误写两参历史上写坏过全库。
- **papersDir 改绑必须走 preview→move/rebind 三步语义**（POST /api/spaces/:id/dir[/preview]），不许直接改字符串；空间目录不得相同/互相嵌套。
- **paper id = 文件内容 sha1 前 16 位**，与文件名无关：改名 / 删除文件不影响 id、全文、概念、批注。
- **空总结不可当成功**：模型返回空对象时存可重试占位，不写空「## TL;DR」。
- **发现的查询理解三级兜底**：`claude -p`（无头常 401，且新版输出是消息数组）→ GLM 网关 → 原始主题；排序是「相关·权威·新近」复合分，不是单引用量。
- **裸 arXiv ID 文件名**（`2012.12556.pdf`）靠 `parseArxivUrl(文件名)` 识别走 `id:` 精确查，别退回 `cleanFilenameToTitle`（会把 ID 当年份删掉）。

## 工程纪律

- 改动配套 `node --test`（当前 225 例，pg-mem 无需真实 PG）；`npm run lint`（ESLint）、`npm run format:check`（Prettier，仅 `lib/server/tests`）。
- 新功能优先 TDD：先写/改测试看其失败，再实现。
- 提交信息用约定式 + emoji，结尾带 `Co-Authored-By`。
