# 设置中心重构 · 设计文档

> 日期：2026-06-23 · 状态：已批准，待实现

## 背景与问题

现有「设置中心」（`#settings-view`）是左导航 5 页结构：AI 接口、总结提示词、标签/主题提示词、主题与标签管理、关于。后端用 `store.settings` 做**运行时热覆盖**，但 `applySettingsOverride` 只覆盖了 `ai` 一块。

`config.json` 中还有一大批配置**完全没进设置界面**（用户痛点：「没同步当前配置」）：

- `scanIntervalMinutes`（文件扫描间隔）
- `arxiv`：`enabled` / `titleSimilarityThreshold` / `minIntervalMs`
- `discover`：`maxResults` / `perAxis` / `semanticScholar` / `semanticScholarApiKey` / `openAlex` / `recencyWindowYears` / `titleSimThreshold` / `claudeTimeoutMs` / `weights{rel,auth,rec}`
- `host` / `port` / `papersDir`（服务级，运行时不可改 → 只读展示）

## 目标

1. **配置全同步**：上述可调配置全部纳入设置并可编辑，运行时热生效（沿用 `store.settings` 覆盖机制，无需重启）。
2. **状态可见**：每个可编辑项展示「生效值 / config 默认值 / 是否已被覆盖」，并能一键恢复默认。
3. **外观升级**：保留左导航 + 右内容框架，分组导航、新增「概览」仪表盘、统一字段样式、设置内搜索，符合顶级论文产品调性。

非目标（YAGNI）：直接写回 `config.json`；改 host/port/papersDir 等需重启项（仅只读展示）。

## 信息架构（左导航分组）

| 分组 | 条目 | 数据 / 动作 |
|---|---|---|
| 总览 | **概览**（新） | 生效配置全景仪表盘 + 服务状态 + 「N 项已覆盖 config」汇总 + 一键全部恢复 |
| 智能 | AI 接口 | `ai.*`（沿用，套新字段样式） |
| 智能 | 总结提示词 | `summaryPrompt`（沿用） |
| 智能 | 标签 / 主题提示词 | `tagsPrompt`（沿用） |
| 采集 | **文件扫描**（新） | `scanIntervalMinutes` |
| 采集 | **arXiv 元数据**（新） | `arxiv.{enabled,titleSimilarityThreshold,minIntervalMs}` |
| 采集 | **主题发现**（新） | `discover.*`（含 `weights`） |
| 数据与系统 | 主题与标签 | taxonomy（沿用） |
| 数据与系统 | **系统信息**（新） | host/port/papersDir/version/papers 只读 + 健康 + 可折叠「原始 config.json 只读」 |

## 统一字段样式（核心 UX）

每个可编辑项渲染为：**label + 「已覆盖 config」徽标（仅当该字段在 `store.settings` 中存在覆盖时显示）+ 生效值输入 + 默认值提示（config.json / 内置）+ 保存/恢复默认 + 保存态回显**。

- 布尔项用开关；数值/字符串用 input；`discover.weights` 三轴用三个数值输入为一组。
- 密钥（`ai.apiKey`、`discover.semanticScholarApiKey`）沿用掩码策略：回显 `********` 表示未改动；空串 = 清空；掩码或未传 = 保持原值。

## 后端设计

### 1. `lib/ai.js` — 泛化 `applySettingsOverride`

当前仅合并 `ai`。扩展为同时合并 `scanIntervalMinutes`、`arxiv`、`discover`（深合并 `discover.weights`），返回新的 `effConfig`，不污染原 `config`。

合并规则：
- `ai` 段**保持现有行为不变**（白名单 5 字段，`!== undefined && !== ''` 才覆盖）。
- 新增段（scan/arxiv/discover）规则改为 **`!== undefined` 即覆盖**，以正确处理布尔 `false`（如 `arxiv.enabled:false`）与数值 `0`（如 `scanIntervalMinutes:0` 关闭定时扫描）。
- 字符串「空串=清空」语义仅对密钥类字段（`semanticScholarApiKey`）保留，其余字符串空串按普通值覆盖。
- 各段按白名单字段拷贝，未知字段忽略。

### 2. `lib/scanner.js` — 扫描间隔热生效 + arxiv 读 effConfig

- 把构造参数 `scanIntervalMs` 存入可变局部 `let currentIntervalMs`；`start()` 用它建定时器。
- 新增 `reschedule(minutes)`：`clearInterval(timer)` → `currentIntervalMs = minutes*60*1000` → `minutes>0` 时重建定时器，否则停表。加入返回对象。
- `processOne` 顶部提前算 `effConfig = applySettingsOverride(config, store.settings)`；arXiv 段把 `deps.config.arxiv.*` 改读 `effConfig.arxiv.*`（`enabled` / `minIntervalMs` / `titleSimilarityThreshold`），使 arxiv 覆盖热生效。（`timeoutMs` / `maxRetries` 不在设置范围，仍可读 effConfig，回退默认。）

### 3. `lib/api.js` — 端点

- **扩展 `GET /api/settings`** 返回：
  - 智能：`ai`（生效，掩码）、`configAi`、`summaryPrompt/configPrompt/defaultPrompt`、`tagsPrompt/defaultTagsPrompt`
  - 采集：`scan/configScan`、`arxiv/configArxiv`、`discover/configDiscover`（discover 含 `hasS2Key` + 掩码，`weights`）
  - `overrides`：`{ ai:[字段], scan:[..], arxiv:[..], discover:[..], summaryPrompt:bool, tagsPrompt:bool }`，列出 `store.settings` 中实际存在覆盖的键，供徽标与「N 项已覆盖」计数。
  - `system`：`{ host, port, papersDir, version, papers, rawConfig }`（rawConfig 为脱敏后的 config.json 只读，apiKey 掩码）。
- **新增** `PUT /api/settings/scan` `{ scanIntervalMinutes }`：白名单校验（整数 ≥0）→ 写 `store.settings.scanIntervalMinutes` → save → `scanner.reschedule(eff)` → 回 `{ scan }`。
- **新增** `PUT /api/settings/arxiv` `{ enabled?, titleSimilarityThreshold?, minIntervalMs? }`：白名单 → 写 `store.settings.arxiv` → save → 回 `{ arxiv }`。
- **新增** `PUT /api/settings/discover` `{ maxResults?, perAxis?, semanticScholar?, semanticScholarApiKey?, openAlex?, recencyWindowYears?, titleSimThreshold?, claudeTimeoutMs?, weights? }`：白名单 + 密钥掩码保护 → 写 `store.settings.discover` → save → 回 `{ discover }`。
- **新增** `POST /api/settings/reset` `{ section }` 或 `{ all:true }`：删除 `store.settings` 对应段（`all` 清空除审计字段外全部覆盖）→ save → 若涉及 scan 则 `scanner.reschedule(config 默认)` → 回 `{ ok:true }`。前端 reset 后重新 `GET /api/settings` 刷新。

所有写端点维持现有 `store.settings.updatedAt = Date.now()` 审计。

### 4. `server.js`

`scanner` 已通过 `createApiRouter({ store, save, scanner, config })` 注入，无需改动接线；确认 `scanner.reschedule` 暴露后可用。

## 前端设计

- `public/index.html`：导航重构为分组（带分组小标题）；新增 `概览`、`文件扫描`、`arXiv 元数据`、`主题发现`、`系统信息` 五个 panel；顶部加设置内搜索框。
- `public/app.js`：
  - `loadSettingsData` 扩展渲染所有段 + 徽标（依据 `overrides`）+ 默认值提示。
  - 概览仪表盘：metric 卡（模型/扫描间隔/arXiv/发现来源/论文数/服务状态）+ 「N 项已覆盖」+ 全部恢复。
  - 新增 `saveScan / saveArxiv / saveDiscover / resetSection / resetAll` 处理器，保存后刷新徽标。
  - 设置内搜索：按 label/关键词过滤导航条目并定位（轻量实现）。
- `public/styles.css`：分组导航小标题、metric 卡、覆盖徽标、开关、危险区等样式（沿用 Indigo / slate 设计令牌）。

## 测试（TDD，配套 `node --test`）

先写后端测试看其失败，再实现：

- `tests/ai.test.js`：`applySettingsOverride` 对 scan/arxiv/discover 的合并 —— 布尔 `false` 生效、数值 `0` 生效、`discover.weights` 深合并、未设字段透传 config、ai 段行为不回归。
- `tests/api.test.js`：`GET /api/settings` 含新段与 `overrides`/`system`；`PUT /scan|/arxiv|/discover` 持久化与回显；密钥掩码保护；`POST /reset` 各分支。
- `tests/scanner.test.js`：`reschedule` 重置定时器（用注入计时或断言无抛错 + 行为）；arxiv 段读 effConfig（`store.settings.arxiv.enabled:false` 时跳过补全）。

前端：手动 + preview 验证。

## 风险与注意

- **合并规则布尔/0**：新增段必须用 `!== undefined`，沿用 ai 的 `!== ''` 会吞掉 `false`/`0` —— 已在设计中区分。
- **`deps.saveStore(store)` 单参**：写端点保存沿用现有 `save` 闭包，勿误传两参。
- **arxiv rateLimit**：全局 `deps.rateLimitArxiv` 的 minInterval 在 server 启动时由 config 固化，本次仅让 `searchArxiv` 的逐调用 `minIntervalMs` 走 effConfig 热生效（足够且正确），不动全局限流器。
