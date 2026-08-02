# Changelog

本文件记录 PaperWiki 每个版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号语义化。

## [Unpublished]

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
