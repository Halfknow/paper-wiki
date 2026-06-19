# AGENTS.md — PaperWiki 实现现状

> 面向 AI agent / 新开发者的项目地图：架构、数据流、关键约定与陷阱。
> 用户向人类看的介绍见 `README.md`；修改记录见 `CHANGELOG.md`。

## 这是什么

一个**薄**的本地 Web 服务：扫描 `papers/*.pdf` → 提取全文 → 查 arXiv 补元数据 → 用 OpenAI 兼容接口生成总结/标签/主题/概念，并提供一个亮色 SPA（列表 + 详情 tab + 独立 PDF 阅读器 + 概念清单 + 提示词编辑）。

- **零构建前端**：原生 ESM，浏览器直接加载 `public/`。
- **零数据库**：状态存 `data/papers.json`（单文件 JSON，进程内串行写锁）。
- **串行流水线**：避免压垮本地 AI / 触发 arXiv 限速。

## 目录结构

```
server.js              HTTP 入口：静态/PDF/vendor/API 路由 + 启动 scanner
lib/
  store.js   ★         数据模型 v2：papers/tags/topics/folders/concepts/settings
                        原子写、串行锁、v1→v2 迁移、损坏文件自愈
  scanner.js ★         增量扫描 + 串行流水线（parse→arxiv→ai）+ extractConcepts
  ai.js      ★         OpenAI 兼容 chat 调用：summarize / extractConcepts
                        含 429/5xx 指数退避重试、JSON 容错解析
  api.js     ★         REST 路由：papers/tags/topics/folders/concepts/settings/stats
  parser.js            pdfjs-dist 全文提取（Node 端，无 DOM worker）
  arxiv.js             Atom 解析、标题相似度匹配、PDF 链接抽取
  util.js              sha1、限速器、标题归一化/相似度、文件名清洗
public/
  index.html           三栏布局 + 阅读器 + 概念/提示词视图 + 收藏夹模态
  app.js     ★         主逻辑：路由/列表/详情 tab/收藏夹/主题/概念/多选/提示词
  reader.js  ★         pdf.js 自定义阅读器（逐页 canvas + 续读）
  styles.css ★         亮色主题（grid + flex 列布局，列表独立滚动）
scripts/scan-once.js   不启 HTTP，扫一次处理完队列后退出（初始化/排错）
tests/*.test.js        node --test，覆盖全部 lib 模块（51 例）
config.json            实际配置（gitignore，含 key）；模板 config.example.json
ecosystem.config.cjs   pm2 配置
data/                  papers.json + text/（运行时，gitignore）
papers/                你的 PDF（只读扫描，gitignore）
```

★ = 本次重构重点改动文件。

## 数据模型（store v2，`data/papers.json`）

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
  "settings": { "summaryPrompt": "...", "updatedAt" }   // 在线编辑的总结提示词
}
```

**向后兼容**：`loadStore` → `migrateStore` 自动把 v1 数据补齐为 v2（加 topics/folders/concepts/settings 字段、规范化每篇论文）。**损坏自愈**：`papers.json` 若是非 JSON 或非对象（如被外部写成纯字符串），自动备份为 `.corrupt-<ts>` 并回空 store，不让服务崩。

## 核心数据流

```
启动 server.js
  ├─ loadStore(data/papers.json)   ← v1 自动迁移 / 损坏自愈
  ├─ createScanner(...).start()    ← 立即全量 scan，之后每 scanIntervalMinutes 增量
  └─ http.createServer             ← /papers /vendor /api /静态

scan() 一篇新论文:
  scanDir → fingerprintAll(sha1) → diffPapers(added/changed/missing)
  → enqueue(added) → pump() 串行处理队列

processOne(id):                     ← 串行，避免限速
  1. parsing    parser.extractText → 写 data/text/<id>.txt
  2. enriching  arxiv.searchArxiv + pickBest（阈值 0.75，限速 3s）
  3. summarizing ai.summarize(prompt = store.settings.summaryPrompt
                              || config.summaryPrompt || DEFAULT_PROMPT)
     → 写 summary/tags/topics/concepts/conceptIds
  finally: deps.saveStore(store)   ← 单参！见下方陷阱
```

**概念增量抽取**（`scanner.extractConcepts(ids)`）：复用 `data/text/<id>.txt`，把已有 term 喂给模型只返回新概念，`mergeConcepts` 按归一化 term 去重并合并 paperIds。

## 关键约定 / 陷阱（改代码前必读）

1. **`deps.saveStore` 是单参闭包**：`saveStore: (s) => saveStore(storePath, s)`。
   scanner 必须调 `deps.saveStore(store)`（**一个参数**）。历史上曾误写成两参，导致把 storePath 字符串当 store 存进 `papers.json`，把库整个写坏。已加单测防回归。

2. **提示词优先级**：`store.settings.summaryPrompt`（在线编辑）> `config.summaryPrompt` > `DEFAULT_PROMPT`（lib/ai.js）。改默认 prompt 要同步改测试里硬编码的期望片段。

3. **AI 输出必须是 JSON object**：`response_format:{type:'json_object'}`。`summarize` 期望 `{tldr,contributions,method,tags,topics,concepts,metadata}`；改字段要同步改 `scanner.processOne` 的消费逻辑与 `buildSummaryMarkdown`。

4. **概念去重 key**：`normalizeTerm`（小写 + 折叠空白）；`conceptIdFor` 基于归一化 term 的稳定 hash，保证跨论文可归并。别用随机 id。

5. **滚动布局**：`.layout` 是 grid，三列各需 `min-height:0` 才能内部滚动；`.list-pane` 是 flex 列（工具栏固定 + `.paper-list` 独立 `overflow:auto`），否则会变成整页滚动。侧栏收起靠 `.layout.sidebar-collapsed` 切 grid 列宽到 0 + 显示 `.sidebar-rail`；紧凑视图靠 `.paper-list.compact .paper-item` 单行布局。两者都记忆到 localStorage（`pw-sidebar` / `pw-compact`）。

6. **pdf.js worker**：前端 `reader.js` 用 `import * as pdfjsLib from '/vendor/pdfjs.js'`（ES module），worker 设 `/vendor/pdfjs.worker.js`。server.js 的 VENDOR_MAP 把这两个映射到 `pdfjs-dist/build/*.min.mjs`，且 MIME 表必须含 `.mjs → text/javascript`。

7. **重启才加载后端改动**：`lib/` 模块在启动时 `require()` 进内存并缓存；改了 lib 必须重启服务。前端 `public/` 是每次请求即时读取，改完刷新浏览器即可。

## 运行 / 测试

```bash
npm start                 # 前台，http://localhost:8888
npm run scan              # 只扫一次，不启 HTTP（初始化/排错）
npm test                  # node --test tests/*.test.js（51 例）
pm2 restart paper-wiki    # 生产环境重启（改 lib 后必需）
```

## 待办 / 已知限制

- 见 README「后续可扩展（v3）」：MinerU 解析、论文关系链、SQLite（>500 篇时）、向量检索、概念共现图。
- `data/papers.json` 单文件，论文量很大时（>500）建议迁 SQLite。
- 概念清单去重为纯文本归一化，无语义合并提示。
