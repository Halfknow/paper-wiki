# 导航与信息架构重构设计（v3.17）

> 日期：2026-08-04
> 目标：把顶栏从「什么都往里塞的一行」重构成纯 app chrome，确立「一个空间，三种切面」的信息架构。

## 背景与问题诊断

当前顶栏一行里混了四种性质完全不同的元素：**身份标识**（logo / 空间切换器）、**页面导航**（概念 / 公式按钮）、**论文页专属筛选**（状态 / 主题 / 标签 / 仅星标）、**全局动作与状态**（导入 / 发现 / 扫描 / stats）。由此派生出 6 个真实矛盾：

1. **搜索归属矛盾**：`#search` 写死 `placeholder="搜索论文…"`，但在概念页照样显示；而概念页自己还有一个 `#concept-q`。同屏两个搜索框，一个不管用。公式页同理。
2. **筛选条矛盾**（比搜索更严重）：`.filter-strip` 的四个筛选器只对论文有效，在概念 / 公式页原样杵着；而概念页的分类筛选却藏在页内一个漏斗图标 `#concept-filter-btn` 里。同一个概念，两套范式。
3. **返回箭头与平级导航矛盾**：`#btn-concepts-close` / `#btn-formulas-close` 是「模态 / 下钻」的交互语言，与「三个平级页面」的心智模型直接冲突。
4. **设置入口不可达（实质缺陷）**：`#btn-settings` 位于 `#library-view` 内的侧栏 footer。切到概念 / 公式页时整个 `#library-view` 被 `display:none`，**设置入口随之消失**，只能先退回论文库。
5. **stats 与导航语义重复**：`renderStats` 输出的「N 概念」「N 公式」pill 与顶栏的「概念」「公式」按钮表达同一组数字。
6. **骨架不一致**：论文页是「侧栏 + 列表 + 详情」三栏，概念 / 公式页全宽无侧栏。三个「平级页面」布局骨架完全不同，切换时整体塌陷重建。

另有一个明确的渲染缺陷：**深链 `/concepts` 刷新时先闪现论文页**。根因有两处，缺一不可修：

- `index.html` 中 `#library-view` 没有 `display:none`（其余三个视图都有），首帧必然是论文页；
- `showConcepts()` 中 `showView('concepts')` 排在 `/api/concepts` + `/api/papers` + `/api/settings` 三个网络请求**之后**。

## 设计原则

**顶栏管全局，工具条管本页。** 顶栏只承载四类元素：身份（logo / 空间）、导航（三页分段）、查找（上下文搜索）、全局动作与状态（添加 / 状态 / 设置）。任何只对某一页有意义的控件，一律下沉到该页自己的工具条或侧栏。

**概念与公式是当前空间论文的派生物**（概念卡片上的论文胶囊能跳回论文即是证据），不是独立语料库。因此它们既不是模态，也不是另一个应用，而是同一份知识库的三个切面 —— 这要求三页共享同一套骨架。

## 一、顶栏最终形态

```html
<header class="topbar">
  <div class="brand">PW</div>
  <div class="space-switcher">…</div>
  <nav class="view-nav" id="view-nav">
    <a href="/library"  data-view="library">论文<span class="vn-count">128</span></a>
    <a href="/concepts" data-view="concepts">概念<span class="vn-count">512</span></a>
    <a href="/formulas" data-view="formulas">公式<span class="vn-count">87</span></a>
  </nav>
  <span class="topbar-spacer"></span>
  <div class="search-wrap">…</div>
  <div class="status-chip" id="status-chip">…</div>
  <div class="add-menu" id="add-menu">+ 添加 ▾</div>
  <button class="icon-btn" id="btn-settings-top">⚙</button>
</header>
```

### 导航用 `<a href>` 而非 `<button>`

`js/core/router.js` 已实现站内 `<a>` 拦截，因此中键可开新标签页、右键可复制链接、hover 有真实 URL 预览。三个「页面」如果连链接都不是，就不配叫页面。`keepParams: ['space']` 保证 `?space=` 跨导航自动携带，无需在 href 里写。

### 视觉「融为一体」的具体做法

分段组整体是一个 `--radius-sm` 圆角容器，`height:34px`、`background:rgba(241,245,249,.86)`、`border:1px solid var(--border)` —— 与左侧 `.space-current`、右侧 `.filter-trigger` 共用同一套设计 token。选中段为 `background:var(--accent-soft); color:var(--accent-strong)` 的内嵌胶囊，**不加外阴影**（避免浮起来破坏「嵌在 bar 里」的观感）。视觉上它读作「空间切换器的延伸」，即「在 xx 空间里看 xx」，与实际语义层级一致。

### 计数徽标

`.vn-count` 挂在导航段上，数据来自 `renderStats` 已有的 `stats.total / stats.concepts / stats.formulas`（全局统计，不随筛选变）。同时删除 stats 里重复的「N 概念 / N 公式」pill。

### 筛选条下沉

`.filter-strip`（状态 / 主题 / 标签 / 仅星标）整体从顶栏移入论文页的 `.list-toolbar`。这是消除矛盾 2 的根本办法。

## 二、上下文搜索

单一 `#search`，行为按当前视图分派：

| 页面 | placeholder | 行为 | 附属控件 |
|---|---|---|---|
| 论文 | 搜索论文… | 现有 DSL / 回车全文检索，逻辑完全不动 | 语法帮助、高级搜索、保存的搜索 chip 行 |
| 概念 | 搜索术语或解释… | 复用现 `#concept-q` 的 handler | 隐藏 |
| 公式 | 搜索公式名、LaTeX 或解读… | 复用现 `#formula-q` 的 handler | 隐藏 |

页内 `#concept-q` / `#formula-q` 删除。各页查询词**各自进 URL**（`/concepts?q=attention`、`/formulas?q=softmax`），与论文页对称 —— 三个平级页面应有对称的深链能力，切走再切回来查询词仍在。`Ctrl+K` 永远聚焦 `#search`。

切页时不清空各页记忆的查询词：查询词随路由 query 走，路由器负责还原。

## 三、状态胶囊与动作收敛

`#stats` 的五个 pill 换成单一 `#status-chip`：

- **空闲**：8px 灰点，仅图标态
- **处理中**：indigo 脉冲点 + `3 处理中`（**不折叠**）
- **有错误**：红点 + `1 错误`（**不折叠**）

即「正常时收起，异常时自己跳出来」。后台任务失败却完全静默是可用性红线，不允许把错误全藏进 hover。

hover / 点击展开 popover：就绪 `ready/total`、处理中明细（复用现有按 `status` 聚合的 `detail` 文案）、错误数、上次扫描时间，底部一个「立即扫描」按钮。

`#btn-import` / `#btn-discover` 合并为 `+ 添加 ▾` 下拉（从 arXiv 导入 / 按主题发现）；`#btn-scan` 移入状态 popover 的「立即扫描」—— 它本质是重建索引，归属状态维护而非主动作。顶栏右侧控件从 5 个降到 3 个。

## 四、闪现修复（两处根因）

**首帧**：把视图显隐从 inline `style.display` 换成 class（`.view-hidden { display:none !important }`，`showView` 切 class），并在 `<head>` 内加一段内联脚本，依据 `location.pathname` 同步为正确的视图去掉该 class。**在任何 JS 模块加载之前定好首帧**，零闪现。

改用 class 而非继续用 inline style 的原因：现 `showView` 靠 `style.display=''` 恢复，依赖各视图在 CSS 里的默认 display 值（`.layout` 是 grid、`.page-view` 是 flex）。内联脚本若要在首帧设对，就得复制这套默认值，脆弱。class 方案无此耦合。

**二次延迟**：`showConcepts()` / `showFormulas()` / `openSettings()` 中，`showView()` 提到所有 `await` 之前，先出骨架屏，数据到达后再 render。

## 五、骨架统一（第二步）

`.layout` 从 `#library-view` 内部提到外层，成为三页共享的 app shell。`.sidebar` / `.sidebar-rail` 常驻，内容按当前视图渲染：

- **论文**：视图（全部 / 星标 / 未读）+ 收藏夹 —— 现状不变
- **概念**：全部概念 · 按分类（11 类 `category`，带计数）· 分隔 · 概念地图（制品数）。把现藏于 `#concept-filter-btn` 漏斗图标内的分类筛选、以及 `#concept-view` 的「清单 / 地图」分段一并搬入侧栏；页内工具条只剩排版 / 排序 / 下载
- **公式**：全部公式 · 按分类（带计数）

同时：

- 删除 `#btn-concepts-close` / `#btn-formulas-close` 两个返回箭头
- 删除侧栏 footer 的 `#btn-settings` 与 rail 的 `#rail-btn-settings`，设置入口统一到顶栏齿轮（避免三个入口）
- 设置改为覆盖层呈现：保留 `/settings/:tab` 路由（深链有价值），加遮罩 + Esc 关闭 + 关闭回到上一个路由，明确「不是第四个 tab」

### 风险

集中在两点：`.layout` 的 grid + `min-height:0` 三列滚动约定（AGENTS.md 陷阱 5）；`#library-view` 这个 id 被 `js/views/view-switch.js` 与多个 jsdom 测试（`routing-ui` / `conceptmaps-ui` / `regression-ui`）引用。故第二步必须与第一步分开提交。

### 实施后的偏差（实现时发现，已按此落地）

1. **筛选条下沉推迟到第二步之后**。第一步原计划把 `.filter-strip` 移进 `.list-toolbar`，实测不可行——列表列最窄 320px（`--list-width` 默认 410px），四个下拉必然溢出。第一步改为「随视图隐藏」，完整下沉需要一条横跨内容区全宽的 page-toolbar 带，留作后续。
2. **`.view-hidden` 必须 `display:none !important`**。它与 `.layout { display:grid }` 特异性同为 `(0,1,0)`，靠先后顺序定胜负，`.layout` 更靠后就赢——表现为「class 加上了但没真隐藏」。这是第一步引入、第二步截图时才发现的缺陷；jsdom 抓不到（不加载外部 CSS，只能断言 class），故 `scripts/verify-boot-view.mjs` 补了「放开 app.js 点导航切页后复读 computed display」的第二遍。
3. **概念分类清单改从数据现算**。原方案沿用 `_CONCEPT_CATEGORIES` 枚举，实测模型会返回枚举外的分类值，照枚举列会让那些概念在分面里彻底消失。改为从 `state.concepts` 现算，枚举只提供中文标签与已知分类排序。
4. **设置覆盖层关闭回「来路」而非固定 `/library`**。原方案只写了「关闭后回到上一个路由」，实现上由 `bind.js` 的 `closeSettingsOverlay` 记录打开前的 URL 收口，深链无来路时才兜底 `/library`。

## 落地顺序

**第一步（低风险，消除全部逻辑矛盾）**：顶栏重构（分段导航 + 计数徽标 + 上下文搜索 + 状态胶囊 + 添加下拉 + 设置齿轮）、筛选条下沉至 `.list-toolbar`、闪现两处修复、设置入口全局化。

**第二步（骨架统一）**：`.layout` 提到外层、侧栏常驻并按视图渲染内容、删返回箭头与冗余设置入口、设置改覆盖层。

每步独立验证、独立提交。

## 测试

新增 `tests/topbar-nav.test.js`（jsdom，走 `helpers/ui.js` 的 `bootUi`）覆盖：

- 深链 `/concepts` 首帧不出现论文页（`#library-view` 带 `.view-hidden`）
- 导航段 `active` 态随路由切换
- 搜索 `placeholder` 随视图切换
- 三个视图下 `#btn-settings-top` 均存在且可点击
- `#status-chip` 在 `processing > 0` / `error > 0` 时输出可见文案（不被折叠）
- 概念页 `?q=` 深链还原查询词

现有 `tests/routing-ui.test.js` 同步调整。按项目纪律：先写测试看其失败，再实现。
