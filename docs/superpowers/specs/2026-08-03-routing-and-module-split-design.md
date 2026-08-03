# PaperWiki 路由化重构与前端模块拆分设计

- 日期：2026-08-03
- 分支：`refactor/routing`
- 基线提交：`dc5c3ad`
- 基线测试：595 例通过（`ai.test.js` 的 `timeoutMs=50` 断言在并行满载下偶发 flaky，单文件跑 73 例全绿，与本次重构无关）

## 1. 问题

`public/app.js` 已达 6960 行 / 366 KB。改一处聊天输入框的行为，就要把约 180k tokens 灌进上下文，基于 agent 的开发难以为继。

诊断结果，根因有三层：

| 层次 | 现状 | 证据 |
| --- | --- | --- |
| 无 URL 路由 | 视图切换靠 `showView()` 改 `display:none` | app.js 内 `location.*` / `history.*` / `popstate` 命中数为 0 |
| 单文件承载 9 个子系统 | 库列表、详情、笔记、聊天、概念、公式、设置、空间、搜索 GUI | app.js 1–6960 行 |
| 事件接线集中 | `bind()` 单函数 772 行，跨所有子系统 | app.js 5273–6045 行 |

后端同构：`createApiRouter` 内是一条约 1800 行的 `if (pathname === … && method === …)` 长链（`src/api/router.js` 409–2100 行）。

没有路由，就没有天然的模块边界——这是「拆不动」的真正原因，而不仅仅是文件太长。

## 2. 目标与非目标

**目标**

1. 引入生产惯例的前端路由（History API + 干净 URL + 服务端 SPA fallback）。
2. 将 `public/app.js` 拆为约 40 个单一职责模块，每个文件低于 450 行。
3. 将后端 `createApiRouter` 的 if 链重构为声明式路由表 + 按领域分文件。
4. 补齐单元测试：纯函数层新增毫秒级单测，jsdom 集成测试保留并新增路由集成测试。

**非目标（本轮明确不做）**

- 不重构 `public/reader.js`（2815 行，独立模块）——只为它增加 `/reader/:id` 路由入口。
- 不引入构建工具或打包器，保持原生 ESM 直出，与项目「零构建」现状一致。
- 不改任何 HTTP 契约、数据模型或视觉表现。
- 不做与路由无关的重构。

## 3. 前端路由设计

### 3.1 路由表

```
/                          → 重定向到 /library
/library                   → 库视图；筛选状态在 query
/paper/:id                 → 库视图 + 选中论文，tab 默认 summary
/paper/:id/:tab            → tab ∈ summary | notes | chat | info
/reader/:id                → 阅读器全屏
/concepts                  → 概念清单
/concepts/maps             → 概念地图制品列表
/concepts/maps/:id         → 打开指定地图制品
/formulas                  → 公式清单
/settings                  → 重定向到 /settings/overview
/settings/:tab             → tab ∈ overview | ai | channels | prompts | collect | taxonomy | spaces | system
```

未匹配的路径重定向到 `/library`。

### 3.2 Query 参数约定

库视图筛选状态全部落在 query，可分享、可收藏、可前进后退：

```
?q=<搜索/DSL>&status=<状态>&read=<阅读态>&tag=a,b&topic=x,y
&tagOp=or|and&topicOp=or|and&starred=1&folder=<id>&sort=<排序>&mode=<检索模式>
```

`space` 是**全局保留参数**，路由器在任何导航间自动携带：

```
/paper/9f2a1b3c?space=cv-papers
/library?q=diffusion&space=cv-papers
```

优先级：URL 的 `?space=` > `localStorage['pw-space']` > 服务端 active 空间。空间切换时写回 localStorage 并 `replaceState` 更新 URL。

省略默认值：与默认相同的参数不写进 URL，避免 `/library?status=&sort=addedDesc&starred=0` 这种噪声。

### 3.3 路径命名约束

论文详情用**单数** `/paper/:id`。`/papers/` 前缀已被 `src/server.js` 占用于 PDF 原文静态服务（含 HTTP Range 支持），不可冲突。

### 3.4 路由器模块 API

`public/js/core/router.js`：

```js
// 纯函数（无 DOM 依赖，可脱离 jsdom 单测）
export function matchRoute(routes, pathname)      // → { route, params } | null
export function buildPath(pattern, params)        // '/paper/:id/:tab' + {id,tab} → '/paper/x/chat'
export function parseQuery(search)                // → 普通对象
export function stringifyQuery(obj, defaults)     // 省略等于 defaults 的键
export function isReservedPath(pathname)          // /api /papers /vendor /js 及带扩展名

// 有状态部分
export function createRouter({ routes, onNavigate, keepParams })
//   .start()                     绑定 popstate、拦截 [data-link] 点击、首次 resolve
//   .navigate(path, { replace, query, keepQuery })
//   .setQuery(patch, { replace }) 只改 query 不换视图（筛选变化用）
//   .current()                   → { name, path, params, query }
//   .stop()
```

匹配规则：静态段优先于参数段；先注册先匹配；末尾斜杠归一化；参数值 `decodeURIComponent`。

### 3.5 视图生命周期

每条路由声明 `{ name, pattern, enter(ctx), leave() }`。路由器在切换时调用旧路由的 `leave()`（用于停轮询、flush 未保存的内联编辑）再调用新路由的 `enter(ctx)`。这把现有散落的 `_stopConceptMapPolling()` / `flushPendingNotes()` 收口到统一时机。

### 3.6 服务端 SPA fallback

`src/server.js` 在静态文件分支前插入判定：

- 保留前缀 `/api/`、`/papers/`、`/vendor/` → 走原有逻辑
- 路径含扩展名（`/app.js`、`/styles.css`、`/js/core/router.js`）→ 走静态文件
- 其余无扩展名路径 → 返回 `public/index.html`（`Cache-Control: no-cache`）

判定抽为纯函数 `isAppRoute(pathname)` 并导出，便于单测。

## 4. 前端模块拆分

`public/app.js` 缩至约 60 行，只做 import 与 boot。`index.html` 与 `tests/helpers/ui.js` 的加载路径保持 `/app.js` 不变，改动面最小。

```
public/js/
  core/
    router.js            路由器（纯匹配函数 + 导航状态机）
    routes.js            路由表定义与各视图 enter/leave
    api.js               sp / api / jget / POST / PUT / PATCH / DEL / safeGet / streamChatFetch
    state.js             state 单例、setView、notesState / chatState 访问器
    dom.js               $ / escapeHtml / toast / setBusy / renderMd / fixCjkStrong
    format.js            CHIP_PALETTE / chipOf / statusDot / statusLabel / starBadge /
                         shortAuthors / chipList / progressPercent / renderStats
  library/
    refresh.js           refresh()
    list.js              renderList / 全文检索结果 / triggerSearch
    sidebar.js           renderSidebar / 文件夹拖放
    filters.js           renderFilters / 状态菜单 / 标签主题筛选浮层
    bulk.js              多选与批量操作
    folders.js           收藏夹模态
  detail/
    detail.js            select / renderDetail / renderTabBody / patch
    info-tab.js
    notes-panel.js       NotesPanel 与笔记卡片
    chat-md.js           renderChatMd / 代码块折叠
    chat-view.js         renderChatTab / 消息 HTML / 大纲
    chat-input.js        参数面板 / 输入框 / 额外论文 chips
    chat-mention.js      @ 提及选择器
    models.js            模型切换器
  concepts/
    concepts.js
    concept-maps.js
  formulas/
    formulas.js
    formulas-masonry.js
  settings/
    settings.js          openSettings / tab / 自定义下拉 / loadSettingsData / overview / system
    channels.js          渠道管理
    prompts.js           各提示词保存
    collect.js           scan / arxiv / discover / translate / formula-engine / mineru / reset
    taxonomy.js          主题标签管理
  spaces/
    spaces.js
    dir-wizard.js
  search/
    advanced-panel.js
    suggest.js
    saved-searches.js
    help.js
  reader-host.js         openReader / syncLocalAnnotations
  layout.js              侧栏收起 / 列表宽度分隔条
  bind.js                汇总调用各模块的 bindXxx()
  boot.js                启动序列
```

`bind()` 的 772 行按领域打散到各模块自己的 `bindLibrary()` / `bindChat()` / `bindSettings()` 等，`bind.js` 只负责按序调用。

现有 `window.*` 导出（`window.pwState`、`window.PaperWikiSearchGUI`、`window.NotesPanel` 等，供 `reader.js` 与测试消费）全部保留，集中到 `boot.js` 一处声明，避免散落。

### 4.1 循环依赖策略

`state.js` 与 `dom.js` 是叶子模块，不依赖任何视图模块。视图模块之间若需互相调用（如 `list.js` 需要 `select()`），通过 `core/routes.js` 的导航间接完成（点击列表项 → `router.navigate('/paper/'+id)` → 路由 enter 调 `select()`），而不是直接 import。这条规则同时消除了大部分潜在环。

## 5. 后端路由重构

```
src/api/
  route-table.js     纯函数匹配器
  views.js           summaryView / detailView / channelView / aiSettingsView 等纯视图函数
  router.js          组装 ctx + 注册路由模块 + dispatch（保留现有导出）
  routes/
    spaces.js  papers.js  settings.js  taxonomy.js  concepts.js
    concept-maps.js  formulas.js  search.js  discover.js  ai.js  system.js
```

`route-table.js`：

```js
export function createRouteTable()
//   .get(pattern, handler, opts)  .post()  .put()  .patch()  .delete()
//   .match(method, pathname)      → { handler, params, opts } | null
```

各 `routes/*.js` 导出 `register(table, ctx)`。

Handler 统一签名：

```js
async (req, res, { params, query, body, store, save, space, spaceId, ctx })
```

空间解析由 dispatcher 统一执行（`opts.space === false` 的路由跳过，如 `/api/spaces/*`），取代目前每个分支各自调 `resolveSpace(q)`。

`router.js` 继续导出 `{ createApiRouter, summaryView, detailView }`，保持 `src/server.js` 与现有测试的 import 不变。

**对外 HTTP 契约完全不变**——`tests/api.test.js`（113 KB）一行不改仍全绿，这是重构正确性最强的证据。

## 6. 测试设计

### 6.1 新增纯单测（无 jsdom，毫秒级，不进 slow guard）

| 文件 | 覆盖 |
| --- | --- |
| `tests/frontend-router.test.js` | `matchRoute` 静态优先 / 参数提取 / 多参数 / 未匹配返回 null / 尾斜杠归一 / URL 编码；`buildPath` 往返；`parseQuery` / `stringifyQuery` 省略默认值往返；`isReservedPath` |
| `tests/api-route-table.test.js` | method 分派 / 参数提取 / 静态路径优先于参数路径 / 未注册返回 null / 同路径多 method |
| `tests/spa-fallback.test.js` | `isAppRoute` 对 `/api/x`、`/papers/a.pdf`、`/vendor/katex.js`、`/app.js`、`/js/core/router.js`、`/paper/abc`、`/settings/ai`、`/` 的判定 |

### 6.2 新增 jsdom 集成测试

`tests/routing-ui.test.js`：

- 深链 `/paper/:id/chat` 直达并渲染聊天 tab
- 深链 `/settings/channels`、`/concepts/maps`、`/formulas` 直达对应视图
- 点击列表项后 URL 变为 `/paper/:id`
- 切 tab 后 URL 变为 `/paper/:id/notes`
- 修改筛选后 query 更新，且默认值不写入 URL
- `popstate`（后退）回到上一视图并恢复筛选
- 未知路径 `/nope` 回退到 `/library`
- `?space=` 深链使 API 请求带上正确的空间参数

### 6.3 改造

- `tests/helpers/ui.js`：新增 `initialPath` 选项（默认 `/library`）与 `back()` / `forward()` 辅助（jsdom 支持 `pushState`，`popstate` 需手动派发）。
- 现有 8 个 jsdom UI 测试：断言均在 DOM 层，预计大部分零改动；个别隐含「启动即 library」假设的补 `initialPath`。

### 6.4 验收标准

- 全量 `PW_FULL_TESTS=1 node --test` 通过数 ≥ 595 + 新增例数，失败 0（flaky 的 `timeoutMs` 例除外）
- `npm run lint` 与 `npm run format:check` 通过
- `public/app.js` < 100 行；`public/js/**` 单文件 < 450 行；`src/api/**` 单文件 < 450 行
- `tests/api.test.js` 零改动

## 7. 实施顺序

每个 Phase 结束跑一次全量测试，保持绿色。

| Phase | 内容 | 验证 |
| --- | --- | --- |
| 1 | 后端 `route-table.js` + `views.js` + `routes/` 拆分 | `api.test.js` 零改动全绿 + 新增 `api-route-table.test.js` |
| 2 | `server.js` SPA fallback + `isAppRoute` | 新增 `spa-fallback.test.js` |
| 3 | 前端 `core/` 抽取（api / dom / state / format） | 现有 UI 测试全绿 |
| 4 | 路由器 + 路由表 + `routes.js` 接入 | 新增 `frontend-router.test.js` + `routing-ui.test.js` |
| 5 | 按领域拆分 views（每拆一域跑一次全量） | 全量 |
| 6 | `bind()` 打散 | 全量 |
| 7 | lint / format / 全量回归 / 更新 AGENTS.md 与 CHANGELOG.md | 全绿 |

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| ESM 拆分引入循环依赖导致 TDZ 报错 | 遵守 §4.1 分层规则；每 Phase 跑 jsdom 集成测试，import 环会在 boot 阶段立刻炸出来 |
| 后端 if 链有隐式顺序依赖（前缀匹配先命中） | 逐条迁移，保留原顺序注册；`api.test.js` 零改动作为回归网 |
| jsdom 的 History API 行为与浏览器有差异 | 路由匹配逻辑做成纯函数单测；jsdom 只测「URL 变了 → DOM 变了」这层 |
| Docker 镜像需重建才生效 | 前端文件全部打进镜像，验证时执行 `docker compose up -d --build app` |
| 新增 `public/js/**` 静态目录未被服务 | `server.js` 静态分支已按 `PUBLIC_DIR` 前缀放行子目录，无需改动；由 SPA fallback 的扩展名判定保证 `.js` 不被吞掉 |
