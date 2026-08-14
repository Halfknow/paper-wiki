# Changelog

本文件记录 PaperWiki 每个版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号语义化。

## [Unpublished]

### Changed — 收藏夹管理重设计：管理入口收敛到「收藏夹」标题行 ⚙（v3.22)

旧入口有三处且都有问题：「新建」的 + 挂在**视图**标题行（语义错位）、编辑藏在每个收藏夹行的 **hover 铅笔**里（发现性差 + 18px 小目标误触率高，想点收藏夹切视图却点进编辑）、删除又藏在编辑弹窗内——三个动作三处入口，没有一处能看全收藏夹全貌，且**无法排序**。重设计为一处收口：

- **入口**：侧栏「收藏夹」标题行右侧一个 ⚙ 小按钮（side-icon-btn 同款，与「视图」行的收起按钮对称）→ 打开「管理收藏夹」面板；「视图」标题行的错位 + 移除。
- **管理面板**（`folder-manager.js` + `#folder-manager` 模态，取代旧 `folder-modal` 与行内铅笔，二者连同 `openFolderModal/editingFolder/pickedColor` 一并退役）：
  - **列表行**：拖拽柄 + 色块 + 名称 + 篇数 + hover 显形的 ✏️/🗑️ 操作；
  - **行内编辑**：✏️ 原地展开为「名称输入 + 8 色色板 + 保存/取消」（不嵌套二级弹窗），Enter 保存 / Esc 取消；
  - **新建**：底部虚线「＋ 新建收藏夹」→ 顶部插入编辑行，保存即 POST；
  - **拖拽排序**：HTML5 DnD（上半/下半定插前/插后，拖到空白 = 移到末尾，落点指示线与阅读架抽屉同语言），落库后侧栏**即时**重排（纯排序不走全量 refresh）；
  - **删除**：PWDialog 确认；当前筛选正指向被删夹时顺手清筛选（避免空视图）。
- **新端点** `PUT /api/folders/order {ids}`：按给定顺序重排 `store.folders`——未知 id 忽略、重复取首现、未列出的按原相对顺序补末尾（收藏夹数组顺序从此是用户语义，不再是创建时间序）。返回与 GET 同形（带 count）。
- **不变式**：侧栏行点击切视图、拖论文入夹、rail 色点等主交互零改动；`bind.js` 全局 Esc 与列表键盘导航守卫从 `#folder-modal` 换到 `#folder-manager`。
- **测试**：`tests/folder-manager-ui.test.js`（jsdom 直驱模块 + 真实 index.html：渲染/行内编辑保存链/取消/新建/空名拦截/删除清筛选/拖拽排序 + 侧栏即时重排/空态，8 例）+ `tests/api.test.js` 新增 order 端点用例。

### Added — 阅读架：阅读器内多篇论文切换（v3.21）

一次只能开一篇 PDF 是阅读器的核心瓶颈——对比阅读、按主题顺读都要「退回列表 → 找到下一篇 → 再打开」。新增**阅读架**（浏览器多标签的学术版）：打开过的论文自动上架，左下角 FAB（带计数徽章）展开左侧抽屉即可切换，全程不离开阅读器。

- **数据与端点**：per-space 存 `store.settings.readerShelf`（有序 id 数组）。新增 `GET /api/reader-shelf`（返回富化条目：标题/年份/阅读进度）与 `PUT /api/reader-shelf`（整体替换；规整：去重保首次出现、滤掉已删论文、上限 50）。删除论文时 `deletePapersCleanup` 联动剔除架上死 id（GET 规整作兜底自愈）。
- **顺序语义**：数组顺序即阅读顺序，**完全由用户手动维护**（抽屉内 HTML5 拖拽重排，落点指示线区分插前/插后，拖到列表空白 = 移到末尾）；打开/切换绝不重排。打开新论文追加到末尾，已在架上只激活不重复加。
- **切换走整链路由**：点条目 → `/reader/:id` **replace** 导航。同名路由不触发 leave（阅读器不闪关），enter 重跑 `openReader` 全链（拉详情/上架/打开 PDF）——URL 深链与刷新语义天然正确，replace 不污染后退栈；移除当前篇自动切邻居（优先下一篇，末尾篇切前一篇），架子清空则关阅读器（确认弹窗提示）。
- **抽屉顶部搜索框**：`GET /api/papers?q=` 实时搜索库内论文（250ms 防抖），点结果直接打开上架——组织一次阅读会话不用回库视图。已上架的标「已在架上」不可重复选。
- **快捷键**：`[` / `]` 环绕切换上/下一篇（输入态自动跳过）；Esc 分层新增「关阅读架抽屉」（在聊天抽屉之后、批注/阅读器之前；搜索结果浮着时先清结果）。
- **架构**：`public/js/reader/shelf.js`（状态单例：per-space 惰性加载 + subscribeShelf 订阅 + 串行 PUT 链防乱序）与 `shelf-drawer.js`（FAB/抽屉 UI）**与 pdf.js 完全解耦**——常驻侧 reader-host（打开时上架）与惰性 reader.js 共享同一实例，jsdom 测试无需加载 pdf.js 即可直测。reader-host 注入 `onSwitchPaper`（路由导航）钩子，reader.js 不 import 路由（避免与 nav.js 循环依赖）。
- **顺带加固**：`reader.open()` 增加**并发打开令牌**——阅读架快速连点切换时两次 getDocument 交错，旧请求后完成会把新 viewer 覆盖回旧论文；令牌失配即销毁弃用。
- **测试**：`tests/api-shelf.test.js`（端点往返/规整/per-space/删除联动 6 例）+ `tests/reader-shelf-ui.test.js`（jsdom 直驱抽屉：加载渲染/上架/切换/移除语义/拖拽重排/环绕切换/搜索添加/清空 12 例）。测试抓出 `toggle()` 语义写反的真 bug（无参调用永远走 close，浏览器里 FAB 打不开抽屉）。

### Fixed — 开过 PDF 阅读器后全应用无法粘贴（pdf.js 全局 paste 拦截）

- **根因**：阅读器光标模式底层借用 `AnnotationEditorType.FREETEXT`（陷阱 11：NONE 下批注不可点选），而 pdf.js 的 `AnnotationEditorUIManager` 在非 NONE 模式下经 `setEditingState(true)` 在 **document 级**挂 `copy/cut/paste` 监听且**无条件 `event.preventDefault()`**（为批注编辑器剪贴板设计）。阅读器关闭时 viewer 保活复用、无人调 `setDocument(null)`，监听泄漏到全局——开过 PDF 后，搜索框/设置/导入框等一切输入框都无法粘贴。
- **修复**：
  - `reader.js _teardown`：关闭时 `uiManager.removeEditListeners()` 卸掉 document 级编辑监听（切工具时 pdf.js 会按需重新挂载）；
  - `reader.js bindChat`：抽屉冒泡防护盾从 keydown 扩展到 `copy/cut/paste`——阅读器打开期间（监听常驻）抽屉内聊天输入/笔记卡的粘贴复制不再被吞；
  - `chat-tab.js`：详情聊天输入框 paste 加 `stopPropagation` 防御。
- **验证**：真实浏览器全链路——开/关阅读器后顶栏搜索框 Ctrl+V 正常；阅读器打开态抽屉聊天框粘贴正常。


### Fixed — 搜索框清空 × / 阅读器退出 URL 脱节 / busy 按钮抖动

- **搜索框清空 × 回归**：原生 `::-webkit-search-cancel-button` 此前因与右侧动作区重叠被 CSS 隐藏，清空只剩 Esc 一条路。新增自定义 × 按钮（`.search-actions` 内首位），显隐用 `:placeholder-shown` 纯 CSS 驱动（对程序化赋值同样生效，无需 JS 同步）；点击与 Esc 共用提取出的 `clearSearch()`（按视图分派清理 + 回写 URL）。
- **阅读器返回按钮 URL 脱节**：左上角 ← 此前直接 `reader.close()` 只关视图不动路由，URL 停在 `/reader/:id` 与页面状态脱节（退出后搜索/导航异常、刷新又弹回阅读器）。新增 `onBack` 钩子（reader-host 注入）：当前在 `/reader/:id` 路由时 `history.back()` 由路由 leave 关阅读器，与全局 Esc 同语义。
- **busy 按钮宽度抖动**：`setBusy` 换文案时按钮先坍缩再恢复（如信息页「复制 BibTeX」→「复制中…」）。`setBusy` 现在在换文案前钉住 `min-width`，结束恢复——所有 busy 按钮通用。


### Removed — 列表工具条「导出」按钮

工具条（多选那一栏）的导出下拉（当前列表/全部 → BibTeX/CSV）退役：详情头已有「复制 BibTeX」、多选菜单里也有选中项的 BibTeX/CSV 导出，工具条入口是第三处冗余。后端 `/api/papers.bib|.csv` 端点保留（多选导出继续用）。


### Changed — 规范改名全量化：本地扫描的自有命名文件也统一为「作者 等 - 年份 - 标题.pdf」

此前 `processOne` 只对**裸 arXiv ID 命名**的文件（发现/URL 导入落地名）做规范改名，用户自有命名的本地文件（如 `2015-作者-标题.pdf`、出版社下载名 `1-s2.0-Sxxx-main.pdf`）一律不动——导致本地扫描入库的文件命名风格不统一。现按产品决策全量规范化：

- **`normalizePaperFilename()` 统一收口**（`scanner.js`）：有标题即改名（无标题时规范名没有信息量，跳过）；撞名加 `(arxivId|id)` 后缀；id 基于内容 sha1，重命名不影响 id/全文/概念/批注。
- **processOne 第 4 步**去掉「仅裸 ID」门槛，所有新入库论文处理后即规范命名。
- **scan() 新增存量 pass**：processOne 只处理新增/变更，已入库论文不会再过流水线——每轮扫描对库内 ready 论文做轻量改名检查（字符串比对，已规范零开销），存量文件最终全部统一。
- **存量 pass 顺带修复「外部改名 desync」**：`diffPapers` 对同尺寸纯改名不判 changed，此前用户在文件管理器里手动改名后 store.filename 永远指向旧路径（打开 PDF 404）。扫描 pass 先把 filename/filepath 同步为磁盘事实，再做规范化。
- **无标题存量的元数据回填（metaOnly 队列任务）**：规范改名需要标题，而部分存量论文是 ready 但标题为空（早期 arXiv 补全失败的遗留）。scan() 把这类论文（一次性 `metaBackfillAt` 标记防重复入队）送进串行队列跑轻量回填：arXiv 重试（自有命名也可能 `ti:` 命中）→ 仍无标题则 AI 从已存全文提取 `title/authors/year`（只补空字段，**不动**总结/标签/主题/概念/公式）→ 规范改名。全程复用共享串行队列，不并发压 AI/arXiv。
- **注意**：手动把文件改成自定义名后，下一轮扫描会被规范名覆盖（无豁免机制）；如需保留自定义命名，后续可加 per-space 开关。
- **测试**：`tests/scanner.test.js` 更新非裸 ID 断言为新行为，新增「scan 存量规范化改名 + 外部改名同步 + 二轮幂等」「元数据回填（arXiv 命中/AI 兜底两路径 + 不动既有内容 + 防重复入队）」用例（39/39 通过）。

### Fixed — AI 聊天流式回答无法选中复制（token 级重渲根因）

- **根因**：流式期间每个 token 都 `content.innerHTML = renderChatMd(accumulated)` 全量重渲气泡（实测 ~96 次/秒），选区锚点节点被移除 → 选区立即塌陷。思考型模型一次回答流式几分钟，期间任何选中/复制尝试都会失败。`onDone` 的定型 `replaceWith` 与 `input.focus()` 同样摧毁选区；`ensureStreamingBubble` 还有无条件 `innerHTML=''` 的二次清空。
- **修复**（`detail/chat-tab.js` + `reader.js` 抽屉，两处同构）：
  - token 渲染前检查 `selectionWithin(content)`：气泡内有活动选区则跳过本次重建，下个 token 自然补渲；
  - `ensureStreamingBubble` 幂等化：仅在思维骨架 → 流式切换时清空一次；
  - `onDone` 定型渲染（补时间戳/操作按钮）在用户持选区时经 `runAfterSelectionRelease` 推迟到选区释放；`onDone`/`onFail` 的 `input.focus()` 在聊天区有选区时跳过（focus 会塌陷文档选区）。
- **共用 helper**：`core/dom.js` 新增 `selectionWithin()` / `runAfterSelectionRelease()`；list.js / refresh.js 的同名局部实现统一收口到此处。
- **测试**：`tests/chat-ui.test.js` 新增「流式选区保护」用例（手动 EventSource 驱动：token 渲染跳过 → done 定型推迟 → 释放补渲全链路）。

### Fixed — 论文列表文字无法选中复制（draggable 根因）+ 轮询重建选区守卫补齐

- **根因**：列表卡片为「拖入收藏夹」挂了常驻 `draggable=true`，Chromium UA 样式给 `[draggable]` 元素上 `user-select:none`——整张卡片的标题/作者/主题/标签全部无法选中复制，且作者 CSS `user-select:text` 盖不掉（拖拽手势恒优先于文本选择）。
- **修复（`library/list.js`）**：条目默认 `draggable=false`（文本可选）；`mouseover` 按悬停位置分派——悬在文本区（标题/作者/chips）保持不可拖（拖动手势 = 文本选择），悬在留白/圆点/进度条才启用拖拽（拖入收藏夹）。`draggable` 必须在 mousedown 之前就位，故用 mouseover 而非 mousedown 设置。
- **拖选后 click 抑制（`library/list.js`）**：拖选结束的 mouseup 会紧跟一个 click，此前直接触发 `gotoPaperRoute` 跳转、路由重建立刻摧毁选区——「选中了却复制不了」的第二根因。条目内有活动选区时 click/dblclick 视为选择手势的尾巴，不触发打开论文/阅读器（普通点击：mousedown 已使旧选区塌陷，不受影响）。全文检索结果项同款处理。
- **轮询守卫补齐（`library/refresh.js`）**：10s 轮询此前对列表/侧栏/筛选条**无选区守卫**——用户在这些区域选中的文字每 10s 必被 innerHTML 重建摧毁。新增 `selectionWithin()` helper：容器内有活动选区时跳过本轮重建（数据已进 state，下一轮无选区自然补渲）。
- **顺手修「推迟后永不补渲」**：detail 守卫此前在选区检查**之前**就合并 `state.detail`，导致被推迟的重建下一轮因 `updatedAt` 已相等而永远补不上（视图静默变旧）。改为守卫通过后才合并——推迟的更新会在选区释放后下一轮补上。
- **测试**：`tests/regression-ui.test.js` 新增 4 例（hover 分派 draggable / 拖选后 click 抑制 / 列表选区守卫 / detail 推迟补渲语义锁定）。

### Changed — 可靠性地基：健康检查探测 + 结构化日志 + 中文搜索 trigram 索引

针对一次系统性审查发现的可靠性盲区，做三件相互独立、向后兼容的改进。

- **健康检查真正探活（`GET /api/health`）**：此前 `status` 硬编码 `ok`、篇数取自启动时缓存的内存 store，PG 断了 / 磁盘满了探活照常绿。改为：① 探 DB 连通性（`SELECT 1`，2s 超时标 `timeout`，异常标 `down`）；② 探磁盘剩余空间（`fs.statfs` papers/backups 目录，低于 `config.health.minDiskMb` 默认 100MB 标 `degraded`）。返回新增 `checks:{db,disk}` 子结构，任一子项异常则总体 `degraded`，但 **HTTP 仍 200**（探活语义 = 进程能响应）。旧字段（`status/uptime/spaces/papers/missingFuse`）全部保留。
- **AI 上游探测独立端点（`GET /api/health/ai`）**：复用 `listModels`（已有 8s 超时 + 永不抛错语义），返回 `{status, source, latencyMs}`。`source:'upstream'` 表示打到上游，`'config'` 表示回退静态候选（degraded）。慢探测隔离开，不拖累主 health 响应。
- **结构化日志（`src/core/logger.js`）**：新增零依赖 logger（`createLogger(module)` → `{debug,info,warn,error}`），格式 `ISO LEVEL [module] msg {json}`，level 由 env `PW_LOG_LEVEL` 控制（默认 info，生产默认 warn）。`core/util.js` 的 `log()` 内部委托 logger（38 处现有调用零改动）；`store.js`（9 处）、`db/index.js`、`server.js` 的裸 `console.error` 统一迁到 logger（可选 migration 跳过由 error 降为 warn——本就是预期行为）。
- **错误不再静默吞**：`server.js` 两处 `backupAllSpaces().catch(()=>{})`（定时 + 启动）改为 `.catch(e => logger.error(...))`——此前「listSpaces 抛错」类未捕获错误被完全吞掉，运维无感。
- **中文全文搜索 trigram 索引（migration 006）**：`paper_texts.searchFulltext` 对中文查询（`hasCjk` 为真）永远走 `fulltext ILIKE '%q%'`，该路径**无索引可用**全表扫大文本。新增 `006-paper-texts-trigram.optional.sql`（`pg_trgm` 扩展 + GIN trigram 索引，`.optional.` 同 002 语义，pg-mem 跳过）。真实 PG 上中文搜索走索引；`searchFulltext` 代码零改动（查询优化器自动选用）。
- **测试**：新增 `tests/logger.test.js`（9 例，level 过滤/模块名/stderr/env 优先级/util.log 兼容）；`tests/api.test.js` health 用例补 `checks` 断言 + 新增 degraded/timeout/磁盘/health-ai 5 例（共 95 例全过）；`tests/db.test.js` 加 optional migration 跳过用例（共 31 例）。

### Fixed — 收起态 rail 在概念/公式页仍挂论文筛选按钮（v3.19）

侧栏收起后的图标栏（rail）原来是一份**静态的论文页内容**（全部论文/星标/未读 + 收藏夹色点）——切到概念/公式页再收起侧栏，这些按钮还杵在那，点了改的是看不见的论文筛选。rail 改为与侧栏 `.side-ctx` 同机制的 `.rail-ctx[data-ctx=...]` 三份上下文，由 `showView` 同步切换：论文 = 原有视图快捷入口 + 收藏夹；概念 = 清单/地图（走路由，active 态与展开侧栏同步）；公式 = 全部公式（清分类分面）。展开按钮与设置齿轮三页共用。

### Changed — 模型渠道全局化：跨空间共享，提示词保持 per-space（v3.19）

此前渠道（`settings.ai.channels` + `activeChannelId`）存在各空间的 settings 里，在 A 空间配的 Kimi 到 B 空间就「消失」。渠道本质是「用哪个上游端点」的全局决策，与空间内容无关——改为全局共享；提示词（总结/标签/概念/公式/概念地图/笔记）是内容偏好，**保持 per-space 不动**。

- **存储**：渠道落 `app_state['globalAi']`（PG KV），不再写 `spaces.settings`。repository 新增通用 `getAppState/setAppState`。
- **生效链路**：读取侧统一经 `withGlobalAi(settings, gai)` 把全局渠道并进 settings 再喂 `applySettingsOverride`（后者零改动）。API handler 从 `resolveSpace` 解构 `gai`；scanner 在 `subFor()` 单收口包装，六处调用点不动。
- **优先级阶梯（向后兼容）**：全局渠道 → per-space channels（旧数据兜底，不删除）→ 旧版顶层三元组 → config.json。清空全局渠道后逐层回落。
- **启动迁移**：`ensureGlobalAi()` 按 active 空间 → default → 其余（渠道多者优先）把现有 per-space 渠道提升为全局，原副本保留作兜底。升级后各空间立即可见同一组渠道卡片。
- **前端零改动**：GET/PUT 接口契约不变（渠道列表照常出现在 `GET /api/settings` 的 `ai.channels`）。
- **语义微调**：首次保存渠道不再删除空间的旧版顶层三元组——它降级为「无全局渠道时」的 per-space 兜底（v3.13 的「删除防双写」语义在全局化后已无必要）。`POST /api/settings/reset` 不动全局渠道。
- **顺带修复**：`routes/discover.js` 里 `const { discoverOpts } = ctx` 遮蔽了模块级同名函数（ctx 从未提供它），`/api/discover` 一调就 TypeError——v3.15 路由化重构引入的潜伏 bug。

### Changed — 筛选条下沉列表工具条，顶栏达成纯 chrome（v3.18）

v3.17 第一步留了条尾巴：状态/主题/标签/仅星标还寄居顶栏（当时放不下——列表列最窄 320px）。这一步完成下沉，顶栏从此只剩全局控件。

- **筛选条沉入 `.list-toolbar`**：状态/主题/标签触发器与排序、视图密度、多选同处论文页自己的工具条，随 `#library-view` 整体显隐（`showView` 不再单独切换）。工具条全部件统一 30px 高 / 12px 字紧凑密度；状态触发器默认文案「全部状态」收成「状态」（列表列宽按字符计预算）。放不下时换行——筛选+排序居左一行，密度+多选（`.toolbar-actions`，`margin-left:auto`）右对齐一行，任何列宽都不横向溢出。
- **仅星标 checkbox 退役**：星标入口仍有三处——侧栏「星标」视图、搜索 DSL `star:1`、高级搜索面板，顶栏这个 checkbox 是第四处冗余。
- **紧凑/舒适与多选改纯图标**：文字交给 title/aria-label（多选的开关态由 title「多选⇄退出多选」+ active 类表达）。
- **设置入口移回左下角**：顶栏齿轮 `#btn-settings-top` 退役，恢复侧栏 footer（`#btn-settings`）+ rail 底部（`#btn-settings-rail`）双入口。当年从侧栏搬走是因为 footer 藏在 `#library-view` 里、切页即消失；v3.17 骨架统一后侧栏跨视图常驻，这个问题已不存在，顶栏进一步纯化。
- **状态胶囊色点换 activity 矢量图标**：色点语义太弱。图标吃 `currentColor`，沿用 data-level 三色（idle 灰 / busy 琥珀脉动 / error 红）。
- **顶栏高度统一 34px 定高**：`#search` 从 `min-height` 改 `height`。原先 `.star-filter` 只写 `min-height:34px`、继承 body `line-height:1.55`，实测 37px 高——它是随视图显隐的控件，把 `align-items:center` 的顶栏在论文页撑高 2px、切概念/公式页又缩回去（切页时顶栏「跳一下」的根因）。死样式 `.topbar select` / `.star-filter` 一族一并清除。

### Fixed — 聊天用户/AI 头像矢量图标偏心

`CHAT_ROLE_ICO`（`public/js/detail/chat-view.js`）两个图标的路径几何不在 24×24 viewBox 正中，CSS 的 `align-items/justify-content:center` 只能把 SVG 整体居中，纠正不了字形内部偏移：

- **AI 四角星**：起点 `M12 3`，垂直跨度 y=[3,17]，中心 y=10，比 viewBox 中心 12 偏上 2 个单位（上空 3、下空 7）→ 看起来「漂在圆里偏上」。起点改为 `M12 5`，垂直跨度 y=[5,19]，中心回到 12（后续 `l` 相对命令整体跟随平移，形状不变）。
- **用户胸像**：头圆 `cy=8`（y=[4,12]）+ 肩部路径（y=[15,21]），合成中心偏下。`cy` 改为 7（与 lucide `user` 对齐），合成垂直跨度 y=[3,21]，中心回到 12。

水平方向两图均已在中心（x 跨度中心=12），无需调整。

### Changed — 顶栏重构为纯 chrome：一级导航 + 上下文搜索 + 状态胶囊（v3.17，第一步）

把顶栏从「身份 + 导航 + 论文页专属筛选 + 全局动作」混在一行，收敛为**顶栏管全局、工具条管本页**。确立「一个空间，三种切面」的信息架构——概念与公式是当前空间论文的派生物（概念卡片的论文胶囊能跳回论文即是证据），故与论文平级、共享同一套 chrome。设计文档见 `docs/superpowers/specs/2026-08-04-navigation-ia-design.md`。

- **一级导航 `#view-nav`**：论文 / 概念 / 公式 分段控件，紧贴空间切换器右侧（读作「在 X 空间里看 Y」），与 `.space-current` / `.filter-trigger` 共用同一套 token（34px 高、`--radius-sm`、同边框色），选中段是 `accent-soft` 内嵌胶囊、**不加外阴影**（一浮起来就不像嵌在 bar 里）。元素是 `<a href>` 而非 `<button>`——`core/router.js` 已拦截站内链接，故中键可开新标签页、右键可复制链接；`bind.js` 再覆盖一层只为 `force:true`（点当前页那一段要重新入场拉数据）与概念页子视图记忆。段上带**计数徽标**，取代旧 stats 里重复的「N 概念 / N 公式」pill。
- **上下文搜索**：唯一的 `#search` 靠右，placeholder 与检索目标随视图切换（论文 → 现有 DSL/全文检索链路不动；概念 / 公式 → 本地过滤）。页内 `#concept-q` / `#formula-q` **退役**（此前概念页同屏两个搜索框，顶栏那个还搜不了概念）。语法帮助与高级搜索仅论文页可用；`Ctrl K` 三页通用。概念/公式页的查询词**进 URL**（`/concepts?q=`），与论文页对称。
- **论文页专属筛选条随视图隐藏**：状态 / 主题 / 标签 / 仅星标只对论文有效，`showView` 在概念、公式页整条隐藏（旧实现照样杵着）。完整下沉到页面工具条留到第二步——列表列最窄 320px，塞四个下拉必然溢出。
- **状态胶囊 `#status-chip`** 取代五个 stat-pill：空闲时只剩一个灰点，**处理中 / 出错时把文案顶出来**（把异常也折叠进 hover 会让后台失败完全静默）。hover/点击展开 popover 看就绪 / 处理中明细 / 错误 / 概念 / 公式，底部收纳「立即扫描」——扫描本质是重建索引，属状态维护而非主动作。
- **动作收敛**：导入 / 发现合并为 `+ 添加` 下拉（同一意图的两条路径）。顶栏右侧控件由 5 个降到 3 个。
- **设置入口全局化**：旧入口 `#btn-settings` 在 `#library-view` 内的侧栏 footer，切到概念/公式页时整个库视图 `display:none`，**设置就进不去了**。改为顶栏齿轮 `#btn-settings-top`，侧栏 footer 与 rail 的重复入口一并移除。
- **删掉概念页 / 公式页的「返回论文库」箭头**：返回箭头是「下钻」的交互语言，与平级导航冲突。

### Changed — 骨架统一：常驻侧栏 + 分面下沉 + 设置改覆盖层（v3.17，第二步）

第一步只动了顶栏，三个平级页面的**布局骨架**仍不一致（论文页三栏、概念/公式页全宽无侧栏），切页时整块塌陷重建。这一步把骨架也统一了。

- **`.app-shell` 常驻骨架**：侧栏与 rail 从 `#library-view` 内部提到三个内容视图之外，`.app-shell` 是 `侧栏 | 内容区` 两列，`#library-view` 降级为内容区里的 `列表 | 分隔条 | 详情` 三列。切页只换 `.app-content` 里的内容与侧栏的 `.side-ctx`，骨架恒定。`sidebar-collapsed` 随之改挂 `#app-shell`（收起态跨视图保持）。
- **侧栏按视图切上下文区块**：论文 = 视图 + 收藏夹（不变）；概念 = 视图（清单 / 地图）+ 分类分面；公式 = 全部公式 + 分类分面。分类项点击是多选切换（同 Zotero 标签选择器），带计数。
- **分面下沉，消除同一状态两处入口**：概念页的「清单 / 地图」分段与分类筛选从页内搬到侧栏（它们决定「看哪一批」，属分面导航）；页内漏斗只剩「共享频次 / 章节出处」，工具条只剩「怎么显示」（排版 / 排序 / 下载）。
- **概念分类清单改从数据现算**：旧漏斗面板照 `_CONCEPT_CATEGORIES` 枚举列 chips，而提示词里的枚举只是建议——模型返回枚举外的分类时，那些概念在分面里**彻底消失**。现在分类从 `state.concepts` 现算，枚举只用来提供中文标签与已知分类的排序，枚举外的排在最后。
- **设置改覆盖层**：仍是 `/settings/:tab` 路由，但呈现为遮罩 + 居中面板，Esc / 点遮罩 / 「关闭」都能退出，且**回到打开它之前的那个页面**（从概念页点齿轮再关掉却落到论文库，是最容易被抱怨的丢上下文）。深链直达无来路时兜底 `/library`。

### Fixed — 切到概念/公式页时论文页的列表工具条仍挂在左上角（v3.17）

`.view-hidden { display:none }` 与 `.layout { display:grid }` 特异性同为 `(0,1,0)`，胜负取决于在 styles.css 里的先后——`.layout` 更靠后就赢了，于是 `#library-view` 加上了 `.view-hidden` 类却没真隐藏，概念页左上角残留论文页的排序下拉与密度分段。`.view-hidden` 改为 `display:none !important`（工具类压过元素自带的布局 display 是它该有的语义），首帧那几条「显出某视图」的规则同步加 `!important`（两条都 important 时比特异性，`(1,2,1)` 稳赢）。

**为什么单测没抓到**：jsdom 不加载外部 CSS，测试只能断言 class 是否加上——而 bug 恰恰是「class 加了但 display 没变」。`scripts/verify-boot-view.mjs` 因此补了第二遍：让 app.js 正常跑，点导航切页后读 computed display。

### Fixed — 深链 /concepts /formulas /settings 刷新时先闪现论文页（v3.17）

两处根因，缺一不可修：

- **首帧**：`#library-view` 是四个视图里唯一没有 `display:none` 的，首帧必然画论文页。视图显隐从 inline style 改为 `.view-hidden` 类（inline style 的恢复靠 `style.display=''`，依赖各视图 CSS 默认 display —— 首帧规则若要选对就得复制这套默认值，脆弱）；`<head>` 加一行内联脚本把 `location.pathname` 写进 `data-boot-path`，由 `styles.css` 的 `[data-boot-path^="/concepts"]` 一族规则在解析阶段就选中正确视图。脚本**故意不含任何映射逻辑**（映射全在 CSS），避免与 `showView()` 两处实现漂移；脚本失败也只退化成当前行为。`showView` 首次执行清掉该属性交还控制权。
- **二次延迟**：`showConcepts()` 里 `showView('concepts')` 排在 `/api/concepts` + `/api/papers` + `/api/settings` **三个网络请求之后**。现已提到所有 `await` 之前，`showFormulas` 同样处理。
- **验证**：`scripts/verify-boot-view.mjs`（真实 Chromium，阻断 app.js 把页面钉在首帧后读各视图 computed display）——jsdom 测不了这个，它不加载外部 CSS。

### Fixed — 深链 /formulas /concepts 时卡片关联论文丢失显示「独立条目」（v3.15）

`state.papers` 只由 `refresh()`（库视图 enter / 10s 轮询）填充。v3.15 引入 URL 路由后，**直接刷新/深链 /formulas 或 /concepts 时 refresh() 尚未跑过**，`state.papers` 为空 → 卡片 `occurrences`/`paperIds` 全部解析不到 → 误显示「（独立条目）」；10s 轮询补拉后渲染的懒加载批次才有论文，看起来「前面独立条目、滚动到后面又有了」。`showFormulas`/`showConcepts` 现在在 `state.papers` 为空时直接补拉一次列表（不走 refresh()，避免 renderList/syncFilterToUrl 副作用污染当前页 URL）。

### Fixed — 公式瀑布流懒加载塌列：同步定位 + 三遍分离消 thrash + 取证埋点（v3.15）

懒加载触发后瀑布流变成「全宽单列列表」的第二轮根因修复（第一轮 v3.14 的 ResizeObserver 只覆盖宽度变化无人纠正的场景）：

- **同步定位消除在流瞬态**：`_renderFormulaBatch` 历史上追加新卡后用**双 rAF** 延迟跑瀑布流定位——新批次卡在定位前以「在流、全宽、相对定位」刷在屏幕上；慢机器/重负载下 rAF 排在成批 KaTeX 同步渲染之后，用户会看到持续数秒甚至更久的列表态。KaTeX 本就同步渲染（卡高立即可测），改为**追加后同步定位**；字体异步回流由 rAF 复查（只重算高度）+ resize/RO 兜底。
- **三遍分离（写-读-写）消 layout thrashing**：原实现逐卡「设宽 → 读 offsetHeight」——每次读都强制同步重排（N 张卡 = N 次 reflow，重负载下主线程长时间卡死）。改为先批量设宽、再批量读高（浏览器合并为一次 reflow）、最后批量写 top/left。
- **单卡异常不中断整批**：`_buildFormulaCard` 加 try/catch——否则一张卡的极端 LaTeX/Markdown 异常会让本批追加失败，observer 反复重试同一批且定位永远排不上。
- **取证埋点（临时）**：布局关键事件（batch / layout-apply / layout-fallback / ro-fire / win-resize）记录到 `window._masonryDebug`，用于收集用户真实环境的事件序列（复现后控制台 `copy(JSON.stringify(window._masonryDebug))`）。
- **已验证场景**（Playwright 真实 Chromium）：正常逐批滚动全量加载列数稳定；窄窗（cols=1）→ 加载中途拉宽窗口自动恢复 cols=3。

### Changed — 概念地图提示词改浅色高级风 + 制品清单改缩略图网格（v3.15）

- **提示词参考 Claude 制品提示词优化（深色 → 浅色）**：默认提示词的设计美学段落从暗色玻璃拟态改为**浅色高级风**（明亮暖白/冷白底、纯白卡片 + 细边框 + 柔和投影、配色克制、强调色仅用于标题/徽标/连线）。借鉴 Claude `read_me` 设计模块的思想——提示词内置一份权威**设计令牌**规范（`:root` CSS 变量统一定义配色/间距刻度/圆角/字号层级，全部样式只引用变量，不散落硬编码色值）；并加入 never-expose-machinery（只输出 HTML 文档，不输出"我将要…"式叙述）。路由判断/`sendPrompt`/`window.storage` 等 Claude 运行时机制与独立生成场景无关，未采纳。
- **提示词回退为「暗色骨架浅色化」（v3.16 调整）**：v3.15 的「浅色高级风 + 设计令牌」过于克制（大面积留白、禁止渐变糊屏），生成效果不如 v3.10 暗色版。v3.16 回到 v3.10 暗色版的美学骨架——保留**鲜艳渐变主色（indigo→violet→pink）、玻璃拟态卡片质感（backdrop-filter blur + 半透明白底）、氛围光晕背景、大胆展示字体、3 视图交互与 staggered 微动画**，仅把深色底（#0a0e1a）翻成**浅色底**（#f8fafc 冷白 + 多层极淡渐变光晕）。视觉冲击力与暗色版相当，但配色为浅色。
- **制品清单列表行 → 缩略图网格**：制品卡上方是**live 缩略图**——制品 HTML 在 1280×800 sandboxed iframe（`allow-scripts`，不放 same-origin）里真实渲染后 CSS `scale()` 缩小到卡宽；IntersectionObserver 滚进视口才 GET html 挂载（jsdom/老浏览器立即全挂）。点缩略图直接查看；generating 卡显示 spinner 占位，error 卡（含半成品）显示「不完整」徽标 + 半成品缩略图。
- **轮询只在状态/成员变化时重渲**：制品卡重渲 = 卸载重挂 iframe（重新拉 html + 重跑页内动画），`_pollConceptMaps` 改为检测到跳变才 render；`_stopConceptMapPolling` 后残留回调短路（定时器句柄即开关）。
- **测试**：tests/conceptmaps-ui.test.js 改写 5 例（网格渲染 / 占位卡 / 跳变重渲挂 iframe + 轮询停止 / error 徽标 + 半成品缩略图 / 设置面板）。

### Changed — 路由化重构：前端 History API 路由 + app.js 拆 37 模块 + 后端路由表（v3.15）

**动机**：`public/app.js` 已达 7070 行 / 366KB，改一处聊天输入框的行为要把约 180k tokens 灌进
上下文，基于 agent 的开发难以为继。根因不只是文件长——**整个前端零 URL 路由**（`location.*` /
`history.*` / `popstate` 命中数为 0），视图靠 `showView()` 切 `display:none`，既没有天然的模块
边界，也无法深链 / 分享 / 前进后退。后端同构：`createApiRouter` 里是一条约 1800 行的
`if (pathname === X && method === Y)` 长链。

- **前端路由（History API + 服务端 SPA fallback）**：`/library`（筛选编码在 query）、
  `/paper/:id[/:tab]`、`/reader/:id`、`/concepts[/maps[/:id]]`、`/formulas`、`/settings/:tab`。
  刷新停在当前页、链接可分享、前进后退可用。`?space=` 成为全局保留参数跨导航自动携带。
  纯函数层（matchRoute/buildPath/parseQuery/stringifyQuery）与有状态层（popstate、站内链接
  拦截、enter/leave 生命周期）分离。`src/server.js` 新增 `isAppRoute()` 决定哪些路径回
  index.html，保留 `/api/ /papers/ /vendor/` 与带扩展名的静态文件。
- **app.js 7070 → 47 行**：按领域拆成 37 个模块进 `public/js/**`（core / library / detail /
  concepts / formulas / settings / spaces / search / views / bind）。声明体逐字迁移，只补
  import/export；import 图由自由标识符分析推导。
- **后端路由表化**：`router.js` 2123 → 167 行，只剩装配；新增 `route-table.js`（纯函数匹配，
  静态段优先于参数段，参数字符集与旧正则逐字一致）、`views.js`（只读视图与共享 store 助手）、
  `routes/*.js` 14 个领域模块共 74 条路由。空间上下文由 dispatcher 统一解析。
  **对外 HTTP 契约零变化**——`tests/api.test.js` 一行未改仍 90/90 全绿。
- **测试**：全量 596 → 650 例。新增 `api-route-table`（12，纯函数）、`spa-fallback`（7，纯函数）、
  `frontend-router`（18，纯函数）、`routing-ui`（17，jsdom 深链/前进后退/筛选 query 往返/
  space 透传）。现有 8 个 jsdom UI 测试 71 例**零改动**通过。
  `tests/helpers/ui.js` 增加 `initialPath` 与 back/forward；新增 `helpers/boot-loader.mjs`
  （ESM resolve 钩子传播 `?boot=N`，使同进程可多次 bootUi）。
- **顺带修掉的测试桩缺陷**：`/api/tags` 桩返回裸字符串，而真实契约是 `[{name,count}]`，
  导致 `renderFilters` 把用户选中的标签全剪掉（定位 URL 筛选还原时暴露）。

### Changed — 概念总览图改名「概念地图」+ 后台生成任务化 + 提示词开放设置（v3.14）

**根因（生成慢且看似失败）**：概念地图走**非流式** `callChat`（v3.12 只把超时放宽到 10 分钟）——单文件 HTML 大产出在思考型模型（Kimi k3 等）上常需**数十分钟**（实测该端点 200 字输出约 12.7s），10 分钟 total 预算必超；且非流式请求首字节前完全静默，会被网关/中间代理的空闲超时掐断。双重夹击下制品永远落不了库（生产库 0 制品）。

- **流式生成**：`generateConceptMap` 改走 `callChatStream`——从思考阶段就有字节流动（`reasoning_content` 先行），连接全程保活；total 预算放宽到 30 分钟，重试 1 次。
- **后台任务化**：`POST/PUT /api/concepts/map` 不再挂请求等 AI——立即落库 `status:'generating'` 占位制品并返回元信息，AI 在服务端后台跑，完成/失败更新占位再落库。**切页/刷新/关页面都不打断生成**；前端 4s 轮询 settings 元信息，`generating→ready/error` 跳变 toast 通知。失败制品保留失败原因（含上游状态码，自托管场景排查友好）；输出截断（缺 `</html>`）标 error 但保留半成品可查看/再优化。
- **可取消**：生成中的制品「删除」= 取消后台任务（`AbortController` 经 `chatParams.signal` 透传进 `callChat/callChatStream`，与超时信号 `AbortSignal.any` 合并；外部取消不走退避重试）。服务重启后僵尸 `generating` 占位在读路径解析为 error（任务句柄不可序列化，仅存内存）。PUT 优化期间旧 html 保留可看；同制品生成中重复优化 409。
- **改名**：全站「概念总览图」→「概念地图」（视图 tab、按钮、设置页、提示词、错误文案；标识符 `conceptMaps`/`/api/concepts/map`/`cm_` id 不变，存量制品兼容）。
- **提示词开放设置**：设置页新增「概念地图提示词」面板（智能组），`settings.conceptMapPrompt` 三级回退（生成时自定义要求 > 设置覆盖 > 内置默认），`PUT /api/settings/concept-map-prompt`（空串恢复默认）+ GET settings 回显 + overrides 徽标 + reset section 支持。
- **测试**：改写 tests/api-conceptmap.test.js（4 例适配后台任务语义）+ tests/api.test.js +6 例（占位→完成→取 html / 截断标 error 留半成品 / 生成中删除=取消不复活 / 重复优化 409 / 僵尸 generating 解析 / 提示词保存回显重置）+ tests/ai.test.js 流式断言（stream:true、非 JSON、剥围栏、prevHtml 注入）+ 新增 tests/conceptmaps-ui.test.js（5 例 jsdom UI：改名 / 占位渲染 / 轮询跳变停轮询 / error 制品 / 设置面板）。

### Fixed — 公式瀑布流懒加载后塌成单列（v3.14）

部分环境（窄窗口恢复/侧栏开合/DevTools 开合等 `window resize` 覆盖不到的容器宽度变化）下，瀑布流按旧窄宽度算成单列后无人纠正，懒加载新批次沿用错误列数，看起来像「列表」。

- **`ResizeObserver` 盯 grid 本体宽度**：只认宽度变化（高度变化是重排结果而非原因，过滤掉防反馈循环），宽度变化即防抖重排；`window resize` 监听保留作老浏览器兜底。

### Added — 模型渠道卡片 + 一键切换默认模型（v3.13）

设置页「AI 接口」重构为「模型渠道」：每个 OpenAI 兼容端点一张卡片（名称 / Base URL / Key 状态 / 模型 / 上下文徽标），「设为默认」一键切换全站 AI 能力的驱动渠道，立即生效无需重启。

- **数据结构**：`settings.ai.channels[]`（`{id,name,baseURL,apiKey,model,maxInputTokens}`）+ `activeChannelId`。渠道存在时活跃渠道权威覆盖旧版顶层 `baseURL/apiKey/model`（`applySettingsOverride` 内解析，scanner/api 全部调用方零改动）；渠道 `maxInputTokens` 可单独覆盖全局输入上限。所有渠道 model 自动并入 `extraModels`（聊天切换器白名单 + `/api/ai/models` 候选）。
- **迁移**：首次保存渠道列表时把旧版顶层三元组迁移进渠道并删除（单一事实源，防双写 desync）；无渠道存根的旧部署在 `GET /api/settings` 里合成单卡片「默认渠道」（id=`ch_default`，掩码 key 解析到当前生效 key）。
- **API**：`PUT /api/settings/ai/channels`（全量替换；id 缺省生成 `ch_xxxxxxxx`；apiKey 掩码/未传按 id 保留已存 key，空串=无鉴权；baseURL/model 必填 400；activeChannelId 未命中回落第一个）+ `POST /api/settings/ai/models`（按表单值拉上游 `/v1/models`，掩码 key 按 channelId 解析）+ `POST /api/settings/test` 支持 `channelId` 基底。
- **前端**：卡片网格（默认卡紫色描边 + 「默认」徽标 + 名称哈希色相头像 + Key 状态点）/ 行内编辑卡（快速预设：Kimi for Coding、智谱 GLM、DeepSeek、OpenAI、OpenRouter）/ 拉取模型填 datalist（命中 `context_length` 且 tokens 留空时自动回填）/ 每卡独立「测试连接」。全局参数（最大输入 tokens / 超时 / 各任务上限）与渠道解耦，单独保存。
- **Fixed — 锁定 temperature 的模型 400 全灭**：Kimi k3（`invalid temperature: only 1 is allowed`）/ OpenAI o 系列 / gpt-5 只接受 temperature=1，`callChat`/`callChatStream` 默认发 0.3 会被 400 拒绝。现遇 400 且报错提及 temperature 时剥掉 `temperature/top_p` 立即重发（不占退避重试额度）。
- **测试**：+7 例——渠道覆盖优先级/未命中回落/显式空 key、PUT channels 迁移+掩码保留+切换生效+校验、合成渠道视图、temperature 剥参重发（tests/ai.test.js、tests/api.test.js）。

### Fixed — 渠道编辑「拉取模型」下拉显示不全（v3.13）

原生 `<datalist>` 由浏览器控制渲染：按输入框当前值过滤（框里有 `glm-5.2` 就只剩 1 项）、可视项受限、无法展示上下文信息。重构为**自定义模型选择器**（与 sd-* 下拉/@ 引用浮层同设计语言）：

- **全量可见**：聚焦/输入按子串过滤（id + displayName），chevron 按钮始终展开全量列表；拉取成功自动展开；大网关（OpenRouter 数百个）渲染上限 100 条并提示继续输入过滤。
- **信息密度**：每项显示模型 id（等宽）+ displayName + 上下文徽标（1M/256K，来自网关 `context_length`/`display_name` 扩展字段，`listModels` 新增 `extractDisplayName` 透传）；当前模型高亮 `cur`。
- **tokens 同步**：`card.dataset.tokensFor` 记录当前 tokens 值归属的模型——值为空或归属另一模型时，选中自动回填新模型的 `contextLength`；手动改过的自定义值不覆盖。
- **键盘导航**：↑/↓ 闭环移动高亮、Enter 选中、Esc 关闭（preventDefault 不冒泡到全局 Esc 分层）；点选择器外部关闭。
- **测试**：新增 tests/settings-channels-ui.test.js（5 例，慢守卫）——卡片渲染/全量可见/过滤/键盘选中回填/设为默认 PUT/大列表截断。过程抓获并修复 3 个真实 bug：键盘导航重渲染清高亮（永远只跳第一项）、tokens 归属误判（过滤文本被当旧模型）、选中后 focus() 经 focusin 重开菜单。

### Changed — 单测分层：npm test 快速套件 / test:full 全量（v3.13）

开发效率修复：全量单测在 Docker Desktop 下要 ~38s，两大根因——

- **`callChat` 真实指数退避**：429/5xx 重试用例白等真实退避（单条最重 ~30s）。`ai.js` 退避提取为可注入的 `backoffWait`，新增 `__setBackoffForTests` 测试钩子；`tests/ai.test.js` 顶部全局禁用后 **38s → 0.18s**。
- **Docker bind mount 文件读放大**：`require('jsdom')` 在 gRPC-FUSE 挂载上要 ~20s/文件（CI 原生 fs 无此问题）。6 个 jsdom UI 文件 + scanner 均 >5s。
- **慢文件守卫**：新增 `tests/helpers/slow.js`（`guardSlowFile`，须在重型 require 之前调用），`npm test` 默认整文件跳过（~489 例 / ~11s），`npm run test:full`（`PW_FULL_TESTS=1`，scripts/test-full.js，跨平台）跑全量 580 例；CI 改用 `test:full` 保持全覆盖。

### Fixed — 概念总览图生成后无制品（v3.12）

**根因**：`callChat` 全局限时 `config.ai.timeoutMs`（默认 120s）对「生成单文件 HTML」这种大产出远远不够——GLM 生成总览图常需 2-5 分钟。超时 abort 被当作网络错误进 4 次指数退避重试（每次再超时 120s），白耗约 10 分钟后 502；前端 5 分钟 abort 兜底先到，用户看到「生成超时」，制品永远落不了库。

- **`callChat`/`callChatStream` 支持单次调用级覆盖**：`chatParams.timeoutMs`（超时）与 `chatParams.maxRetries`（重试次数），不传时行为与之前完全一致。
- **`generateConceptMap` 用长超时**：`chatParams: { timeoutMs: 600000, maxRetries: 1 }`（10 分钟预算；超时长调用重试无意义，只补 1 次网络层失败）。
- **前端同步**：`generateConceptMap` 的 abort 兜底 5→10 分钟（与后端一致），按钮/超时文案更新；「优化中」toast 不再承诺「30-90 秒」。
- **测试**：+8 例——timeoutMs/maxRetries 覆盖、generateConceptMap 非 JSON 模式 + 剥围栏 + prevHtml 注入、POST 生成入库 + settings 回显（不吐 html）/ 空清单 400 / AI 失败 502 不落半成品、PUT 优化不新增制品、DELETE 删除（tests/ai.test.js + 新增 tests/api-conceptmap.test.js）。

### Changed — AI 输入上限改 tokens（OpenAI 标准，v3.11）

模型上下文窗口业界以 **token** 计（gpt-4o 128K、gpt-4.1/glm-4.6 1M），原 `maxInputChars`（字符数，默认 24000 ≈ 6-8K tokens）远未用满大窗口模型。现统一改 tokens，旧字段作废弃别名保留（存量 config.json/papers.json 不破坏）。

- **单一入口 `resolveMaxInputChars(config, task)`**：返回**字符预算**（供 build*Messages 的 `.slice(0, N)` 直接用，签名/返回值不变 → 6 个 build 函数零改动）。优先级：`taskMaxInputTokens[task]` > `maxInputTokens` > （旧）`taskMaxInputChars[task]` > （旧）`maxInputChars` > `DEFAULT_MAX_INPUT_TOKENS`(32000)。tokens 命中经 `tokensToCharBudget(t) = t × 3.5`（中英混排安全估值，偏保守）折算成字符；旧 chars 命中原值直传不折算。
- **`listModels` 自动检测上下文窗口**：从上游 `/v1/models` 抓 `context_length`（OpenRouter/newapi 网关扩展字段；OpenAI 原生不返回，`extractContextLength` 兜底 `context_length`/`contextLength`/`max_input_tokens`/`top_provider.context_length` 四种写法）。前端模型切换器每项显示「模型 · 1M」徽标（`formatTokens`：128000→128K、1000000→1M）；网关不返回时回落手动填。
- **设置页**：「最大输入字符」→「最大输入（tokens）」，placeholder「如 1000000 = 1M 上下文」；各任务上限单位改 tokens。`PUT /api/settings/ai` 前端只发 `maxInputTokens`/`taskMaxInputTokens`；`aiSettingsView` 同时回显新旧两套字段（兼容）。
- **`config.example.json`**：`maxInputChars:24000` → `maxInputTokens:32000`。
- **测试**：新增 tokens 路径用例（优先级、`tokensToCharBudget` 边界、`listModels` context_length 多字段名兜底）。

### Changed — 公式清单改真正瀑布流（v3.11）

公式卡片从 CSS grid（行优先但同行卡片高度不齐留空隙）改为 **JS 绝对定位 masonry**（Pinterest 式）：顶行从左到右是排序 1..N、下行紧贴上方**无竖向空隙**。

- **`_layoutFormulaMasonry`**：保留扁平有序 DOM（排序即 document order，测试不破），逐卡测高后放进「最短列」设 `top/left/width` → 顶行严格 1..N（所有列初始高 0 取首个最短列即 round-robin），下行无空隙（每列独立堆叠，只留 12px gap）。兜底：jsdom/容器不可见/宽度测不到时跳过定位、移除 `.js-masonry`，回退 CSS grid（有空隙但可读）。
- **响应式 + 懒加载 + 符号表展开重排**：`resize` 防抖重排（1206px→3 列，726px→2 列）；每批渲染后双 rAF 跑定位；`<details>` 符号表 toggle 监听重排（**注意 toggle 事件不冒泡，必须直挂在每个 `<details>` 上**，不能靠 grid 级事件委托）。
- **移除顶栏「提示词」按钮**：统一从左下角「设置」→ 总结/标签/公式/概念提示词进入（删 `#btn-prompt` + onclick + active 态切换 + 死 CSS `#prompt-view`）。

### Fixed — 滚动到底部按钮定位 + 外部聊天缺按钮（v3.11）

- **PDF 阅读器抽屉 FAB** 原压进聊天框内（`top:-22px` 34px 按钮重叠 12px）→ 改 `bottom:100%; margin-bottom:6px` 整颗浮在输入框上方留 6px 缝。两处聊天（详情 tab + 抽屉）合并为同一套 `.scroll-bottom-btn` 基类样式。
- **外部（详情 tab）AI 聊天补上 FAB**：原按钮塞在不滚动的 `.chat-list` 里 + scroll 监听绑错容器 → 永不显示。移到 `.chat-input-shell`（position:sticky 含定位上下文），scroll 监听改绑真正的滚动容器 `.detail-pane`（`#detail` 持久元素，`dataset.chatScrollWired` 守卫一次性绑定，handler 内 `getElementById` 实时重查避免闭包 stale）。顺手修了**原本就坏的自动滚到底**（流式/进 tab/追加消息时滚 `.detail-pane` 而非不滚动的 `#chat-list`）。

### Added — 概念总览图制品（v3.10）

基于当前空间的概念清单，AI 生成**单文件 HTML 可视化全览图**（架构图/矩阵图/韦恩图形态，含视图切换按钮），每次生成保留为「制品」，可基于自定义提示词二次优化。

- **生成**：概念页「生成总览图」按钮 → 可选自定义要求 → `POST /api/concepts/map` → 后端调 `generateConceptMap`（`callChat jsonMode:false` 返回 HTML 字符串）→ 存 `settings.conceptMaps` 数组（限 50，新的在前）→ 自动 iframe 打开。
- **内置提示词 `DEFAULT_CONCEPT_MAP_PROMPT`**：融入 claude 原生可视化美学（暗色/玻璃拟态/微动画/鲜艳渐变/大胆字体/单文件/视图切换），可在设置页维护。优化已有制品时传 `prevHtml` 让 AI 在原基础上改。
- **制品 CRUD**：`GET /api/concepts/map/:id`（取完整 html）、`PUT /api/concepts/map {id, prompt}`（优化）、`DELETE /api/concepts/map/:id`。`GET /api/settings` 只回显元信息（不含 html 避免变重重）。无需 migration（settings 是 jsonb 兜底）。
- **前端**：概念页底部制品列表（名称/时间/查看/优化/新标签页/删除）。查看用 iframe `srcdoc` 全屏覆盖层；新标签页用 blob URL。

### Added — MinerU 公式抽取引擎（v3.10）

公式抽取引擎可在 **AI** 与 **MinerU** 间切换。MinerU 走自建 Docker 服务（官方 `mineru:3.4.0`，`/file_parse` 端点）解析 PDF 产出高保真 LaTeX（pdfjs 抽行间公式结构会塌掉，MinerU 补这 20%），再喂 AI 批量命名/解读。

- **混合策略**：MinerU 只给 LaTeX，不给 `canonicalName`（跨论文合并 key），故 MinerU 出 LaTeX 后再调 AI 一次批量命名（`nameFormulasViaAi`，提示词三级回退）；AI 不可用时降级为 LaTeX 哈希作 canonicalName（能入库但不跨论文合并）。
- **设置**：`settings.formulas.{engine, mineruUrl, namingPrompt}`（`applySettingsOverride` 新增 formulas 段合并）；设置页「公式抽取引擎」面板（引擎 select + MinerU 服务地址 + MinerU 命名提示词）。
- **客户端 `src/services/mineru.js`**：POST `/file_parse`（multipart `files` 字段，实测 MinerU 3.4.0 约定）→ 解析 `results.<name>.md_content` → 提取 `$$…$$`/`$…$` LaTeX → AI 命名 → 返回 items（`source:'mineru'`）。失败即失败、不偷偷回退 AI（行为可预期）。
- **dispatcher**：`extractFormulasViaEngine`（ai.js）按 `config.formulas.engine` 路由；scanner 两处公式调用（processOne + 批量）统一走它，传 `filepath`（MinerU 需要）。
- **容器访问宿主机 MinerU**：mineruUrl 必须填 `http://host.docker.internal:8000/file_parse`（`127.0.0.1` 在容器内指向容器自身）。
- **source 字段**：`SOURCES` 加 `'mineru'`（normalizeFormula 校验，否则被强制改成 ai）。

### Changed — 公式/概念抽取交互重构（v3.10）

阅读器右上角的公式/概念抽取改为**下拉菜单 + 阅读器内浮层**，支持二次打开/追加抽取/重新抽取替换。

- **rb-right 两个下拉按钮**：公式 Σ + 概念 💡，每个点击弹下拉菜单（仿空间切换器设计语言）：①查看本篇（显示已抽取数量）；②追加抽取（默认）；③重新抽取（替换本篇，仅已抽取过才显示）。
- **统一浮层 `showExtractCandidates(kind, items, opts)`**：公式行（KaTeX 渲染 + 名称/canonicalName 可编辑）、概念行（术语 + 解释 + 分类）。三模式：view（只读 + 快捷抽取按钮）、append（勾选入库）、replace（先清本篇再入库）。
- **merge `mode` 参数**：`POST /api/papers/:id/{formulas,concepts}/merge { items, mode? }`，`mode='replace'` 先 `removePaperFromFormulas`/`removePaperFromConcepts` 清本篇再 merge；默认追加。
- **概念端点补齐**：新增 `POST /api/papers/:id/concepts/candidates`（extractConcepts 返回候选不入库）+ `concepts/merge`。新增 `removePaperFromConcepts`（store.js，多论文共享的只删 paperId，仅剩本篇的整条删）。

### Changed — 概念抽取提示词升级 + category 字段（v3.10）

概念提示词从 5 行升级到对齐公式提示词质量，并新增 category 分类字段（驱动总览图分组）。

- **`DEFAULT_CONCEPT_PROMPT` 重写**：加完整 JSON schema（term/definition/category）、category 枚举（architecture/attention/loss/optimization/... 11 类）、高频概念规范名对照表（Transformer、Attention、KL Divergence 等 40+）、筛选优先级、去重说明。三级回退（settings > config > default），保留旧名 `CONCEPT_PROMPT` 别名。
- **category 字段**：`mergeConcepts` 写入（命中只补空）；migration `005-concept-category.sql`（`ALTER TABLE concepts ADD category`）；db SELECT/INSERT/映射加 category；PATCH 支持；概念卡片显示分类徽章。**修复 category 引入的 hash-diff 抖动**（`conceptToHashRow` 稳定哈希——内存对象无 category 键 vs 读回 category:'' 产生相同 hash）。
- **概念提示词设置页**：仿公式提示词全链路——设置页「概念提示词」面板 + `PUT /api/settings/concept-prompt` + reset known。

### Changed — 阅读器聊天：粘贴图片 + 模型按钮回迁（v3.10）

- **去掉框选截图**，改「粘贴图片 + 文件选择」：删 `startVisionSelect`/`cropRegionToImage`/`extractFormulaFromCrop`/`showFormulaPreview` + 后端 `POST /formulas/vision` + `ai.extractFormulaFromImage`。输入框监听 `paste` 读 clipboard 图片（系统截图后 Ctrl+V）+ 「图片」按钮弹文件选择器，都 push 进 `_chatImages`（复用 chip/视觉问答链路）。长边 1568px 压缩防 papers.json 膨胀。**保留** `/chat/vision` 图片提问通道。
- **模型按钮回迁**：从抽屉底部 `.rcd-bottom-bar` 移回 composer-right 发送按钮左侧（回滚 v3.8.1 的下移）。**模型参数按钮**也移到 composer-right（模型按钮左侧），参数浮层改底部上弹。
- **滚动到底部 FAB 修复**：按钮 DOM 移进 `.rcd-input-row`（position:relative）作为子元素，`top:-22px` 正确锚定输入框顶部（原为 drawer 直接子元素，top:-22px 锚到抽屉最顶错位）。

### Changed — 多选工具栏 + 全部状态下拉重构（v3.10）

- **多选动作收进上弹下拉菜单**：5 个动作（重新总结/重新打标/抽取概念/抽取公式）收进「批量操作」下拉（底部栏菜单上弹 `bottom:100%`），删除按钮外露。**真实百分比进度**：改为逐篇循环（concepts/formulas 传单 id 给批量端点，retag/summarize 走单篇端点），每完成 1 篇更新 `done/total`。统一 busy 门 `setBulkBusy`（CSS `.bulk-busy` 类）取代每动作 5 处手动 disabled。**网络中断兜底**：全部 5 个批量动作加 try/finally，连接断时弹「抽取中断」并自动重置 UI（修 dev server 重启导致进度条永久卡住的 bug）。
- **「全部状态」原生 select → 自定义下拉**：原生 `<select>`（选项面板系统渲染、无法定制）改为与主题/标签按钮同款 `.filter-trigger` 按钮 + `.filter-status-menu` 菜单（indigo 选中态、✓ 标记）。正确区分 `status`（ready/error/pending）与 `readStatus`（unread/reading/done）字段。

### Changed — 公式清单懒加载 + 行优先布局（v3.10）

公式清单卡顿（全量渲染 + 每张卡同步 KaTeX）+ 排序与位置脱节（CSS columns 列优先）。

- **懒加载**：`renderFormulas` 改分批渲染（首批 60，IntersectionObserver 触底追加每批 40），sentinel 显示「已加载 N/M」。grid 级事件委托（`dataset.wired` 守卫），删除/编辑改局部更新（免 `showFormulas` 重拉）。
- **行优先布局**：`.formulas-grid.masonry-view` 从 CSS `columns`（列优先，排序靠前的落左列）→ CSS `grid`（`grid-template-columns: repeat(auto-fill, minmax(340px,1fr))`，行优先，排序第 1→2→3 从左到右铺第一行）。

### Added — 公式抽取与归一化清单（v3.9）

每篇论文抽取核心公式 → 归一化到「一般形式」→ 跨论文按规范名合并 → 形成空间级公式清单，可从清单跳回论文。设计文档见 [`docs/superpowers/specs/2026-08-03-formula-extraction-design.md`](docs/superpowers/specs/2026-08-03-formula-extraction-design.md)。

**为什么需要「归一化」这一层**：同一个公式在不同论文里符号写法各异（`d_k` vs `d`、`ε` vs `e`），按 LaTeX 文本去重几乎合不上。故让模型额外输出一个 **`canonicalName`**（小写英文连字符，如 `scaled-dot-product-attention`）作为唯一合并 key——与概念清单的 `normalizeTerm` 完全同构（陷阱 4 语义）。论文各自的写法进 `occurrences[].rawLatex` + `symbolMap`，清单页展示一般形式、展开某篇能看到「这篇里 `d_k` 写作 `d`」。

- **数据模型**：store 顶层加 `formulas[]`（per-space），论文加 `formulaIds[]`。条目含 `canonicalName / name / latex / description / category / variables[] / plottable / plotHint / occurrences[] / paperIds / source`。`paperIds` 是 `occurrences` 的投影，不变式由 `mergeFormulas` 单点维护。
- **纯逻辑层 `src/core/formulas.js`**：`normalizeCanonicalName` / `normalizeLatex`（剥 `$$`、`\[...\]`、`\begin{equation}`、代码围栏，逐层剥；`aligned/cases` 保留）/ `formulaIdFor` / `normalizeFormula(s)` / `mergeFormulas` / `deleteFormula` / `removePaperFromFormulas` / `formulasToMarkdown`。`src/core/store.js` 的 `conceptIdFor` 内联 hash 抽出为共享 `stableShortHash`（**输出逐字节不变**，已加回归测试钉住已知映射——概念 id 已落库）。
- **合并三规则**：① 命中已有条目**只补空字段**，不覆盖已有 latex/description/variables（否则后来论文的粗糙解读会冲掉先前的好解读）；② 同 paperId 的 occurrence **覆盖而非追加**（重抽幂等）；③ 收尾重建 `paperIds` 并按 canonicalName 排序。
- **持久化**：migration `004-formulas.sql`（新表 `formulas` + `papers.formula_ids`）；`PAPER_COLS` 加 `formulaIds`（陷阱 22，否则掉进 extra 兜底列）；repo 的 load/hash-diff/upsert/delete 四处镜像 concepts 分支；删空间六表级联。读取边界过 `normalizeFormulas` 自愈。
- **AI 层**：`DEFAULT_FORMULA_PROMPT`（三级回退 `settings.formulaPrompt > config.formulaPrompt > 内置`，设置页可编辑）内置 **40 条高频公式规范名对照表**压住命名漂移；`extractFormulas` 走 jsonMode；`parseFormulaResult` 双路容错。
- **数学密度预筛 `pickMathDenseText`**：公式散布全篇，直接 `slice(0, budget)` 会漏掉后半篇。全文不超预算时**原样返回**；超了才按段落数学符号密度（`∑∏∫∇` + 希腊字母 + pdfjs 私有字形）择优、**保序**拼接。
- **抽取时机**：`processOne` 步骤 6（概念之后，独立 try/catch 不阻塞 ready）+ `scanner.extractFormulas(ids)` 批量重抽（串行，单参 `saveStore`）。
- **框选补录（视觉通道）**：pdfjs 抽出的**行间公式结构会塌掉**——实测 `Sharp Minima Can Generalize For Deep Nets` 的分式被拼成一行（`( L(θ′) − L(θ) ) 1 + L(θ)`）、`ε` 退化为私有字形 `\u000f`。故在阅读器 composer 加「公式」按钮：框选公式区域 → 复用已有 `cropRegionToImage` + 多模态通道 → `POST /api/papers/:id/formulas/vision` 出高保真 LaTeX → 右下角预览浮层（KaTeX 渲染 + 新建/合并提示 + 撤销）。
- **API**：`GET /api/formulas`（`?q=` / `?paper=`）、`GET /api/formulas.md`、`PATCH|DELETE /api/formulas/:id`（canonicalName 不可改：它是合并 key 且派生 id）、`POST /api/papers/formulas`、`POST /api/papers/:id/formulas/vision`。`/api/stats` 加 `formulas` 计数，列表/详情视图加 `formulaCount`/`formulaIds`。
- **前端**：新增顶栏「公式」入口 + `formulas-view`（结构镜像概念清单）。卡片 = KaTeX display 公式 + 中文名 + 规范名 + 频次徽章 + 来源标记 + 解读（走 `renderMd` 单一入口，吃陷阱 33 的 `fixCjkStrong`）+ 可折叠符号表 + 论文胶囊（tooltip 带章节与符号对照，点击跳转）。工具栏：搜索 / 排序（频次·名称·分类）/ 布局（瀑布·清单）/ 下载 Markdown，选择 `localStorage` 持久化。多选工具栏与详情信息 tab 各加抽取入口。编辑删除走 `PWDialog`。
- **测试**：`tests/formulas.test.js`（20）、`tests/scanner-formulas.test.js`（8）、`tests/api-formulas.test.js`（15）、`tests/formulas-ui.test.js`（14，jsdom 驱动真实 app.js）+ ai/db/store 补测；`tests/helpers/ui.js` 补 `CSS.escape` 全局（jsdom 不挂 globalThis，`gotoPaper` 需要）。总计 449 → 547 例。

### Added — 每任务独立输入预算（v3.9）

原先全项目共用一个 `ai.maxInputChars`（默认 24000），总结/标签/笔记/概念/聊天互相拖累——公式抽取需要的窗口比总结大一个量级。

- 新增 `settings.ai.taskMaxInputChars`（`{summary, tags, notes, concepts, formulas, chat}`，`null` = 跟随全局），`formulas` 默认 **120000**（128k 上下文模型下约 30k token，多数论文可整篇进入）。
- 新增 `resolveMaxInputChars(config, task)` 作为**单一入口**，ai.js 各 `build*Messages` 一律经它取值，不再各自解构 `config.ai.maxInputChars`。
- `applySettingsOverride` 对 `taskMaxInputChars` **深合并**（同 `discover.weights`）；`PUT /api/settings/ai` 按白名单校验（非白名单任务键忽略，`0`/空视为跟随全局）。
- 设置页 AI 段加「各任务输入上限」折叠区（6 个数字输入，placeholder 显示全局值，有覆盖时自动展开）。

### Changed — 概念清单：瀑布流 + 清单视图 + 返回按钮（v3.9.1）

- **瀑布流排版**：卡片容器从 CSS grid（横向等高对齐，长术语卡撑高同行留白）改为 **CSS multi-column 瀑布流**（`column-width:300px` + `break-inside:avoid`），卡片按内容自然不等高排布，类似小红书——消除同行上下留白；hover 时操作按钮浮于卡片右上角（绝对定位），不再撑宽标题行。窄屏自动降为单列。
- **清单视图（新增）**：工具栏新增「瀑布 / 清单」切换段（`localStorage` 持久化）。清单视图为单行紧凑布局——`频次徽章 | 术语 | 解释摘要（省略）| 论文数 | 操作`，适合快速浏览大量概念；hover 显示编辑/删除。
- **返回按钮**：从工具栏末尾的「← 返回」文字按钮改为标题左侧的圆形图标按钮（`‹` chevron），与标题垂直顶对齐、视觉更克制，工具栏也腾出空间。

### Fixed — 概念清单视图系统性修复（v3.9）

用户报告概念清单页面 UI 异常（字母索引条占满半屏高度）。实地浏览器排查（headless Edge 多宽度审计）定位到三处叠加问题：

- **字母索引条撑到 380px 高（根因）**：索引条里「无概念字母」的置灰类叫 `.empty`，与详情空态的全局规则 `.empty { margin-top:38vh }`（陷阱 928）撞类——`38vh`（≈342px@900 高视口）把 `.empty` 字母砸到行底，flex 行被撑到 364px、整条索引到 382px。改名为 `.off`（仅 `.concepts-alpha-bar a.off` 命中），并给 `.concepts-alpha-sep` 固定高度 + `align-self:center` 防 flex stretch 兜底。修复后索引条回到 40px 单行。
- **工具栏「← 返回」掉到第二行**：`.concepts-toolbar` 用 `margin-left:auto` 右对齐时，flex-basis 受 search 输入项 flex-basis 干扰被压缩，导致「下载 Markdown」/「返回」在 1440 宽也换行。改 `flex:1 1 auto; justify-content:flex-end; min-width:0`——工具栏占满剩余宽度、子元素右对齐，三个控件稳定同行；窄屏整体落到下一行（而非内部断开）。同时把「← 返回」移到标题左侧（独立按钮，与工具栏解耦）。
- **卡片标题行长术语挤压**：长英文术语（如「retrieval-augmented generation with dense passage retrieval and iterative refinement」）把频次徽章/操作按钮挤到换行错位。`.ct` 改 `align-items:flex-start`，`h3` 加 `overflow-wrap:anywhere; line-height:1.4`，徽章/操作行 `flex:0 0 auto` 不再被压缩。

### Added — 概念 → 论文反向导航（v3.9）

- **论文胶囊**：每张概念卡的「出现于」由纯文本（title tooltip）升级为可点击胶囊（`.paper-chip`）。最多平铺 3 个，其余折叠为「+N 篇」（点击就地展开，hover title 仍列全部）。胶囊点击 → 回论文库视图 + 选中该论文（`select`）+ 列表项 `scrollIntoView` 定位 + 1.2s 呼吸高亮（`.paper-item.flash`）。
- **列表项加 `data-id`**：`.paper-item`（含 ft-item）新增 `data-id`，跳转用 `CSS.escape(id)` 精确定位，与筛选/排序顺序解耦；论文被当前筛选排除时仅打开详情、不报错。

### Changed — 浏览器原生弹窗替换为自定义弹窗（v3.9）

- 新增 `public/dialog.js`（`window.PWDialog`：`confirm / prompt / alert`，Promise 化，与 Indigo 主题模态同一视觉语言，居中卡片 + 半透明遮罩 + 进出场动画，Esc/Enter 键盘分层不干扰阅读器）。替换 app.js 14 处 + reader.js 2 处 `confirm()/prompt()` 调用，配套语义化标题与危险样式（红色标题 + 红色主按钮）。新增 `tests/dialog-ui.test.js` 6 例（真实 DOM 交互）；`tests/helpers/ui.js`、`tests/chat-ui.test.js` 加桩保持向后兼容（`.eslintrc.json` 声明 `PWDialog` 全局）。

### Changed — 阅读器小交互（v3.8.1）

- **模型切换按钮下移**：PDF 聊天抽屉的模型按钮从 composer 右侧移到抽屉底部独立栏（`.rcd-bottom-bar` 全宽行），输入区不再拥挤；模型 popover 仍锚定按钮上弹。
- **取消 PDF 加载动画**：移除 `#reader-loading` spinner 遮罩，页面直接渐进渲染（元素与 `.done` 就绪信号保留，e2e 无回归）。

### Fixed — 批注（便签/手写）保存丢失全链路修复（v3.8）

用户报告「除了高亮，便签和手写在 PDF 退出后不会保存」。e2e 逐层埋点（pdf.js UIManager / PaperReader 原型 / PATCH 抓包）挖出三个叠加根因：

- **pdf.js AnnotationStorage 粘性修改标记**：`onSetModified` 只在「上次 `resetModified()` 之后的第一次修改」触发（`#Qe` 置位后不再重复触发），而 reader 从未复位——打开含既有批注的论文时，回显反序列化就会把标记置位（且被 suppress 跳过保存），之后整个会话的批注操作全部静默。修复三处：`saveAnnotations` 成功后 `resetModified()`；`restorePageAnnotations` 完成后复位；`saveAnnotations(force=true)`（关阅读器）绕过 dirty 硬门以存储为准兜底（无变化时服务端 hash-diff 零写放大）。
- **serializeAnnotations 单点故障**：`annotationStorage.serializable` 全量 getter 里任何一条编辑器序列化抛错 → 整个 getter 抛错 → 静默返回 null → 所有批注（含高亮）都无法落盘。改为 `getAll()` 逐条序列化 + 错误隔离（坏条目跳过并 `console.warn` + 状态栏提示，其余正常保存）。
- **e2e 覆盖**：新增 `tests/e2e/annotations.spec.js`——手写/便签「创建 → 退出 → 库存 → 重开回显」全链路（便签用无批注新论文隔离，避免点中已有编辑器是选中而非新建）。

### Added — 元数据回填与 arXiv 补全管线（v3.7）

- **存量回填**：`scripts/backfill-metadata.js`（dry-run 默认 / `--apply` 写库）修复迁移期遗留的元数据缺失——A. 已有 arxivId 精确查；B. 文件名 ID 提取 + 标题校验；C. 多候选标题搜索（清洗全程 / 去作者前缀块 / 英美拼写变体；整句短语 → 关键词 AND → 标题互包含验收）；D. 全文首页标题候选。只填缺失字段，`metaSource='arxiv-backfill'` 可审计。本次执行：**91 篇补回 year、14 篇补回 authors**（剩余 15 篇为书籍/演示/博客等非 arXiv 内容，确认无误判）。
- **流水线优化**：`extractArxivIdFromFilename`（util.js 新增）——enrichment 与规范改名统一改走更宽的文件名 ID 判定：除裸 ID / arxiv.org URL 外，新增标准下载命名 `[2306.02781v4] Title.pdf`、括号内 ID、老格式 `cs.AI/0701001`（月份约束 01-12 防日期误报）。这类文件从此直接 `id:` 精确查，不再掉进 ti: 猜标题必失败的坑。

### Fixed — arXiv 查询语法深坑（回填过程中实测沉淀）

- `ti:"整句"` 是**连续短语精确匹配**：长标题、含弯引号（’）时易 0 命中。
- `ti:词 AND ti:词` 中**任何停用词项会把整个查询清零**（实测 `ti:Attention AND ti:Is` → 0；`AND ti:Need` → 3）。
- `language/models/data` 等高频词作 ti: 项召回过宽或干扰排序。
- 英式拼写（behavioural）与 arXiv 美式标题互不命中。
- 对策（脚本内）：整句 → 去停用词关键词 AND → 标题互包含验收三级兜底。

### Added — AI 笔记（v3.6：聊天 → 结构化笔记卡片）

笔记从「单一 textarea」重构为**结构化卡片流**，AI 聊天成为笔记生产线：

- **数据模型**：新增 `papers.note_cards` jsonb 列（migration `003-note-cards.sql` + `PAPER_COLS`）。卡片形状 `{id,type:qa|skeleton|manual,title,body,meta,createdAt,updatedAt}`；`src/core/notes.js` 纯函数层（`normalizeNoteCards` 写入边界归一化：type 白名单/限量 200 张/单卡 5 万字符/id 撞车重发；`splitMarkdownToCards` 按 `##` 拆卡）。PATCH 白名单 + `detailView` 读取自愈。
- **聊天一键存问答卡**：assistant 消息操作条新增「存入笔记」（书签图标），自动前溯被回答的 user 问题作卡片标题（`Q: ...`）。详情 tab 与阅读器抽屉两处接入（reader 经 `window.saveQaCardToNotes` 桥，GET 取 fresh chat）。拷贝语义：删聊天不删卡。
- **笔记 tab 卡片视图**（`NotesPanel` 组件）：类型色条（qa=indigo/skeleton=amber/manual=slate）、内联编辑/复制/删除/上移下移、≥4 张章节锚点 chips（平滑滚动+flash）、编辑中切论文/切 tab 自动提交。**旧 `notes` TEXT 首开自动按 `##` 拆卡迁移**（幂等，toast 告知），此后该字段退役。
- **AI 一键生成骨架**：`POST /api/papers/:id/notes/generate`（`scanner.generateNoteCards` → `ai.generateNotes`，jsonMode:false 自由 Markdown）：六段式「🎯研究问题/💡核心贡献/🔧方法拆解/📊实验与结果/⚠️局限与开放问题/🔁可复用想法」（含「（论文未提及）」防幻觉约束），骨架卡插入笔记开头。提示词三级覆盖 `settings.notesPrompt > config.notesPrompt > DEFAULT_NOTES_PROMPT`（同 summaryPrompt 模式）。模型不按 `##` 格式输出时报 error 不落卡。
- **阅读器内笔记侧栏**：抽屉头部新增「聊天 | 笔记」segmented（`.rcd-seg`），与详情 tab 共用同一 `NotesPanel` 实现（`window.NotesPanel` 桥），`syncNotePanels` 两处实时双向同步。
- **搜索适配**：`notes:` DSL 与 `hasNotes` 同时匹配 noteCards 的 title+body（`notesHaystackText`）。

### Added — 阅读器聊天抽屉交互

- **点击 PDF 关闭抽屉**：点击 PDF 画布区域关闭未钉住的聊天气泡；豁免划词选区（正要做批注/提问）、选区浮窗、翻译面板、框选遮罩。
- **Pin 钉住按钮**：钉住后点击 PDF 不再关闭（Esc/关闭键/退出阅读器仍可关），状态持久化 `localStorage('pw-reader-chat-pin')`，钉住态高亮 + 图钉倾斜。
- **Esc 分层退出**：框选截图 → @ 引用浮层 → 笔记卡编辑 → 聊天抽屉 → 批注选中 → 阅读器，逐层退出不再一键全关。

### Fixed — 交互与渲染

- **pdf.js 抢键盘**（根因：UIManager KeyboardManager 在 window 冒泡阶段绑定 Ctrl+A/Delete/Backspace/方向键，`textInputChecker` 只豁免 `<input type=text|number>` 不豁免 textarea；有批注编辑器处于选中/编辑态时聊天输入框的这些键全被抢走并 stopEvent）→ 表现为「Ctrl+A 全选 PDF 高亮、Backspace 无法删除」。修复：抽屉冒泡阶段统一 `stopPropagation`（textarea 默认行为不受影响；我方 Esc 分层在 document capture 先行）。已沉淀为 AGENTS.md 陷阱 29。
- **标题/总结无法选中复制**（根因：10s 轮询对 summary/info tab 无条件 `renderDetail()` 全量 `innerHTML` 重建，选区被反复摧毁）。修复双防线：`updatedAt` 不变不重建 + 活动选区推迟重建。
- **重新生成后问题消失**：`doRegenerate` 曾连 user 消息一起从 DOM 移除，但流式完成只补回 assistant → 问题从视图消失直到下次全量刷新。现保留 user 消息（服务端弹整轮重推，索引自然对齐）。
- **换论文聊天历史串台**：reader 是单例但 `#reader-chat-list` 的 `dataset.loaded` 一次性标记导致只有首篇论文加载历史。`open()` 检测换论文 → `_resetChatState()` 重置抽屉（中止流式/清列表草稿 chips/重置 loaded 标记/抽屉开着则立即拉新历史）。
- **参数浮层不可见**（根因：`.chat-params-pop` 的 `bottom:calc(100%+6px)` 是相对详情 composer 上浮，阅读器里包含块是全高抽屉 → 浮层被顶到视口外）。`.rcd-params-pop` 改为头部下拉。
- **CJK 加粗不渲染**（CommonMark 侧翼规则缺陷：`**“引用”**`、`**$公式$**` 前接汉字时定界符非法，marked 原样输出 `**`）。`renderMd` 在 sanitize 后、KaTeX 前加 `fixCjkStrong` 兜底（跳过 code/pre、不跨标签/换行）。
- **`notes:.` 语义错**：原是「含字面点号」子串匹配，纯中文无点号笔记漏检 → 修为「字段非空」约定（`matchField`）。
- **空新卡草稿卡死笔记 tab**：空草稿被 flush 拒绝后保持编辑态 → renderDetail 守卫永久跳过重建。`commitOpenEditor({discardEmptyNew})` 离开即弃。
- **迁移脚本 Windows 路径**：`path.basename` 在 Linux 容器不认旧数据 `D:\...` 反斜杠 → basename 归一失败。先归一分隔符再取。
- **e2e 环境污染**：容器里 `PAPERS_ROOT=/papers` 漏进 webServer 进程会把 fixture 写进生产论文目录。`playwright.config.js` 显式钉住 `PAPERS_ROOT=<repo>/papers`。

### Added — 测试体系（271 → 449 例单元 + 2 → 7 例 e2e）

- **jsdom UI 测试层**（新基建 `tests/helpers/ui.js`）：真实 index.html + 真实 app.js + 可控假后端（fetch/EventSource stub），`bootUi()` 一行启动，轮询回调可手动触发。覆盖：
  - `tests/chat-ui.test.js`（14）：输入/发送键禁用/Enter 发送/删除（user 连带回答）/编辑回填/重新生成/存笔记/复制/清空/建议卡/@浮层/参数持久化/草稿保护。
  - `tests/notes-panel.test.js`（14）：NotesPanel 全操作 + 双面板同步。
  - `tests/regression-ui.test.js`（4）：fixCjkStrong、refresh 选区保护、Esc 分层。
- **后端补测**：`tests/sse.test.js`（8：chat/vision SSE 事件序列与参数白名单）、`tests/property.test.js`（8：幂等/垃圾输入/XSS）、`tests/claude.test.js`（10，claude.js 改 spawn 注入）、`tests/discover-internals.test.js`（16，内部件仅补导出）、`tests/backup.test.js`（6）；api/scanner/ai/db/store/util/search-query 六文件共 +72（processOne 全分支、callChatStream、searchFulltext ids 子集、未测路由批量等）。
- **e2e**：`tests/e2e/reader-chat.spec.js`（5）：真实浏览器验证 Esc 分层、pin 点击外部、pdf.js 抢键、跨论文聊天历史、笔记侧栏。
- `jsdom` 入 devDependencies；`src/core/util.js` 补导出 `parseJsonLenient`/`decodeChunked`（可测性）。

### Fixed — 中间态残留自愈（扫描器 + 一次性数据修复）

**根因**：`processOne`（scanner.js）在写完 summary+tags 后、执行到 `status='ready'`（:318）之前若进程被中断，store 会残留中间态（pending/parsing/enriching/summarizing）。重启后 `diffPapers` 只把文件变动的论文当 changed 重新入队——这些文件没变的论文就被永久跳过，status 卡在中间态：内容（总结/标签/元数据）齐全，但前端状态圆点不变绿（用户看到「标题前面没有」就绪标记）。

- **数据修复**：新增 `scripts/fix-stale-status.js`——遍历所有空间，把「有实质 summary（>30 字，过滤占位）+ 有 summaryAt + status 仍为中间态」的论文翻成 ready。默认 dry-run 只打印清单，`--apply` 才写入（走 repo hash-diff 事务）。本次修复了 Quant 空间 9 篇。
- **代码自愈**：`scanner.js` 的 `scan()` 在 enqueue 前新增中间态自愈——每次扫描时检测上述残留并翻成 ready，避免再次出现「内容已就绪但状态卡住」。空总结的不动（那才是真没处理好，需要重新入队）。
- **前端注释**：`statusDot()`（app.js）显式注释 pending/parsing/enriching/summarizing 均归 busy（琥珀色闪烁），消除「pending 不在 isBusy 判断里时圆点无样式」的疑虑。

### Changed — AI 聊天视觉打磨（v3.5，quiet refinement）
对标 ChatGPT / Claude / LobeChat 的「quiet refinement」方向——从「loud」（重阴影 + 饱和渐变 + 多个 pulse 同时跑）转向「quiet」（扁平实色 + 细线边框 + 单一柔和动效）。

**Markdown + 代码块**（最大内容质量提升）：
- `.chat-content` 补齐 chat 内 markdown 元素样式：标题层级（h1-h4，`## 章节` 带下边框线）、列表（收紧缩进 + 灰色 marker）、表格（边框 + 表头底色 + 斑马纹 + `display:block; overflow:auto` 宽表滚动不撑破气泡）、引用块（左细线 + 弱化色，Claude 风格）、链接/分隔线/图片。此前 AI 回复的表格/列表/标题用浏览器默认渲染（无边框无层级）。
- 代码块头调亮：`#1e293b → #243044`（提对比）+ `inset 0 1px 0 rgba(255,255,255,.05)` 顶部高光 hairline；语言标签 `.cb-lang` 着浅 indigo（`#a5b4fc`）区别于普通灰文。

**头像柔化**：
- 去渐变 + 去彩色发光 + 去 hover scale。user = `var(--accent)` 实色；assistant = `var(--accent-soft)` 底 + `var(--accent-strong)` 字 + 1px 边框。尺寸 32→28px，阴影 `0 1px 2px rgba(15,23,42,.08)` 极淡中性。

**流式精简**：
- 去气泡外发光环（`.chat-bubble.streaming` 的 `box-shadow` 多余信号）；流式光标从 7px 粗块 → **2px 细条**（`vertical-align:baseline`，对标 Claude/ChatGPT 纤细闪烁条），blink 振幅 `.25↔.95` 更柔。
- 思考徽章去 `chat-reasoning-pulse` 1.6s 无限循环（与光标/skeleton 同时跑会干扰），改纯色区分（流式 = accent-soft 底）+ 静态 `◷` 小图标暗示进行中。

**微交互 + 间距**：
- 消息入场 280ms → **180ms**（`translateY 6→4px`），更跟手。
- 操作按钮 `gap 1→2px`、`padding 4→5px`（hover 矩形更清爽，对标 ChatGPT ~4px 间距）。
- 建议卡去 hover lift（不再抬升+阴影），只换底色 + 箭头微移（读起来像按钮不像漂浮卡）。
- 助手气泡去 hover 加深阴影（气泡不可点，hover 加深是噪声）。
- 空状态去「渐变 tile + sparkle 装饰 + 彩色发光」（2021 AI 老套），改扁平品牌标 `var(--accent-soft)` 底。
- 发送键去渐变 + 去常驻阴影 + 去 hover scale + 去 `chat-send-pulse` 无限循环（圆→方块 morphing 本身已足够信号），改扁平实色。
- composer 去常驻阴影（仅留 1px 边框），focus 只加细 accent 环（不再 ring + 紫色阴影叠加）。
- reader FAB 去彩色发光阴影（`rgba(79,70,229,.4)` → 中性 `rgba(15,23,42,.18)`），按钮「抬起」而非「发光」。

**验证**：Playwright DOM 实测——空状态图标 `backgroundImage:none`、composer `box-shadow:none`、发送键实色无阴影、markdown 表格渲染有边框且不撑破气泡；260 单元 + 2 e2e 通过，无 JS 错误。

### Changed — 概念页面全宽 + 多列 + 信息增强（v3.4）
- **全宽布局**：`#concepts-view` 去掉 `max-width:1160px` 限制（`max-width:none`），仅留 `padding:24px 32px 40px` 留白，真正铺满视口。`#prompt-view`（表单类）保留窄布局。
- **响应式多列网格**：`.concepts-grid` 从固定 `1fr`（单列）改为 `repeat(auto-fill, minmax(320px, 1fr))`——宽屏 1440px → 4 列、1024/768px → 2 列、窄屏 1 列，95 个概念不再纵向拉超长。`align-items:start` 让卡片顶部对齐（不等高）。
- **头部增强**：标题加**统计徽章**（实时显示筛选后的概念数，搜索时同步更新）；搜索框拓宽（`flex:1; max-width:360px`，placeholder 改"搜索术语或解释…"）；新增**排序切换** seg 控件（按频次 / 按字母），用户选择持久化到 `localStorage('pw-concept-sort')`。
- **卡片增强**：每张卡加**频次徽章**（"N 篇"，出现在多篇的概念点亮 Indigo，仅 1 篇的灰显）；论文 meta 行 truncate + `title` tooltip 显示完整论文列表（hover 看全部）；编辑/删除按钮 hover 才显示（触屏常驻）。
- **字母索引条**（按字母排序 + 无搜索词时显示）：A-Z 字母索引（存在的点亮、不存在的灰），点击平滑滚动到对应字母段并高亮目标卡片；中文首字单独列（拼音排序）。让长列表快速定位。
- **排序逻辑**：按频次 = `paperIds` 数倒序（同频次按字母兜底）；按字母 = `localeCompare('zh-Hans-CN-u-co-pinyin')`（中文按拼音）。
- **空状态**：搜索无结果时显示"没有匹配「xxx」的概念"，区分无数据态。
- **验证**：Playwright 实测 1440/1024/768px 全宽无横向溢出、列数正确；排序/搜索/字母索引/编辑/删除全链路无回归（260 单元 + 2 e2e 通过）。

### Changed — 双 PG 设计统一到 compose（生产 + 测试，消除游离容器）
- **背景**：历史上 e2e/本地开发用的 PG 由手动 `docker run -p 5433:5432 ...` 启动（playwright.config.js / e2e-bootstrap.js 默认连此端口），每次开发/e2e 都要记一长串命令，且容易制造游离容器（本次清理前的 `pw-dev-pg2`、`pw-e2e-pg`）。
- **docker-compose.yml 双 PG**：`postgres`（生产，端口 25432，持久卷 `pgdata`，存真实论文，`restart: unless-stopped`）+ `postgres-test`（测试，端口 `127.0.0.1:15432`，**无持久卷**，密码 `dev`，`restart: no`）。两者用 **compose profile `test`** 隔离：默认 `docker compose up` 只起生产；测试 PG 仅 `docker compose --profile test up -d postgres-test` 时启动。
- **端口**：测试 PG 宿主端口定为 `15432`（区别于生产 `25432`，且 `15xxx` 段易于辨识为「测试/镜像」用途）。playwright.config.js / e2e-bootstrap.js 默认 DATABASE_URL 同步改为 `127.0.0.1:15432`。
- **命名**：测试 PG 从 `postgres-e2e` 改名为 `postgres-test`（与 `postgres` 同族，`-test` 后缀一眼看出是测试对应物；且不只服务 e2e，也服务本地 node 开发）。
- **设计原因**：e2e 会往 default 空间注入假 sample + 跑高亮往返；若直连生产 PG 会污染真实 156 篇。测试 PG 无持久卷，可反复重置。
- **清理**：删除游离的 `pw-dev-pg2`（含匿名卷）、`pw-e2e-pg`（无人连接、无有价值数据；生产 156 篇数据在 compose `postgres` 完好无损）。
- **文档对齐**：`docker-compose.yml` 顶部加双 PG 设计说明；`scripts/e2e-bootstrap.js` + `playwright.config.js` 注释改指向 `postgres-test`；`AGENTS.md` 工程化段改写为「双 PG 设计」+ 设计原因 + 启动方式，运行命令段更新；`CLAUDE.md` 加双 PG 要点；`README.md` 生产部署段加双 PG 说明 blockquote。
- **验证**：`docker compose --profile test up -d postgres-test` → 容器 `ai_paper_wiki-postgres-test-1` healthy；`npm run test:e2e` 2/2 通过；单元 260 pass；生产 PG 156 篇完好。

## [3.3.0] — 2026-07-18

### Changed — 项目结构分层重组（标准化布局）
- 扁平 `lib/`（14 个文件混放）→ 分层 `src/`：**core**（纯逻辑零 IO：store/util/search/search-query/annotations）/ **db**（持久化 + migrations 收编为 `src/db/migrations`）/ **services**（业务：spaces/scanner/ai/arxiv/discover/claude/parser）/ **api**（router.js）；入口 `server.js` → `src/server.js`。
- 依赖方向清晰化：core ← db/services ← api ← server（纯逻辑可独立测试，业务不反向依赖路由）。
- 根目录只保留配置与文档；日志入 `logs/`、pm2 遗留（ecosystem.config.cjs）删除、TODO/调研报告入 `docs/`。
- 全部 require/Dockerfile/CI/playwright 路径同步；261 例测试 + e2e + 容器冒烟全绿，纯结构移动零逻辑变更（git mv 保留文件历史）。

## [3.2.0] — 2026-07-18

> **搜索 DSL + 高级搜索 GUI：GitHub 式字段查询语法（title:/tag:/year:/-排除/"phrase" body:）+ 统一解析器（元数据筛选 + 正文全文检索合并）+ 高级面板双向同步 + 输入框内联补全 + 语法帮助 + 保存的搜索。** 把原来「单子串 `.includes()` + 回车全文检索二选一」升级为一套可组合、可结构化编辑的查询系统。

### Added — 搜索 DSL 解析器（lib/search-query.js，新文件）
- **GitHub 式字段前缀**：`title:` `abstract:` `summary:` `notes:` `author:` `tag:` `topic:` `year:` `status:` `read:` `star:1` `body:`。冒号无空格，值原样匹配。
- **裸词分词 AND**（修旧 bug）：`transformer attention` 旧版只能匹配连续短语；现在两词都命中（英文词边界匹配，`cat` 不命中 `category`）。`"exact phrase"` 引号精确匹配。
- **操作符**：`-field:value` / `-word`（排除 NOT）、`AND` `OR` `NOT` 大写关键字、`( )` 分组、多 `tag:` 默认 OR 可显式 `tag:a AND tag:b`。
- **year 多格式**：`2024` / `>=2020` / `<=2024` / `>2020` / `<2024` / `2020-2024`（范围）。
- **body:/in:body**：切到正文全文检索（tsvector/ILIKE），与元数据筛选组合成统一查询。
- **中文支持**：CJK 裸词整串匹配（沿用 hasCjk 语义，不做分词）。
- 解析器纯函数、零副作用、前后端共用（前端镜像 `public/search-dsl.js`）。
- **22 例单测**：tokenizer / parser / 各字段 / AND-OR-NOT / year 范围 / body: / 中文 / 词边界。

### Added — 后端统一搜索
- **`GET /api/papers?q=<DSL>`**：`q` 现在走 `parseSearchQuery` + `applyMetadataQuery`，替代旧单子串 `.includes()`。保留旧 query params（`tag=`/`topic=`/`status=`/`starred=`/`folder=`/`readStatus=`）作为 GUI 面板并行入口，与 DSL **AND 合并**。
- **`GET /api/search?q=<DSL>`**：q 含 `body:phrase` 时 phrase 作为正文词，其余字段作为元数据候选 id 子集先过滤，再在该子集做正文检索 → **「正文词 + 元数据筛选」统一查询**。向后兼容：纯文本 q 仍当正文词。
- **`GET /api/search/suggest?field=tag&prefix=mo`**（新）：返回该字段在当前空间论文里的候选值（去重 + 按使用频次倒序），供输入框内联补全。支持 tag/topic/author/title/status/read。
- **`lib/db.js searchFulltext`**：新增可选 `opts.ids` 子集参数（`AND paper_id = ANY($4)`），实现正文检索限定在元数据筛选后的候选集内。
- **`PUT /api/settings/saved-searches`**（新）：保存命名搜索预设（per-space，规整去空/限 30 条/截断）。`GET /api/settings` 回显 `savedSearches`。

### Added — 前端高级搜索 GUI
- **搜索框重构**：左侧搜索图标 + 右侧「? 帮助」「⚙ 高级」按钮 + Ctrl K 快捷键。placeholder 提示语法（`title: tag: year: body:`）。
- **统一触发**：oninput 250ms 防抖；DSL 含 `body:` → 走 `/api/search`（正文检索视图 + 高亮 snippet），否则 → `/api/papers`（元数据即时筛选）。Enter = 立即应用（不等防抖）。`body:` 模式下输入框加 Indigo 竖条提示。
- **高级搜索面板**（`#advanced-search`，折叠）：标题/作者/摘要/总结/年份(起-止)/处理状态/阅读状态/标签(chip 多选)/主题(chip 多选)/关键词/搜索范围(元数据|含正文)/仅星标/仅含笔记。**双向同步**：面板改字段 → 实时生成 DSL 填回搜索框 + 触发搜索；搜索框输入 DSL → 解析回填面板（`parseToPanel`）。底栏显示 DSL 预览 + 搜索/清空/保存按钮。
- **输入框内联补全**：检测光标前最近的 `field:` 前缀，调 `/api/search/suggest` 弹候选浮层（body 级 fixed 定位），↑↓ 导航、Enter/Tab 插入、Esc 关。`tag:`/`topic:`/`author:`/`title:`/`status:`/`read:` 都补全。
- **语法帮助 popover**（`?` 按钮）：列出全部字段前缀 + year 格式 + 操作符 + 示例（静态内容）。
- **保存的搜索**：「保存为预设」命名后存 `store.settings.savedSearches`（per-space）；搜索框下方 chip 行展示，点击即应用 DSL，× 删除。

### Changed — 文件
- `lib/search-query.js`（新）：DSL tokenizer + parser + `parseSearchQuery`/`applyMetadataQuery`/`buildDslFromPanel`/`parseToPanel`。
- `lib/api.js`：`/api/papers` 接 DSL；`/api/search` 加 DSL 解析（body + 元数据交集）；新增 `/api/search/suggest` + `PUT /api/settings/saved-searches`；`GET /api/settings` 回显 savedSearches。
- `lib/db.js`：`searchFulltext` 支持 `opts.ids` 子集。
- `public/search-dsl.js`（新）：浏览器镜像解析器（`window.PaperWikiSearch`）。
- `public/app.js`：`triggerSearch`/`updateSearchModeIndicator` 统一触发；`ensureAdvancedPanel`/`syncAdvancedPanelFromDsl`/`syncSearchBoxFromPanel` 双向同步；`openSuggest`/`handleSuggestKeydown`/`checkSuggestOnInput` 补全；`toggleSearchHelp` 帮助；`saveCurrentSearch`/`renderSavedSearches` 保存。
- `public/index.html`：搜索框加图标/帮助/高级按钮 + 高级面板 + 保存 chip 行容器；加载 search-dsl.js。
- `public/styles.css`：搜索框图标/按钮、高级面板网格、chip、补全浮层、帮助 popover、保存 chip 样式。
- `tests/search-query.test.js`（新）：22 例解析器测试。

### Fixed — 高级搜索面板破坏顶栏布局（v3.2.1）
- **根因**：`#advanced-search` 和 `#saved-searches` 原本是 `.topbar`（grid 布局）的直接子元素，但 topbar 的 grid 只定义了 5 列（品牌/空间/搜索/筛选/动作）。这俩元素即使 `hidden` 不占位，一旦打开就变成 grid 的第 6/7 列，把顶栏高度撑到 466px（正常 59px）+ 横向溢出。
- **修复**：把 `#advanced-search` / `#saved-searches` 从 `<header class="topbar">` 移到 `</header>` 之后（body 级），CSS 改 `position:fixed` 脱离 grid 流。`positionAdvancedPanel()` 用 JS 计算 top/left/width（锚定搜索框正下方，下方空间不足时翻到上方），`positionSavedSearches()` 同理（面板打开时往下让位）。打开时挂 `resize`/`scroll`（capture）监听重定位，z-index 220 在内容之上。
- **点击外部关闭**：高级面板加 `mousedown` 委托（点面板/按钮外即关闭），与帮助 popover/补全浮层一致。
- **验证**：打开前/后 topbar 高度均 59px、`overflowX:false`、`childCount:5`（恢复 5 列）；面板 `position:fixed top:53 left:228 w:432`；双向同步（填 title → DSL 回填）正常；窄屏 800px 不溢出；DSL 检索/补全/保存搜索全链路无回归。

### Tested
- 单元：`npm test` 260 例全过（+22 解析器 + settings 路由）。
- e2e：`npm run test:e2e` 2 例（reader 渲染 + 高亮往返）全过。
- 手动：DSL 各字段 / AND-OR-NOT / year 范围 / body: 正文+元数据交集 / 高级面板双向同步 / 内联补全(键盘+鼠标) / 语法帮助 / 保存搜索全链路验证无 JS 错误。

## [3.1.0] — 2026-07-18

### Added — 论文正文全文检索（tsvector）
- **入口**：顶栏搜索框**回车**进入全文检索（输入时的元数据即时筛选保持不变）；结果视图含 banner（查询词/命中数/退出）+ 每篇最多 3 条**高亮命中片段**（黄色 <mark>）+ 命中次数徽标；点击结果联动详情页；输入变化 / Esc / × 退出。
- **后端 `GET /api/search`**：英文查询走 `to_tsvector('english')` websearch 语法 + `ts_rank` 排序（词干化：mechanisms 命中 mechanism），吃 `002-fulltext-gin.optional.sql` 的表达式 GIN 索引；中文查询自动降级 ILIKE 子串匹配（按命中次数排序）。
- **`lib/search.js`**：查询分词（CJK 整串）+ snippet 提取（窗口合并、HTML 转义 + <mark>，服务端出安全 HTML）。
- migrate() 支持 `.optional.` 迁移（pg-mem 不支持 tsvector 时跳过不记账，查询侧自带 ILIKE 降级）。

## [3.0.1] — 2026-07-18

### Added — 空间名↔文件夹名联动
- **createSpace**：留空 papersDir 时默认用净化后的空间名做子目录（原为空间 id）；同名空间因目录冲突被自然拒绝。
- **renameSpace**：改名同步物理 rename 绑定目录（filepath 派生自动对齐，扫描暂停保护）；目录被占用/冲突时整体拒绝（名称也不改）；仅大小写差异（llm→LLM）视为同一目录放行（Windows/NTFS 大小写不敏感，existsSync 会误报）。
- 存量空间已执行同步：LLM / Quant / GP 三空间目录与空间名一致，0 缺失。

### Fixed
- 空间管理编辑态互斥：展开新卡片编辑时自动取消上一张（丢弃未保存改动）。

## [3.0.0] — 2026-07-18

> **生产化重构：PostgreSQL 持久化 + Docker Compose 部署 + 空间绑定语义重设计。** pm2 + per-space papers.json 退役；前端与业务逻辑不变（改动严格收口在持久化层之下）。设计文档见 `docs/superpowers/specs/2026-07-18-postgres-docker-migration-design.md`。

### Added — PostgreSQL 持久化
- **`lib/db.js`**：createDb（pg Pool + `migrations/*.sql` 编号 migration 幂等执行）+ createRepository——registry CRUD / `loadSpaceStore` 组装（migrateStore 规范化）/ `saveSpaceStore` **hash-diff 事务只写变化行**（scanner 单篇处理每次事务 1-2 行）/ `paper_texts` 全文存取（NUL 字节剥离，PG TEXT 拒收 0x00）。
- **Schema**：`spaces`（meta + tags/topics/settings JSONB）、`papers`（PK=(space_id,id)，标量列 + JSONB 列 + **extra 兜底列**防未知字段丢失）、`paper_texts`（独立表，为未来 tsvector/pgvector 预留）、`concepts`、`folders`、`app_state`。
- **`scripts/migrate-json-to-pg.js`**：旧 `data/`（多空间 spaces.json 或更老扁平 papers.json）+ `text/*.txt` 全量迁 PG，幂等可重跑；papersDir 映射为挂载根内 `<spaceId>` 子目录并打印文件搬移指引。
- 单测栈新增 **pg-mem**：db/spaces/scanner/api 测试全部内存 PG，`npm test`（226 例）无需真实数据库。

### Added — Docker Compose 部署
- `Dockerfile`（node:20-slim / npm ci --omit=dev / USER node）+ `docker-compose.yml`（app + postgres:16-alpine、双 healthcheck、`restart: unless-stopped`、仅绑 127.0.0.1、PG 不对宿主暴露）+ `.env.example`（PAPERS_ROOT / POSTGRES_PASSWORD / APP_PORT）。
- **备份双保险**：每日各空间 store 从 PG 导出 JSON 快照到 backups volume（`backupStoreObject`，格式兼容旧 papers.json，是 PG→JSON 逃生通道）；`scripts/backup-pg.sh` 供宿主 pg_dump 定时任务。
- server.js：PG 不可用启动 **fail-fast**（Docker restart 负责重试）；`PAPERS_ROOT`/`BACKUP_DIR`/`DATABASE_URL` 环境变量化。
- `config.example.json`：`discover.queryEngine` 默认 `gateway`（容器内无 claude CLI，跳过必败 spawn 直走 GLM 网关兜底）。
- CI 从两 job 扩到三 job：lint-and-unit / **pg-smoke**（postgres service + 启动冒烟 CRUD）/ e2e（postgres service）。

### Changed — 空间绑定语义重设计（修复「改路径后文件与数据不同步」）
- **根因修复：filepath 改为运行时派生**——PG 只存 `filename`（相对空间目录），`getSpaceStore` load 时由 papersDir+filename 合成 `filepath`，不落库不参与 diff。改绑后 store 重载即全库路径一致。
- **改绑从「改字符串」变为三步语义**：`POST /api/spaces/:id/dir/preview` 预检（按内容 sha1 对账：匹配数/将缺失清单/新文件数）→ 用户明确选择 `move`（物理搬移库内 PDF，撞名加 `(id)` 后缀，单篇失败记 errors 不中断）或 `rebind`（文件已在新位置，对账更新 filename、复活 missing/标缺失）→ 执行期间 scanner stop+drain 暂停、完成后失效子扫描器缓存 + 触发补扫。
- **目录冲突校验**：papersDir 必须在挂载根内（越界拒绝）；不得与其他空间目录相同或互相嵌套（防双扫描器 rename 竞争）。default 空间改绑 `default` 子目录（不再绑根本身）。
- **前端三步向导**：空间管理编辑态的文件夹字段改只读展示 + 「更改文件夹…」按钮 → 路径输入 → 预检报告卡（含缺失清单前 10 条 + 双模式单选卡）→ 结果页。
- **扫描 missing 熔断**：单轮 scan 缺失 >5 篇且 >50% 判定挂载失效（Docker bind mount 掉了/目录清空），本轮不翻转状态，仅告警 + `/api/health` `missingFuse` 暴露；`changed` 分支同步 filename/filepath（rebind 自愈路径）。

### Removed
- pm2 部署路径（`ecosystem.config.cjs` 保留仅作历史参考）；`data/` 运行时目录（旧 JSON 只作迁移数据源保留）；`store.js` 的文件持久化降级为迁移脚本专用。

## [2.7.0] — 2026-07-17

> **AI 聊天界面现代化重构（对标 ChatGPT / Claude / LobeChat）：气泡式消息布局 / 一体化 Composer（morphing 发送键）/ 模型切换器 / PDF 图表视觉问答。** 两个聊天入口（详情页「AI 聊天」tab + PDF 阅读器 AI 抽屉）再次统一升级，共用同一套现代设计语言。

### Added — 现代气泡布局（Phase 1）
- **气泡式消息**：user 右对齐（accent-soft 气泡）/ assistant 左对齐（白底卡片气泡 + Indigo 渐变圆形头像）。告别旧版"扁平全宽行"，转向 ChatGPT/Claude 式视觉层级。`.chat-msg` flex + `row-reverse` + `.chat-bubble` 圆角卡片。
- **消息 meta 行**：时间戳 + **模型徽章**（`assistant.model`，胶囊样式带小圆点），气泡下方内联显示。
- **流式 skeleton shimmer**：流式占位从"思考中…"文字 + 三点动画，升级为 3 行灰条 shimmer（`@keyframes chat-shimmer`），首 token 后切换为发光气泡 + 末尾光标。
- **气泡外发光**：流式时 `.chat-bubble.streaming` 用 `box-shadow` 微光替代旧竖线光标。
- **内联操作工具条**：消息操作从右上浮窗改为**气泡底部内联**（hover 显示），与 ChatGPT 同款。
- **现代空状态**：大渐变圆图标 + 标题"开始与 AI 探讨这篇论文" + 副标题 + 2×2 建议卡片网格 + 快捷键提示（`@` 引用）。

### Added — 一体化 Composer（Phase 1）
- **单一圆角容器 `.chat-composer`**：上下文 chips 行 → textarea（无边框）→ 底部工具栏，取代旧的"chips+textarea+预置行+footer"散件。
- **morphing 发送键**：发送/停止合并为**单一圆形按钮**，非 busy 时 Indigo 渐变 + 上箭头，流式时变红方块停止图标（`@keyframes chat-send-pulse` 脉冲）。
- **底部工具栏**：左 = 快捷提问（折叠浮层）/ 模型参数 / 大纲 / 清空；右 = 模型切换 + 发送。
- **模型参数徽章通用化**：`.cp-badge` 选择器从 `.chat-params-btn` 扩展到 `.chat-tool-btn`，新版 composer 复用。

### Added — @ 引用论文选择浮层现代化（v2.7）
- **输入即筛 + 上方弹出清单**：textarea 打 `@` → 上方弹出 `.chat-mention-pop.fixed` 浮层（body 级 `position:fixed`，锚定到 textarea 上方，避开所有滚动容器），随输入**实时筛选**。
- **多字段 + token AND 匹配**（`searchPapersForMention`）：标题（最高分）/ 作者 / 年份 / 标签 / 主题；多词查询要求每个 token 都命中（更精准）。空 `@` 显示最近添加的 10 篇（`addedAt` 倒序），让用户开 @ 就有候选。
- **键盘导航**：↑↓ 移动高亮 / Enter 选中 / Esc 取消（共享 `handleMentionKeydown`），鼠标 hover 也能切高亮。
- **富信息列表项**：状态点（ready/error/busy/missing 配色）+ 标题（匹配 token `<mark>` 高亮）+ 作者·年份 meta + 标签 chip；底栏显示总数 + 筛选提示。
- **两处聊天共用单例**：`openChatMentionPicker`/`closeChatMentionPicker`/`handleMentionKeydown` 经 `window.*` 桥给 reader.js，避免重复实现。
- **关键 bug 修复**：`confirmMention` 先捕获 `onPick` 回调到本地变量再 `dispatchEvent('input')`——后者会触发 `handleMentionTrigger → closeChatMentionPicker()` 把 `_mentionCtx` 置 null，旧顺序导致选了论文但 chip 不出现。

### Added — 模型切换器（Phase 2）
- **`GET /api/ai/models`**（lib/api.js + ai.js `listModels`）：优先调上游 `/v1/models`（带 apiKey），失败回退 `config.ai.model` + `config.ai.extraModels`。**永不抛错**——上游不可达返回静态候选，前端切换器总能渲染。
- **`config.ai.extraModels`**（config.example.json）：静态模型候选列表（如 `["gpt-4o", "glm-4.5v", "claude-sonnet-4"]`），避免依赖上游 `/v1/models` 可用性。`applySettingsOverride` 支持数组覆盖。
- **`?model=` 透传 + 白名单**：chat GET/POST 路由收 `?model=`，必须属于可用模型集合（`config.ai.model` + `extraModels` + 上游 `/v1/models`），校验失败静默回退默认（防注入）。
- **前端模型下拉**：composer 工具栏 `.chat-model-btn` 点开 `.chat-model-pop` 浮层（body 级，JS 定位到按钮上方），列出所有可用模型，选中后写 `localStorage('pw-chat-model')` 持久化（跨刷新/跨空间保留），随请求透传。
- **reader 抽屉同步**：头部 `.rcd-model-pill` 徽章 + composer 模型按钮，复用 `window.toggleModelSwitcher`。
- **`assistant.model` 持久化**：scanner 在有显式覆盖时把所用模型记入 assistant 消息，meta 行回显。

### Added — PDF 图表视觉问答（Phase 3）
- **多模态消息**（ai.js `callChat`/`callChatStream`/`chatPaper`）：`messages[i].content` 支持数组（OpenAI 格式 `[{type:'text'},{type:'image_url'}]`）原样透传；`chatPaper` 接受 `images` 选项把附图追加到末尾 user 消息。
- **`POST /api/papers/:id/chat/vision`**（lib/api.js）：带图片 body 的流式端点（EventSource 无法带 body），SSE 协议与 GET /chat 一致（token/done/fail）。图片白名单：`data:image/*;base64,` 前缀，限 4 张。
- **框选提问工具**（reader.js `wireAttachButton` + `startVisionSelect`）：composer「图表」按钮进入框选模式，在 canvas-wrap 上叠加半透明遮罩 + 拖拽矩形选区，松开后从对应 `page.canvas` 截取该区域为 PNG dataURL（CSS→canvas 内部像素按 dpr 换算，长边限 1568px）。
- **附图 chip + 回显**：截图作为可移除 chip 塞进 composer context 行；发送后 user 消息气泡内回显缩略图（`m.images` 持久化，限 4 张）。
- **视觉流式 `streamVisionFetch`**（reader.js）：fetch + ReadableStream 手动解析 SSE（按 `\n\n` 分块），AbortController 中止；模型不支持图片（4xx）时 toast 提示切换视觉模型。

### Fixed — 测试基建
- **e2e-bootstrap 多空间适配**（scripts/e2e-bootstrap.js）：v2.5 多空间后 app 从 `data/spaces/<active>/papers.json` 读，但 bootstrap 只写 legacy `data/papers.json` → 已初始化多空间的本地环境 e2e 找不到 Sample Paper。新增 step 3b 把 sample 记录 + PDF 同步写入 active 空间 store，幂等。

### Fixed — 问答大纲浮窗两大 bug
- **大纲按钮点不开**（根因）：浮窗原 `position:absolute` 挂 `.chat-tab`（随消息撑高 + 随 detail-pane 滚），消息多/滚到底时浮窗定位到 `top:-2984px` 完全不可见。改 `position:fixed` 挂 body、锚定视口右上（顶栏下 `top:60 right:16`），**不随任何滚动容器移动**。
- **toggle 逻辑误开**：`toggleChatOutline(false)`（切论文时关闭用）因原 `shouldClose = existing && open===false` 逻辑——existing 为 false 时 `open===false` 反而走「开」分支 → 切论文瞬间误开浮窗。重构为三态语义：`open===false` 无条件关、`open===true` 无条件开、`open==null` 才 toggle。详情 tab + reader 抽屉两处同修。
- **切论文时关浮窗**：renderChatTab 切论文归零 chatState 时调 `toggleChatOutline(false)`，避免大纲条目指向已失效的旧论文 chat。

### Changed — 文件
- `public/styles.css`：重写 AI 聊天样式段（气泡/composer/空状态/思考徽章/模型下拉/框选遮罩）。
- `public/app.js`：`chatMsgHtml`/`chatEmptyHtml`/`renderChatTab`/`doSend`/`setBusyUI` 重构；新增 `loadAiModels`/`getSelectedModel`/`toggleModelSwitcher`；`streamChatFetch` 透传 model。
- `public/reader.js`：composer 重构 + morphing 键 + `wireModelSwitcher`/`wireAttachButton`/`startVisionSelect`/`cropRegionToImage`/`streamVisionFetch`。
- `public/index.html`：reader 抽屉头部加模型徽章 + composer 改新结构（含图表按钮/模型按钮）。
- `lib/ai.js`：`callChat`/`callChatStream` 支持 `chatParams.model` + 多模态 content；新增 `listModels`；`applySettingsOverride` 加 `extraModels` 数组覆盖。
- `lib/api.js`：新增 `GET /api/ai/models` + `POST /api/papers/:id/chat/vision`；chat 路由加 `?model=` 白名单。
- `lib/scanner.js`：`chatPaper` 透传 `images` + 持久化 `assistant.model` / `user.images`。
- `config.example.json`：`ai.extraModels` 示例。
- `tests/ai.test.js`：+7 例（模型覆盖 / 多模态 / extraModels / listModels 上游+回退）。

### Tested
- 单元：`npm test` 207 例全过（200 + 7 新增）。
- e2e：`npm run test:e2e` 2 例（reader 渲染 + 高亮往返）全过。
- 手动：详情聊天 + reader 抽屉两处气泡/composer/流式 skeleton/思考徽章/@引用/模型切换（8 模型 + 持久化）全链路验证无 JS 错误。

## [2.6.0] — 2026-07-15

> **AI 聊天大幅升级（参照 NewAPI 新版 Playground）：代码块强化 / 消息操作工具栏 / Reasoning 自动折叠+时长 / 参数浮层+开关徽章 / 独立停止键 / 预置快捷提问 / @ 引用多论文联合问答。** 两个聊天入口（详情页「AI 聊天」tab + PDF 阅读器 AI 抽屉）统一升级，共用同一套渲染/交互组件（沿用 `window.*` 桥）。

### Added — 聊天输入区（NewAPI 风格外壳）
- **@ 引用论文（多论文联合问答）**：输入框内打 `@` 弹论文选择器（基于 `state.papers` 客户端匹配 title/authors/year），选中后以可移除 chip 加入上下文；发送时把引用论文 id 经 `?extraIds=` 透传，后端读每篇全文注入独立 context 块（单篇摘要≤1500 / 全文≤6000，合计预算 `maxInputChars*0.6`），提示模型跨论文对比印证。引用 chip 在 user 消息回显（只读，`user.extraIds` 持久化）。
- **预置快捷提问按钮**：输入框上方一排 pill 按钮（核心方法 / 创新点 / 实验结果 / 一句话总结），点击填入并发送。`store.settings.chatPresets` 可自定义（`PUT /api/settings/chat-presets`，规整去空/截断/限 20 条）；内置默认 4 条，`GET /api/settings` 回显。
- **参数浮层 + 开关徽章**：模型参数（思考强度 / 温度 / Top-P / 最大 token）从 `<details>` 网格改为浮层按钮（滑块图标），每参数独立**启用开关**（仅启用的随请求发送），按钮上显示已启用数量的**小圆徽章**。localStorage 存储结构升级为 `{key:{enabled,val}}`（向后兼容旧扁平结构）。
- **独立停止按钮**：流式生成时发送键旁出现独立红色「停止」按钮（不再复用发送键变红），更符合 NewAPI/ChatGPT 习惯。

### Added — 消息渲染与操作
- **代码块强化**：Markdown 代码块升级为卡片（语言标签 + 独立复制按钮 + 超长折叠 >20 行 + 点击展开）。`renderChatMd(md,{final})` 在 `renderMd` 之上做 DOMParser 后处理；流式中 `final=false` 不折叠（避免半截 fence 抖动），完成时 `final=true` 应用折叠。
- **消息操作工具栏（hover/触屏常驻）**：assistant = 复制 / 重新生成（末条）/ **显示原文切换** / 删除；user = **编辑并重发** / 删除。编辑 user 消息截断其后历史重新回答（NewAPI edit-and-resubmit 语义）；显示原文在渲染 Markdown ⇄ 原始文本间切换。
- **Reasoning 自动折叠 + 时长**：思考过程流式时展开 + shimmer 微光，完成后**自动收起并显示「思考了 X 秒」**（`chatState.reasoningStart` 计时），比旧常驻 `<details>` 更优雅。

### Changed — 后端多论文上下文（协议兼容）
- `buildChatMessages`（lib/ai.js）新增可选 `extraPapers`，按 budget 拼独立 context 块 + 跨论文提示。
- `chatPaper`（lib/scanner.js）新增 `opts.extraIds`，读每篇额外论文全文，`user.extraIds` 持久化；regenerate 回退取末尾 user 的 extraIds 保持引用一致。
- chat 路由（lib/api.js）GET/POST 收 `extraIds`（query 逗号分隔 / body 数组），白名单校验（必须存在于 store）；SSE 协议（token/done/fail）不变。
- 新增 `PUT /api/settings/chat-presets` + `GET /api/settings` 回显 `chatPresets`。

## [2.4.0] — 2026-06-23

> **设置中心（全配置接管 + 概览仪表盘 + 状态增强）+ 总结/标签提示词解耦。**
> 左下角「⚙️ 设置」改为分组导航（概览 / AI 接口 / 总结·标签主题提示词 / 文件扫描 / arXiv 元数据 / 主题发现 / 主题与标签 / 系统信息）：把 config.json 的扫描间隔、arxiv、discover 全部纳入界面并运行时热生效，每项标注「生效值 / config 默认 / 是否已覆盖」、可一键恢复默认；新增概览仪表盘与设置内搜索。另修复自定义总结提示词导致空总结+空标签的根因——总结与标签/主题拆成两次独立 AI 调用。

### Added — 设置中心（左下角入口，全屏视图 + 分组导航 + 设置内搜索）
- **分组导航 + 概览仪表盘 + 设置内搜索**：左侧导航分组（总览 / 智能 / 采集 / 数据与系统）。「概览」首页用 metric 卡展示当前生效配置（模型 / 端点 / 扫描间隔 / arXiv 开关 / 发现来源 / 论文数 / 版本 / 服务状态），并汇总「N 项已覆盖 config.json」+ 一键全部恢复默认；顶部搜索框按关键词过滤设置项。
- **全配置接管（运行时热生效，无需重启 pm2）**：把 config.json 的可调项全部纳入界面，保存即写 `store.settings` 并经 `applySettingsOverride` 覆盖——
  - **AI 接口**：API Base / Key（密码框 + 掩码回显，提交掩码不误清空）/ 模型 / 最大输入字符 / 超时；「测试连接」发 ping 校验连通性。
  - **文件扫描**：`scanIntervalMinutes`，保存后即时重置定时器（`scanner.reschedule`），设 0 关闭定时扫描。
  - **arXiv 元数据**：`enabled`（开关）/ `titleSimilarityThreshold` / `minIntervalMs`。
  - **主题发现**：`maxResults` / `perAxis` / `recencyWindowYears` / `titleSimThreshold` / `semanticScholar` / `openAlex` / `semanticScholarApiKey`（掩码）/ 复合排序权重 `weights{rel,auth,rec}`。
- **逐项状态增强**：每个可编辑项展示「生效值」+「config.json 默认值」提示 +「已覆盖 config」徽标（仅当被 `store.settings` 覆盖时显示），支持按段「恢复默认」（清除该段运行时覆盖回到 config）。
- **提示词分离管理**：总结提示词 / 标签主题提示词两个独立面板，各自「恢复默认 / 保存 / 查看内置默认」（总结输出 Markdown、标签主题输出 JSON，互不冲突）。
- **主题与标签管理（精细化重构）**：分段单栏（标签 / 主题切换）取代旧双栏；每行＝哈希色点 + 名称 + **使用量占比条** + 计数 + 悬停浮现的「重命名 / 合并 / 删除」线性图标。支持**搜索**、**排序**（使用量 / 名称 / 最少使用）、**点名称就地重命名**（↵ 提交、Esc 取消，干掉 `prompt()`）、**合并到已有项**（下拉选目标）、**行内删除确认**（不弹系统对话框）、**多选批量合并 / 删除**、低频项（≤2 篇）高亮便于收敛、**点计数跳回主列表按该项筛选**。全部复用既有 `PATCH /api/tags|topics`（`{merge,into}` / `{delete}`）。
- **系统信息**：服务级只读项（host / port / papersDir / 版本 / 论文数 / 运行时长）+ 可折叠「原始 config.json（密钥脱敏，只读）」。
- **去 emoji，统一线性图标**：设置中心 9 个导航项与左下角「设置」入口由 emoji 改为与阅读器工具栏一致的细线 SVG 图标；「设置」入口重做为贴合平台的描边按钮。
- **全站去 emoji（第二轮）**：侧栏「全部论文 / 星标 / 未读」、批量「抽取并追加概念」、空态「📚」、空引导卡、顶栏「提示词」入口与列表紧凑进度，统一由彩色 emoji 换成线性 SVG；保留 `✓ ✗ ☑` 等单色文字符号。
- **星级评分（1–5，全栈）**：`starred` 布尔升级为 `rating` 0–5（`starred` 保留为 `rating>0` 的镜像，向后兼容）。`normalizePaper` 迁移（`starred:true→5`、缺省→0、clamp 0–5）；`PATCH /api/papers/:id {rating}` 写入并镜像；`summaryView`/`detailView` 回传 rating；新增 `ratingDesc` 排序。前端详情用 5 颗线性星控件（点击设分、再点同一颗清零、hover 预览、键盘 ← → / 0 / Enter-Space）；列表标题尾角标「★ N」；排序下拉增「评分最高」；`S` 键无评分↔5 星来回切。
- **概览仪表盘升级**：metric 卡加细线图标 + 悬停描边；前 5 张可点击/回车直达对应设置页（AI / 扫描 / arXiv / 发现）；「服务状态」改为绿色脉冲实时点。
- **主题发现表单精修**：参数分主次——主区为「最大结果数 / 每轴召回 / 复合排序权重」，新近窗口·去重阈值·数据源·API Key 收进可折叠「高级」分区（`<details>`）。权重三联增「实时占比条」（三色堆叠）+ 偏离 1 的提示 + 一键「归一化为 1」按钮（按比例缩放三者之和为 1）。

### Fixed — 自定义总结提示词导致空总结+空标签（根因修复）
- **根因**：`lib/ai.js` 的 `callChat` 把 `response_format:{type:'json_object'}` 写死，与用户自定义的 Markdown 总结提示词（要求输出 `## 章节` / LaTeX）直接冲突 → 模型被强制走 JSON 模式却要写 Markdown → 返回空 `{}` → 触发空总结守卫 → summary 存占位 + tags/topics 全空。
- **修复**：拆成**两次独立调用**——`summarize`（`jsonMode:false`，自由 Markdown，用你的自定义提示词）+ `extractTagsTopics`（`jsonMode:true`，强制 JSON `{tags,topics,metadata}`，用内置或自定义的标签提示词）。两次各自 try/catch：总结失败不阻塞标签，标签失败不回滚总结，任一成功即 `ready`。
- **拆分**：`DEFAULT_PROMPT` 拆为 `DEFAULT_SUMMARY_PROMPT`（Markdown）+ `DEFAULT_TAGS_PROMPT`（JSON）；`summarize` 返回字符串而非 JSON 对象；`buildSummaryMarkdown` 入参改为字符串。

### Changed
- **配置覆盖链路（泛化）**：`applySettingsOverride(config, store.settings)` 从只覆盖 `ai` 扩展为同时覆盖 `scanIntervalMinutes / arxiv / discover`（`weights` 深合并），新增段用「`!== undefined` 即覆盖」规则正确处理布尔 `false` 与数值 `0`（如间隔设 0 关闭扫描）。scanner 的 arxiv 补全改读 effectiveConfig（原读死 `config`，覆盖不生效）；scanner 新增 `reschedule(minutes)` 供扫描间隔热改；discover 网关规划同样走 effectiveConfig。
- **提示词优先级**（各自独立三级）：总结 = `store.settings.summaryPrompt > config.summaryPrompt > DEFAULT_SUMMARY_PROMPT`；标签/主题 = `store.settings.tagsPrompt > config.tagsPrompt > DEFAULT_TAGS_PROMPT`。
- 顶栏「提示词」按钮改为快捷入口，跳转到设置中心·总结提示词 tab（原独立 prompt-view 已迁移进设置中心并删除）；左下角「设置」入口默认进「概览」。
- `GET /api/settings` 进一步扩展返回各采集段「生效值 + config 原值」（`scan/configScan`、`arxiv/configArxiv`、`discover/configDiscover`）、`overrides`（哪些字段被 `store.settings` 覆盖，驱动徽标）、`system`（host/port/papersDir/版本/论文数/脱敏 `rawConfig`）；保留旧字段（`summaryPrompt/configPrompt/defaultPrompt/tagsPrompt/defaultTagsPrompt/ai/configAi`）向后兼容。新增 `PUT /api/settings/{scan,arxiv,discover}` 与 `POST /api/settings/reset`（按段 `{section}` / 全部 `{all:true}` 恢复默认）。

### Tests
- 由 119 例增至 **142 例**：新增 `extractTagsTopics` / `parseTagsResult` / `applySettingsOverride`（ai 覆盖/空串/无 settings + scan/arxiv/discover 合并：布尔 `false`、数值 `0`、`weights` 深合并、未设透传、密钥空串）/ `summarize` 返回字符串 + `jsonMode:false` 校验 / `callChat` 双模式 / scanner 两次调用 mock + `reschedule` 热改间隔 + arxiv 读 effConfig；API 新增 `GET /api/settings` 全段字段（采集段 + overrides + system）、`PUT /api/settings/{ai,scan,arxiv,discover}`（白名单 / 掩码 / 空串清空 / 未传保留）、`POST /api/settings/reset`（按段 + 全部）、`PATCH /api/topics`（重命名/删除）。e2e（reader 渲染 + 高亮往返）保持全绿。

---


## [2.3.0] — 2026-06-22

> **按主题发现论文（Discover）+ 规范命名 + 删除功能 + 元数据/空总结修复。**
> 首页输入主题即自动发现「最新 + 最权威 + 引用量高 + 与现有库不重复」的 arXiv 论文（LLM 生成检索式 → 多轴召回 → 引用量复合排序 → SSE 流式进度）；导入按「作者 等 - 年份 - 标题」命名并预填元数据；新增删除论文（连同本地文件）。

### Added — 按主题发现论文（Discover）
- **入口**：顶栏「发现」→ 输入研究主题/名词（中英文 / 缩写均可）。
- **查询理解三级兜底**：`claude -p`（新增 `lib/claude.js`，spawn 子进程 + `--output-format json`，永不抛错）→ **GLM 网关**（复用 `config.ai` 那套总结接口）→ 原始主题。产出**结构化检索计划**（多 query + arXiv 分类 + 英文关键词），而非单条查询。claude 在无头/pm2 环境常因鉴权 401，网关兜底保证检索质量不退化。
- **多轴召回**：每条检索式分别按 `relevance`（捞经典 / 高被引）与 `submittedDate`（捞最新）两轴查 arXiv，合并去重成候选池——权威与最新论文都能进池（取代旧实现「只取最新 N 篇再按引用量排」的自相矛盾）。`lib/arxiv.js` 新增 `searchArxivMulti`，`searchArxiv` 支持 `maxResults/sortBy/sortOrder/start`（默认值保持旧行为，防回归）。
- **引用量**：Semantic Scholar 批量（支持 `semanticScholarApiKey` + 429 指数退避重试）+ **OpenAlex 按 arXiv DOI 兜底**；回传 `citationsAvailable` 让前端在限流时如实提示。
- **复合排序**：`score = 相关度×0.45 + 权威(log10 引用量)×0.35 + 新近×0.20`（`config.discover.weights` 可调），取代单一引用量排序，直接落地「最新 + 最权威 + 相关」的融合。
- **去重**：剔除库内同 arxivId 或标题高度相似（Jaccard ≥ 阈值）的论文。
- **SSE 流式进度**：`GET /api/discover/stream?topic=` 逐阶段推送（理解主题 → 检索 arXiv[相关/最新各 N 篇] → 引用量[S2/OpenAlex] → 去重排序 → 完成 N 篇）；前端 5 步进度面板实时刷新，结果卡片展示引用量 / 重要引用 + 相关度点条 + 排名。保留 `POST /api/discover` 非流式兜底（脚本/降级用）。
- **批量导入**：勾选候选 → 逐个 `POST /api/import`（并发 3），复用既有下载 + 入库流水线。
- 新增 `lib/discover.js`（`buildDiscoveryQuery` / `planViaGateway` / `enrichWithCitations` / `enrichWithOpenAlex` / `computeRelevance` / `discoverPapers`）+ `lib/claude.js`；`config.discover` 配置块。+测试（36 例）。

### Added — 规范文件名 + 删除论文
- **导入命名「作者 等 - 年份 - 标题.pdf」**：`util.buildPaperFilename` / `safeFilename`（对齐库内 Zotero 风格命名，净化文件系统非法字符 `< > : " / \ | ? *` 与控制字符，标题侧截断使总长 ≤ 180）。`POST /api/import` 接收发现候选的 `meta`（标题/作者/年份/摘要/分类），下载即规范命名并**预填元数据**（`metaSource=arxiv`），使总结直接基于真实标题摘要。
- **删除论文**：`DELETE /api/papers/:id` 删除条目 + 本地 PDF（仅限 `papersDir` 内，防越界）+ 全文文本，并清理概念清单里的论文引用；前端详情头新增「删除」按钮（二次确认，删后回列表）。空论文或有文件的论文均可删。

### Fixed
- **发现 / 裸 ID 导入论文标题·标签·总结全空（根因）**：裸 arXiv ID 命名（`2012.12556.pdf`）经 `scan()` 入库时，`cleanFilenameToTitle` 会把 `2012` 当孤立年份删掉 → `ti:` 标题搜索必失败 → 拿不到 arXiv 元数据 → 空标题。`scanner.processOne` 现在 arxivId 为空时先用 `parseArxivUrl(文件名)` 识别裸 ID 走 `id:` 精确查，并从 arXiv `published` 补年份，再把裸 ID 文件**改名为规范名**（id 基于内容 sha1，改名不影响全文 / 概念 / 批注）。存量空论文点「重新总结」即可自愈。
- **空总结被当作成功**：模型偶发返回空对象（批量 / 超时 / 限流时）时，旧逻辑会写出误导性的空「## TL;DR」并标 `ready`，用户无从察觉。现在判定「无内容」（无 tldr / 贡献 / 方法）→ 不当成功，存可重试占位并清空 `summaryAt`，便于「重新总结」识别重跑。
- **claude `--output-format json` 解析**：新版 CLI（2.1.x）输出的是消息数组 `[{type:'system'},…,{type:'result',result,is_error}]` 而非旧的 `{result}` 单对象；`parseClaudeOutput` 兼容数组并对 `is_error`（如 401）判为失败 → 走网关兜底。

### Tests
- 由 ~70 例增至 **119 例**：discover 全链路（多轴召回 / 复合排序 / 网关兜底 / OpenAlex 兜底 / 数组解析 / 进度回调 / 引用量可用性）、命名 helper（safeFilename / buildPaperFilename / 缺字段回退 / 长标题截断）、裸 ID 识别 + 改名 + 空总结守卫、`/api/import` 带 meta 命名预填、`DELETE /api/papers/:id`。

---

## [2.2.0] — 2026-06-21

> **PDF 阅读器重构（路线 B）+ 批注系统 + Indigo 配色 + 工程化基础。**
> 从自研裸渲染迁移到 pdf.js 官方 PDFViewer，新增高亮/便签/手写批注（保存+回显），配色由绿改 Indigo，补齐 CI/测试/lint/health/备份等工程化基建。

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

### Added — 工程化与运维基础
- **CI（GitHub Actions）**：`.github/workflows/ci.yml` 两个 job——lint-and-unit（eslint + prettier check + `npm test`）、e2e（Playwright，spawn server.js + fixture PDF）。push/PR 自动触发。
- **Prettier + ESLint**：`.prettierrc`（2 空格/单引号/分号/120 行宽，贴合现有后端风格）+ `.eslintrc.json`（`eslint:recommended` + `prettier`，`eqeqeq` 配 `null:ignore` 容纳 `== null` 惯用法，`no-var`/`prefer-const`）。前端 `public/` 排除格式化（无分号 + 手工对齐模板串）。新增 `npm run lint`/`format`/`format:check`/`test:e2e`。
- **health 端点**：`GET /api/health` 返回 `{status, uptime, papers}`，供 pm2/反向代理探活。+测试。
- **错误响应脱敏**：生产模式（`NODE_ENV=production`）顶层 catch 与下载失败不再回传 `e.message`（防泄露路径/栈信息），改回通用错误。
- **每日备份**：`backupStore` 把 `papers.json` 复制到 `data/backups/papers-YYYYMMDD.json`，保留最近 7 份；server 启动即备一次 + 每 6 小时检查。
- **e2e 测试**（Playwright）：`tests/e2e/reader.spec.js` 覆盖 reader 关键路径——① PDF 打开并渲染（canvas 出现）；② 高亮创建 + 关闭后持久化往返（`GET /api/papers/sample` 的 annotations 非空，覆盖 quadPoints TypedArray 退化修复）。配套 `tests/fixtures/sample.pdf`（wkhtmltopdf 生成的 2 页带文本层 PDF）+ `scripts/e2e-bootstrap.js`（预置 config/PDF/papers.json）。

### Changed — 安全与默认值
- **默认监听 127.0.0.1**：`config.example.json` 的 host 与 server.js fallback 从 `0.0.0.0` 改为 `127.0.0.1`，避免不做鉴权时局域网暴露（仍可用 `HOST` env / config 显式开放）。
- **engines 改 `>=20`**：对齐 pdfjs-dist@4.10.38 的实际 node 要求（原 `>=18.17` 与 pdfjs 冲突）。
- **scanIntervalMinutes 用 `??`**：原 `|| 5` 在值为 0 时误降级到 5，改 `??` 让 0 生效（e2e 可禁用后台扫描）。

### Fixed — 工程化过程发现的真实 bug
- **scanner.js `sleep` 未导入**（ESLint 抓到）：`createScanner` 用了 `sleep` 但只解构 `{ sha1OfFile, log }`，`drain` 超时分支会抛 `sleep is not defined` → 补 `require('./util')` 解构 `sleep`。
- 正则多余转义（`[\w\.\-]` → `[\w.-]`、模板串 `\$` → `$`）。

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
