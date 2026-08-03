# AGENTS.md — PaperWiki 实现现状

> 面向 AI agent / 新开发者的项目地图：架构、数据流、关键约定与陷阱。
> 用户向人类看的介绍见 `README.md`；修改记录见 `CHANGELOG.md`。

## 这是什么

一个**薄**的 Web 服务：扫描论文目录 `*.pdf` → 提取全文 → 查 arXiv 补元数据 → 用 OpenAI 兼容接口生成总结/标签/主题/概念/公式，并提供一个 Indigo 主题 SPA（列表 + 详情 tab + 独立 PDF 阅读器 + 批注 + 概念/公式清单 + 总览图制品 + 提示词编辑）。另有**按主题发现**：输入主题 → LLM 生成 arXiv 检索式 → 多轴召回 + 引用量复合排序 → 勾选导入（SSE 流式进度）。公式抽取引擎可在 AI / MinerU 间切换（v3.10）。

- **零构建前端**：原生 ESM，浏览器直接加载 `public/`。
- **PostgreSQL 持久化（v3）**：全部结构化数据 + 论文全文入 PG（`src/db/index.js` repository，hash-diff 事务保存）；内存 store 形状仍是 v2 结构，上层逻辑无感知。PDF 文件本身仍在文件系统（Docker bind mount）。
- **Docker Compose 部署（v3）**：app + postgres:16 两容器；pm2 退役，守护交给 `restart: unless-stopped`。
- **串行流水线**：避免压垮本地 AI / 触发 arXiv 限速。
- **Node ≥ 20**：pdfjs-dist 4.10 的实际要求。

## 目录结构

```
src/                   后端源码（v3.2 分层：core 纯逻辑 / db 持久化 / services 业务 / api 路由）
  server.js            HTTP 入口/装配：createDb→migrate（fail-fast）→ repo → manager → scanner
                        + 静态/PDF/vendor 路由 + 每日 JSON 快照备份 + 优雅关停
  api/
    router.js  ★       REST 路由（原 lib/api.js）：spaces/health/papers/search/tags/topics/folders/
                        concepts/settings/stats/import/discover；ctx={manager,scanner,globalConfig}；
                        每路由 resolveSpace(q)；?space= 隔离；papersDir 改绑 preview/apply
  core/                纯逻辑，零 IO 依赖（可独立单测）
    store.js   ★       数据模型 v2 纯逻辑（emptyStore/migrateStore/normalizePaper/merge*）+
                        文件版 loadStore/saveStore（仅迁移脚本用）+ backupStoreObject（PG→JSON 快照）
    search.js  ★       全文检索辅助：splitTerms（CJK 整串/英文分词）+ buildSnippets（转义+<mark>）
    search-query.js ★  搜索 DSL 解析器（field:value/布尔/year 区间）→ /api/papers?q= 元数据筛选
    annotations.js     批注归一化层：pdf.js TypedArray(quadPoints) 经 JSON 退化的双向修复
    notes.js     ★       AI 笔记卡片纯逻辑（v3.6）：normalizeNoteCards/splitMarkdownToCards/newCardId
    util.js    ★       sha1、限速器、标题归一化/相似度、文件名清洗、parseArxivUrl、safeFilename
  db/
    index.js   ★       PG 持久化层：createDb（pg Pool + migrations 幂等执行）+ createRepository
                        （registry CRUD / loadSpaceStore 组装 / saveSpaceStore hash-diff 事务 /
                        paper_texts 全文存取 NUL 剥离 / searchFulltext tsvector→ILIKE 降级）。
                        **filepath/fulltextPath 派生字段不落库不参与 diff**；papers.extra 兜底
    migrations/*.sql   编号 migration（002 为 .optional.：pg-mem 跳过不记账）
  services/            业务服务（依赖 core/db，被 api/server 装配）
    spaces.js  ★       空间管理器：注册表/store 走 repo；papersDir 挂载根内相对路径；
                        filepath 运行时派生；textStoreBinder；改绑三步语义 preview/apply(move|rebind)
                        + assertNoDirConflict；名↔文件夹联动（createSpace 默认同名/renameSpace 物理同步）
    scanner.js ★       增量扫描 + 串行流水线（parse→arxiv→ai）+ extractConcepts/extractFormulas/retag/chatPaper
                        + createMultiSpaceScanner（共享串行队列/单定时器/missing 熔断/getFuseState）
    ai.js      ★       OpenAI 兼容调用：summarize/extractTagsTopics/extractConcepts/extractFormulas/chatPaper
                        （流式+多模态）+ extractFormulasViaEngine（dispatcher：ai|mineru）+ generateConceptMap
                        + applySettingsOverride（ai/arxiv/discover/translate/formulas 段合并）+ listModels（抓 context_length）
                        + resolveMaxInputChars（v3.11 tokens 优先级，仍返字符预算）/ tokensToCharBudget
    mineru.js  ★       MinerU 公式抽取客户端（v3.10）：POST /file_parse → 解析 md_content LaTeX → AI 命名
    arxiv.js   ★       Atom 解析、标题相似度匹配、PDF 下载；searchArxiv(Multi)
    discover.js ★      按主题发现：检索计划(claude→网关→原始)/多轴召回/引用量/复合排序/去重
    claude.js  ★       spawn `claude -p` 子进程（永不抛错，失败回退网关）
    parser.js          pdfjs-dist 全文提取（Node 端，无 DOM worker）
public/                零构建前端（原生 ESM，浏览器直接加载）
  index.html           三栏布局 + 空间切换器 + 阅读器 + 概念/提示词视图 + 各模态
  app.js     ★         主逻辑：路由/列表/详情/收藏夹/概念/多选/导入/空间切换/全文检索/高级搜索
  reader.js  ★         pdf.js PDFViewer 阅读器（双页/批注/缩放/续读/AI 抽屉）
  search-dsl.js ★      高级搜索面板（DSL 双向同步）
  styles.css ★         Indigo 主题
scripts/               运维脚本：scan-once（CLI 扫描）/ migrate-json-to-pg（旧数据迁移，幂等）/
                        backfill-metadata（arXiv 元数据回填，dry-run 默认）/
                        e2e-bootstrap（e2e 种子）/ backup-pg.sh（pg_dump）
tests/                 node --test 单测（572 例，pg-mem 无需真实 PG；chat-ui/notes-panel/regression-ui 用
                        jsdom 驱动真实 app.js，共享 helpers/ui.js 的 bootUi）+ e2e（Playwright 7 例，需 dev PG）
docs/                  设计文档（superpowers/specs+plans）+ TODO + 调研报告
Dockerfile / docker-compose.yml / .env(.example)   部署（app+postgres；PAPERS_ROOT bind mount）
config.json(.example)  业务配置（AI 网关等；根目录，compose 只读挂载）
papers/                本地开发挂载根；生产 = .env 的 PAPERS_ROOT（每空间一个同名子目录）
backups/ logs/         运行时产物（gitignore）：JSON 快照与归档 / 历史日志
.github/workflows/ci.yml  CI：lint+unit / pg-smoke / e2e 三 job（后两个带 postgres service）
```

★ = v2.2 / v2.3 / v2.4 / v2.5 / v2.7 重点改动文件（v2.7：聊天 UI 现代化重构——气泡布局/composer/模型切换器/视觉问答，改 public/{app,reader,index,styles} + lib/{ai,api,scanner}；v2.5：spaces/scanner(createMultiSpaceScanner)/api/server + 前端空间切换器；v2.4：ai/api/scanner + 前端设置中心；v2.3：discover/claude/util/arxiv/api/scanner）。

## 数据模型（内存 store 仍是 v2 形状；持久化在 PostgreSQL）

> v3 起持久化迁 PG（`src/db/index.js`），但**内存 store 形状 100% 不变**（仍是下面的 v2 结构）——
> repository 负责 组装（loadSpaceStore）与 hash-diff 保存（saveSpaceStore）。表结构：
> `spaces`（meta + tags/topics/settings JSONB）、`papers`（PK=(space_id,id)，标量列 + JSONB 列 + extra 兜底）、
> `paper_texts`（全文独立表）、`concepts`、`folders`、`app_state`（activeSpaceId）、`schema_migrations`。
> v3.6 起 `papers` 增 `note_cards` jsonb 列（migration 003）；`src/core/notes.js` 为卡片纯逻辑层（normalizeNoteCards/splitMarkdownToCards）。
> v3.9 起 `papers` 增 `formula_ids` jsonb 列 + 新表 `formulas`（migration 004）；`src/core/formulas.js` 为公式纯逻辑层。
> v3.10 起 `concepts` 增 `category` 列（migration 005）。**注意**：`filepath`/`fulltextPath` 是运行时派生字段，不落库（见陷阱 22）。
> **注意**：`filepath`/`fulltextPath` 是运行时派生字段，不落库（见陷阱 22）。

```jsonc
{
  "version": 2,
  "papers": {
    "<id=sha1前16位>": {
      "id, filename, filepath, fileMtime, fileSize, addedAt, updatedAt",
      "title, authors, year, abstract",
      "arxivId, arxivUrl, primaryCategory, metaSource, metaConfidence",
      "fulltextChars, fulltextPath",
      "summary, summaryModel, summaryAt",
      "tags": [],          // 细粒度英文标签
      "topics": [],        // 粗粒度中文主题（1-3 个）
      "conceptIds": [],    // 本篇贡献的概念 id
      "folders": [],       // 所属虚拟收藏夹 id
      "readProgress": { "page", "scrollTop", "scale", "total", "updatedAt" } | null,
      "annotations": { "hash", "items":[...], "updatedAt" } | null,  // PDF 批注（坐标存 PDF 点）
      "notes": "",           // 旧字段（v3.6 起退役，首开自动拆卡迁移到 noteCards）
      "noteCards": [],       // AI 笔记卡片（v3.6）：[{id,type:qa|skeleton|manual,title,body,meta,createdAt,updatedAt}]
      "starred": false, "readStatus": "unread|reading|done",
      "status": "pending|parsing|enriching|summarizing|ready|error|missing",
      "error": null
    }
  },
  "tags":     [...],                       // 全局标签字典
  "topics":   [...],                       // 全局主题字典
  "folders":  [ { "id", "name", "color", "createdAt" } ],
  "concepts": [ { "id", "term", "definition", "category", "paperIds", "source", "createdAt", "updatedAt" } ],
  "formulas": [ { "id", "canonicalName", "name", "latex", "description", "category", "variables[]", "plottable", "plotHint", "occurrences[]", "paperIds", "source", "createdAt", "updatedAt" } ],  // v3.9 公式清单
  "settings": {                       // 在线编辑的设置（见陷阱 2/3/19/20）—— 运行时覆盖 config，仅存被改过的字段
    "summaryPrompt": "...",            // 总结提示词（Markdown 自由输出）
    "tagsPrompt": "...",               // 标签/主题提示词（强制 JSON）
    "formulaPrompt": "...",            // 公式抽取提示词（强制 JSON，v3.9 三级回退）
    "conceptPrompt": "...",            // 概念抽取提示词（强制 JSON，v3.10 三级回退，含 category 字段）
    "ai": { "baseURL": "...", "apiKey": "...", "model": "...", "maxInputTokens": 32000, "timeoutMs": 120000, "taskMaxInputTokens": {...}, "maxInputChars": 24000（旧别名）, "taskMaxInputChars": {...}（旧别名） },
    "scanIntervalMinutes": 5,          // 覆盖扫描间隔（热改 → scanner.reschedule；0=关闭定时扫描）
    "arxiv": { "enabled": true, "titleSimilarityThreshold": 0.75, "minIntervalMs": 3000 },
    "discover": { "maxResults": 40, "perAxis": 25, "semanticScholar": true, "openAlex": true,
                  "recencyWindowYears": 8, "titleSimThreshold": 0.85,
                  "semanticScholarApiKey": "...", "weights": { "rel": 0.45, "auth": 0.35, "rec": 0.2 } },
    "translate": { "engine": "google", "targetLang": "zh-CN" },  // 划线翻译
    "formulas": { "engine": "ai", "mineruUrl": "", "namingPrompt": "" },  // v3.10 公式引擎：ai|mineru + MinerU 地址 + 命名提示词
    "conceptMaps": [ { "id", "name", "html", "prompt", "createdAt", "updatedAt" } ],  // v3.10 概念总览图制品
    "updatedAt": 0
  }
}
```

**向后兼容**：`loadStore` → `migrateStore` 自动把 v1 数据补齐为 v2（加 topics/folders/concepts/settings/annotations 字段、规范化每篇论文）。`migrateStore` 只确保 `settings` 是对象，不强行塞 key——新字段靠读取时 `?? default` 兜底。**损坏自愈**：`papers.json` 若是非 JSON 或非对象，自动备份为 `.corrupt-<ts>` 并回空 store。

## Spaces 架构（v3：PG 持久化 + 挂载根收口）

**物理布局**：
```
PostgreSQL（compose 内 postgres 服务，pgdata volume）
  spaces / papers / paper_texts / concepts / formulas / folders / app_state   ← 全部结构化数据 + 全文
<PAPERS_ROOT>/（宿主目录 bind mount → 容器 /papers）
  default/       default 空间的 PDF（v3 起 default 也绑子目录，不绑根本身）
  <spaceId>/     其他空间（新建空间默认以 id 作子目录名）
backups volume   每日 JSON 快照（PG→JSON 逃生通道，格式兼容旧 papers.json）
```

**核心抽象**（`src/services/spaces.js` `createSpaceManager({repo, papersRoot, globalConfig})`）：
- 注册表内存态源于 `repo.loadRegistry()`；空库自动建 default（papersDir='default'）
- `getSpaceStore(id)` / `saveSpaceStore(id, store)`：repo 组装/hash-diff 保存，**内存缓存**（manager 持有 store 引用，与 scanner/api 共享）；load 时**派生 filepath**（papersDir+filename）
- `saveStoreBinder(id)`：单参闭包注入 scanner deps.saveStore（**遵守陷阱 1**）
- `textStoreBinder(id)`：全文 `{load,save,remove}` → PG paper_texts（注入 scanner/api）
- `resolveSpacePapersDir(id)`：相对 papersRoot 解析 + **越界拒绝** + 自动 mkdir
- `previewPapersDirChange(id, newDir)`：sha1 对账预检（只读）；
  `applyPapersDirChange(id, newDir, 'move'|'rebind')`：原子改绑（见陷阱 23）；
  `assertNoDirConflict`：禁止与其他空间目录相同/互相嵌套（防双扫描器 rename 竞争）
- 旧 JSON→PG 迁移不再在 manager 内做，见 `scripts/migrate-json-to-pg.js`（幂等）

**隔离语义**：paper id = `sha1(内容)`，**同 PDF 跨空间是各自 store 里的独立条目**（符合隔离，非 bug）。tags/topics/folders/concepts/settings 全部 per-space（各空间 store 独立）。

**多空间扫描器**（`src/services/scanner.js` `createMultiSpaceScanner({manager, deps})`）：
- 每空间建一个子扫描器（复用 `createScanner` 的完整流水线闭包），子扫描器的 store/papersDir/textStore 各自指向该空间
- **共享单一串行队列**（queue 项 = `{spaceId, id}`，pump 串行 await 子扫描器 processOne）——遵守陷阱：串行防压垮本地 AI / 触发 arXiv 限速
- 子扫描器的内部 enqueue 被 `onEnqueue` 钩子转交到共享队列（子扫描器自身不被 start，内部 queue 无人 pump）
- 单一定时器：间隔 = `min(所有 scheduled 空间 scanInterval)`，每次 tick `scan({dueOnly:true})` 内部按 per-space lastScanAt 判定哪些到点
- `reschedule(spaceId, minutes)`：改某空间间隔 + 重算定时器（遵守陷阱 20）

**后端路由**（`src/api/router.js` `createApiRouter({manager, scanner, globalConfig})`）：
- ctx 从 `{store, save, scanner, config}` 变为 `{manager, scanner, globalConfig}`
- 每路由顶部 `const {spaceId, space, store, save} = await resolveSpace(q)`：`?space=<id>` 指定空间，无参回 active
- **SSE 路由（chat/discover）**：EventSource 无法设 header，spaceId 走 URL query `?space=`（后端回退 active 保证无参仍工作）
- `/api/spaces` 路由组：GET 列表 / POST 创建 / PATCH 改名 / DELETE 删空间（default 拒删，保留物理 PDF）/ POST :id/activate /
  **POST :id/dir/preview（改绑预检）/ POST :id/dir {newDir, mode}（执行 move|rebind，期间 stop+drain 暂停扫描）**

**前端**（`public/app.js`）：
- `state.space`（localStorage 持久化 `pw-space`）+ `state.spaces[]`
- `sp(url)` 注入器：所有 `/api/` `/papers/` 请求自动带 `?space=<active>`（已有 ?space= 不覆盖）；reader.js 经 `window.sp` 复用
- `switchSpace(id)`：activate → **teardown**（关 chat EventSource、flush notes、关 reader）→ 清空 selected/filter/detail → refresh + renderDetail
- 顶栏空间切换器下拉（选空间 / 新建 / 管理模态）；管理模态改名+删除；**改文件夹走三步向导**
  （openDirWizard：输入路径 → 预检报告+模式单选 → 执行结果，见陷阱 23）

## 核心数据流

```
启动 server.js
  ├─ createDb → db.migrate()       ← PG 不可用 fail-fast（Docker restart 重试）
  ├─ createRepository → createSpaceManager({repo, papersRoot, globalConfig})
  ├─ backupAllSpaces()             ← 启动即备一次 + 每 6h 检查（JSON 快照，按天去重保留 7 份）
  ├─ createMultiSpaceScanner.start() ← 立即全量 scan，之后单一定时器（min 间隔）增量
  └─ http.createServer             ← /papers /vendor /api /静态

scan() 一篇新论文:
  scanDir → fingerprintAll(sha1) → diffPapers(added/changed/missing)
  → enqueue(added) → pump() 串行处理队列

processOne(id):                     ← 串行，避免限速
  effConfig = applySettingsOverride(config, store.settings)   ← 顶部算一次；ai/arxiv/discover 段统一走它（设置热生效）
  1. parsing    parser.extractText → textStore.save(id, text)（PG paper_texts，NUL 剥离）
  2. enriching  按 **effConfig.arxiv**（enabled/minIntervalMs/titleSimilarityThreshold 可热改，见陷阱 20）查元数据：
                p.arxivId 或 parseArxivUrl(文件名) 命中 → id: 精确查；
                否则 cleanFilenameToTitle + ti: + pickBest（阈值默认 0.75，限速 3s）。补 year(published)
  3. summarizing **两次独立 AI 调用**（见陷阱 18）：
     3a. ai.summarize(prompt = summaryPrompt 三级, jsonMode:false) → 自由 Markdown 字符串
         → 有内容写 summary（buildSummaryMarkdown 归一化）；空 → 存可重试占位（陷阱 13）
     3b. ai.extractTagsTopics(prompt = tagsPrompt 三级, jsonMode:true) → {tags,topics,metadata}
         → 写 tags（小写英文）/topics（中文，≤3）/metadata 兜底（仅标题缺失时）；独立 try/catch
  4. 规范命名   裸 ID 文件名 → buildPaperFilename「作者 等 - 年份 - 标题.pdf」并 rename（id 不变）
  5. 概念抽取   ai.extractConcepts(prompt = conceptPrompt 三级, jsonMode:true) → mergeConcepts（按 normalizeTerm 去重，
               命中只补空 definition/category，v3.10 起含 category 字段）
  6. 公式抽取   extractFormulasViaEngine（dispatcher，effConfig.formulas.engine=ai|mineru；见陷阱 37）
               → mergeFormulas（按 canonicalName 去重，命中只补空字段）；独立 try/catch 不阻塞 ready
  finally: deps.saveStore(store)   ← 单参！见下方陷阱

arXiv 导入 (POST /api/import { url, meta? }):
  util.parseArxivUrl → arxiv.downloadPaperPdf → 落 papers/。带 meta（来自发现候选）时
  按 buildPaperFilename 命名 + 预填 title/authors/year/abstract（metaSource=arxiv）→ enqueue 总结

按主题发现 (GET /api/discover/stream?topic= ，SSE):
  discover.discoverPapers:
    buildDiscoveryQuery  claude -p（src/services/claude.js）→ 失败回退 GLM 网关(planViaGateway) → 原始主题
                         产出 {queries[], categories[], keyterms[]}
    多轴召回             每 query × {relevance, submittedDate} → searchArxivMulti → 合并去重
    enrichWithCitations  Semantic Scholar 批量(+apiKey/429 重试) → 缺失项 enrichWithOpenAlex(arXiv DOI)
    复合排序             computeRelevance(keyterms) + log(引用量) + 新近，加权(config.discover.weights)
    去重                 剔除库内同 arxivId / 标题相似
  onProgress(stage) → SSE event: progress / done / fail（前端 5 步进度面板）

删除 (DELETE /api/papers/:id):
  删 store 条目 + PDF 文件(限 papersDir 内) + 清理 concepts[].paperIds
  （全文行由 repo.saveSpaceStore 检测论文删除时连带 DELETE paper_texts）
```

**概念增量抽取**（`scanner.extractConcepts(ids)`）：复用 textStore 里的全文，把已有 term 喂给模型只返回新概念，`mergeConcepts` 按归一化 term 去重并合并 paperIds。v3.10 起概念带 `category` 字段（11 类枚举）。

**公式抽取**（`scanner.extractFormulas(ids)` + processOne 步骤 6）：走 `extractFormulasViaEngine` dispatcher（引擎=ai 喂全文 / 引擎=mineru 喂 PDF filepath）；`mergeFormulas` 按 canonicalName 去重，命中只补空字段。阅读器右上角下拉菜单支持「查看本篇/追加抽取/重新抽取（replace）」，候选端点 `POST /api/papers/:id/{formulas,concepts}/candidates` 返回不入库，勾选后 `merge {items, mode?}` 入库（见陷阱 40）。

**概念总览图**（`POST /api/concepts/map`，v3.10）：把概念清单喂给 `generateConceptMap`（callChat jsonMode:false）产出单文件 HTML 全览图，存 `settings.conceptMaps` 制品数组。可基于自定义 prompt 二次优化（PUT，传 prevHtml）。


**批注持久化**（reader.js ↔ api.js ↔ annotations.js）：前端 `annotationStorage.onSetModified` → 防抖 serialize（`doc.annotationStorage.serializable.map`）→ PATCH `{annotations:{items}}` → api.js 经 `annotations.normalizeAnnotations` 归一化后存 store。回显：open 时拿 detailView.annotations → loadAnnotations 按 pageIndex 分组 → pagerendered 后 `getPageView(i).annotationEditorLayer.annotationEditorLayer.deserialize(item)`。

## 关键约定 / 陷阱（改代码前必读）

1. **`deps.saveStore` 是单参闭包**：`saveStore: (store) => manager.saveSpaceStore(id, store)`。
   scanner 必须调 `deps.saveStore(store)`（**一个参数**）。历史上曾误写成两参把 storePath 字符串当 store 写坏全库。已加单测防回归。

2. **提示词优先级（各自独立三级）**：
   - 总结：`store.settings.summaryPrompt` > `config.summaryPrompt` > `DEFAULT_SUMMARY_PROMPT`（src/services/ai.js）。
   - 标签/主题：`store.settings.tagsPrompt` > `config.tagsPrompt` > `DEFAULT_TAGS_PROMPT`。
   - （`DEFAULT_PROMPT` 是 `DEFAULT_SUMMARY_PROMPT` 的别名，向后兼容保留。）

3. **总结与标签/主题是两次独立 AI 调用（陷阱 18 详解）**：不要合并回单次。
   - `summarize`：`jsonMode:false`，返回**自由 Markdown 字符串**（不再 JSON）。用户可自定义提示词输出任意 Markdown/LaTeX。
   - `extractTagsTopics`：`jsonMode:true`，强制 `response_format:{type:'json_object'}`，返回 `{tags,topics,metadata}`。
   - `buildSummaryMarkdown(md)` 入参是**字符串**（剥围栏 + 空则占位），不再是对象。

4. **概念去重 key**：`normalizeTerm`（小写 + 折叠空白）；`conceptIdFor` 基于归一化 term 的稳定 hash，保证跨论文可归并。别用随机 id。

5. **滚动布局**：`.layout` 是 grid，三列各需 `min-height:0` 才能内部滚动；`.list-pane` 是 flex 列（工具栏固定 + `.paper-list` 独立 `overflow:auto`）。侧栏收起靠 `.layout.sidebar-collapsed` 切 grid 列宽到 0 + 显示 `.sidebar-rail`；紧凑视图靠 `.paper-list.compact .paper-item` 单行布局。

6. **pdf.js viewer 加载（零构建 hack）**：reader.js 先 `import '/vendor/pdfjs.js'`（副作用注册 `globalThis.pdfjsLib`）再 `import '/vendor/pdfjs-viewer.js'`（注册 `globalThis.pdfjsViewer`，依赖 pdfjsLib）。**顺序固定**，否则 pdfjsViewer 解构出 undefined。worker 设 `/vendor/pdfjs.worker.js`。server.js 的 VENDOR_MAP 映射 build/pdf.min.mjs + web/pdf_viewer.mjs + images/，MIME 表必须含 `.mjs → text/javascript`。

7. **PDFViewer 容器必须 `position:absolute`**：构造期硬校验 `getComputedStyle(container).position === 'absolute'`，否则抛错。reader-view 用 absolute 布局（bar 浮顶 + canvas-wrap absolute 铺满）。

8. **annotationEditorMode 必须是单一枚举值**：构造时传 `NONE`（不是 `FREETEXT|HIGHLIGHT|INK` 组合位掩码）。`isValidAnnotationEditorMode` 要求 `Object.values().includes(mode)`，组合值(27)会被拒 → UIManager 不创建 → 批注全失效。运行时 `viewer.annotationEditorMode = {mode: HIGHLIGHT}`（**注意是对象 `{mode}` 不是裸整数**）切工具。

9. **批注 quadPoints 经 JSON 退化**：pdf.js `serialize()` 输出 `Float32Array`，JSON.stringify 后变 `{"0":x}` 稠密键对象，`deserialize` 时 `.length` 为 undefined 循环 0 次 → 高亮消失。**必须经 `src/core/annotations.js` 的 `normalizeAnnotations` 双向归一化**（PATCH 写入 + detailView 读取）+ reader.js 前端 `repairAnnotationValue`。

10. **双页空白页坑**：别用 `removePageBorders:true` + spread，`getVisibleElements` 水平裁剪会误判右页不可见导致不渲染。改用 CSS 覆盖默认边框 + `afterReady` 主动 `_ensureRender` + `pagerendered` 兜底推进单线程渲染链。

11. **光标模式无法选中批注**：NONE 模式下 `.annotationEditorLayer.disabled { pointer-events:none }` 封死整层，点击到不了 editor。删除批注必须先切到对应工具（高亮/便签/手写）使层 enable。

12. **改代码要重建容器**：v3 生产跑在 Docker 里，`src/`、`public/` 都打进镜像——任何代码改动须
    `docker compose up -d --build app` 重建生效（前端也一样，镜像内 public/ 不是宿主目录）。`config.json`
    是挂载文件，改后 `docker compose restart app` 即可。本地 `node server.js` 开发时前端仍是即时读盘。

13. **空总结不可当成功**：模型偶发返回空对象 `{}`（批量/超时/限流）。`processOne` 判定「有内容」= 有 `tldr`/`contributions`/`method` 之一；否则存 `buildSummaryMarkdown(null)` 占位并清 `summaryAt`，不写误导性的空「## TL;DR」。`buildSummaryMarkdown({})` 只会得到空标题——务必在写入前过滤。

14. **裸 ID 文件名查不到元数据（历史 bug）**：`cleanFilenameToTitle("2012.12556")` 会把 `2012` 当孤立年份删掉 → `ti:".12556"` 搜不到 → 元数据全空 → 空标题→空总结。`processOne` 现在 `p.arxivId` 为空时先 `parseArxivUrl(文件名)` 识别裸 ID 走 `id:` 精确查。改元数据逻辑勿回退此分支。

15. **发现的查询理解必须有兜底**：`claude -p`（src/services/claude.js）在无头/pm2 环境常因鉴权 **401**（进程 exit≠0 或 `is_error:true`）；且新版 CLI `--output-format json` 输出**消息数组**（取末个 `type:'result'`）而非 `{result}` 单对象。`buildDiscoveryQuery` 三级兜底 `claude → planViaGateway(GLM) → 原始主题`，`config.discover.queryEngine` 可强制。改 prompt/解析要保持兜底链。

16. **发现排序是复合分，不是单引用量**：旧实现「取最新 N 篇再按引用量排」自相矛盾（最新论文≈0 引用）。现按 `relevance + submittedDate` 两轴召回进池，再 `相关×0.45 + 权威×0.35 + 新近×0.20` 排序。引用量经 S2 + OpenAlex 兜底，`citationsAvailable=false` 时前端要提示「按相关+新近排」。

17. **改名/删除以内容 sha1 为 id**：paper id = `sha1(文件内容)前16位`，与文件名无关。所以 `processOne` 改名、`DELETE` 删文件都不影响 id / `data/text/<id>.txt` / 概念 / 批注。改名撞名时加 ` (arxivId)` 后缀；删文件限定 `papersDir` 内防越界。

18. **总结与标签/主题必须分两次调用，不能合并**（v2.4 根因修复）：历史上二者在同一次 `response_format:json_object` 调用里返回，用户自定义总结提示词（要 Markdown 章节/LaTeX）与 JSON 硬约束冲突 → 模型返回空 `{}` → 空总结 + 空标签。现 `summarize`（jsonMode:false，自由 Markdown）与 `extractTagsTopics`（jsonMode:true，JSON）分开，各自 try/catch。**改 AI 逻辑勿合并回单次调用**。`callChat` 的 `jsonMode` 参数默认 `true`（向后兼容 extractConcepts/extractTagsTopics），`summarize` 显式传 `false`。

19. **配置覆盖层（store.settings）不改 config.json，已泛化到多段**：`applySettingsOverride(config, store.settings)` 返回**新对象**，把 `store.settings` 的 `ai / scanIntervalMinutes / arxiv / discover / translate / formulas` 合并到 config 之上（`discover.weights` 深合并，`ai.taskMaxInputChars`/`ai.taskMaxInputTokens` 深合并），不修改原 config（保持只读语义）。scanner/api 每次调用前合成 effectiveConfig。**合并规则分两类**：`ai` 段沿用历史（`!== undefined && !== ''` 才覆盖，空串 apiKey 视为未设置）；新增段（scan/arxiv/discover/translate/formulas）用 **`!== undefined` 即覆盖**，以正确处理布尔 `false`（如 `arxiv.enabled:false`）与数值 `0`（如 `scanIntervalMinutes:0`）——**勿对新增段套 `!== ''`，会吞掉 false/0**。`formulas.namingPrompt`/`formulas.mineruUrl`/`semanticScholarApiKey` 空串沿用密钥语义（不覆盖、回退 config/默认）。`config.json` 仍启动时一次性读盘，设置改动只落 `store.settings`（PG spaces.settings jsonb），无需重启；`POST /api/settings/reset {section|all}` 删除对应覆盖回到 config 默认。

37. **输入上限以 tokens 为准（v3.11，OpenAI 标准）**：模型上下文窗口业界以 **token** 计（gpt-4o 128K、gpt-4.1/glm-4.6 1M），旧 `maxInputChars`（字符数）已作**废弃别名**保留。`resolveMaxInputChars(config, task)` 是**单一入口**（ai.js 内所有 build*Messages 一律经它），返回**字符预算**供 `.slice(0, N)` 用——签名/返回值不变，故 build 函数零改动。优先级：`taskMaxInputTokens[task]` > `maxInputTokens` > （旧）`taskMaxInputChars[task]` > （旧）`maxInputChars` > `DEFAULT_MAX_INPUT_TOKENS`(32000)。tokens 字段命中经 `tokensToCharBudget(t)` = `t × 3.5`（中英混排安全估值，英文~4 中文~1.5，偏保守）折算成字符；旧 chars 字段命中**原值直传不折算**（存量 config.json/papers.json 兼容）。
    - **改输入预算逻辑勿绕过 resolveMaxInputChars**：新加任务先加进 `INPUT_BUDGET_TASKS`（同步 public/app.js 的 `TASK_BUDGET_KEYS` + index.html 的 `tb-<task>` 输入）。
    - **模型上下文窗口自动检测**：`listModels` 从上游 `/v1/models` 抓 `context_length`（OpenRouter/newapi 网关扩展字段，OpenAI 原生**不返回**——`extractContextLength` 兜底 `context_length`/`contextLength`/`max_input_tokens`/`top_provider.context_length` 四种写法，无则 null），前端模型切换器显示「模型 · 1M」徽标；网关不返回时回落手动填 `maxInputTokens`。
    - **PUT /api/settings/ai**：前端只发 `maxInputTokens`/`taskMaxInputTokens`（旧字段不再写，但收到也不拒）；`aiSettingsView` 同时回显新旧两套字段（兼容旧前端读取）。

20. **扫描间隔热改 + arxiv 必须读 effConfig**：scanner 定时器在 `createScanner` 按 `scanIntervalMs` 建一次，改 `store.settings.scanIntervalMinutes` 后必须调 `scanner.reschedule(minutes)`（`PUT /api/settings/scan` 已接线）重置定时器（0=停表），否则间隔改动不生效。另：`processOne` 的 arxiv 补全段读 **`effConfig.arxiv` 而非 `deps.config.arxiv`**（历史上读死 config → 设置面板关 arxiv / 改阈值不生效）；effConfig 在 processOne 顶部算一次，ai/arxiv/discover 共用。

21. **聊天模型切换 + 视觉问答两套流式通道（v2.7）**：
   - **模型切换**：`GET /api/ai/models` 调上游 `/v1/models`（带 apiKey）+ 合并 `config.ai.extraModels`；前端 `localStorage('pw-chat-model')` 持久化选择，经 `?model=` 透传。**白名单校验**（src/api/router.js chat 路由）：必须 ∈ {config.ai.model} ∪ extraModels ∪ 上游 models，否则静默回退默认——**勿跳过白名单直接透传用户输入**（注入风险）。`callChat/callChatStream` 用 `chatParams.model || config.ai.model`；scanner 在有显式覆盖时持久化 `assistant.model`。
   - **视觉问答走 POST `/api/papers/:id/chat/vision`**（不是 EventSource）：EventSource 无法携带 body（图片 base64），故视觉问答用 fetch + ReadableStream 手动解析 SSE（reader.js `streamVisionFetch`）；纯文本仍走 EventSource（GET /chat）保持兼容。**改流式协议勿合并回单通道**。
   - **多模态 content**：`chatPaper` 的 `images` 选项把末尾 user 消息 `content` 从字符串升级为数组 `[{type:'text'},{type:'image_url'}]`（OpenAI 格式原样透传）。图片白名单：`data:image/*;base64,` 前缀，限 4 张（防 papers.json 膨胀）。
   - **粘贴图片压缩**（reader.js `addImageFile`/`compressImageDataUrl`，v3.10）：输入框 `paste` 监听读 clipboard 图片 + 「图片」按钮文件选择器，转 dataURL push 进 `_chatImages`（复用 chip/视觉问答链路）。长边限 1568px 压缩（防 base64 撑大 papers.json）。原框选截图（`cropRegionToImage`）已废弃删除。
   - **前端两处聊天共用渲染**：app.js 经 `window.*` 暴露 `chatMsgHtml/chatEmptyHtml/renderChatMd/toggleModelSwitcher/getSelectedModel/loadAiModels/pwState` 给 reader.js（ESM 隔离）。改聊天渲染逻辑要同步两处。
   - **@ 引用浮层 confirmMention 顺序陷阱**：`confirmMention` 必须**先捕获 `onPick` 回调到本地变量**，再 `dispatchEvent('input')`（会触发 `handleMentionTrigger → closeChatMentionPicker()` 把 `_mentionCtx` 置 null），最后调 `onPick`。顺序反了 → 选了论文但 chip 不出现。浮层是 body 级 `position:fixed` 单例，两处聊天共用 `openChatMentionPicker/closeChatMentionPicker/handleMentionKeydown`。

22. **filepath 是运行时派生字段，绝不落库**（v3 绑定 desync 根因修复）：PG 只存 `filename`（相对空间目录），
    `manager.getSpaceStore` 在 load 时合成 `p.filepath = papersDir + filename`；repo 保存时剥除
    filepath/fulltextPath 且不参与 hash-diff。**改 papersDir 后 store 重载即全库路径一致**。
    新代码要新增持久字段时记得加进 src/db/index.js 的 PAPER_COLS（否则会进 extra JSONB 兜底列——数据不丢但不可 SQL 查询）。

23. **papersDir 改绑必须走 preview/apply 三步语义**：`changePapersDir` 旧语义（只改字符串）已废除（现等价 rebind）。
    正确入口：`POST /api/spaces/:id/dir/preview` 预检（sha1 对账报告）→ `POST /api/spaces/:id/dir {newDir, mode}`
    执行（move=物理搬移+撞名加 (id) 后缀；rebind=对账更新 filename/复活或标 missing），期间 scanner stop+drain
    暂停、完成后 invalidate 子扫描器（papersDir 缓存已变）+ start 补扫。目录校验：必须在挂载根内、
    不得与其他空间目录相同或互相嵌套（双扫描器会 rename 竞争）。前端只能走向导，不再提供自由文本改绑。

24. **jsonb 参数必须 JSON.stringify；PG TEXT 不收 NUL**：node-pg 会把 JS 数组序列化成 PG 数组字面量
    （`{a,b}`）而非 JSON——jsonb 列直接传数组必写坏，src/db/index.js 内一律 `jstr()`。全文可能含 `0000`
    （pdfjs 偶发），`savePaperText` 已剥离；绕过 repo 直写 paper_texts 会踩 `invalid byte sequence`。

25. **missing 熔断**：单轮 scan 中 `missing > 5 且 > 库内 50%` 视为目录挂载失效（Docker bind mount 掉了/目录清空），
    本轮不翻转任何状态，只告警 + `/api/health` 的 `missingFuse` 暴露。正常少量缺失照旧标记。
    写扫描相关代码勿绕过此保护；测试挂载问题先看 health。

26. **pg-mem 怪癖（单测）**：对**已存在表**的 `CREATE TABLE IF NOT EXISTS` 会报错——migrate 先探测
    `schema_migrations` 再建；migration SQL 逐条执行且先剥 `--` 注释行。单测全用 pg-mem（无需真实 PG）；
    e2e/pg-smoke 才用真实 postgres。

27. **全文检索双路径（v3.1，GET /api/search）**：英文查询走 `to_tsvector('english')`（websearch_to_tsquery +
    ts_rank，吃 002 的表达式 GIN 索引，词干化）；中文查询与 tsvector 不可用后端（pg-mem）走 ILIKE 子串降级。
    **migration 002 是 `.optional.`**：pg-mem 建不了 GIN，migrate() 对 optional 失败跳过不记账（真实 PG 正常记账）。
    snippet 在 Node 侧生成（src/core/search buildSnippets，只 load 命中篇全文），输出**已转义 HTML**（<mark> 高亮），
    前端直接 innerHTML——改 snippet 逻辑勿在前端二次转义。前端入口：搜索框**回车**进全文模式（即时筛选不变），
    输入变化/Esc/× 退出。已知偏差：含字面 %/_ 的查询在 pg-mem 中行为与真实 PG 不同（反斜杠转义解析差异）。

28. **搜索 DSL + 高级搜索 GUI（v3.2，lib/search-query.js）**：
   - **统一解析器**：`/api/papers?q=` 与 `/api/search?q=` 都走 `parseSearchQuery`（GitHub 式字段前缀 `title:/tag:/year:/-排除/"phrase" body:`）。裸词分词 AND（修旧单子串 bug）；英文词边界匹配（`cat` 不命中 `category`）；CJK 整串。`body:` 词走正文检索，其余字段作为元数据候选 id 子集先过滤再正文检索（交集）。
   - **前后端共用解析器**：`lib/search-query.js`（Node）+ `public/search-dsl.js`（浏览器镜像，`window.PaperWikiSearch`）。改语法要同步两份。前端用它做：① 检测 `body:` 分流（triggerSearch）② 高级面板双向同步（buildDslFromPanel/parseToPanel）③ 内联补全（detectFieldAtCursor）。
   - **双向同步陷阱**：高级面板改字段 → `syncSearchBoxFromPanel` 生成 DSL 填回搜索框 + 触发搜索；搜索框输入 → `syncAdvancedPanelFromDsl` 回填面板。用 `_advSyncing` 标志防循环。
   - **`searchFulltext` 的 `opts.ids` 子集**：`/api/search` 含元数据字段时，先 `applyMetadataQuery` 得候选 id，传给 `searchFulltext` 的 `opts.ids`，SQL 加 `AND paper_id = ANY($4)` 限定。**改交集逻辑勿在 Node 侧二次过滤**（SQL 已做）。
   - **保存的搜索**：`PUT /api/settings/saved-searches`（规整去空/限 30 条），per-space。前端 chip 行点击应用 DSL。

29. **pdf.js KeyboardManager 会抢 textarea 的键（聊天输入框无法删除/Ctrl+A 全选高亮）**：
   UIManager 在 window 冒泡阶段注册全局 keydown，KeyboardManager 绑定 ctrl+a（全选批注编辑器）/
   Delete/Backspace（删选中批注）/方向键（平移），执行后 stopEvent 吞默认行为。其豁免检查
   textInputChecker 只认 <input type=text|number>，**不认 textarea**；有批注编辑器处于选中/编辑态
   （isEditorHandlingKeyboard 为真）时，抽屉里 textarea 的这些键全被抢走。
   修复：bindChat 里在抽屉冒泡阶段统一 e.stopPropagation()（textarea 默认行为不受影响；
   我方 Esc 分层在 document capture 先行，也不受影响）。改键盘相关代码勿删此拦截。

30. **AI 笔记架构（v3.6）**：卡片存 `papers.note_cards`（jsonb），旧 `notes` TEXT 由 NotesPanel.load 首开时
    自动按 `^## ` 拆卡 PATCH 迁移（幂等）。写入边界一律 `normalizeNoteCards`（router PATCH 归一化 +
    detailView 读取自愈）。骨架生成必须含 `^## ` 否则报 error（防整段文本塞一张卡）。**NotesPanel 是
    共享组件**：详情 tab（renderTabBody）与阅读器抽屉（window.NotesPanel 桥）各挂一份，保存后
    `syncNotePanels` 同步另一份；`window._readerNotesPanel` 是阅读器侧注册点。`commitOpenEditor`
    的 `discardEmptyNew`（flushPendingNotes 用）防「空新卡草稿保持编辑态 → renderDetail 守卫永久
    跳过 → 笔记 tab 卡死」。聊天「存入笔记」是拷贝语义（删聊天不删卡），reader 侧先 GET fresh chat
    再存（this.paper.chat 可能滞后）。notesPrompt 三级回退同 summaryPrompt 模式。

31. **阅读器键盘/Esc 事件分层**：`_onKey`（document capture）Esc 处理顺序固定：
    （typing && @浮层开 → 交给输入框 handleMentionKeydown）→ 笔记卡编辑（commitOpenEditor）→
    聊天抽屉 → 批注选中/文本浮层 →（冒泡到 app.js 全局）阅读器。app.js 全局 Esc 分支有
    `e.defaultPrevented` 守卫（内层已消费不再关阅读器/模态）。**点击 PDF 关闭未钉住抽屉**
    （wirePdfClickClose）：豁免划词选区/选区浮窗/翻译面板；pin 按钮（rcd-pin-btn，
    localStorage 持久化）钉住后不关。改键盘交互必须保持分层，勿一键全关。

32. **renderDetail 轮询重建守卫**：10s 轮询对 summary/info tab 只在 `fresh.updatedAt !==
    state.detail.updatedAt` 时重建，且有活动文本选择（detail 内 getSelection 非空）时推迟——
    否则选区每 10s 被 innerHTML 摧毁（「标题/总结无法复制」的根因）。chat/notes tab 沿用旧守卫
    （busy/草稿/卡编辑态跳过）。新增周期性重渲染逻辑必须过同样的守卫。

33. **CommonMark CJK 缺陷 + fixCjkStrong**：`**“引用”**`、`**$公式$**` 前接汉字时按侧翼规则
    定界符非法 → marked 原样输出 `**`。renderMd 在 DOMPurify 之后、KaTeX 之前跑 fixCjkStrong
    （跳过 pre/code、内容不跨标签/换行 [^<
]、必须先于 KaTeX 否则 <span> 阻断匹配）。改渲染
    管线勿删此兜底；所有 Markdown 展示都经 renderMd 单一入口。

36. **批注保存三件套（v3.8 根因链）**：① pdf.js AnnotationStorage 的 `onSetModified` 是**粘性**的
   （只在 resetModified 后第一次修改触发）——`saveAnnotations` 成功后必须 `resetModified()`，
   `restorePageAnnotations` 完成也必须复位（否则回显置位后整会话静默）；② `serializeAnnotations`
   禁用 `annotationStorage.serializable` 全量 getter（单条坏数据全灭），用 `getAll()` 逐条序列化 +
   错误隔离；③ 关阅读器的 `saveAnnotations(force=true)` 绕过 dirty 硬门兜底（hash-diff 使无变化
   PATCH 零成本）。手写/便签编辑器在 edit mode 期间不入库，提交（deselect/切工具/关闭）才序列化，
   属 pdf.js 语义而非 bug。

35. **arXiv API 查询语法三大坑（v3.7 实测）**：① `ti:"整句"` 是连续短语精确匹配（长标题/弯引号易 0 命中）；
   ② `ti:词 AND ti:词` 里任何停用词项把整查清零（`AND ti:Is` → 0）；③ `language/models/data` 高频词
   作 ti: 项召回过宽。需要标题搜索时按 `scripts/backfill-metadata.js` 的三级兜底写：整句 → 去停用词
   关键词 AND（月份约束/英美拼写变体候选）→ 标题互包含验收。文件名取 ID 统一用 `extractArxivIdFromFilename`
   （裸 ID/[id] 下载命名/括号内/老格式，MM 01-12 防误报），enrichment 与规范改名勿再用裸 parseArxivUrl 判定。

34. **e2e 必须显式钉住 PAPERS_ROOT**：playwright webServer.env 默认继承 process.env，容器里
    `PAPERS_ROOT=/papers`（生产挂载）会漏进 e2e 服务进程 → 扫描/bootstrap 写坏真实论文目录
    （曾把 fixture 写进生产根）。playwright.config.js 已显式 `PAPERS_ROOT=<repo>/papers`，
    勿移除；新增 e2e 环境变量同理要防环境泄漏。

37. **公式引擎 dispatcher（v3.10）**：scanner 两处公式调用（processOne + 批量 extractFormulas）统一走
    `deps.ai.extractFormulasViaEngine`（不是直接 `extractFormulas`）。dispatcher 按 `effConfig.formulas.engine`
    路由：`'mineru'` 调 `require('./mineru').extractFormulas`（需 `filepath`，故 scanner 必须传 filepath），
    其余（默认 `'ai'`）走 `extractFormulas`（用 `fulltext`）。**改公式抽取勿绕过 dispatcher 直接调 ai.extractFormulas**，
    否则 MinerU 引擎设置失效。dispatcher 用 lazy require mineru 避免循环依赖（mineru.js 反向 require ai.callChat）。

38. **MinerU 服务地址在容器内必须用 host.docker.internal（v3.10）**：MinerU 跑在宿主机（端口 8000），
    app 容器内 `127.0.0.1` 指向容器自身 → 连不上。设置页 mineruUrl 必须填 `http://host.docker.internal:8000/file_parse`。
    MinerU 3.4.0 的 `/file_parse` 端点 multipart 字段名是 `files`（复数，FastAPI `List[UploadFile]`），不是 `file`。
    同步返回 `{ status, results: { "<文件名去扩展>": { md_content } } }`，公式以内联 LaTeX 出现在 md_content。

39. **概念 category 引入的 hash-diff 抖动（v3.10）**：`loadSpaceStore` 末尾 `snapshots.set(spaceId, buildSnapshot(store))`
    会用**读回的 store**（concept 带 `category:''`）覆盖快照。若内存对象（testStore push 的 concept 无 category 键）
    与读回对象（category:''）JSON 不同 → 下次 save 误判全量重写 concept。修复：`buildSnapshot` 对 concept 走
    `conceptToHashRow(c)`（补默认 `category:''`）稳定哈希。**给已有实体加新字段时，必须在 buildSnapshot 的 hash
    入口同步加默认值兜底**，否则 load/save 循环会触发幽灵重写。公式已有 `normalizeFormulas` 自愈做同样的事。

40. **公式/概念抽取 merge 的 replace 模式（v3.10）**：`POST /api/papers/:id/{formulas,concepts}/merge`
    支持 `mode:'replace'`：先 `removePaperFromFormulas`/`removePaperFromConcepts` 清本篇，再 merge。
    `removePaperFromConcepts`（store.js）语义：多论文共享的概念只删该 paperId，仅剩本篇的概念整条删
    （同 `removePaperFromFormulas` 对 occurrences 的处理）。默认（无 mode）是追加（mergeFormulas 命中只补空字段，幂等）。
    阅读器抽取下拉菜单「重新抽取」走 replace、「追加抽取」走默认。

41. **批量动作必须 try/finally 重置 UI（v3.10）**：多选工具栏的 5 个批量动作（concepts/formulas/retag/resume/delete）
    逐篇循环时若中途网络断（dev server 重启/连接中断），`await POST` 抛错会跳过 `setBulkBusy(false)` →
    `.bulk-busy` 类常驻 → 进度条永久卡死。全部 5 个动作必须 try/catch/finally，catch 弹「中断」toast，
    finally 调 `setBulkBusy(false)`。`setBulkBusy` 用 CSS `.bulk-bar.bulk-busy` 类统一禁用交互（触发器/菜单/删除键），
    取代每个动作手动 disable 5 个按钮。

42. **大产出 AI 调用必须覆盖单次超时（v3.12 根因修复）**：`callChat` 默认用 `config.ai.timeoutMs`（120s），
    对「生成单文件 HTML」（概念总览图）这类大产出远远不够——超时 abort 会被当网络错误进 4 次指数退避重试
    （每次再超时 120s），白耗 ~10 分钟后 502，制品永远落不了库。`callChat`/`callChatStream` 现支持
    `chatParams.timeoutMs`（单次超时）与 `chatParams.maxRetries`（重试次数）覆盖；`generateConceptMap`
    传 `{ timeoutMs: 600000, maxRetries: 1 }`。**新增长耗时 AI 调用（整页 HTML/长文档生成）时必须显式给
    timeoutMs 预算并调小 maxRetries**，且前端 abort 兜底要 ≥ 后端超时（总览图两端都是 10 分钟）。

## 工程化

- **测试**：`npm test`（node --test，572 例，覆盖全 lib + jsdom UI（聊天/笔记面板/回归）；db/spaces/scanner/api 用 pg-mem 无需真实 PG）；
  `npm run test:e2e`（Playwright，reader 渲染 + 高亮往返；需 dev PG，见下）。
- **双 PG 设计（生产 + 测试）**：`docker-compose.yml` 同时维护两个 PG，用 profile 隔离默认行为：
  - **`postgres`（生产）**：端口 `25432` → 宿主，持久卷 `pgdata`（存真实论文），`restart: unless-stopped`。`docker compose up` 默认启动，app 容器连此（`DATABASE_URL=@postgres:5432`）。
  - **`postgres-test`（测试）**：端口 `127.0.0.1:15432` → 宿主，**无持久卷**（容器删即丢），密码 `dev`，`restart: no`。专用于 e2e + 本地 node 开发调试。
    `profiles: [test]` 隔离，默认 `docker compose up` **不启动**；跑 e2e 前手动：`docker compose --profile test up -d postgres-test`。
- **双 PG 设计原因**：e2e 会往 default 空间注入假 sample 论文 + 跑高亮往返；若直连生产 PG 会污染真实 156 篇。测试 PG 无持久卷，可反复重置。
  **勿再手动 `docker run` 制造游离 PG 容器**——所\u6709\u6d4b\u8bd5 PG \u7edf\u4e00\u8d70 `postgres-test` 服\u52a1\u3002
- **代码质量**：`npm run lint`（ESLint，`eqeqeq` 配 `null:ignore` 容纳 `== null`）；`npm run format`/`format:check`（Prettier，**仅 lib/server/tests**，public/ 排除因无分号风格冲突）。
- **CI**：`.github/workflows/ci.yml` 三个 job——lint-and-unit、pg-smoke（postgres service + 启动冒烟 CRUD）、e2e（postgres service）。push/PR 触发。
- **运维**：`GET /api/health` 探活（含 `missingFuse` 挂载失效告警）；`NODE_ENV=production` 错误响应脱敏；
  每日 JSON 快照到 backups volume（保留 7 份，PG→JSON 逃生通道）；`scripts/backup-pg.sh` 供 pg_dump 定时备份。
- **安全**：compose 仅绑 `127.0.0.1`；PG 不对宿主暴露端口。无鉴权——多人/公网部署需自行加。

## 运行 / 测试

```bash
# 生产（Docker Compose）
cp .env.example .env               # 填 PAPERS_ROOT / POSTGRES_PASSWORD / APP_PORT
docker compose up -d --build       # http://127.0.0.1:8888
docker compose restart app         # 只改 config.json 时
docker compose up -d --build app   # 改任何代码后（lib/public 都打进镜像）
docker compose run --rm -v ./data:/legacy-data app node scripts/migrate-json-to-pg.js /legacy-data
                                   # 旧 JSON 数据一次性迁移（Git Bash 下加 MSYS_NO_PATHCONV=1）

# 本地开发（不进容器；用测试 PG postgres-test）
docker compose --profile test up -d postgres-test   # 启测试 PG（端口 15432）
DATABASE_URL=postgres://paperwiki:dev@127.0.0.1:15432/paperwiki npm start
DATABASE_URL=... npm run scan      # 只扫一次，不启 HTTP

npm test                  # node --test（572 例，pg-mem + jsdom，无需真实 PG）
npm run test:e2e          # Playwright 7 例（先 docker compose --profile test up -d postgres-test；默认连 15432，可用 E2E_DATABASE_URL 覆盖）
npm run lint              # ESLint
npm run format:check      # Prettier 检查
```

## 待办 / 已知限制

- 概念/公式去重为纯文本归一化（normalizeTerm/normalizeCanonicalName），无语义合并提示。
- 概念总览图（conceptMaps）的 HTML 存在 settings jsonb，制品多时 GET /api/settings 体积增大（已只回显元信息规避）。
- 写锁是进程内的（repository writeChain），靠单容器单进程守护；多副本部署需改造（advisory lock 等）。
- 批注已实现保存+回显；写回 PDF（XFDF）待办。
- pgvector 向量检索（语义相似推荐）未启用（schema 可平滑演进）；tsvector 全文检索已于 v3.1 上线。
- MinerU 引擎需要单独部署 MinerU 服务（非项目自带）；引擎=mineru 时概念仍走 AI（MinerU 不抽概念）。
- 旧 `data/` 目录已归档为 `data-legacy-20260718.zip`（gitignore）后删除；解压回 `data/` 即可重跑迁移脚本回滚。
