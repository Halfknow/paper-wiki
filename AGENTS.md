# AGENTS.md — PaperWiki 实现现状

> 面向 AI agent / 新开发者的项目地图：架构、数据流、关键约定与陷阱。
> 用户向人类看的介绍见 `README.md`；修改记录见 `CHANGELOG.md`。

## 这是什么

一个**薄**的本地 Web 服务：扫描 `papers/*.pdf` → 提取全文 → 查 arXiv 补元数据 → 用 OpenAI 兼容接口生成总结/标签/主题/概念，并提供一个 Indigo 主题 SPA（列表 + 详情 tab + 独立 PDF 阅读器 + 批注 + 概念清单 + 提示词编辑）。另有**按主题发现**：输入主题 → LLM 生成 arXiv 检索式 → 多轴召回 + 引用量复合排序 → 勾选导入（SSE 流式进度）。

- **零构建前端**：原生 ESM，浏览器直接加载 `public/`。
- **零数据库**：状态存 `data/papers.json`（单文件 JSON，进程内串行写锁，每日备份）。
- **串行流水线**：避免压垮本地 AI / 触发 arXiv 限速。
- **Node ≥ 20**：pdfjs-dist 4.10 的实际要求。

## 目录结构

```
server.js              HTTP 入口：静态/PDF/vendor/API 路由 + 启动 scanner + 每日备份
lib/
  store.js   ★         数据模型 v2：papers/tags/topics/folders/concepts/settings
                        原子写、串行锁、v1→v2 迁移、损坏自愈、backupStore 每日备份
                        **签名不变，被各空间复用**（loadStore(path)/saveStore(path,store)）
  spaces.js  ★（新）   空间管理器：per-space 独立 store 文件 + papersDir 绑定 + text/backups 隔离
                        注册表 data/spaces.json（原子写串行锁）；CRUD（createSpace/renameSpace/
                        changePapersDir/deleteSpace/setActive）；迁移（旧 papers.json→default 空间，幂等）；
                        resolvePapersDir 收口（替代历史 5 处 path.resolve）；saveStoreBinder 单参闭包
  scanner.js ★         增量扫描 + 串行流水线（parse→arxiv→ai）+ extractConcepts + drain
                        **createScanner 不变**；新增 createMultiSpaceScanner：多空间共享单一串行队列
                        （遵守陷阱：串行防限速），per-space store/storePath/papersDir，单一定时器取 min 间隔
  ai.js      ★         OpenAI 兼容 chat 调用：summarize(自由Markdown) / extractTagsTopics(JSON) / extractConcepts / chatPaper(多轮+流式+多模态)
                        含 429/5xx 指数退避重试、JSON 容错解析、applySettingsOverride（store.settings 覆盖 config 的 ai/scan/arxiv/discover）
                        **v2.7**：callChat/callChatStream 支持 chatParams.model 覆盖 + 多模态 content 数组；新增 listModels（上游 /v1/models + extraModels 回退）
  api.js     ★         REST 路由：spaces（新）/health/papers/tags/topics/folders/concepts/settings/stats/import/discover；paper DELETE
                        **ctx = {manager, scanner, globalConfig}**；每路由 resolveSpace(q) 取 {spaceId,store,save}；
                        ?space= 路由隔离（无参回 active）；settings 读写 space.store.settings
  discover.js ★        按主题发现：检索计划(claude→网关→原始)/多轴召回/S2+OpenAlex 引用量/复合排序/去重
  claude.js  ★         spawn `claude -p --output-format json` 子进程（永不抛错，失败回退网关）
  annotations.js       批注归一化层：pdf.js TypedArray(quadPoints) 经 JSON 退化的双向修复
  parser.js            pdfjs-dist 全文提取（Node 端，无 DOM worker）
  arxiv.js   ★         Atom 解析、标题相似度匹配、PDF 链接抽取、下载；searchArxiv 支持 sort/分页 + searchArxivMulti
  util.js    ★         sha1、限速器、sleep、标题归一化/相似度、文件名清洗、parseArxivUrl、safeFilename/buildPaperFilename
public/
  index.html           三栏布局 + 顶栏空间切换器 + 阅读器 + 概念/提示词视图 + 收藏夹/导入/空间管理模态
  app.js     ★         主逻辑：路由/列表/详情/收藏夹/主题/概念/多选/导入/键盘导航/**空间切换(sp helper/teardown)**
                        sp(url) 注入器：所有 /api/ /papers/ 请求自动带 ?space=<active>
  reader.js  ★         pdf.js PDFViewer 阅读器：双页/批注/缩放/续读（PDF URL + chat 经 sp() 带空间）
  styles.css ★         Indigo 主题（grid + flex 列布局，列表独立滚动，reader 深灰底白页，space-switcher 下拉）
scripts/scan-once.js   不启 HTTP，扫一次处理完队列后退出；多空间版（--space <id> 或扫全部）
scripts/e2e-bootstrap.js  e2e 测试数据准备（预置 config/PDF/papers.json）
tests/*.test.js        node --test，覆盖全部 lib 模块（207 例，含 spaces.test.js 22 例 + 多空间 scanner 5 例 + ai 模型/多模态 7 例）
tests/e2e/             Playwright e2e（reader 渲染 + 高亮往返）
tests/fixtures/        sample.pdf（2 页带文本层，e2e 用）
config.json            实际配置（gitignore，含 key）；模板 config.example.json（全局 config，作为新空间默认模板 + applySettingsOverride 基底）
ecosystem.config.cjs   pm2 配置（强制 instances:1 保写锁有效）
data/                  spaces.json（注册表）+ spaces/<id>/{papers.json,text,backups}（per-space，运行时，gitignore）
papers/                你的 PDF（只读扫描，gitignore；default 空间默认绑定）
.github/workflows/ci.yml  CI：lint+unit / e2e 两 job
.prettierrc/.eslintrc.json  代码质量（仅格式化 lib/server/tests，public/ 排除）
```

★ = v2.2 / v2.3 / v2.4 / v2.5 / v2.7 重点改动文件（v2.7：聊天 UI 现代化重构——气泡布局/composer/模型切换器/视觉问答，改 public/{app,reader,index,styles} + lib/{ai,api,scanner}；v2.5：spaces/scanner(createMultiSpaceScanner)/api/server + 前端空间切换器；v2.4：ai/api/scanner + 前端设置中心；v2.3：discover/claude/util/arxiv/api/scanner）。

## 数据模型（store v2，per-space `data/spaces/<id>/papers.json`）

> v2.5 起引入**多空间**：每个空间是一个完全隔离的库（独立 store 文件 + 独立 papersDir 绑定）。
> store.js 的 store 形状不变（仍是下面的 v2 结构），只是从单一 `data/papers.json` 变成 per-space
> `data/spaces/<id>/papers.json`。详见下方「Spaces 架构」。

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
      "notes": "",
      "starred": false, "readStatus": "unread|reading|done",
      "status": "pending|parsing|enriching|summarizing|ready|error|missing",
      "error": null
    }
  },
  "tags":     [...],                       // 全局标签字典
  "topics":   [...],                       // 全局主题字典
  "folders":  [ { "id", "name", "color", "createdAt" } ],
  "concepts": [ { "id", "term", "definition", "paperIds", "createdAt", "updatedAt" } ],
  "settings": {                       // 在线编辑的设置（见陷阱 2/3/19/20）—— 运行时覆盖 config，仅存被改过的字段
    "summaryPrompt": "...",            // 总结提示词（Markdown 自由输出）
    "tagsPrompt": "...",               // 标签/主题提示词（强制 JSON）
    "ai": { "baseURL": "...", "apiKey": "...", "model": "...", "maxInputChars": 24000, "timeoutMs": 120000 },
    "scanIntervalMinutes": 5,          // 覆盖扫描间隔（热改 → scanner.reschedule；0=关闭定时扫描）
    "arxiv": { "enabled": true, "titleSimilarityThreshold": 0.75, "minIntervalMs": 3000 },
    "discover": { "maxResults": 40, "perAxis": 25, "semanticScholar": true, "openAlex": true,
                  "recencyWindowYears": 8, "titleSimThreshold": 0.85,
                  "semanticScholarApiKey": "...", "weights": { "rel": 0.45, "auth": 0.35, "rec": 0.2 } },
    "updatedAt": 0
  }
}
```

**向后兼容**：`loadStore` → `migrateStore` 自动把 v1 数据补齐为 v2（加 topics/folders/concepts/settings/annotations 字段、规范化每篇论文）。`migrateStore` 只确保 `settings` 是对象，不强行塞 key——新字段靠读取时 `?? default` 兜底。**损坏自愈**：`papers.json` 若是非 JSON 或非对象，自动备份为 `.corrupt-<ts>` 并回空 store。

## Spaces 架构（v2.5）

**物理布局**：
```
data/
  spaces.json                    空间注册表 { version, activeSpaceId, spaces:[{id,name,papersDir,createdAt,scanIntervalMinutes,lastScanAt}] }
  spaces/<id>/papers.json        per-space 完整 store（复用 lib/store.js，签名不变）
  spaces/<id>/text/<paperId>.txt per-space 全文
  spaces/<id>/backups/           per-space 每日备份
papers/                          default 空间绑定的文件夹（迁移后归属 default）
```

**核心抽象**（`lib/spaces.js` `createSpaceManager(dataDir, projectRoot, globalConfig)`）：
- 注册表原子写（串行锁，与 store.js 同模式）；损坏自愈（备份后回 emptyRegistry）
- `getSpaceStore(id)` / `saveSpaceStore(id, store)`：per-space load/save，**内存缓存**（manager 持有 store 引用，与 scanner 共享）
- `saveStoreBinder(id)`：返回单参闭包 `(store)=>saveStore(path,store)`，注入 scanner deps.saveStore（**遵守陷阱 1**：scanner 必须调单参 saveStore）
- `resolveSpacePapersDir(id)`：**统一收口**（替代历史上 5 处各自 `path.resolve(__dirname, config.papersDir)`）；相对路径相对 projectRoot，自动 mkdir
- `createSpace` / `renameSpace` / `changePapersDir` / `deleteSpace` / `setActiveSpace` / `setScanInterval`
- `migrateLegacyIfNeeded`：检测旧 `data/papers.json` 存在且无 `spaces.json` 时，一次性迁入 default 空间（move papers.json/text/backups → `data/spaces/default/`），迁前 backup `.pre-spaces-<ts>`，**幂等**

**隔离语义**：paper id = `sha1(内容)`，**同 PDF 跨空间是各自 store 里的独立条目**（符合隔离，非 bug）。tags/topics/folders/concepts/settings 全部 per-space（各空间 store 独立）。

**多空间扫描器**（`lib/scanner.js` `createMultiSpaceScanner({manager, deps})`）：
- 每空间建一个子扫描器（复用 `createScanner` 的完整流水线闭包），子扫描器的 store/storePath/papersDir 各自指向该空间
- **共享单一串行队列**（queue 项 = `{spaceId, id}`，pump 串行 await 子扫描器 processOne）——遵守陷阱：串行防压垮本地 AI / 触发 arXiv 限速
- 子扫描器的内部 enqueue 被 `onEnqueue` 钩子转交到共享队列（子扫描器自身不被 start，内部 queue 无人 pump）
- 单一定时器：间隔 = `min(所有 scheduled 空间 scanInterval)`，每次 tick `scan({dueOnly:true})` 内部按 per-space lastScanAt 判定哪些到点
- `reschedule(spaceId, minutes)`：改某空间间隔 + 重算定时器（遵守陷阱 20）

**后端路由**（`lib/api.js` `createApiRouter({manager, scanner, globalConfig})`）：
- ctx 从 `{store, save, scanner, config}` 变为 `{manager, scanner, globalConfig}`
- 每路由顶部 `const {spaceId, space, store, save} = await resolveSpace(q)`：`?space=<id>` 指定空间，无参回 active
- **SSE 路由（chat/discover）**：EventSource 无法设 header，spaceId 走 URL query `?space=`（后端回退 active 保证无参仍工作）
- 新增 `/api/spaces` 路由组：GET 列表 / POST 创建 / PATCH 改名+改 papersDir / DELETE 删空间（default 拒删，保留物理 PDF）/ POST :id/activate

**前端**（`public/app.js`）：
- `state.space`（localStorage 持久化 `pw-space`）+ `state.spaces[]`
- `sp(url)` 注入器：所有 `/api/` `/papers/` 请求自动带 `?space=<active>`（已有 ?space= 不覆盖）；reader.js 经 `window.sp` 复用
- `switchSpace(id)`：activate → **teardown**（关 chat EventSource、flush notes、关 reader）→ 清空 selected/filter/detail → refresh + renderDetail
- 顶栏空间切换器下拉（选空间 / 新建 / 管理模态）；管理模态改名+改 papersDir+删除

## 核心数据流

```
启动 server.js
  ├─ loadStore(data/papers.json)   ← v1 自动迁移 / 损坏自愈
  ├─ backupStore(storePath)        ← 启动即备一次 + 每 6h 检查（按天去重，保留 7 份）
  ├─ createScanner(...).start()    ← 立即全量 scan，之后每 scanIntervalMinutes 增量
  └─ http.createServer             ← /papers /vendor /api /静态

scan() 一篇新论文:
  scanDir → fingerprintAll(sha1) → diffPapers(added/changed/missing)
  → enqueue(added) → pump() 串行处理队列

processOne(id):                     ← 串行，避免限速
  effConfig = applySettingsOverride(config, store.settings)   ← 顶部算一次；ai/arxiv/discover 段统一走它（设置热生效）
  1. parsing    parser.extractText → 写 data/text/<id>.txt
  2. enriching  按 **effConfig.arxiv**（enabled/minIntervalMs/titleSimilarityThreshold 可热改，见陷阱 20）查元数据：
                p.arxivId 或 parseArxivUrl(文件名) 命中 → id: 精确查；
                否则 cleanFilenameToTitle + ti: + pickBest（阈值默认 0.75，限速 3s）。补 year(published)
  3. summarizing **两次独立 AI 调用**（见陷阱 18）：
     3a. ai.summarize(prompt = summaryPrompt 三级, jsonMode:false) → 自由 Markdown 字符串
         → 有内容写 summary（buildSummaryMarkdown 归一化）；空 → 存可重试占位（陷阱 13）
     3b. ai.extractTagsTopics(prompt = tagsPrompt 三级, jsonMode:true) → {tags,topics,metadata}
         → 写 tags（小写英文）/topics（中文，≤3）/metadata 兜底（仅标题缺失时）；独立 try/catch
  4. 规范命名   裸 ID 文件名 → buildPaperFilename「作者 等 - 年份 - 标题.pdf」并 rename（id 不变）
  finally: deps.saveStore(store)   ← 单参！见下方陷阱

arXiv 导入 (POST /api/import { url, meta? }):
  util.parseArxivUrl → arxiv.downloadPaperPdf → 落 papers/。带 meta（来自发现候选）时
  按 buildPaperFilename 命名 + 预填 title/authors/year/abstract（metaSource=arxiv）→ enqueue 总结

按主题发现 (GET /api/discover/stream?topic= ，SSE):
  discover.discoverPapers:
    buildDiscoveryQuery  claude -p（lib/claude.js）→ 失败回退 GLM 网关(planViaGateway) → 原始主题
                         产出 {queries[], categories[], keyterms[]}
    多轴召回             每 query × {relevance, submittedDate} → searchArxivMulti → 合并去重
    enrichWithCitations  Semantic Scholar 批量(+apiKey/429 重试) → 缺失项 enrichWithOpenAlex(arXiv DOI)
    复合排序             computeRelevance(keyterms) + log(引用量) + 新近，加权(config.discover.weights)
    去重                 剔除库内同 arxivId / 标题相似
  onProgress(stage) → SSE event: progress / done / fail（前端 5 步进度面板）

删除 (DELETE /api/papers/:id):
  删 store 条目 + p.filepath(限 papersDir 内) + p.fulltextPath + 清理 concepts[].paperIds
```

**概念增量抽取**（`scanner.extractConcepts(ids)`）：复用 `data/text/<id>.txt`，把已有 term 喂给模型只返回新概念，`mergeConcepts` 按归一化 term 去重并合并 paperIds。

**批注持久化**（reader.js ↔ api.js ↔ annotations.js）：前端 `annotationStorage.onSetModified` → 防抖 serialize（`doc.annotationStorage.serializable.map`）→ PATCH `{annotations:{items}}` → api.js 经 `annotations.normalizeAnnotations` 归一化后存 store。回显：open 时拿 detailView.annotations → loadAnnotations 按 pageIndex 分组 → pagerendered 后 `getPageView(i).annotationEditorLayer.annotationEditorLayer.deserialize(item)`。

## 关键约定 / 陷阱（改代码前必读）

1. **`deps.saveStore` 是单参闭包**：`saveStore: (s) => saveStore(storePath, s)`。
   scanner 必须调 `deps.saveStore(store)`（**一个参数**）。历史上曾误写成两参，导致把 storePath 字符串当 store 存进 `papers.json`，把库整个写坏。已加单测防回归。

2. **提示词优先级（各自独立三级）**：
   - 总结：`store.settings.summaryPrompt` > `config.summaryPrompt` > `DEFAULT_SUMMARY_PROMPT`（lib/ai.js）。
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

9. **批注 quadPoints 经 JSON 退化**：pdf.js `serialize()` 输出 `Float32Array`，JSON.stringify 后变 `{"0":x}` 稠密键对象，`deserialize` 时 `.length` 为 undefined 循环 0 次 → 高亮消失。**必须经 `lib/annotations.js` 的 `normalizeAnnotations` 双向归一化**（PATCH 写入 + detailView 读取）+ reader.js 前端 `repairAnnotationValue`。

10. **双页空白页坑**：别用 `removePageBorders:true` + spread，`getVisibleElements` 水平裁剪会误判右页不可见导致不渲染。改用 CSS 覆盖默认边框 + `afterReady` 主动 `_ensureRender` + `pagerendered` 兜底推进单线程渲染链。

11. **光标模式无法选中批注**：NONE 模式下 `.annotationEditorLayer.disabled { pointer-events:none }` 封死整层，点击到不了 editor。删除批注必须先切到对应工具（高亮/便签/手写）使层 enable。

12. **重启才加载后端改动**：`lib/` 模块在启动时 `require()` 进内存并缓存；改了 `lib/`、`server.js`、`config.json` 必须 `pm2 restart` 才生效。前端 `public/`（html/js/css）每次请求即时读盘且发 `no-cache`，改完**刷新浏览器即可**。`data/papers.json` 是内存态运行数据，运行中手改会被覆盖。

13. **空总结不可当成功**：模型偶发返回空对象 `{}`（批量/超时/限流）。`processOne` 判定「有内容」= 有 `tldr`/`contributions`/`method` 之一；否则存 `buildSummaryMarkdown(null)` 占位并清 `summaryAt`，不写误导性的空「## TL;DR」。`buildSummaryMarkdown({})` 只会得到空标题——务必在写入前过滤。

14. **裸 ID 文件名查不到元数据（历史 bug）**：`cleanFilenameToTitle("2012.12556")` 会把 `2012` 当孤立年份删掉 → `ti:".12556"` 搜不到 → 元数据全空 → 空标题→空总结。`processOne` 现在 `p.arxivId` 为空时先 `parseArxivUrl(文件名)` 识别裸 ID 走 `id:` 精确查。改元数据逻辑勿回退此分支。

15. **发现的查询理解必须有兜底**：`claude -p`（lib/claude.js）在无头/pm2 环境常因鉴权 **401**（进程 exit≠0 或 `is_error:true`）；且新版 CLI `--output-format json` 输出**消息数组**（取末个 `type:'result'`）而非 `{result}` 单对象。`buildDiscoveryQuery` 三级兜底 `claude → planViaGateway(GLM) → 原始主题`，`config.discover.queryEngine` 可强制。改 prompt/解析要保持兜底链。

16. **发现排序是复合分，不是单引用量**：旧实现「取最新 N 篇再按引用量排」自相矛盾（最新论文≈0 引用）。现按 `relevance + submittedDate` 两轴召回进池，再 `相关×0.45 + 权威×0.35 + 新近×0.20` 排序。引用量经 S2 + OpenAlex 兜底，`citationsAvailable=false` 时前端要提示「按相关+新近排」。

17. **改名/删除以内容 sha1 为 id**：paper id = `sha1(文件内容)前16位`，与文件名无关。所以 `processOne` 改名、`DELETE` 删文件都不影响 id / `data/text/<id>.txt` / 概念 / 批注。改名撞名时加 ` (arxivId)` 后缀；删文件限定 `papersDir` 内防越界。

18. **总结与标签/主题必须分两次调用，不能合并**（v2.4 根因修复）：历史上二者在同一次 `response_format:json_object` 调用里返回，用户自定义总结提示词（要 Markdown 章节/LaTeX）与 JSON 硬约束冲突 → 模型返回空 `{}` → 空总结 + 空标签。现 `summarize`（jsonMode:false，自由 Markdown）与 `extractTagsTopics`（jsonMode:true，JSON）分开，各自 try/catch。**改 AI 逻辑勿合并回单次调用**。`callChat` 的 `jsonMode` 参数默认 `true`（向后兼容 extractConcepts/extractTagsTopics），`summarize` 显式传 `false`。

19. **配置覆盖层（store.settings）不改 config.json，已泛化到多段**：`applySettingsOverride(config, store.settings)` 返回**新对象**，把 `store.settings` 的 `ai / scanIntervalMinutes / arxiv / discover` 合并到 config 之上（`discover.weights` 深合并），不修改原 config（保持只读语义）。scanner/api 每次调用前合成 effectiveConfig。**合并规则分两类**：`ai` 段沿用历史（`!== undefined && !== ''` 才覆盖，空串 apiKey 视为未设置）；新增段（scan/arxiv/discover）用 **`!== undefined` 即覆盖**，以正确处理布尔 `false`（如 `arxiv.enabled:false`）与数值 `0`（如 `scanIntervalMinutes:0`）——**勿对新增段套 `!== ''`，会吞掉 false/0**。`semanticScholarApiKey` 空串沿用密钥语义（不覆盖、回退 config）。`config.json` 仍启动时一次性读盘，设置改动只落 `store.settings`（papers.json），无需重启；`POST /api/settings/reset {section|all}` 删除对应覆盖回到 config 默认。

20. **扫描间隔热改 + arxiv 必须读 effConfig**：scanner 定时器在 `createScanner` 按 `scanIntervalMs` 建一次，改 `store.settings.scanIntervalMinutes` 后必须调 `scanner.reschedule(minutes)`（`PUT /api/settings/scan` 已接线）重置定时器（0=停表），否则间隔改动不生效。另：`processOne` 的 arxiv 补全段读 **`effConfig.arxiv` 而非 `deps.config.arxiv`**（历史上读死 config → 设置面板关 arxiv / 改阈值不生效）；effConfig 在 processOne 顶部算一次，ai/arxiv/discover 共用。

21. **聊天模型切换 + 视觉问答两套流式通道（v2.7）**：
   - **模型切换**：`GET /api/ai/models` 调上游 `/v1/models`（带 apiKey）+ 合并 `config.ai.extraModels`；前端 `localStorage('pw-chat-model')` 持久化选择，经 `?model=` 透传。**白名单校验**（lib/api.js chat 路由）：必须 ∈ {config.ai.model} ∪ extraModels ∪ 上游 models，否则静默回退默认——**勿跳过白名单直接透传用户输入**（注入风险）。`callChat/callChatStream` 用 `chatParams.model || config.ai.model`；scanner 在有显式覆盖时持久化 `assistant.model`。
   - **视觉问答走 POST `/api/papers/:id/chat/vision`**（不是 EventSource）：EventSource 无法携带 body（图片 base64），故视觉问答用 fetch + ReadableStream 手动解析 SSE（reader.js `streamVisionFetch`）；纯文本仍走 EventSource（GET /chat）保持兼容。**改流式协议勿合并回单通道**。
   - **多模态 content**：`chatPaper` 的 `images` 选项把末尾 user 消息 `content` 从字符串升级为数组 `[{type:'text'},{type:'image_url'}]`（OpenAI 格式原样透传）。图片白名单：`data:image/*;base64,` 前缀，限 4 张（防 papers.json 膨胀）。
   - **框选截图坐标换算**（reader.js `cropRegionToImage`）：pdf.js canvas 按 devicePixelRatio 过采样，canvas.width ≫ CSS 宽度。框选用屏幕坐标（相对 canvas-wrap），裁剪须按 `canvas.width / pageRect.width` 比例换算到 canvas 内部像素，否则截错区域。长边限 1568px（OpenAI 视觉建议）。
   - **前端两处聊天共用渲染**：app.js 经 `window.*` 暴露 `chatMsgHtml/chatEmptyHtml/renderChatMd/toggleModelSwitcher/getSelectedModel/loadAiModels/pwState` 给 reader.js（ESM 隔离）。改聊天渲染逻辑要同步两处。
   - **@ 引用浮层 confirmMention 顺序陷阱**：`confirmMention` 必须**先捕获 `onPick` 回调到本地变量**，再 `dispatchEvent('input')`（会触发 `handleMentionTrigger → closeChatMentionPicker()` 把 `_mentionCtx` 置 null），最后调 `onPick`。顺序反了 → 选了论文但 chip 不出现。浮层是 body 级 `position:fixed` 单例，两处聊天共用 `openChatMentionPicker/closeChatMentionPicker/handleMentionKeydown`。

## 工程化

- **测试**：`npm test`（node --test，207 例，覆盖全 lib）；`npm run test:e2e`（Playwright，reader 渲染 + 高亮往返）。
- **代码质量**：`npm run lint`（ESLint，`eqeqeq` 配 `null:ignore` 容纳 `== null`）；`npm run format`/`format:check`（Prettier，**仅 lib/server/tests**，public/ 排除因无分号风格冲突）。
- **CI**：`.github/workflows/ci.yml` 两个 job——lint-and-unit、e2e。push/PR 触发。
- **运维**：`GET /api/health` 探活；`NODE_ENV=production` 错误响应脱敏；`backupStore` 每日备份 `data/backups/papers-YYYYMMDD.json`（保留 7 份）。
- **安全**：默认监听 127.0.0.1（不做鉴权时避免局域网暴露）。无鉴权——多人/公网部署需自行加。

## 运行 / 测试

```bash
npm start                 # 前台，http://127.0.0.1:8888
npm run scan              # 只扫一次，不启 HTTP（初始化/排错）
npm test                  # node --test（207 例）
npm run test:e2e          # Playwright（reader + 高亮往返）
npm run lint              # ESLint
npm run format:check      # Prettier 检查
pm2 restart paper-wiki    # 生产环境重启（改 lib 后必需）
```

## 待办 / 已知限制

- 见 README「后续可扩展（v3）」：MinerU 解析、论文关系链、SQLite（>500 篇时）、向量检索、概念共现图、批注 XFDF 导出。
- `data/papers.json` 单文件，论文量很大时（>500）建议迁 SQLite。
- 概念清单去重为纯文本归一化，无语义合并提示。
- 写锁是进程内的（`let writeChain`），靠 pm2 `instances:1` 守护；多实例会写坏 papers.json。
- 批注已实现保存+回显；写回 PDF（XFDF）是 v3 待办。
