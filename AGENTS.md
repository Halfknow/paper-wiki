# AGENTS.md — PaperWiki 实现现状

> 面向 AI agent / 新开发者的项目地图：架构、数据流、关键约定与陷阱。
> 用户向人类看的介绍见 `README.md`；修改记录见 `CHANGELOG.md`。

## 这是什么

一个**薄**的本地 Web 服务：扫描 `papers/*.pdf` → 提取全文 → 查 arXiv 补元数据 → 用 OpenAI 兼容接口生成总结/标签/主题/概念，并提供一个 Indigo 主题 SPA（列表 + 详情 tab + 独立 PDF 阅读器 + 批注 + 概念清单 + 提示词编辑）。

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
  scanner.js ★         增量扫描 + 串行流水线（parse→arxiv→ai）+ extractConcepts + drain
  ai.js      ★         OpenAI 兼容 chat 调用：summarize / extractConcepts
                        含 429/5xx 指数退避重试、JSON 容错解析
  api.js     ★         REST 路由：health/papers/tags/topics/folders/concepts/settings/stats/import
  annotations.js ★     批注归一化层：pdf.js TypedArray(quadPoints) 经 JSON 退化的双向修复
  parser.js            pdfjs-dist 全文提取（Node 端，无 DOM worker）
  arxiv.js             Atom 解析、标题相似度匹配、PDF 链接抽取、下载
  util.js              sha1、限速器、sleep、标题归一化/相似度、文件名清洗、parseArxivUrl
public/
  index.html           三栏布局 + 阅读器(reader-bar批注工具组) + 概念/提示词视图 + 收藏夹/导入模态
  app.js     ★         主逻辑：路由/列表/详情/收藏夹/主题/概念/多选/导入/键盘导航(1065行)
  reader.js  ★         pdf.js PDFViewer 阅读器：双页/批注/缩放/续读(1025行)
  styles.css ★         Indigo 主题（grid + flex 列布局，列表独立滚动，reader 深灰底白页）
scripts/scan-once.js   不启 HTTP，扫一次处理完队列后退出（初始化/排错）
scripts/e2e-bootstrap.js  e2e 测试数据准备（预置 config/PDF/papers.json）
tests/*.test.js        node --test，覆盖全部 lib 模块（70 例）
tests/e2e/             Playwright e2e（reader 渲染 + 高亮往返）
tests/fixtures/        sample.pdf（2 页带文本层，e2e 用）
config.json            实际配置（gitignore，含 key）；模板 config.example.json
ecosystem.config.cjs   pm2 配置（强制 instances:1 保写锁有效）
data/                  papers.json + text/ + backups/（运行时，gitignore）
papers/                你的 PDF（只读扫描，gitignore）
.github/workflows/ci.yml  CI：lint+unit / e2e 两 job
.prettierrc/.eslintrc.json  代码质量（仅格式化 lib/server/tests，public/ 排除）
```

★ = v2.2 重点改动文件。

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
  "settings": { "summaryPrompt": "...", "updatedAt" }   // 在线编辑的总结提示词
}
```

**向后兼容**：`loadStore` → `migrateStore` 自动把 v1 数据补齐为 v2（加 topics/folders/concepts/settings/annotations 字段、规范化每篇论文）。**损坏自愈**：`papers.json` 若是非 JSON 或非对象，自动备份为 `.corrupt-<ts>` 并回空 store。

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
  1. parsing    parser.extractText → 写 data/text/<id>.txt
  2. enriching  arxiv.searchArxiv + pickBest（阈值 0.75，限速 3s）
  3. summarizing ai.summarize(prompt = store.settings.summaryPrompt
                              || config.summaryPrompt || DEFAULT_PROMPT)
     → 写 summary/tags/topics/concepts/conceptIds
  finally: deps.saveStore(store)   ← 单参！见下方陷阱

arXiv 导入 (POST /api/import):
  util.parseArxivUrl → arxiv.downloadPaperPdf → 落 papers/ → 下次 scan 自动入库
```

**概念增量抽取**（`scanner.extractConcepts(ids)`）：复用 `data/text/<id>.txt`，把已有 term 喂给模型只返回新概念，`mergeConcepts` 按归一化 term 去重并合并 paperIds。

**批注持久化**（reader.js ↔ api.js ↔ annotations.js）：前端 `annotationStorage.onSetModified` → 防抖 serialize（`doc.annotationStorage.serializable.map`）→ PATCH `{annotations:{items}}` → api.js 经 `annotations.normalizeAnnotations` 归一化后存 store。回显：open 时拿 detailView.annotations → loadAnnotations 按 pageIndex 分组 → pagerendered 后 `getPageView(i).annotationEditorLayer.annotationEditorLayer.deserialize(item)`。

## 关键约定 / 陷阱（改代码前必读）

1. **`deps.saveStore` 是单参闭包**：`saveStore: (s) => saveStore(storePath, s)`。
   scanner 必须调 `deps.saveStore(store)`（**一个参数**）。历史上曾误写成两参，导致把 storePath 字符串当 store 存进 `papers.json`，把库整个写坏。已加单测防回归。

2. **提示词优先级**：`store.settings.summaryPrompt`（在线编辑）> `config.summaryPrompt` > `DEFAULT_PROMPT`（lib/ai.js）。

3. **AI 输出必须是 JSON object**：`response_format:{type:'json_object'}`。`summarize` 期望 `{tldr,contributions,method,tags,topics,concepts,metadata}`；改字段要同步改 `scanner.processOne` 的消费逻辑与 `buildSummaryMarkdown`。

4. **概念去重 key**：`normalizeTerm`（小写 + 折叠空白）；`conceptIdFor` 基于归一化 term 的稳定 hash，保证跨论文可归并。别用随机 id。

5. **滚动布局**：`.layout` 是 grid，三列各需 `min-height:0` 才能内部滚动；`.list-pane` 是 flex 列（工具栏固定 + `.paper-list` 独立 `overflow:auto`）。侧栏收起靠 `.layout.sidebar-collapsed` 切 grid 列宽到 0 + 显示 `.sidebar-rail`；紧凑视图靠 `.paper-list.compact .paper-item` 单行布局。

6. **pdf.js viewer 加载（零构建 hack）**：reader.js 先 `import '/vendor/pdfjs.js'`（副作用注册 `globalThis.pdfjsLib`）再 `import '/vendor/pdfjs-viewer.js'`（注册 `globalThis.pdfjsViewer`，依赖 pdfjsLib）。**顺序固定**，否则 pdfjsViewer 解构出 undefined。worker 设 `/vendor/pdfjs.worker.js`。server.js 的 VENDOR_MAP 映射 build/pdf.min.mjs + web/pdf_viewer.mjs + images/，MIME 表必须含 `.mjs → text/javascript`。

7. **PDFViewer 容器必须 `position:absolute`**：构造期硬校验 `getComputedStyle(container).position === 'absolute'`，否则抛错。reader-view 用 absolute 布局（bar 浮顶 + canvas-wrap absolute 铺满）。

8. **annotationEditorMode 必须是单一枚举值**：构造时传 `NONE`（不是 `FREETEXT|HIGHLIGHT|INK` 组合位掩码）。`isValidAnnotationEditorMode` 要求 `Object.values().includes(mode)`，组合值(27)会被拒 → UIManager 不创建 → 批注全失效。运行时 `viewer.annotationEditorMode = {mode: HIGHLIGHT}`（**注意是对象 `{mode}` 不是裸整数**）切工具。

9. **批注 quadPoints 经 JSON 退化**：pdf.js `serialize()` 输出 `Float32Array`，JSON.stringify 后变 `{"0":x}` 稠密键对象，`deserialize` 时 `.length` 为 undefined 循环 0 次 → 高亮消失。**必须经 `lib/annotations.js` 的 `normalizeAnnotations` 双向归一化**（PATCH 写入 + detailView 读取）+ reader.js 前端 `repairAnnotationValue`。

10. **双页空白页坑**：别用 `removePageBorders:true` + spread，`getVisibleElements` 水平裁剪会误判右页不可见导致不渲染。改用 CSS 覆盖默认边框 + `afterReady` 主动 `_ensureRender` + `pagerendered` 兜底推进单线程渲染链。

11. **光标模式无法选中批注**：NONE 模式下 `.annotationEditorLayer.disabled { pointer-events:none }` 封死整层，点击到不了 editor。删除批注必须先切到对应工具（高亮/便签/手写）使层 enable。

12. **重启才加载后端改动**：`lib/` 模块在启动时 `require()` 进内存并缓存；改了 lib 必须重启服务。前端 `public/` 是每次请求即时读取，改完刷新浏览器即可。

## 工程化

- **测试**：`npm test`（node --test，70 例，覆盖全 lib）；`npm run test:e2e`（Playwright，reader 渲染 + 高亮往返）。
- **代码质量**：`npm run lint`（ESLint，`eqeqeq` 配 `null:ignore` 容纳 `== null`）；`npm run format`/`format:check`（Prettier，**仅 lib/server/tests**，public/ 排除因无分号风格冲突）。
- **CI**：`.github/workflows/ci.yml` 两个 job——lint-and-unit、e2e。push/PR 触发。
- **运维**：`GET /api/health` 探活；`NODE_ENV=production` 错误响应脱敏；`backupStore` 每日备份 `data/backups/papers-YYYYMMDD.json`（保留 7 份）。
- **安全**：默认监听 127.0.0.1（不做鉴权时避免局域网暴露）。无鉴权——多人/公网部署需自行加。

## 运行 / 测试

```bash
npm start                 # 前台，http://127.0.0.1:8888
npm run scan              # 只扫一次，不启 HTTP（初始化/排错）
npm test                  # node --test（70 例）
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
