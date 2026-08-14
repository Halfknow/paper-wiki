# PaperWiki — 本地 arXiv 论文管理站

一个**薄**的 Web 服务：扫描论文目录里的 PDF，自动提取文本、查 arXiv 补全元数据、用 OpenAI 兼容接口（如你的 New API gateway / 智谱 / DeepSeek）生成总结、细粒度标签、粗粒度主题与**概念清单**，并提供一个 Indigo 主题的可筛选/搜索/编辑笔记/独立 PDF 阅读器（**双页、批注高亮/便签/手写**）页面。

> **v3.0 起**：数据全量存 **PostgreSQL**（论文元数据 + 全文 + 批注 + 设置），服务以 **Docker Compose** 部署（app + postgres 两容器）；论文 PDF 仍是你磁盘上的普通文件（bind mount 进容器）。

## 功能

- 📁 **持续扫描**：增量扫描 `papers/`，按文件内容 sha1 识别新增/变更（改名/移动不丢笔记）
- 🔭 **按主题发现论文**：顶栏「发现」输入研究主题/名词（中英文均可）→ LLM（`claude -p`，失败回退 GLM 网关）生成 arXiv 检索式 → **两轴召回**（相关度 + 最新）→ Semantic Scholar / OpenAlex 补引用量 → **复合排序**（相关·权威·新近）→ 剔除已入库 → 勾选批量导入。**SSE 流式进度**全程可见
- 🔗 **arXiv 网址导入**：顶栏粘贴 arXiv `abs`/`pdf`/`html` 网址或裸 ID（如 `2310.01234`）下载并入库
- 🏷️ **规范命名**：发现/网址导入的论文按「作者 等 - 年份 - 标题.pdf」落盘（净化非法字符），元数据空缺时按文件名里的 arXiv ID 自动补全并改名
- 🗑️ **删除论文**：详情页「删除」按钮，连同本地 PDF 与全文一并移除（二次确认）
- 🎨 **Indigo 主题**：淡蓝灰底 + Indigo 强调色；chip 高区分（主题色轮换 / 标签中性灰 / 指标青 / 状态语义色）
- 🗂️ **虚拟收藏夹**：在页面里建文件夹（如「精读 / 待复现 / 综述」），一篇论文可属多个收藏夹，与磁盘目录解耦；侧栏「收藏夹」标题行的 ⚙ 打开管理面板——新建 / 改名换色（行内编辑）/ 拖拽排序 / 删除一处收口
- 🏷️ **双维度筛选**：
  - **标签 tag**（细粒度英文技术词，AI 自动生成，全局字典去重，可合并/重命名/删除）
  - **主题 topic**（AI 给的 1–3 个中文大方向，如「推理 / 数据选择」，作为一级筛选维度）
- 📝 **笔记 + 实时预览**：Markdown 编辑器，左侧编辑、右侧 `marked` + KaTeX 实时预览，自动保存
- 🔍 **搜索与筛选**：按标题/摘要/总结/笔记/标签/主题全文搜索，按标签/主题/收藏夹/阅读状态/星标筛选，支持标题/年份/添加/更新多维度排序
- 📄 **PDF 阅读器**（基于 pdf.js 官方 PDFViewer）：点「打开 PDF」进入全屏阅读器
  - ⤴️ **续读**：自动记录页码 + 滚动位置 + 缩放，下次从上次位置接着读
  - 📖 **双页全宽**：默认双页并排填满窗口宽度，页间留小间隙；可切单页
  - 🔍 **缩放**：按钮、Ctrl/Cmd + 滚轮、**触控双指缩放**、适应宽度
  - 🖍️ **批注**：高亮（选中文字着色）、便签（点击添加文字备注）、手写（自由绘制）；7 色现代浅透配色；批注存进 `paper.annotations`（外置 JSON，不污染原 PDF），重开自动回显
  - 🗑️ **删除批注**：编辑模式下点选批注后按 Delete
  - 🗂️ **阅读架**（v3.21）：打开过的论文自动上架，左下角 FAB 展开抽屉即可在多篇论文间切换——拖拽调整顺序、一键移除、搜索框直接从库中加新论文，全程不离开阅读器；`[` / `]` 快捷切换上/下一篇
- 🧠 **AI 概念清单**：所有论文涉及的关键概念由 AI 抽取后维护在一份清单里（去重归并），页面有专门入口查看/搜索/编辑，可导出 Markdown
  - 选中多篇论文 → 「抽取并追加概念」，AI 只返回**新**概念追加到清单后
- ⚙️ **设置中心**：左下角「⚙️ 设置」入口，全屏视图 + 分组导航（概览 / AI 接口 / 总结·标签主题提示词 / 文件扫描 / arXiv 元数据 / 主题发现 / 主题与标签 / 系统信息）+ 设置内搜索。**把 config.json 的可调项全部纳入界面并运行时热生效**（无需重启 pm2）：AI 接口（Base / Key 掩码 / 模型 / 超时 + 测试连接）、文件扫描间隔（即时重置定时器）、arXiv 补全开关与阈值、主题发现的召回规模/来源/复合排序权重。每项标注「生效值 / config 默认 / 是否已覆盖」、可一键恢复默认；「概览」首页汇总当前生效配置与服务状态；提示词总结/标签主题分离管理（Markdown vs JSON，互不冲突）；主题/标签可重命名（合并）/删除；「系统信息」展示服务级只读项 + 脱敏 config.json
- 📊 **处理可见化**：顶栏 stats 显示当前处理阶段（解析中/补元数据/总结中 各几篇），列表项 busy 状态实时刷新
- ⌨️ **键盘导航**：列表 ↑↓ 选择 / Enter 打开 PDF / S 收藏
- 🔗 **arXiv 元数据**：按文件名清洗标题查 arXiv API 补全（匹配失败则 AI 兜底并标注）
- ♻️ **可替换模块**：换 MinerU 解析只改 `src/parser.js`，换模型只改 `config.json`

## 安装

```bash
npm install
cp config.example.json config.json
# 编辑 config.json：把 ai.baseURL / apiKey / model 改成你的网关
```

> Node 版本要求 ≥ 20（pdfjs-dist 4.10 的实际要求）。若用 [fnm](https://github.com/Schniz/fnm) 管理多版本，先 `fnm use`。

## 运行

### 开发（前台）

```bash
npm start            # node server.js
# 浏览器打开 http://127.0.0.1:8888
```

### 生产（Docker Compose，v3 推荐）

```bash
cp .env.example .env        # 填 PAPERS_ROOT（论文根目录）/ POSTGRES_PASSWORD / APP_PORT
cp config.example.json config.json   # 填 AI 网关
docker compose up -d --build
# 浏览器打开 http://127.0.0.1:8888
docker compose logs -f app  # 查看日志
docker compose up -d --build app   # 升级代码后重建
```

论文目录约定：`PAPERS_ROOT` 是挂载根，**每个空间是其下的一个子目录**（默认空间 = `<PAPERS_ROOT>/default`）。

> **双 PG（生产 + 测试）**：`docker-compose.yml` 同时维护两个 PostgreSQL——`postgres`（生产，端口 25432，持久卷，存你的真实论文）和 `postgres-test`（测试，端口 15432，无持久卷，密码 `dev`）。`docker compose up` 只启动生产；测试 PG 用 profile 隔离，仅 `docker compose --profile test up -d postgres-test` 时启动，用于 e2e 测试和本地 node 开发调试。这样跑测试不会污染真实数据，也避免手动 `docker run` 制造游离容器。

**从 v2（pm2 + JSON）升级**：

```bash
pm2 stop paper-wiki
docker compose up -d postgres
docker compose run --rm -v ./data:/legacy-data app node scripts/migrate-json-to-pg.js /legacy-data
# 按脚本打印的指引，把各空间的 PDF 移入 <PAPERS_ROOT>/<spaceId>/ 子目录
docker compose up -d --build
```

每日自动导出 JSON 快照到 backups volume（PG→JSON 逃生通道）；`scripts/backup-pg.sh` 可配宿主定时任务做 pg_dump。

> **默认监听 127.0.0.1**（仅本机访问，避免不做鉴权时局域网暴露 AI key 消耗通道）。若需局域网访问，在 config.json 设 `"host": "0.0.0.0"` 或用环境变量 `HOST=0.0.0.0`。生产模式（`NODE_ENV=production`）错误响应会脱敏，不回传内部细节。

> 升级后**需要重启服务**（`pm2 restart paper-wiki`）才能加载后端改动；前端静态页是即时读取的，无需重启。

### 仅扫描一次（不启动 HTTP）

```bash
npm run scan        # 扫描并处理完队列后退出
```

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8888` | 监听地址（`HOST`/`PORT` env 可覆盖） |
| `papersDir` | `papers` | PDF 目录 |
| `scanIntervalMinutes` | `5` | 增量扫描间隔（`0` 表示只扫一次） |
| `ai.baseURL` | — | OpenAI 兼容接口（网关的 `/v1`） |
| `ai.apiKey` | — | 接口密钥（仅后端使用，不暴露给前端） |
| `ai.model` | — | 模型名，如 `glm-4.5` / `deepseek-chat` |
| `ai.maxInputChars` | `24000` | 送入模型的全文截断长度 |
| `ai.timeoutMs` | `120000` | 单次 AI 调用超时 |
| `arxiv.enabled` | `true` | 是否查 arXiv 补元数据 |
| `arxiv.titleSimilarityThreshold` | `0.75` | 标题匹配阈值 |
| `arxiv.minIntervalMs` | `3000` | arXiv API 调用最小间隔（礼貌限速；发现的多轴多查询也走它） |
| `discover.maxResults` / `perAxis` | `40` / `25` | 发现：最终候选上限 / 每轴每查询拉取数 |
| `discover.semanticScholar` | `true` | 是否查 Semantic Scholar 引用量 |
| `discover.semanticScholarApiKey` | `""` | S2 API key（可选，免 key 也能用，靠 OpenAlex 兜底；填 key 降低限流） |
| `discover.openAlex` | `true` | S2 缺失时是否用 OpenAlex 按 arXiv DOI 兜底引用量 |
| `discover.weights` | `{rel:.45,auth:.35,rec:.2}` | 复合排序权重：相关度 / 权威(引用量) / 新近 |
| `discover.queryEngine` | `auto` | 查询理解引擎：`auto`(claude→网关→原始) / `claude` / `gateway` |
| `summaryPrompt` | — | 自定义总结 system prompt（留空用内置默认，输出 Markdown） |
| `tagsPrompt` | — | 自定义标签/主题 system prompt（留空用内置默认，输出 JSON `{tags,topics,metadata}`） |

> **设置中心**：左下角「⚙️ 设置」可在浏览器里在线配置上表里**几乎所有运行时可调项**——AI 接口、扫描间隔、arXiv 补全、主题发现参数、提示词，并管理主题/标签。改动写入 `store.settings` 并经 `applySettingsOverride` 运行时覆盖 config.json，**保存即生效、无需重启**（扫描间隔会即时重置定时器）；每项可「恢复默认」回到 config.json。`host/port/papersDir` 等服务级项在「系统信息」只读展示（改它们仍需改 config.json + 重启）。建议首次使用先在设置中心配好，不必手改 config.json。

## 工作方式

1. 启动时全量扫描，之后每 `scanIntervalMinutes` 增量扫描。
2. 每篇论文走流水线（串行，避免压垮本地 AI / 触发 arXiv 限速）：
   `提取全文 → 查 arXiv 补元数据 → AI 生成总结 + 标签 + 主题 + 概念`
3. 状态存 `data/papers.json`（每日自动备份到 `data/backups/`，保留 7 份）；全文存 `data/text/<id>.txt`；概念清单也存于 `papers.json` 的 `concepts` 字段。
4. 页面 10 秒轮询（阅读器打开时暂停），处理中的论文状态会自动刷新。

## 数据结构（store v2）

`data/papers.json`：

```
{
  version: 2,
  papers: { [id]: { ..., tags, topics, folders, readProgress, annotations, conceptIds } },
  tags:    [...],            // 细粒度标签字典
  topics:  [...],            // 粗粒度主题字典
  folders: [ { id, name, color, createdAt } ],   // 虚拟收藏夹
  concepts:[ { id, term, definition, paperIds, createdAt } ]  // AI 概念清单
}
```

`readProgress`：`{ page, scrollTop, scale, total, updatedAt }`；`annotations`：`{ hash, items:[...], updatedAt }`（坐标存 PDF 点，缩放/设备无关）。

旧版（v1）数据启动时自动迁移：补齐缺失字段，每篇论文补 `topics/folders/readProgress/annotations/conceptIds`。

## 目录结构

```
papers/        你的 PDF（只读扫描，gitignore）
data/          papers.json + text/ + backups/（运行时数据，gitignore）
config.json    实际配置（gitignore，含 key）；模板见 config.example.json
src/           后端模块：util/store/parser/arxiv/ai/scanner/api/annotations/discover/claude
public/        前端静态页（无构建，原生 ESM）
  ├─ index.html   三栏布局（侧栏/列表/详情）+ 阅读器 + 概念视图 + 设置中心（AI接口/提示词/主题标签管理/关于）
  ├─ app.js       主逻辑：路由/列表/详情/收藏夹/主题/概念/多选/导入/设置中心/键盘导航
  ├─ reader.js    pdf.js 阅读器（双页/批注/缩放/续读）
  └─ styles.css   Indigo 主题
scripts/       scan-once.js（CLI 扫描）+ e2e-bootstrap.js（e2e 数据准备）
tests/         单测（*.test.js）+ e2e（tests/e2e/）+ fixtures（sample.pdf）
src/server.js  HTTP 入口（分层结构见 AGENTS.md）
migrations/    PG schema（编号 migration）
Dockerfile / docker-compose.yml / .env   Docker Compose 部署（v3）
logs/          运行日志（gitignore）
```

## REST API（节选）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活：`{status, uptime, papers, checks:{db,disk}}`（无需鉴权）。`status` 为 `ok`\|`degraded`，DB 连通性探 `SELECT 1`、磁盘探 papers/backups 目录剩余空间，子探测失败仅标红不返回 5xx |
| GET | `/api/health/ai` | AI 上游可达性探测（慢探测，与主 health 隔离）：`{status, source, latencyMs}`。`source:'upstream'` 表示打到上游，`'config'` 表示回退静态候选（degraded） |
| GET | `/api/papers` | 列表，支持 `q/tag/topic/folder/status/readStatus/starred/sort` |
| GET | `/api/papers/:id` | 详情（含 summary/notes/annotations） |
| PATCH | `/api/papers/:id` | 更新 notes/starred/readStatus/tags/topics/folders/readProgress/annotations |
| DELETE | `/api/papers/:id` | 删除条目 + 本地 PDF + 全文，并清理概念引用 |
| POST | `/api/papers/:id/summarize` | 重新总结（含主题/概念；裸 ID 文件会顺带补元数据 + 改名） |
| POST | `/api/papers/concepts` | body `{ids:[...]}`：对选中论文**增量抽取**概念 |
| GET | `/api/discover/stream?topic=` | **SSE 流式**按主题发现（逐阶段进度 + 结果） |
| POST | `/api/discover` | body `{topic}`：非流式发现（兜底/脚本用） |
| POST | `/api/import` | body `{url, meta?}`：arXiv 网址/ID 导入；带 meta 时按「作者-年份-标题」命名并预填 |
| POST | `/api/scan` | 手动扫描 |
| GET/PATCH | `/api/tags` | 标签字典（`{merge,into}` 重命名 / `{delete}` 删除） |
| GET/PATCH | `/api/topics` | 主题字典 + 计数（`{merge,into}` / `{delete}`，对齐标签） |
| GET/POST/PATCH/DELETE | `/api/folders[/:id]` | 收藏夹 CRUD |
| PUT | `/api/folders/order` | 收藏夹排序（`{ids}` 按给定顺序重排） |
| GET | `/api/concepts` | 概念清单（`?q=`/`?paper=`） |
| GET | `/api/concepts.md` | 概念清单 Markdown 文档 |
| PATCH/DELETE | `/api/concepts/:id` | 编辑/删除概念 |
| GET | `/api/settings` | 读取全段「生效值 + config 原值」（ai/scan/arxiv/discover）+ 提示词 + `overrides`（已覆盖字段）+ `system`（只读 + 脱敏 rawConfig），密钥掩码 |
| PUT | `/api/settings/summary-prompt` | body `{value}`：更新总结提示词（空串=恢复默认） |
| PUT | `/api/settings/tags-prompt` | body `{value}`：更新标签/主题提示词（空串=恢复默认） |
| PUT | `/api/settings/ai` | body `{baseURL?,apiKey?,model?,maxInputChars?,timeoutMs?}`：运行时覆盖 config.ai（热生效） |
| PUT | `/api/settings/scan` | body `{scanIntervalMinutes}`：热改扫描间隔并重置定时器（0=关闭定时扫描） |
| PUT | `/api/settings/arxiv` | body `{enabled?,titleSimilarityThreshold?,minIntervalMs?}`：运行时覆盖 arxiv 段 |
| PUT | `/api/settings/discover` | body `{maxResults?,perAxis?,semanticScholar?,openAlex?,recencyWindowYears?,titleSimThreshold?,semanticScholarApiKey?,weights?}`：运行时覆盖 discover 段 |
| POST | `/api/settings/reset` | body `{section}` 或 `{all:true}`：清除运行时覆盖，恢复 config.json 默认 |
| POST | `/api/settings/test` | 用当前生效配置发 ping，验证 AI 连通性 |
| GET | `/api/stats` | 统计（含 folders/topics/concepts 计数） |

## 测试

```bash
npm test            # node --test，跑 lib 各模块单元测试（142 例）
npm run lint        # ESLint
npm run format:check # Prettier 格式检查
npm run test:e2e    # Playwright e2e（reader 渲染 + 高亮往返）
```

覆盖 store v2 迁移、原子写/串行锁/损坏自愈、annotations TypedArray 归一化、AI prompt/增量抽取解析、arXiv 网址解析、API 全端点（含 discover / import-with-meta / delete / settings 各段 ai·scan·arxiv·discover·reset / settings/test / topics PATCH）、health 端点；**发现**全链路（多轴召回 / 复合排序 / claude→网关兜底 / OpenAlex 兜底 / 进度回调）、命名 helper、裸 ID 识别+改名+空总结守卫、**两次独立 AI 调用**（summarize Markdown + extractTagsTopics JSON）+ applySettingsOverride 配置覆盖（ai/scan/arxiv/discover）+ scanner.reschedule 热改间隔 + arxiv 读 effConfig。e2e 用 Playwright 跑真实浏览器，覆盖 PDF 打开渲染 + 高亮创建持久化往返。

CI（GitHub Actions）在每次 push/PR 自动跑 lint + 单测 + e2e。

## 后续可扩展（v3）

- 接 MinerU 做高质量结构化解析（替换 `src/parser.js`）
- 论文关系链 / 引用对比
- SQLite 替换 JSON（论文量 > 500 时）
- 向量检索（语义相似论文推荐）
- 概念间关系图（哪些概念常共现）
- 批注写回 PDF（XFDF 导出，供 Acrobat 等互通）
