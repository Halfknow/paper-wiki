# Changelog

本文件记录 PaperWiki 每个版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号语义化。

## [Unreleased]

### Added — 配色系统重设计
- **主色由绿改 Indigo**：`--accent` `#2f7d5d`（绿）→ `#4f46e5`（Indigo），背景淡蓝灰 slate；按钮/链接/选中/Logo/favicon 全部统一到 Indigo 系。
- **chip 高区分**：主题按名 hash 轮换 6 色（indigo/violet/cyan/blue/pink/amber）、标签改中性灰、指标用 cyan、状态用语义色（绿/红/amber），告别"一片绿"。
- **细节**：作者名单两行截断（arXiv 链接等元信息完整保留）；arXiv 类目 badge 前去掉分隔点；search 与按钮高度统一 34px；logo 去掉 `v2`；侧栏收起后的展开按钮重设计为图标 + 竖排提示。

### Added — PDF 阅读器重构（路线 B：pdf.js 官方 PDFViewer）
- **整体迁移到官方 PDFViewer**：从自研裸 canvas + 手拼 TextLayer 迁移到 `pdfjs-dist` 的 `PDFViewer`，自带文本层（DPR/缩放自适应）、虚拟滚动、AnnotationEditorLayer。引入 `web/pdf_viewer.mjs` + `pdf_viewer.css` + `images/`（server.js 新增 vendor 映射，含 `/vendor/pdfjs-viewer.js`/`.css`/`/vendor/images/` 目录）。
- **批注：高亮 / 便签 / 手写**：基于 pdf.js AnnotationEditor（HIGHLIGHT / FREETEXT / INK）。顶栏图标工具组（光标/高亮笔/便签/手写笔 SVG）+ 7 色现代浅透配色选择器；光标模式选中文本弹浮动高亮按钮（亮色浮窗）。
- **批注持久化与回显**：`annotationStorage.onSetModified` 触发防抖保存 → PATCH 进 `paper.annotations`（外置 JSON，坐标存 PDF 点，不污染原 PDF）。store.js `normalizePaper` 加 `annotations` 字段（自动迁移，无需 bump version）；api.js PATCH 白名单 + detailView 返回 annotations。**回显**：监听 `pagerendered` → 经 `getPageView().annotationEditorLayer.annotationEditorLayer.deserialize(item)` 重建可视 editor；多重时机兜底（loadAnnotations 后主动扫描 + 800ms/2000ms 延迟重试）解决 drawLayer 异步就绪竞态。
- **批注持久化归一化层**（`lib/annotations.js`）：pdf.js 的 `serialize()` 把高亮几何 `quadPoints` 输出为 `Float32Array`，经 JSON 序列化往返后退化为 `{"0":x,"1":y}` 稠密键对象，`deserialize` 时 `.length` 为 undefined 导致循环 0 次 → 高亮消失。本模块在服务端持久化边界（PATCH 写入 + detailView 读取）双向归一化，把 TypedArray / 稠密数字键对象还原为真数组，并自愈历史脏数据。前端 reader.js 同步实现 `repairAnnotationValue` 在 serialize/load 时二次保险。+测试（复现退化、修复、边界）。
- **列表排序增强**：新增「标题降序 / 年份降序 / 年份升序 / 添加升序」，原仅「标题升序 / 更新降序 / 添加降序」；年份升序时无年份者沉底。
- **删除批注**：编辑模式（高亮/便签/手写）下点选批注后按 Delete/Backspace 删除（pdf.js 自带，自动触发保存）；光标模式因层被 `pointer-events:none` 封死无法点选，按删除键会引导用户先切工具。
- **双页全宽 + 统一间隙**：`fitToWidth()` 按 `容器宽 / (列数 × 原页宽)` 计算 scale 让两页填满宽度；页面四边统一 6px 间隙（上下左右、页间一致），`#viewer` padding + `.page` margin 覆盖 pdf_viewer.css 默认边框。
- **缩放交互**：Ctrl/Cmd + 滚轮缩放、适应宽度按钮（⤢）、点击缩放百分比快捷回 fit、**触控双指缩放**（pdf.js 无内置 pinch，手算指间距比值 → `currentScale`，`touch-action:pan-y` 配合）。
- **续读**：保留 `{page, scrollTop, scale, total}` 持久化（防抖 + 限频 + close 强制 flush）；打开默认双页全宽而非恢复旧 scale（避免上次手动缩放值导致比窗口大）。
- **文字选区**：`.textLayer ::selection` 用 Indigo 半透明 + `line-height:1` 收紧，选区贴合文字不再显高/宽。

### Added — arXiv 网址导入
- 顶栏支持粘贴 arXiv 网址（`abs`/`pdf`/`html`）或裸 ID（如 `2310.01234`）下载并入库；util.js 加 `parseArxivInput` 解析各种格式，scanner 加下载流程，api.js 加 `POST /api/import`。+测试。

### Added — 产品体验优化（处理可见化 / 进度进列表 / 自动已读 / 键盘导航 / 批注反馈 / 空库引导）
- **处理可见化**：顶栏 stats 处理中 pill 带脉冲点并聚合当前阶段（解析中/补元数据/总结中 各几篇），列表项 busy 状态用 busy-tag，批量首扫不再是黑盒。
- **进度进列表**：紧凑视图补阅读进度条 + 📖N%，舒适视图进度悬停提示"双击继续阅读"，读完显示徽标。
- **自动已读**：阅读进度 ≥95% 自动标 done，>2% 标 reading；详情页新增"标记已读/未读"快捷按钮。
- **键盘导航**：列表 ↑↓ 选择 / Enter 打开 PDF / S 收藏，工具栏显示快捷键提示（宽屏可见）。
- **批注保存反馈**：高亮/便签保存成功在阅读器状态栏闪现"✓ 批注已保存(N)"。
- **空库引导**：真正空库（非筛选无结果）显示 3 步上手卡片，替代干巴巴的"暂无论文"。

### Fixed
- **paper list 滚动**：列表下滑时不再带动整页滚动（`.layout` 加 `overflow:hidden`，三列 grid 项 `min-height:0`，`.list-pane` flex 列布局）。
- **PDF 阅读器三个致命崩溃**：① `get total()` getter 与赋值冲突抛 TypeError；② PDFViewer 要求容器 `position:absolute`（构造期硬校验）→ reader-view 改 absolute 布局；③ 构造函数 `Object.assign` 字段名（`back`）与 bind 用的 `this.elBack` 不匹配 → 加 `el*` 映射。
- **批注全部失效根因**：初始 `annotationEditorMode` 用组合位掩码 `FREETEXT|HIGHLIGHT|INK=27`，被 `isValidAnnotationEditorMode` 拒绝（要求单一枚举值）→ UIManager 从未创建。改为 `NONE`，UIManager 正常创建后靠运行时 `setTool` 切换。
- **高亮无法保存/回显（根因有四，全部修复）**：
  ① **TypedArray 经 JSON 退化**（最核心）：pdf.js `serialize()` 把高亮 `quadPoints` 输出为 `Float32Array`，JSON 序列化后退化为 `{"0":x,"1":y}` 稠密键对象，`deserialize` 时 `.length` 为 undefined 导致重建循环 0 次 → 高亮几何为空 → 视觉消失（数据其实在 papers.json 里）。新增 `lib/annotations.js` 在服务端持久化边界双向归一化 + reader.js 前端 `repairAnnotationValue` 二次保险，把 TypedArray/稠密键对象还原为真数组。+单测复现退化并验证修复。
  ② `saveAnnotations` 的 2 秒限频 + `close()` 时未 await 就 `destroy doc`，最后一次高亮丢失 → saveAnnotations 加 force 参数，close/`_teardown` 改 async，销毁 doc 前 `commitOrRemove()` + `flushAnnotationEditorsToStorage()` + await 强制保存完成。
  ③ 双击列表项打开阅读器时不传 annotations（summaryView 不含该字段），导致已存高亮无法回显 → openReader 统一兜底懒拉 detailView 取回，保存后 `syncLocalAnnotations` 同步本地缓存。
  ④ `restorePageAnnotations` 在 deserialize 前 delete `_annotByPage`，单条失败丢整页 → 改为 deserialize 全部成功后再 delete；另把 `pdfjs_internal_editor_` 前缀的内部 id 置 null 避免回显冲突。
- **双页第二页空白**：`removePageBorders:true` + spread 模式下 `getVisibleElements` 水平裁剪误判右页不可见导致不渲染 → 去掉 removePageBorders，改用 CSS 覆盖默认边框；另加 `afterReady` 主动 `_ensureRender` + `pagerendered` 兜底推进单线程渲染链。
- **双页比窗口大（103%）**：afterReady 恢复了上次手动缩放的 scale 而非 fit → 改为默认总是 fitToWidth。
- **顶部间隙不统一**：`.reader-canvas-wrap` 有 `padding:18px 0 40px` → 改 0，间隙全交由 `#viewer` padding:6px 控制。

### Docs
- **AGENTS.md**：面向 agent / 新开发者的实现现状地图（架构、数据流、关键约定与陷阱）。
- **CHANGELOG.md**：本文件，记录每次修改。

---

## [2.1.0] — 2026-06-18

### Added
- **总结提示词在线编辑**（✏️ 提示词）：顶栏入口编辑 system prompt，写入 store 即时生效，无需重启；留空用内置默认，可折叠查看默认提示词参考。
  - 后端：store 新增 `settings` 字段（持久化 + v1→v2 迁移）；scanner 按优先级 `store.settings.summaryPrompt > config.summaryPrompt > DEFAULT_PROMPT` 取提示词。
  - API：`GET /api/settings`、`PUT /api/settings/summary-prompt`。
  - 测试：+2 API 单测（GET 结构、PUT 持久化与 trim、空串恢复默认）。

---

## [2.0.0] — 2026-06-18（全面重构）

### Added — 主题与界面
- **亮色主题**：`styles.css` 完全重写为白底 + 浅灰面板 + 蓝色强调；状态色调整为浅底可读对比。
- **虚拟收藏夹**：页面内建文件夹（精读/待复现/综述等），一篇论文可属多个，与磁盘目录解耦；可编辑名称/颜色、删除自动解绑。
- **主题（topic）双维度筛选**：AI 给每篇 1-3 个中文大方向（推理/数据选择等），作为独立筛选维度，列表卡片色块区分；与细粒度 tag 分离。
- **排序**：新增「最近更新」「标题」排序（原仅「最近添加」）。
- **信息 tab**：详情新增 Info tab，集中编辑阅读状态/主题/收藏夹/标签、查看摘要与概念贡献。

### Added — PDF 阅读器
- **独立 PDF 阅读器**（`public/reader.js`）：pdf.js 自定义渲染，逐页 canvas + 工具栏（上下页/页码跳转/缩放），不再挤在详情页。
- **续读**：自动记录 `{page, scrollTop, scale}`，下次打开从上次位置接着读。

### Added — AI 概念清单
- **概念清单**（🧠）：所有论文关键概念由 AI 抽取后去重归并，页面有专门入口查看/搜索/编辑/删除，可导出 Markdown（`/api/concepts.md`）。
- **多选追加**：列表「多选 → 抽取并追加概念」，AI 只返回新概念（把已有 term 喂模型避免重复）。

### Changed — 后端
- store 升级到 **v2**：新增 `topics/folders/concepts/settings` 字段，自动迁移 v1 数据。
- AI prompt 扩展输出 `topics` 与 `concepts`；新增 `extractConcepts` 增量抽取。
- API 新增 `/api/folders`(CRUD)、`/api/topics`、`/api/concepts(.md)`、`POST /api/papers/concepts`、`readProgress` 写入、`topic/folder` 筛选。
- `server.js` 新增 pdfjs worker vendor 映射（`.mjs` MIME）。

### Fixed
- **`loadStore` 健壮性**：`papers.json` 为非 JSON / 非对象（含被外部写成路径字符串）时，自动备份为 `.corrupt-<ts>` 并回空 store，不再让整个服务崩。
- **AI 429/5xx 重试**：`callChat` 加指数退避重试（4 次，2–30s），批量跑不再被瞬时限流误判为 error；400 等硬错误不重试。
- **`saveStore` 参数错位**（历史 bug）：scanner 由 `deps.saveStore(storePath, store)` 改为 `deps.saveStore(store)` 单参，与 server/scan-once 的闭包定义一致；加单测防回归。

### Tests
- 由 29 例增至 51 例（store v2 迁移、topics/concepts/folders 辅助函数、AI prompt/增量抽取/重试解析、API 新端点与筛选、损坏文件自愈）。

---

## [1.0.0] — 初始版本（历史，据 git log）

### Added
- `feat(store)`: JSON store 原子写、进程内串行锁、tag 合并。
- `feat(parser)`: pdfjs 全文提取，页感知拼接。
- `feat(arxiv)`: Atom 解析、标题相似度匹配、按类型取 PDF 链接。
- `feat(ai)`: OpenAI 兼容 summarizer，JSON 容错解析。
- `feat(scanner)`: 增量扫描、指纹 diff、串行流水线。
- `feat(server)`: HTTP server，静态/PDF/vendor 服务 + REST API。
- `feat(web)`: 静态 SPA，列表/筛选/搜索、总结/笔记/PDF tab。
- `chore`: pm2 配置、scan-once 脚本、README。
