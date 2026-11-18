# PaperWiki 设计系统规范（Design System v1）

> 适用版本：v3.63 起（P1 组件收口 v3.64）　|　状态：**生效中的规范 + 迁移计划**　|　维护：所有 UI 改动的 PR 必须对照本文
>
> **现在去哪写组件**：规范组件（§6）唯一定义在 `public/components.css`（在 styles.css **之后**加载）；图标走 `public/js/core/icons.js`；token 在 `public/tokens.css`。`tests/design-lint.test.js` 会拦下：在 components.css 以外重定义 `.btn/.badge/.tag/.switch/.seg/.spinner/.field` 基座、老按钮 class 不带 `.btn`、emoji（含 CSS `content`）、px / 半像素字号、无名图标按钮、内联色值。
>
> 本文回答三个问题：**现在哪里不统一**（§1 审查）、**统一成什么样**（§2–§8 规范）、**怎么从现状走过去**（§9–§10 工程化与迁移）。
> 规范用语：**必须 / 禁止** = 硬约束（会写进 lint / 测试）；**应当** = 默认做法，偏离需在 PR 里说明理由；**可以** = 允许的变体。

---

## 0. 产品定位与设计立场

PaperWiki 是研究者**长时间停留**的工作台：读论文、看总结、对话、整理概念与公式。由此推出四条立场，它们是后文每条规则的出处：

1. **内容优先，chrome 安静。** 标题、正文、公式是主角；按钮、徽章、边框是配角。配角默认静默，hover / 选中才显形（这已经是 v3.33 qbtn、v3.56 按钮三层的方向，本文把它推到全站）。
2. **一个意图，一种表达。** 「确认删除」「选中」「处理中」「加载中」在全站只能有一种视觉与交互。同义不同形是"不成熟感"的最大来源。
3. **状态永远可见，失败绝不静默。** 后台任务、保存、出错都必须有可感知的反馈，且反馈渠道按严重度分级（§7.1）。
4. **浅深同源，键鼠等价。** 任何颜色只通过语义 token 出现；任何鼠标动作都有键盘路径和可读的 aria 名称。

---

## 1. 现状审查（v3.62 快照）

### 1.1 定量盘点

数据取自 `public/styles.css`（5400+ 行）与 `public/**/*.js`、`index.html` 的静态扫描，以及在 1440×900 暗色主题下对论文 / 详情 / 概念 / 设置四个视图的实测。

| 维度 | 现状 | 目标（§10 验收线） |
|---|---|---|
| 字号取值 | **17 种**（9 / 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 15.5 / 16 / 17 / 18 / 22），471 处声明，其中 **127 处半像素** | 7 级 token，半像素 0 |
| 字重 | 400 / 500 / 550 / 600 / 650 / 700 / 800，非常规字重（550/650/700/800）70 处 | 400 / 500 / 600 三档 |
| 圆角取值 | 0–16px 间约 **18 种**字面值（含 5/7/9/11/14/15 等奇数），另有 `--radius*` 与 `--ctl-r*` 两套 token 并存 | 5 级 token + full |
| 控件高度 | 26 / 28 / 30 / 32 / 34 / 36 / 38 / 40 / 42，**9 种** | 4 档（24/28/32/36） |
| z-index | **26 个**离散值（1 … 1500），同为"模态"的有 80 / 200 / 1000 / 1400 / 1500 | 8 级层级 token |
| 遮罩（scrim） | 不透明度 .32 / .38 / .40 / .56 四种，部分带 blur，部分不带 | 1 个 token（浅/深各一值） |
| 硬编码色值 | 221 行含 `#hex`；47 处阴影写死 `rgba(15,23,42,…)` | token 文件之外 0 |
| `!important` | 38 处 | 仅 `[hidden]` 与 reduced-motion |
| `@keyframes` | **40 个**，其中旋转动画 5 个（`rdr-spin / rtp-spin / cms-spin / rb-spin / dsc-rot`），下拉/弹出进场 ≥8 个 | 6 个共享动效 |
| 断点 | 5 个（1240 / 1100 / 1080 / 860 / 760） | 3 个 |
| 图标 | 230 个内联 `<svg>` 散落在 23 个文件，`stroke-width` 有 **11 种**（1.5–3.2），无统一图标注册表 | 单一 `icons.js`，1 种描边 |
| emoji / 字符图标 | 详情 tab 用 💬✨📝，概念抽屉 📍，笔记 ✨，渠道测试 ✓/✗，多选 ☑/☐，发现进度 ○/✓ | 0（统一线性 SVG） |
| 确认弹窗 | `PWDialog` 已存在，但仍有 **3 处 `window.confirm`** | 0 |
| 键盘监听 | 23 处 `keydown` 监听分布在 14 个文件，无统一的浮层栈 | 1 个层级管理器 |
| 反馈渠道 | `toast()` 212 处调用 + 阅读器私有 `setStatus()` 48 处 | 统一分级反馈 |
| 模态语义 | `index.html` 里 5 个 `.modal-mask` 模态无 `role="dialog"` | 全部具备 |

### 1.2 结构性问题（按影响排序）

**P1. 样式表是"按时间追加的补丁层"，不是"按组件组织的系统"。**
`styles.css` 末尾 R1–R10、v3.33–v3.52 共 20 余个版本块，靠"后写的覆盖先写的"生效。例：`.qbtn.icon` 在 v3.33 定义 22px，v3.37 再改 24px；`.masonry-view .concept-card .ct` 在 v3.33 加 `padding-right:64px`，v3.35 又清回 0。结果是：读任何一个组件都要全文搜索才知道它最终长什么样，新改动极易被后面的补丁吃掉——这是一致性持续劣化的**根因**，不解决它，任何规范都会再次被稀释。

**P2. 三套 token 并存，语义重叠。**
- 旧 slate 系：`--panel/--panel2/--border/--border2/--muted/--muted2`
- v3.56 控件系：`--ink/--ring/--fill-*`（从墨色派生透明度）
- v3.59 行式系：`--s-t1/--s-t2/--s-line/--s-edge/--s-fill`（同样从墨色派生）

`--ring` 与 `--s-edge` 都是 `rgba(ink,.13)`，`--fill-ghost-hover` 与 `--s-fill` 都是 `rgba(ink,.05)`——同值异名。同时 `styles.css:33` 注释写"主按钮是墨色而非品牌色"，而 `--fill-primary` 实际是 Indigo，文档与实现已经分叉。

**P3. 暗色模式有两套底色。**
全站暗色是藏青 slate（`--panel:#151c2a`），设置覆盖层暗色却是中性灰（`--s-paper:#1b1f26`，`styles.css:4668`）。实测打开设置时，面板与背后页面色相明显不同。浅色下设置面板也硬编码 `--s-paper:#fff`（`styles.css:3991`），不跟随 `--surface-raise`。

**P4. 同一类组件有多份实现。**

| 组件 | 现有实现 |
|---|---|
| 按钮 | `.btn`（三层）、`.qbtn`、`.chat-tool-btn`、`.chat-text-btn`、`.notes-tb-btn`、`.rb-chrome-btn`、`.side-icon-btn`、`.sa-btn`、`.fp-op-btn`、`.search-btn`、`.card-star`… 约 15 个家族 |
| 输入框 | 控件环风格（32/28）、`.pfd-row input`（34px 实线边框）、`.fe-input`（36px）、`.settings-form select`（42px，padding 10/12）、`.pwdlg-input`（border + 2px 光环）——**5 套** |
| 开关 | `.switch`（36×20）与 `.fe-switch`（34×19）两套 |
| 分段控件 | `.seg-group`、`.icon-seg`、`.text-seg`、`.tax-seg`、`#theme-seg`、`.view-nav`（顶栏导航也是分段形态，但高 34、选中用 accent-soft 而非抬起块） |
| 徽章 / 标签 | 详情头一行内同时出现：绿描边点状"就绪"、无边"已读"、描边"读到 2%"、灰底"11 概念"、描边胶囊"arXiv cs.CL"、Indigo 描边"arxiv"、彩色 topic、灰色 tag——**8 种样式**在同一视线内 |
| 模态容器 | `.modal`（r8，380 宽）、`.pwdlg`（r8，400）、`.pfdlg`（460–620）、`.fm-modal`（480）、`.settings-shell`（r12）、`.fdv`（r14，880）、`.formula-candidates-pop`、`.cp` 命令面板——尺寸、圆角、遮罩、动效各不相同 |
| 加载指示 | 5 种 spinner + shimmer 骨架 + 文字"加载中…" |

**P5. 交互规则未成文，导致行为分叉。**
- 删除确认：PWDialog（自定义）与 `window.confirm`（`formulas/detail-overlay.js:218`、`reader/shelf-drawer.js:344`、`library/folder-manager.js:129`）并存；PWDialog 的危险确认默认聚焦"确定"，**回车即删除**。
- 一屏多个主按钮：概念页标题区"+ 新增"与顶栏"+ 添加"同为 Indigo 实心，违反"每屏一个主动作"。
- 加载反馈：实测在论文列表点击一篇论文后约 2 秒内，详情区仍显示「从左侧选择一篇论文」空态，用户会误以为点击没生效（v3.32 R7 的详情骨架没有覆盖这段等待）。
- 全局入口可达性：概念页侧栏分面很长时，侧栏底部的「阅读架 / 设置」被滚出视口，需要滚动侧栏才能找到。

### 1.3 顺手发现的缺陷（可在 P0 一并修）

- `library/folder-manager.js:129`：确认文案引号不配对：`「${fo.name}”`。
- `--font-mono` 在 6 处被引用但从未定义（全部走 fallback）。
- `.space-opt .space-opt-dir` 定义两次（`styles.css:226` 12px / `:238` 11px），`.space-menu-divider` 也定义两次（`:221` / `:239`），后者覆盖前者。
- `.list-toolbar .btn.sm` 的注释仍写"全局 .btn 是 min-height:34px"（`styles.css:1142`），实际已是 32px。
- `.cp-kind.k-*` 文字色（`#1d4ed8` 等）与 `.chip-N`、`.toast`（`#1e293b`）为硬编码，暗色依赖逐条补丁覆盖。

### 1.4 已经做对、应当保留并推广的部分

- v3.58「下拉内容统一规格」：多个浮层共享面板外壳 + 菜单项规格 + SVG 遮罩勾——**这正是全站组件化应有的写法**，§6 各组件照此模式。
- v3.56 按钮三层语义（primary / ghost / subtle + danger 叠加）与两档尺寸。
- 控件用**内阴影环**而不是 border（不占盒模型、不与分隔线叠成 2px）。
- R2 骨架屏、R3 结构化空态（图标 + 诊断 + 行动）、R4 `:focus-visible` 与 reduced-motion、R5 `tabular-nums`。
- `chipClass(name)` → `.chip-N` 的稳定色槽方案（同名标签跨页同色）。
- URL 即状态的路由约定（AGENTS.md 陷阱 0 系列）。

---

## 2. 设计原则（可执行版）

| # | 原则 | 落到规则上 |
|---|---|---|
| 1 | **安静的 chrome** | 卡片内动作 hover 才显形；元数据用中性徽章；高饱和色只给"需要用户注意"的信号（错误、处理中、选中、重点星标） |
| 2 | **一个意图一种表达** | 每个意图在 §6 有唯一组件；新需求先找组件，找不到才扩展组件，**禁止**在视图 CSS 里重画一个"差不多"的按钮/输入框 |
| 3 | **层级靠字号与字重，不靠颜色** | 标题 600、正文 400、元信息降一级字号 + `--text-2`；不用颜色区分层级 |
| 4 | **状态可见、可撤销优先** | 可恢复的操作用"执行 + 撤销 toast"，不可恢复的才弹确认；后台任务必须在状态胶囊可见 |
| 5 | **键盘一等公民** | 所有浮层 Esc 关闭、焦点进出有序；图标按钮必有 `aria-label`；快捷键在 tooltip 和 `?` 帮助里可发现 |
| 6 | **浅深同源** | 组件 CSS 只引用语义 token；暗色只改 token 值，不写组件级暗色补丁 |

---

## 3. Design Tokens

### 3.1 三层结构

```
原始层 primitives   --slate-50 … --slate-950, --indigo-50 … --indigo-700, --red-500 …（只在 tokens.css 出现）
   ↓
语义层 semantic     --bg, --surface-1, --text-1, --border-default, --accent, --danger …（组件只能用这一层）
   ↓
组件层 component    --btn-h, --field-h, --menu-radius …（可选；只在需要被局部覆盖时才定义）
```

**禁止**组件 CSS 直接写原始色值或原始层 token。暗色主题 = 只在 `html[data-theme="dark"]` 里重新赋值**语义层**。

### 3.2 颜色（语义层）

新名 → 现有名对照（迁移期旧名保留为别名，§10）：

| 语义 token | 用途 | 浅色值 | 暗色值 | 现有名（别名） |
|---|---|---|---|---|
| `--bg` | 应用底 | slate-100 `#f1f5f9` | `#0e1420` | `--bg` |
| `--surface-1` | 面板、卡片、列表 | `#ffffff` | `#151c2a` | `--panel` |
| `--surface-2` | 侧栏、凹陷区、表头 | `#f1f5f9` | `#1b2334` | `--panel2` |
| `--surface-3` | 骨架、进度轨 | `#e2e8f0` | `#253044` | `--panel3` |
| `--surface-raised` | 菜单、弹窗、抽屉、设置面板 | `#ffffff` | `#1c2434` | `--surface-raise`、`--s-paper` |
| `--text-1` | 主文 | `#0f172a` | `#e6eaf2` | `--text`、`--s-t1` |
| `--text-2` | 次要文字、描述 | `#64748b`（4.8:1） | `#9aa6bb` | `--muted`、`--s-t2` |
| `--text-3` | 占位、禁用、弱元信息（**不得**承载必读信息） | `#94a3b8` | `#67738a` | `--muted2`、`--s-t3` |
| `--border-subtle` | 行间发丝线 | `rgba(ink,.07)` | `rgba(ink,.10)` | `--s-line` |
| `--border-default` | 控件内环、容器描边 | `rgba(ink,.13)` | `rgba(ink,.16)` | `--ring`、`--s-edge`、`--border` |
| `--border-strong` | hover 描边、分隔强调 | `rgba(ink,.22)` | `rgba(ink,.26)` | `--ring-hover`、`--border2`、`--border-hover` |
| `--fill-hover` | 无底元素 hover | `rgba(ink,.05)` | `rgba(ink,.07)` | `--fill-ghost-hover`、`--s-fill` |
| `--fill-secondary` | 次级按钮/输入底 | `rgba(ink,.04)` | `rgba(ink,.06)` | 同名 |
| `--fill-pressed` | 次级 hover / 按下 | `rgba(ink,.08)` | `rgba(ink,.11)` | `--fill-secondary-hover`、`--s-fill-hover` |
| `--fill-selected` | 中性选中 | `rgba(ink,.10)` | `rgba(ink,.14)` | `--fill-active` |
| `--accent` | 品牌 Indigo：链接、焦点环、选中强调 | `#4f46e5` | `#818cf8` | 同名 |
| `--accent-hover` | 主按钮 hover | `#4338ca` | `#7c7ff5` | `--accent-strong`/`--fill-primary-hover` |
| `--accent-subtle` | 选中底 | `#eef2ff` | `rgba(99,102,241,.18)` | `--accent-soft` |
| `--accent-border` | 选中描边 | `rgba(79,70,229,.28)` | `rgba(129,140,248,.40)` | 现散落为字面量 |
| `--on-accent` | 主按钮文字 | `#fff` | `#fff` | `--on-primary` |
| `--success` / `-subtle` / `-border` | 就绪、成功 | green-600 系 | green-400 系 | `--green*` |
| `--warning` / … | 处理中、需注意、核心创新 | amber-600 系 | amber-400 系 | `--amber*` |
| `--danger` / … | 错误、破坏性 | red-600 系 | red-400 系 | `--red*` |
| `--info` / … | 来源、链接型信息 | blue-600 系 | blue-400 系 | `--blue*` |
| `--star` | 重点星标 | `#f59e0b` | `#fbbf24` | 现为字面量 |
| `--scrim` | 模态遮罩 | `rgba(15,23,42,.40)` | `rgba(0,0,0,.56)` | 现 4 种值 |
| `--selection` | 文本选区 | `rgba(79,70,229,.28)` | `rgba(129,140,248,.40)` | 字面量 |

**规则**

- **文字用实色，填充/描边用墨色透明度。** 文字若用透明度，在不同底色上对比度会漂移，无法保证 AA；填充与描边用透明度则能自动适配任何底。（这修正了 v3.59 `--s-t2 = rgba(ink,.60)` 的做法。）
- **Indigo 的使用面只有四处**：主按钮、链接、焦点环、选中态。其余一律中性。
- **语义色只表达状态**，不做装饰；`cyan / violet / pink` 退出语义层，只作为 `.chip-N` 标签色槽的原始色使用。
- **暗色只有一套底色（slate 藏青）。** 设置覆盖层改用 `--surface-raised`，删除 `--s-paper/--s-nav` 的独立赋值（修 P3）。
- 标签色槽 `.chip-0…7` 保留（这是用户内容的"身份色"），但其浅/深两套值移入 tokens.css，以 `--chip-N-bg/fg/border` 表达。

### 3.3 字体与字号

```css
--font-sans: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;   /* 当前未定义，补上 */
```

| token | 字号 / 行高 | 用途 |
|---|---|---|
| `--fs-xs` | 11 / 16 | 计数、徽章、kbd、时间戳（**全站最小字号**） |
| `--fs-sm` | 12 / 18 | 元信息（作者·年份）、提示、表单说明、分组标题 |
| `--fs-md` | 13 / 20 | 密集 UI：列表卡标题（紧凑）、工具条、菜单次要项、表格 |
| `--fs-base` | 14 / 22 | 默认 UI：按钮、菜单项、输入、侧栏项、对话气泡 |
| `--fs-lg` | 15 / 26 | 长文阅读（`.md` 总结/笔记）、知识卡标题 |
| `--fs-xl` | 18 / 26 | 弹窗标题、详情区小节标题 |
| `--fs-2xl` | 22 / 30 | 页面标题（概念清单/公式清单）、详情论文标题 |

**规则**

- **禁止半像素字号。** 微软雅黑等 CJK 字体在 Windows 下对 .5px 没有对应 hinting，同一字号在不同元素上会落到不同的整数渲染，正是"看起来差不多但又不一样"的来源。
- **禁止 < 11px。** 现有 9 / 9.5 / 10 / 10.5px（多为徽章）统一升到 11px，并用字重和底色区分层级，而不是继续压字号。
- 映射：`9–10.5 → xs`，`11.5 → sm`，`12.5 → md`（文字密集处）或 `sm`，`13.5 → base`，`15.5/16/17 → lg 或 xl`。
- **字重只用 400 / 500 / 600。** 550 / 650 在无可变字重的中文字体上会被就近取整到 500 / 700，实际渲染与设计意图不符；700 / 800 仅允许用于数字型 KPI（tabular-nums）。
- 所有计数、进度、频次、时间：`font-variant-numeric: tabular-nums`（沿用 R5）。

### 3.4 间距

4px 基准网格：

```
--sp-0: 0   --sp-0_5: 2px  --sp-1: 4px  --sp-1_5: 6px  --sp-2: 8px  --sp-3: 12px
--sp-4: 16px  --sp-5: 20px  --sp-6: 24px  --sp-8: 32px  --sp-10: 40px  --sp-12: 48px
```

- 控件内部水平 padding：28 档 `--sp-2_5`（10px）、32 档 `--sp-3`（12px）；图标与文字间距 `--sp-1_5`。
- 卡片内边距：列表项 `--sp-3`；网格知识卡 `--sp-4`；弹窗 `--sp-5`（20px）×`--sp-6`（24px）。
- 区块间距：同组 `--sp-2`，组间 `--sp-4`，区段间 `--sp-6`。
- 奇数值（7 / 9 / 11 / 13px）**禁止**新增；存量在触碰时就近归位。

### 3.5 圆角

| token | 值 | 用途 |
|---|---|---|
| `--r-xs` | 4px | 徽章、kbd、进度条、内嵌小块 |
| `--r-sm` | 6px | 28 档控件、分段控件内格、菜单项内高亮块 |
| `--r-md` | 8px | 32/36 档控件、列表项、输入框 |
| `--r-lg` | 12px | 浮层面板（菜单/popover）、知识卡、设置面板、抽屉内分区卡 |
| `--r-xl` | 16px | 居中模态、命令面板 |
| `--r-full` | 9999px | 胶囊、头像、圆点、开关 |

**嵌套规则**：内层圆角 = 外层圆角 − 间距（如 12px 面板 + 4px 内边距 → 菜单项 8px）。这是 v3.58 菜单已经遵守的规则，推广全站。现有 `--radius` 与 `--ctl-r` 两套合并为上表一套。

### 3.6 阴影与层级（elevation）

| token | 浅色 | 用途 |
|---|---|---|
| `--shadow-0` | none | 平铺在面板上的元素 |
| `--shadow-1` | `0 1px 2px rgba(ink,.06)` | 静息卡片、分段控件选中块 |
| `--shadow-2` | `0 4px 14px rgba(ink,.10)` | 卡片 hover、菜单、popover、toast |
| `--shadow-3` | `0 16px 48px rgba(ink,.18)` | 模态、抽屉、命令面板 |

暗色下阴影几乎不可见，因此暗色层级**改用表面明度表达**：越高的层 `--surface-*` 越亮，阴影值同时加深（已有 `--shadow-lg` 暗色值可沿用）。

### 3.7 层级（z-index）

**必须**使用以下 token，禁止裸数字：

| token | 值 | 归属 |
|---|---|---|
| `--z-base` | 0 | 文档流 |
| `--z-raised` | 10 | 吸顶头（概念页标题头）、列表工具条、阅读器内部浮层 |
| `--z-chrome` | 30 | 顶栏 |
| `--z-view` | 50 | 整屏视图：阅读器 `#reader-view`、设置覆盖层 `.settings-overlay`（它们是「页面」，其内部的菜单/抽屉/模态仍需压在其上） |
| `--z-dropdown` | 100 | 菜单、筛选浮层、模型选择器、问答大纲 |
| `--z-drawer` | 200 | 侧滑抽屉（概念详情、公式编辑覆盖层） |
| `--z-modal` | 300 | 居中模态（`.modal-mask`）、公式预览/候选、全屏概念图 |
| `--z-dialog` | 400 | PWDialog / 表单对话框（可叠在模态之上） |
| `--z-toast` | 500 | toast |
| `--z-tooltip` | 600 | 自定义 tooltip |

组件内部的局部叠放（阅读器 1–8）**应当**在容器上设 `isolation: isolate` 建立独立层叠上下文后使用 1–9 的小数字，不参与全局层级。同一层内需要细分先后时用 `calc(var(--z-x) + n)`（如阅读架悬浮按钮 `calc(var(--z-raised) + 1)`），不要另起数字。

> P0 落地时修正了两处层级倒挂：旧值下 PWDialog（1000）低于设置覆盖层（1200）、toast（120）低于所有覆盖层——在设置里点「删除」弹出的确认框会被遮住。现在 dialog 400 / toast 500 恒在最上。

### 3.8 动效

```css
--dur-fast: 100ms;   /* 颜色、背景、透明度的 hover 反馈 */
--dur-base: 160ms;   /* 菜单/popover/toast 出入、tab 切换 */
--dur-slow: 240ms;   /* 抽屉、模态、布局变化 */
--ease-out: cubic-bezier(.2, .8, .2, 1);    /* 进场 */
--ease-in:  cubic-bezier(.4, 0, 1, 1);      /* 退场 */
--ease-standard: cubic-bezier(.2, 0, 0, 1); /* 位移/尺寸 */
```

共享关键帧（替代现有 40 个）：

| 名称 | 效果 | 替代 |
|---|---|---|
| `pw-fade-in` | opacity 0→1 | `cd-fade`、`settingsOverlayIn` … |
| `pw-pop-in` | opacity + translateY(-4px) + scale(.98) | `spaceMenuIn`、`fsmIn`、`sd-in`、`bulkMenuIn`、`fp-in`、`cm-in`、`co-in` … |
| `pw-rise-in` | opacity + translateY(8px) | `settingsShellIn`、`fdv-in`、`card-in`、`chat-msg-in` |
| `pw-slide-in-end` | translateX(100%)→0 | `cd-slide`、`bp-slide` |
| `pw-spin` | 360° 旋转 | `rdr-spin`、`rtp-spin`、`cms-spin`、`rb-spin`、`dsc-rot` |
| `pw-shimmer` / `pw-pulse` | 骨架扫光 / 呼吸 | `skel-sweep`、`pulse-dot`、`chat-shimmer` |

规则：hover 只过渡颜色类属性（`--dur-fast`）；**禁止**对 `width/height/top/left` 做过渡（用 transform）；退场时长 ≈ 进场的 70%；reduced-motion 全局降级保留（R4）。

### 3.9 尺寸与断点

**控件高度（只有四档）**

| token | 值 | 场景 |
|---|---|---|
| `--ctl-xs` | 24px | 卡片内微钮（qbtn、星标）——WCAG 2.2 最小命中区 |
| `--ctl-sm` | 28px | 列表工具条、分段控件、表格行内操作、弹窗底部按钮 |
| `--ctl-md` | 32px | 顶栏、侧栏项、默认按钮、菜单项 |
| `--ctl-lg` | 36px | 表单字段（对话框 / 抽屉 / 设置）、搜索框、对话输入 |

顶栏现有 34px 的 `.view-nav` / `.status-chip` 归到 32px；设置页 42px 的 select、38/40px 的零散控件归到 36px。

**断点（只有三个）**

| 名称 | 条件 | 行为 |
|---|---|---|
| `wide` | ≤1240px | 顶栏允许换行、搜索独占一行 |
| `medium` | ≤1100px | 侧栏收窄、列表上限收紧（合并现有 1080 与 1100） |
| `compact` | ≤860px | 列表/详情堆叠、设置导航改顶部 tab（合并现有 760） |

CSS 变量不能用于 `@media`，因此断点值以注释常量写在 tokens.css 顶部，并由 lint 校验 `@media` 只出现这三个值。

---

## 4. 图标

- **唯一来源**：新建 `public/js/core/icons.js`，导出 `icon(name, { size = 16, label } = {})` 返回 SVG 字符串；`index.html` 中的静态图标改为 `<svg><use href="#i-name"/></svg>` 引用页内 `<symbol>` sprite（零构建可用）。
- **网格**：viewBox `0 0 24 24`；描边 `stroke-width: 1.75`，`stroke-linecap/linejoin: round`，`fill: none`，颜色 `currentColor`。现有 11 种描边归一。
- **尺寸**：14（卡内微钮、徽章内）/ 16（默认按钮、菜单、侧栏）/ 20（空态之外的大按钮、阅读器工具栏）/ 36（空态插图）。
- **风格**：与 `reader-bar` 现有细线图标一致（见 memory「UI 不用 emoji」）。
- **禁止 emoji 与字符图标**进入 UI（注释里可以）。待替换清单：

| 位置 | 现状 | 替换为 |
|---|---|---|
| `detail/detail.js:158-160` | 💬 ✨ 📝 | `message-circle` / `sparkles` / `notebook-pen` |
| `concepts/detail-drawer.js:115` | 📍 | `map-pin` |
| `detail/notes-panel.js:97-99` | ✨ | `sparkles` |
| `reader/shelf-drawer.js:151,168` 文案 | 🔖 | 文案里写「书签按钮」+ 内嵌图标 |
| `reader.js:2527,2557` | ⚠ ✓ | 走 §7.1 反馈组件的 level 图标 |
| `settings/channels.js:221-261` | ✓ ✗ | `.badge` success / danger |
| `library/list.js:156` | ☑ ☐ | 统一复选框组件（§6.6） |
| `library/discover.js:98` | ○ ✓ | `circle` / `check` + `.spinner` |

- 图标按钮**必须**带 `aria-label`；有快捷键的在 tooltip 中显示（§6.12）。

---

## 5. 布局

- **应用骨架**：顶栏（56px，含 12px 上下留白）+ 常驻侧栏（230 / 收起 56 / medium 186）+ 内容区。侧栏底部的「阅读架 / 设置」**必须**固定在侧栏滚动区之外（修复 §1.2 P5 第 4 条）：侧栏改为 `grid-template-rows: 1fr auto`，只有上半区滚动。
- **页面头**：知识页标题头 sticky（v3.36）保留；页面标题 `--fs-2xl/600`，副标题 `--fs-sm/--text-2`，右侧工具区按钮最多一个 primary。
- **内容宽度**：长文 `.md` 全宽（尊重用户 v3.56 的选择），但表格/公式横向滚动兜底（R6b）；表单 `max-width: 720px`。
- **栅格**：知识卡瀑布流列宽 ≥ 300px，列间距 `--sp-4`；列表项间距 `--sp-1`。
- **滚动**：每个面板独立滚动（`min-height:0` 规则，AGENTS 陷阱 5）；滚动后吸顶头出现底边线 + `--shadow-1`。

---

## 6. 组件规范

每个组件给出：**解剖 / 变体 / 尺寸 / 状态 / 无障碍 / 合并清单**。状态矩阵统一为：`default · hover · active(按下) · focus-visible · selected · disabled · busy · invalid`（按组件取子集）。

### 6.1 Button

| 变体 | 外观 | 何时用 |
|---|---|---|
| `primary` | `--accent` 实心 + `--on-accent` | 当前区域**唯一**最重要的动作（打开 PDF、保存、确认） |
| `secondary`（现 `.ghost`） | `--fill-secondary` + 内环 `--border-default` | 大多数动作：取消、编辑、导出 |
| `ghost`（现 `.subtle`） | 透明，hover 出 `--fill-hover` | 工具条、卡片内、低频入口 |
| `danger` 修饰 | primary+danger = 红实心；secondary/ghost+danger = 红字，hover 出 `--danger-subtle` | 破坏性动作 |

- 尺寸：`xs`（24，仅图标）/ `sm`（28）/ `md`（32，默认）/ `lg`（36，仅表单底部或空态主行动）。
- 图标按钮：正方形，宽 = 高；**必须** `aria-label`。
- busy：保留宽度（`setBusy` 已实现）、文字改进行时、前置 `.spinner`，`aria-busy="true"`。
- focus：`0 0 0 2px var(--surface-1), 0 0 0 4px var(--accent)`（现有实现保留）。
- **每个视觉区域最多一个 primary。** 一个"区域"= 顶栏 / 页面头 / 一个弹窗 / 一张卡。概念页「+ 新增」改为 secondary（顶栏「+ 添加」才是全局 primary）。
- **合并**：`.qbtn` → `.btn.ghost.xs`；`.chat-tool-btn / .notes-tb-btn / .rb-chrome-btn / .side-icon-btn / .fp-op-btn` → `.btn.ghost` 对应尺寸；`.sa-btn / .chat-text-btn` → `.btn.secondary.sm`；`.card-star / .cd-star` → `.btn.ghost.xs.icon` + `.is-starred` 修饰（`--star` 色）。
- **P1 落地（v3.64）✅**：上述全部完成，另把 7 个关闭 × 钮（`.co-close/.cmp-close/.rcd-close/.rsd-close/.settings-x/.shp-close/.ft-banner-close`）并入 `.btn.ghost.icon`；`.chat-model-btn` → `.btn.secondary.sm`，`.fp-op-toggle` → `.seg`（`.chat-text-btn` 是死 CSS，已删）。老 class 保留在元素上**只作 JS / 测试钩子**，视觉 CSS 已从 styles.css 删除；`ui.legacyButtonWithoutBtn` 硬约束保证它们永远与 `.btn` 同现。
- 星标：`.btn.ghost.xs.icon.star-btn` + `.is-starred`（实心金 + `star-pop` 弹跳）；JS 切换的是 `is-starred`，不再是 `on`。
- 纯图标按钮内未声明 `width` 的 SVG 统一 16px（`.xs` 14px），不要再在上下文里写 13/15px 散值。

### 6.2 Segmented Control（分段控件）

- 外壳：`--fill-secondary` + 内环，高 `--ctl-sm`，内边距 2px，`--r-sm`。
- 格：透明 → hover `--fill-hover` → **选中 = `--surface-1` 抬起块 + `--shadow-1` + 文字/图标 `--accent`**。
- 纯图标格正方形；文字格横向 padding `--sp-2_5`。
- 键盘：外壳 `role="radiogroup"`，格 `role="radio"`，←/→ 切换。
- **合并**：`.seg-group / .icon-seg / .text-seg / .tax-seg / #theme-seg` → `.seg`。
- **顶栏一级导航 `.view-nav` 不是分段控件而是导航**：保留 accent-subtle 选中（表达"你在这里"），但高度归 32、字号 `--fs-base/500`，与其他顶栏控件对齐。

### 6.3 Text Field / Textarea / Select

单一规格（替代现有 5 套）：

```
高度 --ctl-lg(36)（工具条内可 --ctl-sm）  圆角 --r-md  水平 padding --sp-3  字号 --fs-base
底 --surface-1   描边：内环 inset 0 0 0 1px --border-default
hover   → 内环 --border-strong
focus   → 内环 --accent + 外光环 0 0 0 3px --accent-subtle
invalid → 内环 --danger + 外光环 --danger-subtle，下方 --fs-sm 红色错误文案
disabled→ --fill-secondary 底、--text-3 文字、不响应 hover
```

- **一律用内环，不用 border**（与按钮同一语言；避免 1px 跳动）。
- 标签布局两种：**表单式**（标签在上，`--fs-sm/500/--text-2`，间距 6px）用于对话框和抽屉；**行式**（标签左 / 控件右 / 发丝线分隔，v3.59 `.set-row`）用于设置和信息 tab。同一表单内不得混用。
- 下拉选择一律用自定义 `.sd-*` 下拉（v3.58 规格），**禁止**裸 `<select>` 出现在 UI 中（UA 控件在暗色和 Windows 上不可控）。
- 数值输入：右对齐 + tabular-nums + 固定 140px 宽（v3.45 保留）。
- **合并**：`.pfd-row input`、`.fpk-input`、`.fe-input`、`.settings-form select/textarea`、`.pwdlg-input` → `.field`（`input.field` / `textarea.field`）。
- **P1 落地（v3.64）✅**：`components.css` 的 `.field` 规则组同时列出上述存量选择器作**别名**（存量表单不必逐个改 markup，外观只在一处定义）；styles.css 只留它们的布局（宽度 / flex / 多行最小高）。新代码直接写 `class="field"`（工具条内 `.field.sm` = 28px）。非法态：`.is-invalid` / `[aria-invalid=true]`（存量 `.pfd-invalid` 同效）。
- 设置页行式表单 `.sr-ctl` 内的输入（v3.59）已是内环 + `--r-md` 同一语言，高 32（行内控件档），保持现状。

### 6.4 Switch / Checkbox / Radio

- Switch：36×20，轨道 `--r-full`，关 `--fill-pressed`、开 `--accent`，旋钮 16px 白；`role="switch"` + `aria-checked`。合并 `.switch` 与 `.fe-switch`。
- Checkbox / Radio：原生 + `accent-color: var(--accent)`（已全局设置），尺寸 16px；**禁止**用 ☑☐ 字符模拟。
- 多选卡片的选中标记：统一为左上角 18px 圆形勾选（概念/公式卡现有 `::before` 方案），论文列表同样采用，不再用字符。

### 6.5 Menu / Dropdown / Popover

- **菜单（单选/动作）**：沿用 v3.58 统一规格——面板 `--r-lg` + 4px 内边距 + `--shadow-2`；项 32px / `--r-md` / `--fs-base`；选中 = SVG 勾（不铺色块）；分隔线 1px `--border-default`。新增菜单**必须**加入该选择器组或直接使用 `.menu-pop/.menu-item`。
- **筛选浮层（多选，`.filter-pop`）**：作为唯一例外保留，但外壳圆角/阴影/进场动效与菜单一致。
- **键盘**：触发器 `aria-haspopup="menu"` + `aria-expanded`；↑/↓ 移动、Enter 选择、Esc 关闭并把焦点还给触发器、Home/End 首尾、字母键跳转。
- **定位**：默认触发器下方 4px 左对齐；空间不足时翻转；面板最大高 `min(360px, 60vh)` 内部滚动。
- 进场 `pw-pop-in`（`--dur-base`），退场无动画或 `--dur-fast` 淡出。

### 6.6 Badge / Tag / Count（徽章体系）

> **P2 补充（v3.65）**：chip 内的「移除 ×」统一为 **Chip 移除微钮**——`icon('x')` 12px，`--chip-x`（16px）圆形热区，静息弱色、hover `--danger` + `--danger-subtle`。它是 chip 的组成部分，不占 §3.9 控件四档。外观只在 components.css 定义，覆盖 `.chip-row .x / .sf-chip-x / .saved-chip-x / .extra-chip-x / .ca-x / .rcd-quote-x / .fpk-x`。

> **P1 落地（v3.64）✅**：`.badge` 变体 `success / warning / danger / info / accent`，另有分类色 `.violet / .cyan`（命令面板类型）、`.plain`（去底纯计数）、`.has-dot`（前置 6px 圆点）、`.is-live`（脉冲点，处理中）；Badge / Tag 均无描边、`--r-xs`、高 20px。下表「合并」一行列出的老 class 全部改为 `.badge.{variant}`（老名只作钩子）。

这是当前最混乱的区域（详情头一行 8 种样式）。今后只有三种物件：

| 物件 | 表达 | 外观 | 例 |
|---|---|---|---|
| **Tag**（用户内容） | 主题、标签——用户可点击筛选 | `.chip-N` 色槽浅底 + 同色字，**无边框**，`--r-xs`，高 20px，`--fs-xs/500` | 语言模型、rwkv-7 |
| **Badge**（系统状态/属性） | 状态、来源、类别、阅读状态 | 变体 `neutral / success / warning / danger / info / accent`；neutral = `--fill-secondary` 底 + `--text-2`；语义变体 = `-subtle` 底 + 语义色字；可选前置 6px 圆点；高 20px，`--r-xs`，`--fs-xs/500` | 就绪、已读、arXiv cs.CL、核心创新 |
| **Count** | 纯数字 | 无底，`--text-3`（选中项内 `--accent`），tabular-nums，`--fs-xs` | 侧栏 132、导航 922 |

规则：

- **静息时只有两类颜色出现在卡片上**：Tag 色槽 + 需要注意的状态（warning/danger）。就绪、已读、来源等常态属性一律 neutral。
- Badge **不加描边**（描边胶囊会被误认为按钮）；可点击的必须有 hover 态和 `cursor:pointer`，不可点击的不得有。
- 「读到 2%」「11 概念」这类元指标并入 meta 行文字（`作者 · 年份 · 11 概念 · 读到 2%`），不再做成徽章。
- **合并**：`.stat-pill / .cat-badge / .src-badge / .fc-cat / .fc-src / .fdv-cat / .fdv-src / .freq-badge / .mini-metric / .read-chip / .busy-tag / .imp-badge / .cp-kind / .cd-badge` → `.badge.{variant}`；`.tag / .topic` → `.tag.chip-N`。

### 6.7 Card

| 类型 | 用途 | 规格 |
|---|---|---|
| List item | 论文列表 | 无边框，`--r-md`，padding `--sp-3`；hover `--fill-hover`；选中 `--accent-subtle` 底 + 左侧 3px `--accent` 内阴影条（不再同时加整圈描边） |
| Grid card | 概念 / 公式 / 制品 | `--surface-1` + 1px `--border-default` + `--r-lg` + padding `--sp-4`；hover `--shadow-2` + `--border-strong`，**不上浮位移**（瀑布流里位移会造成邻卡视觉抖动） |
| Section card | 设置 / 编辑抽屉分区 / 详情头 | `--surface-raised` + `--r-lg` + padding `--sp-5`；不可嵌套第二层卡片，内层用 `--surface-2` 凹陷区 |

- 卡片解剖（Grid card）：**头行**（标题 `--fs-lg/600` · 弹性空白 · 动作组 · 星标）→ **正文**（`--fs-md/--text-2`，3 行截断）→ **出处行**（Tag/引用）→ **脚行**（Badge + Count）。
- 卡内动作：`opacity:0` 静息 → 卡片 hover / focus-within 时 `opacity:1`；`@media (hover:none)` 常显；**进行中状态的动作（取消）常显**（v3.41 规则推广）。
- 整卡可点击时，内部按钮 `stopPropagation`，卡片本身是 `<article>` + 标题内 `<a>`/`<button>`，不在 `<div>` 上挂 click。

### 6.8 Overlay 家族（模态 / 抽屉 / 浮层）

先确定**用哪一种**：

| 类型 | 何时用 | 例 |
|---|---|---|
| **Popover** | 锚定触发器、轻量、点外部即关、不阻断 | 菜单、筛选、问答大纲、状态胶囊明细 |
| **Dialog（居中模态）** | 需要用户完成或确认后才能继续的**短**任务 | 确认删除、新建空间、合并、导入 |
| **Drawer（侧滑抽屉）** | 查看/编辑某个对象的详情，同时保留背后上下文 | 概念详情、公式编辑、阅读器 AI/阅读架 |
| **Sheet（大面板）** | 有自己导航的独立工作区 | 设置、公式预览、命令面板 |
| **Fullscreen** | 需要全部画布 | 概念图 |

统一规格：

| 属性 | Dialog | Drawer | Sheet |
|---|---|---|---|
| 宽度 | `sm 400` / `md 560` / `lg 720` | `sm 380` / `md 480` / `lg 760` | `min(94vw, 1080px)` |
| 圆角 | `--r-xl` | 贴边侧 0，内侧 `--r-xl`（或全 0） | `--r-xl` |
| 遮罩 | `--scrim` | `--scrim`（阅读器内抽屉无遮罩） | `--scrim` + `backdrop-filter: blur(2px)` |
| 层级 | `--z-modal`（确认类 `--z-dialog`） | `--z-drawer` | `--z-modal` |
| 进场 | `pw-rise-in` `--dur-base` | `pw-slide-in-end` `--dur-slow` | `pw-rise-in` `--dur-base` |
| 解剖 | 头（标题 `--fs-xl/600` + 关闭 ×）/ 体（可滚动）/ 脚（按钮右对齐：次要在左、主要在右） | 同左，头部吸顶、脚部吸底 | 左导航 + 右内容 |

行为（**必须**，由 §9.4 的层级管理器统一实现）：

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向标题。
- 打开时焦点移入（第一个输入框，或无输入时的**次要**按钮）；**焦点陷阱**（Tab 不逃出）；关闭时焦点还给触发器。
- Esc 只关闭**最上层**；点遮罩关闭（有未保存修改时先询问）。
- 打开期间背景 `inert`，body 不滚动。
- 关闭按钮固定在右上角，24px 图标按钮，`aria-label="关闭"`。

> **P2 落地（v3.65）✅**：`public/layers.js`（`window.PWLayers`）+ ESM 薄壳 `js/core/layers.js`（`openLayer / holdLayer / releaseLayer / showModal / hideModal / registerShortcut / hasModalLayer`）。要点：
> - **单一栈、两只监听**：capture 阶段处理顶层 `onKey`、Tab 焦点陷阱和 capture 快捷键；bubble 阶段处理 Esc——内层元素 `preventDefault` 过的 Esc（输入法组合、@ 浮层、编辑框）不越级关层。`onEscape` 返回 `false` 表示「没处理」，事件继续传。
> - **背景 inert**：打开模态时 body 的其它直接子元素加 `inert`（`#toast-root`、`<script>`、`[data-layer-keep]` 除外）。**推论：模态打开期间新挂到 body 的浮层会被 inert**——临时元素要挂在模态内部（如公式详情的剪贴板兜底 textarea）。
> - **幂等**：同一元素重复 `open` 返回同一层；`holdLayer(host)` 把层句柄存在 `host.__pwLayer` 上，适合「显隐由 class 控制」的存量浮层。
> - 阅读器整体不登记为层（聊天浮层挂在 body），其 Esc 分层由 capture 快捷键自管。

**合并**：`.modal-mask/.modal`、`.pwdlg-mask/.pwdlg`、`.pfdlg`、`.fm-modal`、`.formula-candidates-pop` → `.overlay` + `.dialog.{sm|md|lg}`；`.concept-detail`、`.formula-editor`、`.reader-chat-drawer`、`.reader-shelf-drawer` → `.drawer`；`.settings-shell`、`.fdv`、`.cp` → `.sheet`。

### 6.9 Tabs

- 详情区 tab（总结 / 笔记 / AI 聊天 / 信息）：**下划线式**，`--fs-base/500`，未选 `--text-2`，选中 `--text-1` + 2px `--accent` 底线，tab 间距 `--sp-5`。
- 与分段控件的分工：**tab 切换的是"内容区"，分段控件切换的是"同一内容的呈现方式"**（密度、排序、主题）。不要用分段控件做 tab。
- 键盘：`role="tablist"`，←/→ 切换，Home/End。
- 图标：tab 默认不带图标；若带，必须是 §4 线性图标（替换现有 emoji）。

### 6.10 Sidebar Item

- 高 32，`--r-md`，padding `0 --sp-2`，图标 16 + 文字 `--fs-base` + 右侧 Count。
- hover `--fill-hover`；选中 `--fill-selected` + 文字 `--text-1/500` + Count `--accent`（中性底，与列表项的 accent-subtle 区分：侧栏是"范围"，列表是"对象"）。
- 分组标题 `--fs-sm/500/--text-2`，右侧可放 ghost.xs 图标按钮（如收藏夹管理）。

### 6.11 反馈组件：Toast / Inline status / Banner

| 组件 | 规格 |
|---|---|
| **Toast** | 右上（顶栏下 12px），宽 ≤ 360，`--surface-raised` 底 + `--shadow-2` + 左侧 16px level 图标（info/success/warning/danger），**不再用整块深色/红色/绿色底**（浅深主题都更克制且可读）；可带一个文字按钮（如「撤销」「查看」）；info/success 3.2s，warning 5s，danger 不自动消失直到关闭或 8s 且鼠标不在其上；`aria-live="polite"`，danger 用 `role="alert"` |
| **Inline status** | 控件旁/表单下的就地反馈（保存成功 ✓、连接测试结果），`--fs-sm` + level 图标 + 语义色；2s 后淡出（成功）或常驻（失败） |
| **Banner** | 页面/面板顶部的持续状态（如「有 7 项设置覆盖 config.json」），`--{level}-subtle` 底 + `--r-md` + 右侧行动按钮 |

阅读器私有的 `setStatus()` 迁移到同一套：短暂确认走 Inline status（阅读器底部状态条），需要用户知道的走 Toast，现有 `SILENT_STATUS_RE` 白名单思路保留为"静默确认"等级。

> **P2 落地（v3.65）✅**：`js/core/feedback.js`——`toast(msg, {level, action:{label, run}, duration, closable})`、`undoToast(msg, onUndo)`。时长按上表；带动作 ≥ 5s；`duration: 0` 常驻；悬停 / 聚焦暂停计时（恢复后至少再留 1.2s）；danger 与带动作 / 常驻的 toast 自带关闭钮；同屏 ≤ 4 条。旧签名 `toast(msg, 'error'|'warn')` 自动映射为 danger / warning。阅读器 `setStatus(text, level)` 改为直接走 toast：`level === true` 时失败类文案（失败 / 出错 / 错误 / 损坏 / 无法）为 danger，其余为 warning。

### 6.12 Tooltip

- 图标按钮、截断文本、徽章缩写**必须**有 tooltip。
- 迁移期可继续用 `title`；目标是统一 `data-tip` 自定义 tooltip（延迟 500ms 显示、`--fs-sm`、`--surface-raised` 反色或深底、可含 `<kbd>`），以便显示快捷键并跟随主题。
- 有 `aria-label` 的元素 tooltip 文本应与之一致。

### 6.13 Empty / Loading / Progress

- **空态**（R3 保留）：36px 线性图标 + 一句诊断（`--fs-base/600`）+ 一句说明（`--fs-sm/--text-2`）+ 至多 2 个行动按钮（一个 primary）。区分三种：**首次空**（引导添加）、**筛选空**（提供"清除筛选"）、**出错空**（提供"重试"）。
- **骨架**（R2 保留）：与最终布局同构；任何 >150ms 的视图加载**必须**立刻出骨架，不得先显示别的空态（修复详情区"从左侧选择一篇论文"误显示）。
- **Spinner**：唯一 `.spinner`（14/16/20 三档，2px 描边，`pw-spin` 0.8s linear）。
- **进度**：已知进度用 3px 进度条（`--r-full`，`--accent` 填充，`--surface-3` 轨道）；阶段性任务（发现/扫描）用步骤列表：待办 `circle` / 进行中 `.spinner` / 完成 `check`。

### 6.14 Kbd

`--fs-xs`、`--font-mono`、`--r-xs`、`--surface-2` 底 + 1px `--border-strong` + 底边 2px。快捷键文案统一写法：`Ctrl K`（Windows）/ `⌘ K`（macOS），按平台渲染。

---

## 7. 交互规范

### 7.1 反馈分级

| 场景 | 渠道 | 例 |
|---|---|---|
| 操作即结果、结果可见 | **无额外反馈**（结果本身就是反馈） | 切换星标、切换 tab、改密度 |
| 操作成功但结果不在视野内 | Toast success / info | 已加入收藏夹、已导出 |
| 就地编辑的保存 | Inline status | 设置项保存、批注保存 |
| 可恢复的破坏性操作 | **执行 + 「撤销」toast**（5s） | 移出收藏夹、移出阅读架、删除笔记卡 |
| 不可恢复的破坏性操作 | Dialog danger 确认 | 删除论文、删除空间、批量删除概念 |
| 后台任务 | 顶栏状态胶囊（已有）+ 完成时 toast | 扫描、总结、公式抽取 |
| 失败 | Toast danger（带"重试"/"查看详情"）+ 出错位置 Inline | 网关失败、MinerU 降级 |

失败文案必须回答三件事：**发生了什么、为什么（若已知）、用户可以做什么**。例：「总结失败：模型返回空内容。可在信息 tab 点"重新总结"，或在设置中切换模型。」

### 7.2 破坏性操作

- **禁止** `window.confirm / alert / prompt`（3 处存量在 P0 移除）。
- 确认对话框标题用**动词 + 对象**（「删除公式？」），正文说明**后果与范围**（「将从 3 篇论文的产出中移除，不可撤销」），主按钮用**动词**（「删除」），不用「确定」。
- 危险确认的**默认焦点在"取消"**，Enter 不直接触发删除（当前 PWDialog 聚焦"确定"，需修改）。
- 批量破坏性操作在确认框中写明数量。
- 能做成可撤销的，优先撤销而不是确认（确认框会被习惯性点掉，撤销才真正保护数据）。

### 7.3 加载与异步

| 等待时长 | 表现 |
|---|---|
| < 150ms | 不显示任何加载（避免闪烁） |
| 150ms – 1s | 骨架（视图级）或按钮内 spinner（动作级） |
| 1s – 10s | 骨架 + 可见阶段文案（如「解析中 → 补元数据 → 总结中」） |
| > 10s / 不确定 | 转为后台任务：状态胶囊 + 可取消；完成后 toast |

- 异步按钮用 `setBusy`：锁宽、禁用、进行时文案；**必须**在 `finally` 中恢复（AGENTS 陷阱 41 推广到所有按钮）。
- 流式输出（聊天、AI 解读）：首 token 前显示 shimmer 占位；流式中提供「停止」；结束后操作区淡入。
- 乐观更新：星标、已读状态、收藏夹勾选先改 UI 再请求，失败回滚 + toast。

### 7.4 选择与多选

- 三个知识对象（论文 / 概念 / 公式）的多选模式**同构**：工具条「多选」切换 → 卡片左上出现勾选圆 → 底部 pick-bar（已选 N · 批量动作 · 退出）。论文列表的 `bulk-bar` 与知识页 `pick-bar` 合并为同一组件。
- 支持 Shift 点击区间选、Ctrl/⌘+A 全选当前筛选结果、Esc 退出。

> **P2 落地（v3.65）✅**：`js/core/multi-select.js` 的 `createMultiSelect({getSet, order, view, onChange, onExit})` 是三页唯一的选择逻辑；选中集合仍归页面持有。范围选与全选按 `order()`（**当前筛选 + 排序后的完整列表**，知识页懒加载未渲染的卡片也算）计；键盘经 `registerShortcut` 注册、只在 `body[data-view]` 等于本页时生效。底栏两套 DOM（论文库 `#bulk-bar` 有进度条与批量菜单，知识页 `pick-bar.js`）保留，但结构、文案、`role="toolbar"` 与禁用规则一致：「已选 N ｜ 全选 ↔ 取消全选 ｜ 退出多选 —— 动作」。

### 7.5 键盘

全局快捷键表（`?` 面板为唯一文档来源，新增快捷键必须登记）：

| 键 | 作用 | 状态 |
|---|---|---|
| `Ctrl/⌘ K` | 命令面板 | 已有 |
| `/` | 聚焦搜索 | 已有 |
| `?` | 快捷键帮助 | 已有 |
| `↓ / ↑` | 论文列表上下移动 | 已有（仅论文页）；**扩展到概念/公式页**，并补 `j / k` |
| `Enter` | 论文页：打开阅读器 | 已有；知识页改为打开详情抽屉/预览 |
| `s` | 当前论文星标切换 | 已有；知识页同语义 |
| `← / →`、`+ / -` | 阅读器翻页、缩放 | 已有 |
| `[ / ]` | 阅读器切换阅读架上一篇/下一篇 | 已有 |
| `Ctrl/⌘ D` | 放入/移出阅读架 | 已有 |
| `Esc` | 关闭最上层浮层 → 退出多选 → 清空搜索（逐级） | 已统一（v3.65 `layers.js` Esc 栈 + `multi-select.js`） |

- 现状问题示例：`js/bind.js:665-671` 的列表导航靠手动列举 `folder-manager / import-modal / discover-modal` 三个模态来判断"有没有浮层打开"，空间管理、目录向导、PWDialog、概念抽屉都不在名单里——这类"手写排除名单"必然随浮层增加而漏判，应改为询问 `layers.js` 的"当前是否有模态层"。

- 输入态（`isTypingTarget`）下单键快捷键让位。
- 新增全局键盘逻辑**必须**通过 §9.4 的层级管理器注册，禁止再在模块里直接 `document.addEventListener('keydown')`。

### 7.6 Hover 显形

- 静默 → hover 显形的元素，**必须**同时在 `:focus-within` 时显形（键盘用户），在 `@media (hover:none)` 下常显（触屏）。
- 显形只做 `opacity`，**禁止**改变布局（v3.35 的结论推广）。

### 7.7 文案

- 中文全角标点；省略号用「…」（单字符）；引号用「」，嵌套用『』。
- 按钮：动词或动词短语（「打开 PDF」「重新总结」），2–6 字，不加句号。
- 进行时：「总结中…」「保存中…」；完成时：「已保存」「已加入阅读架」。
- 数字与单位、中英文之间空一格（「11 个概念」「Qwen3 模型」）。
- 不在 UI 文案里使用 emoji 和 ✓✗⚠ 等字符。
- 术语表统一：论文 / 概念 / 公式 / 空间 / 收藏夹 / 阅读架 / 主题 / 标签 / 总结 / 笔记——同一事物不出现两个叫法。

---

## 8. 可访问性与主题基线

**可访问性（WCAG 2.2 AA）**

- 文字对比度 ≥ 4.5:1（大字 ≥ 3:1）；`--text-3` 只用于占位与禁用（不承载必读信息）。
- 交互目标 ≥ 24×24px。
- 所有可交互元素可 Tab 到达，焦点可见（`:focus-visible` 全局环保留）。
- 图标按钮 `aria-label`；状态变化 `aria-live`；导航当前项 `aria-current`（已有）；开关 `role="switch"`；tab `role="tab"`。
- 颜色不是唯一信号：状态徽章带文字或图标，错误输入带文案。
- `prefers-reduced-motion` 全局降级（保留 R4）。

**暗色主题清单（每个 UI PR 自检）**

1. 组件 CSS 中没有 `#hex`、`rgb(a)` 字面量、`white/black` 关键字。
2. 没有组件级 `html[data-theme="dark"] .xxx` 覆盖（新代码）；需要时说明为什么 token 无法表达。
3. 没有内联 `style` 色值（会压过主题覆盖，AGENTS 已有约定）。
4. 在浅/深两种主题下各截一张图附在 PR。

---

## 9. 技术规范（CSS / JS 工程化）

### 9.1 样式文件结构

零构建前提下，用原生 **CSS Cascade Layers** 解决"后写覆盖先写"的补丁依赖：

```
public/css/
  index.css            @layer reset, tokens, base, components, patterns, views, overrides;
                       @import 下列文件（各自声明所属 layer）
  tokens.css           原始层 + 语义层 + 暗色语义层（唯一允许出现色值的文件）
  base.css             reset、body 排版、滚动条、:focus-visible、reduced-motion、关键帧
  components/
    button.css  field.css  switch.css  seg.css  menu.css  badge.css  card.css
    overlay.css  tabs.css  toast.css  skeleton.css  empty.css  kbd.css  tooltip.css
  patterns/
    app-shell.css  sidebar.css  page-head.css  list-toolbar.css  pick-bar.css  row-form.css
  views/
    library.css  detail.css  chat.css  reader.css  concepts.css  formulas.css  settings.css
  vendor/
    pdfjs-overrides.css  katex-overrides.css
```

- 层的优先级由 `@layer` 声明顺序决定，与文件内书写顺序无关——**视图层永远压过组件层**，不再需要 `!important` 或"写在文件最后"。
- 视图 CSS 只做**布局与定位**，不重新定义组件外观；需要变体就在组件文件里加修饰类。
- 迁移方式：先把现有 `styles.css` 整体放进 `@layer legacy`（位于 `components` 之前），新组件写在更高的层，然后按组件逐块搬出 legacy，直至清空。整个过程页面不会出现覆盖顺序回归。

### 9.2 命名

- 组件：短前缀 + 元素，修饰用独立类：`.btn` `.btn.secondary.sm`，`.badge.success`，`.dialog.md`，`.drawer-head`。
- 状态：`.is-active / .is-selected / .is-busy / .is-open / .is-invalid / .is-starred`（逐步替换裸 `.active / .open / .on`）。
- JS 钩子：`data-*` 或 `id`；**禁止**用于样式选择的 id（`#theme-seg` 等存量迁移为类）。
- 视图前缀登记在本文附录 B，新前缀需先登记，避免同一前缀被两个模块各自使用；同一模块也不应有多个前缀（如阅读器现有 `rb- / reader- / rdr-` 三个）。

### 9.3 JS 组件化

在 `public/js/core/` 下补齐以下"单一入口"，视图模块只能通过它们生成 UI 原语：

| 模块 | 导出 | 替代 |
|---|---|---|
| `icons.js` | `icon(name, opts)`、sprite 注入 | 230 处内联 SVG |
| `ui-kit.js`（扩展） | `button({variant,size,icon,label})`、`badge(text,{variant,dot})`、`tag(name)`、`spinner(size)`、`emptyState({...})`、`skeleton(kind)` | 各模块手拼 HTML |
| `feedback.js` | `toast(msg,{level,action,duration})`、`inlineStatus(el,msg,level)` | `toast()` 与阅读器 `setStatus()` |
| `layers.js` | `openLayer({kind,el,trigger,onClose})`：遮罩、焦点陷阱、焦点归还、Esc 栈、`inert`、滚动锁；`registerShortcut(keys,handler,{scope})` | 23 处分散 keydown 与各浮层自管 Esc |
| `dialog.js`（改造） | `PWDialog.*` 改为基于 `layers.js`，危险确认默认聚焦取消 | 3 处 `window.confirm` |

模板函数输出的 HTML 一律经 `escapeHtml`；不在模板里写 `style="color:…"`。

### 9.4 自动化护栏（让规范可执行）

规范不落到工具上就会再次漂移。项目已有 `node --test` 文化，因此新增 **`tests/design-lint.test.js`**（纯文本扫描，毫秒级，进快速套件）：

| 规则 | 范围 | 策略 |
|---|---|---|
| 无 `#hex / rgb() / rgba(数字…)` 字面量 | `public/**/*.css` 除 `tokens.css` | **棘轮**：记录当前计数为基线，只许减不许增 |
| 无半像素 `font-size` 且值来自 `--fs-*` | 同上 | 棘轮 |
| `z-index` 只能是 `var(--z-*)` 或 1–9（局部） | 同上 | **硬约束**（P0 已清零） |
| `@media` 只出现 1240 / 1100 / 860 | 同上 | 棘轮（P2 收敛后改硬约束） |
| `@keyframes` 数量 | 同上 | 棘轮（P3 收敛到 `base.css` 的 `pw-*` 后改硬约束） |
| 无 `window.confirm/alert/prompt` | `public/**/*.js` | 硬约束 |
| 无 emoji / ✓✗☑☐⚠ 出现在字符串字面量中 | `public/**/*.js`、`index.html` 文本节点 | 棘轮 |
| 无内联 `style=` 色值 | `public/**/*.js`、`index.html` | 棘轮 |
| `role="dialog"` 元素必须有 `aria-modal` 与 `aria-labelledby/label`；每个 `.modal` 必须声明 `role="dialog"` | `index.html` | 硬约束 |
| icon-only `<button>` 必须有 `aria-label` | `index.html` | 棘轮 |
| `tokens.css` 先于 `styles.css` 加载，且组件引用的 `--z-*` 均已定义 | `index.html` / `tokens.css` | 硬约束 |

棘轮的计数**下降**时测试同样失败，提示把 `BASELINE` 改成新值——每次改进都会被锁住，不会悄悄回退。

可选：引入 `stylelint`（`declaration-property-value-allowed-list`、`color-no-hex`、`scale-unlimited/declaration-strict-value`）作为 `npm run lint:css`，与上面的测试互补。

### 9.5 组件样板间（Living Styleguide）

新增开发路由 `/__styleguide`（仅本地，静态 `public/styleguide.html`），按 §6 顺序渲染每个组件的所有变体 × 状态 × 浅/深主题。用途：

- 改组件时一眼看到全部变体的影响；
- e2e 里加一个 Playwright 截图用例做**视觉回归**（浅/深各一张），差异超阈值即失败；
- 新成员/新 agent 不读 CSS 也能知道"有什么可以用"。

---

## 10. 迁移路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 立规矩（1–2 天）✅ v3.63** | ① 建 `tokens.css`，补齐 §3 全部语义 token，旧名改为别名；② z-index / scrim / 动效 / `--font-mono` token 化；③ 设置覆盖层暗色改用全局 slate 底（修 P3）；④ 移除 3 处 `window.confirm`，PWDialog 危险确认默认聚焦取消；⑤ 概念页「+ 新增」降为 secondary；⑥ 侧栏底部入口固定；⑦ 详情加载立即出骨架；⑧ §1.3 小缺陷；⑨ 落地 `design-lint.test.js` 棘轮基线 | lint 测试通过；z-index 字面量 0；暗色设置与全站同色相 |
| **P1 收组件（3–5 天）✅ v3.64** | 按 §6 合并：Button 家族 → `.btn`；5 套输入 → `.field`；2 套开关 → `.switch`（含 `.switch.sm` 28×16）；分段控件 → `.seg`；徽章体系 → `.badge/.tag`；5 个 spinner → `.spinner`；`icons.js` + 替换全部 emoji。全部落在新文件 `public/components.css` | 字号 7 档（`--fs-*`，lint 上限）、半像素 / px 字号 0（硬约束）；控件高度 24/28/32/36（lint 棘轮，余 4 处：rail 38px 导航钮 + chip 内 × 微钮）；emoji 0（含 CSS content，硬约束）；已合并按钮族 100% 走 `.btn`（硬约束） |
| **P2 收浮层与交互（3–4 天）✅ v3.65** | `layers.js`：所有 Dialog/Drawer/Sheet 走统一外壳、焦点陷阱、Esc 栈；`feedback.js`：toast 分级 + 撤销、阅读器 `setStatus` 并轨；多选模式三页同构；P1 遗留（chip × 图标化、rail 38px） | 模态 100% 具备 `role/aria`（硬约束 `js.dialogWithoutLayer`）；`document` 级 keydown 监听 = 2 处、均在 layers.js（硬约束 `js.documentKeydown`）；非四档控件高度 0 |
| **P3 拆文件与样板间（2–3 天）** | `styles.css` 进 `@layer legacy` → 按 §9.1 逐块迁出；`/__styleguide` + 视觉回归用例；`!important` 清理 | `styles.css` 删除；`!important` ≤ 3；断点 3 个；关键帧 ≤ 8 |

每个阶段独立可发布，并在 CHANGELOG 里以「设计系统 P0/P1…」记录；AGENTS.md「关键约定」中加一条指向本文的链接，作为 agent 改 UI 前的必读。

---

## 附录 A：PR 设计自检清单

- [ ] 用到的颜色、字号、间距、圆角、阴影、层级、时长全部来自 token
- [ ] 复用了 §6 现有组件；若新增变体，已加到组件文件而不是视图文件
- [ ] 本区域最多一个 primary 按钮
- [ ] 图标来自 `icons.js`，无 emoji / 字符图标
- [ ] 所有状态都有样式：hover / focus-visible / disabled / busy / 空 / 错
- [ ] 浮层走 `layers.js`：Esc、焦点陷阱、焦点归还、`role="dialog"`
- [ ] 破坏性操作：可撤销 → 撤销 toast；不可撤销 → 危险确认（默认焦点在取消）
- [ ] 异步动作：`setBusy` + `finally` 恢复；失败有可行动的错误文案
- [ ] 图标按钮有 `aria-label`；快捷键已登记到 `?` 面板
- [ ] 浅色 / 深色截图各一张；`node --test` 含 design-lint 通过

## 附录 B：类名前缀登记（现状）

| 前缀 | 归属 | 前缀 | 归属 |
|---|---|---|---|
| `sa-` | 空间管理 | `fm-` | 收藏夹管理 |
| `sd-` | 自定义下拉 | `fsm-` | 状态筛选菜单 |
| `fp-` / `filter-` | 多选筛选浮层 | `cp-` | 命令面板 |
| `cd-` | 概念详情抽屉 | `fdv-` | 公式预览 |
| `fe-` | 公式编辑抽屉 | `pfd-` / `pfdlg` | 表单对话框 |
| `pwdlg-` | PWDialog | `rb-` / `reader-` / `rdr-` | 阅读器（三个前缀，P3 合并为 `rdr-`） |
| `rsd-` / `rsf-` | 阅读架抽屉 / FAB | `cms-` | 制品（概念图等） |
| `ps-` | 提示词工作台 | `sr-` / `set-` / `s-` | 设置行式布局（P3 合并为 `set-`） |
| `chat-` / `cmp-` / `co-` | 聊天 / 模型浮层 / 问答大纲 | `es-` | 空态 |
| `skel-` / `ds-` | 骨架 | `vn-` / `sc-` / `sp-` | 顶栏导航 / 状态胶囊 / 状态明细 |

## 附录 C：参考

- 现有设计决策出处：`styles.css` 内 v3.56（控件令牌、按钮三层）、v3.58（下拉统一规格）、v3.59（行式布局令牌）、R1–R10（v3.31/3.32 UI 迭代）。
- 外部参照：claude.ai cds（控件度量来源）、Radix Primitives（浮层可访问性行为）、WCAG 2.2（目标尺寸 2.5.8、焦点可见 2.4.7）、MDN `@layer`。
