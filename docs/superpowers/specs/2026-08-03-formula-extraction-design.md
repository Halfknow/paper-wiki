# PaperWiki 公式抽取与归一化清单设计（v3.9）

> 日期：2026-08-03　状态：已确认（用户逐项决策）
> 目标：每篇论文抽取核心公式 → 归一化到一般形式 → 跨论文合并为空间级公式清单；每条公式带解读、
> 符号表与出处，可从清单跳转回论文。函数图像绘制本次不做，但数据结构预留。

## 已确认决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 跨论文合并 key | **规范名（canonicalName）做 key** | 与 `mergeConcepts` 完全同构（陷阱 4 语义），实现最轻、行为可预测；模型给规范名比给一致 LaTeX 稳定得多 |
| 抽取通道 | **文本自动抽取 + 阅读器框选补录** | 自动拿 80% 覆盖；剩余 20% 复用已有 `cropRegionToImage` + 视觉通道人工精修。零新依赖 |
| 条目信息量 | **结构化**（含 `variables[]` / `plottable` / `plotHint`） | 抽取是花钱的；一次把画图元数据一起要出来，将来做图无需重跑全库 |
| 输入预算 | **按任务分预算**，设置页可改 | 用户模型 128k 上下文；公式需要的窗口比总结大一个量级，共用全局值互相拖累 |
| LaTeX 指纹二级去重 | 不做（v2 候选） | 需先跑过全库看真实重复率再决定值不值得 |

### 前置实测（决策依据）

1. **pdfjs 抽出的正文里，行间公式结构会塌掉。** 实测 `Sharp Minima Can Generalize For Deep Nets`：
   `max θ ′ ∈ B 2 ( \u000f,θ ) ( L ( θ ′ ) − L ( θ ) ) 1 + L ( θ )` —— 分式横线丢失（分子分母拼成一行），
   `ε` 退化为私有字形 `\u000f`。行内公式尚可读，行间公式模型需靠上下文重建，会有错。
   → 这是「框选补录」通道存在的根本原因。
2. **KaTeX 已全局可用**（`/vendor/katex.js` + `katex.css`，见 `src/server.js` VENDOR_MAP），公式渲染零成本。
3. **视觉链路已存在**（reader.js `cropRegionToImage` 坐标换算 + 聊天视觉的图片白名单），框选补录无需新建能力。

---

## 一、数据模型

store 顶层新增 `formulas: []`（per-space，与 `concepts` 平级），每篇论文新增 `formulaIds: []`。
内存 store 形状保持 v2 风格，上层逻辑无感知（与 concepts 一致）。

```jsonc
{
  "id": "fm_1a2b3c4d",                              // stableShortHash(normalizeCanonicalName)，前缀 fm_
  "canonicalName": "scaled-dot-product-attention",  // 合并 key：小写英文连字符
  "name": "缩放点积注意力",                           // 中文显示名
  "latex": "\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V",
  "description": "…Markdown 解读…",
  "category": "attention",                          // 粗分类，清单页分组用；可空
  "variables": [
    { "symbol": "Q",   "meaning": "查询矩阵",   "role": "input" },
    { "symbol": "d_k", "meaning": "键向量维度", "role": "param" }
  ],                                                // role: input | param | output | const
  "plottable": false,                               // 是否可作为单变量函数绘图（本次仅落数据）
  "plotHint": { "variable": "x", "range": [-5, 5], "params": { "sigma": 1 } },  // 可为 null
  "occurrences": [
    { "paperId": "…", "rawLatex": "论文原写法", "context": "式(3)，3.2 节", "symbolMap": { "d_k": "d" } }
  ],
  "paperIds": ["…"],
  "source": "ai" | "vision" | "manual",
  "createdAt": 0,
  "updatedAt": 0
}
```

**`paperIds` 与 `occurrences` 并存是刻意设计**：

- `paperIds` 让 `DELETE /api/papers/:id` 的清理逻辑（`src/api/router.js` 第 194–198 行 concepts 那段）原样复用；
- `occurrences` 承载多对多的附加属性（每篇论文各自的原写法、章节出处、符号映射）。
- 不变式：`paperIds` 恒等于 `occurrences.map(o => o.paperId)`，由 `mergeFormulas` 单点维护，其它代码不得直改。

**`occurrences[].symbolMap` 是「归一化」真正落地的地方**：清单页展示一般形式，展开某篇论文时能看到
「这篇论文里 `d_k` 写作 `d`」。没有它，「归一化到一般形式」就只是丢失信息。

## 二、持久化

- 新增 `src/db/migrations/004-formulas.sql`：

```sql
CREATE TABLE IF NOT EXISTS formulas (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  canonical_name TEXT,
  name TEXT,
  latex TEXT,
  description TEXT,
  category TEXT,
  variables JSONB,
  plottable BOOLEAN DEFAULT FALSE,
  plot_hint JSONB,
  occurrences JSONB,
  paper_ids JSONB,
  source TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (space_id, id)
);
ALTER TABLE papers ADD COLUMN IF NOT EXISTS formula_ids JSONB;
```

- `src/db/index.js`：
  - `PAPER_COLS` 加 `['formulaIds', 'formula_ids', true]`（**陷阱 22**：不加会掉进 `extra` JSONB 兜底列，数据不丢但不可 SQL 查询）；
  - `loadSpaceStore` / 快照 `hashOf` / `saveSpaceStore` 的 upsert+delete 四处镜像 concepts 分支；
  - 所有 jsonb 参数走 `jstr()`（**陷阱 24**：node-pg 会把裸数组写成 PG 数组字面量）；
  - 删空间级联加 `DELETE FROM formulas WHERE space_id=$1`。
- pg-mem 兼容：migration 004 为普通（非 `.optional.`）编号 migration，纯 DDL，pg-mem 可执行；
  `CREATE TABLE IF NOT EXISTS` 对已存在表的怪癖由现有 migrate 探测逻辑覆盖（**陷阱 26**）。

## 三、纯逻辑层 `src/core/formulas.js`（零 IO，可独立单测）

| 函数 | 职责 |
| --- | --- |
| `normalizeCanonicalName(s)` | 小写、空白/下划线→连字符、折叠重复连字符、去首尾连字符 |
| `formulaIdFor(name)` | `'fm_' + stableShortHash(归一化名)` |
| `normalizeLatex(s)` | 剥 `$$…$$` / `$…$` / `\[…\]` / `\begin{equation}…\end{equation}` 包裹，存裸公式体；渲染时再定 display 模式 |
| `normalizeFormula(raw)` | 字段兜底 + `variables` / `occurrences` 数组归一化；写入边界与读取边界都过（同**陷阱 30** 的 `normalizeNoteCards` 模式） |
| `mergeFormulas(store, items, paperId)` | 按 canonicalName 合并，返回本次新增 id 列表 |
| `deleteFormula(store, id)` | 删条目 + 清所有 `paper.formulaIds` |
| `removePaperFromFormulas(store, paperId)` | 删论文时清该 paper 的 occurrence；occurrence 清空后删除整条（对齐 concepts 现有行为） |
| `formulasToMarkdown(store)` | 导出 `/api/formulas.md` |

`src/core/store.js` 的 `conceptIdFor` 内联 hash 抽出为共享的 `stableShortHash(key)`，
`conceptIdFor` 与 `formulaIdFor` 各自加前缀调用它。**`conceptIdFor` 的输出必须逐字节不变**
（已有概念 id 已落库），需有单测钉住若干已知 term → id 的映射。

### `mergeFormulas` 的三条关键规则

1. **命中已有条目时只补空字段，不覆盖已有 `description` / `latex` / `variables`**——
   否则第 5 篇论文的粗糙解读会冲掉第 1 篇的好解读。
2. **同 `paperId` 的 occurrence 覆盖而非追加**——保证重复抽取幂等。
3. 合并后同步 `paperIds` 与 `updatedAt`，并对列表按 `canonicalName` 排序（同 `mergeConcepts` 的排序语义）。

## 四、AI 层（`src/services/ai.js`）

- `DEFAULT_FORMULA_PROMPT`，三级回退 `store.settings.formulaPrompt > config.formulaPrompt > DEFAULT_FORMULA_PROMPT`
  （**陷阱 2** 同款），设置页提示词区可编辑。
- `buildFormulaMessages({ title, abstract, fulltext, existingFormulas, maxInputChars })`：
  把已有条目的 `canonicalName + latex` 喂进去（截断到前 200 条），要求命中已有的只回 occurrence、不重复造条目。
- `extractFormulas({ ... })` 走 `jsonMode: true`；`parseFormulaResult` 复用 `parseConceptResult` 的
  「先裸数组、再包裹对象」双路容错。
- `pickMathDenseText(fulltext, budget)`：全文不超 budget 时**原样返回**（128k 模型下多数论文走这条）；
  超出才按段落切分、按数学符号密度（`∑∏∫∇∂√≤≥≈∈∀∃` + 希腊字母 + `\u0000-\u001f` 私有字形 + `=` 密度）打分，
  择优子集**保持原文顺序**拼接，段间插 `…`。

### Prompt 的四条硬约束

1. 只抽**核心公式** 3–8 个：论文自己提出的方法、目标/损失函数、关键指标定义。
   **不要**抽引用他人的背景公式、不要抽推导中间步骤。
2. `latex` 输出**领域通用符号的一般形式**；论文的个性化记号放 `occurrences[].rawLatex` 与 `symbolMap`。
3. `canonicalName` 用小写英文连字符，**优先使用学界通用名**；prompt 内附 20–30 条高频公式规范名对照表
   （attention / kl-divergence / elbo / cross-entropy / softmax / layer-norm / adam-update / …）压住命名漂移。
4. `latex` 必须是 **KaTeX 可渲染子集**（禁 `\newcommand`、自定义宏、`align` 以外的多行环境）。

## 五、每任务输入预算

现状：全项目只有一个全局 `ai.maxInputChars`（默认 24000），总结/标签/概念/笔记/聊天共用。

新增 `settings.ai.taskMaxInputChars`：

```jsonc
"taskMaxInputChars": {
  "summary": null, "tags": null, "notes": null,
  "concepts": null, "formulas": 120000, "chat": null
}
```

- `null` / 缺失 = 跟随全局 `ai.maxInputChars`。
- 新增 `resolveMaxInputChars(config, task)` 作为**单一入口**，`ai.js` 各 `build*Messages` 一律经它取值，
  不再各自 `const { maxInputChars = 24000 } = config.ai`。
- `applySettingsOverride` 对 `taskMaxInputChars` 做**深合并**（同 `discover.weights` 的处理），
  并沿用新增段的 `!== undefined` 即覆盖规则（**陷阱 19**：勿套 `!== ''`，会吞掉 0）。
- 设置页 AI 段加一张小表：6 个数字输入，占位符显示「跟随全局 24000」，空值写回 `null`。
  `PUT /api/settings/ai` 接收并校验（非负整数或 null）。

`formulas` 默认 120000 字符：128k 上下文模型下约合 30k token，绝大多数论文（5–8 万字符）可整篇进入，
`pickMathDenseText` 只在超长综述时才实际生效。

## 六、抽取时机（`src/services/scanner.js`）

- `processOne` **步骤 6**（概念抽取之后）：独立 try/catch，失败只 `log` 不影响主流程与 `saveStore`。
- `scanner.extractFormulas(ids)`：复用 `textStore` 全文，串行调 AI，最后一次性 `deps.saveStore(store)`
  （**陷阱 1**：单参！）。
- `createMultiSpaceScanner.extractFormulas(spaceId, ids)`：转发到子扫描器，与 `extractConcepts` 同构。
- `deps` 注入 `mergeFormulas`（与现有 `mergeConcepts` 注入方式一致）。

## 七、API（`src/api/router.js`）

```
GET    /api/formulas                      ?q=（匹配 name/canonicalName/latex/description）&paper=<id>
GET    /api/formulas.md                   纯 Markdown 导出
PATCH  /api/formulas/:id                  { name?, latex?, description?, category?, variables?, plottable?, plotHint? }
DELETE /api/formulas/:id
POST   /api/papers/formulas               { ids: [...] }   批量抽取并追加
POST   /api/papers/:id/formulas/vision    { image }        框选补录
```

- 路由 id 正则沿用 concepts 的 `[\w.-]+`。
- 每路由顶部 `resolveSpace(q)`，`?space=` 隔离（现有约定）。
- `DELETE /api/papers/:id` 增加 `removePaperFromFormulas` 调用。
- `/api/stats` 增加 `formulas` 计数。
- **vision 路由**：复用聊天视觉的图片白名单（`data:image/*;base64,` 前缀、限 **1 张**、大小上限沿用现值），
  一次性返回 JSON（**非 SSE**——结果是结构化对象而非流式文本，无需 EventSource/fetch-stream 双通道）。
  返回体 `{ formula, isNew }`，`isNew=false` 表示合并进了已有条目。

## 八、前端

### 公式清单页（新 `formulas-view`，结构镜像 `concepts-view`）

- 顶栏「概念」旁加「公式」按钮；`showView(name)` 加 `formulas` 分支（现有三态改四态）。
- **卡片**：KaTeX display 渲染的公式 + 中文名 + `canonicalName`（小字）+ 出现篇数徽章
  + 解读（走 `renderMd` 单一入口，吃**陷阱 33** 的 `fixCjkStrong`）+ 可折叠符号表（variables）
  + 论文胶囊（复用 concepts 的 `data-goto` 跳转语义，最多平铺 3 个、其余折叠 `+N`）。
  展开某篇论文胶囊时显示该篇的 `rawLatex` 与 `symbolMap` 差异。
- **工具栏**：搜索框 / 排序（出现频次·名称·分类）/ 布局（瀑布流·紧凑清单）/ 下载 Markdown。
  排序与布局选择用 `localStorage`（`pw-formula-sort` / `pw-formula-layout`）持久化，同概念页。
- **编辑 / 删除**走 `PWDialog`（`public/dialog.js`），不用原生 `prompt` / `confirm`。
- 图标遵循 reader-bar 那套细线 SVG，不用 emoji。

### 阅读器框选补录

现有框选截图菜单增加一项「提取为公式」→ POST vision 接口 → `PWDialog` 预览
（KaTeX 渲染结果 + 可编辑规范名/中文名）→ 确认入库 → toast 提示新建或合并。

### 详情「信息」tab

镜像概念那块：「本篇贡献 N 个公式」+「重新抽取并追加」按钮（调 `POST /api/papers/formulas {ids:[p.id]}`），
完成后重新拉详情视图刷新计数。

### 多选工具栏

加「抽取并追加公式」按钮，与现有 `btn-pick-concepts` 同构（含 disabled 状态联动）。

## 九、测试（TDD：先写测试看其失败，再实现）

| 文件 | 覆盖点 |
| --- | --- |
| `tests/formulas.test.js`（新） | `normalizeCanonicalName` / `normalizeLatex` 包裹剥离 / `formulaIdFor` 稳定性 / `mergeFormulas`（新建·合并·不覆盖已有解读·同 paperId occurrence 幂等·paperIds 不变式）/ `deleteFormula` / `removePaperFromFormulas` 空 occurrence 删条目 / Markdown 导出 |
| `tests/store.test.js`（补） | `conceptIdFor` 抽出 `stableShortHash` 后输出**逐字节不变**（钉住已知映射防回归） |
| `tests/ai.test.js`（补） | `buildFormulaMessages` 注入 existingFormulas / `parseFormulaResult` 双路容错 / `pickMathDenseText` 预算与保序 / `resolveMaxInputChars` 三级回退 / `applySettingsOverride` 对 `taskMaxInputChars` 深合并 |
| `tests/api.test.js`（补） | 6 条新路由 + 删论文清理 occurrences + `/api/stats` 计数（pg-mem） |
| `tests/db.test.js`（补） | formulas 表 hash-diff 往返 / `formulaIds` 落 `PAPER_COLS` 不进 `extra` / 删空间级联 |
| `tests/scanner.test.js`（补） | `extractFormulas` 串行 + 单参 `saveStore` + 失败不影响主流程 |
| `tests/formulas-ui.test.js`（新） | jsdom 驱动真实 `app.js`（沿用 `helpers/ui.js` 的 `bootUi`）：公式页渲染 / 搜索筛选 / 排序布局切换 / 论文跳转 / 编辑删除走 PWDialog |

配套跑 `npm run lint` 与 `npm run format:check`。

## 十、明确不做（YAGNI）

- **函数图像绘制**——本次只落 `plottable` / `plotHint` 数据，前端不渲染图像。
- **LaTeX 结构指纹二级去重与人工合并 UI**——待跑过全库看真实重复率再评估。
- **公式关系图**（公式间的推导/依赖关系）——模型编造关系风险高。
- **Node 端整页视觉抽取**——需引入 `canvas` 原生依赖，Docker 镜像变重、扫描流水线显著变慢。

## 十一、已知风险

**`canonicalName` 的一致性完全托付给模型。** 同一个 KL 散度，模型可能在 A 论文输出 `kl-divergence`、
在 B 论文输出 `kullback-leibler-divergence`——两者 hash 不同即合并失败。

缓解措施（本设计已含）：① prompt 内附高频公式规范名对照表；② 增量抽取时喂入已有条目列表。
这能压住大部分但不可能 100%。真实重复率需跑过全库才知道，故人工合并 UI 留作 v2。

**部署提醒**：改动含 `src/` 与 `public/`，生产须 `docker compose up -d --build app` 重建镜像才生效（**陷阱 12**）。
