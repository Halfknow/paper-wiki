# arXiv 论文管理站（PaperWiki）— 设计文档

- **日期**：2026-06-17
- **状态**：待实现
- **作者**：Xiaoyu + Claude

## 1. 背景与目标

本地 `papers/` 文件夹中持续积累 arXiv / 论文 PDF（当前 15 篇，LLM 方向），文件命名格式不统一（`年份-作者-标题`、`作者 - 年份 - 标题`、`Pre_年份_标题`、`JAIR_年份_标题` 等）。需要一个非常薄的本地服务，提供一个 Web 页面来管理这些论文：标签、AI 总结、笔记、markdown 预览、PDF 预览，并能持续扫描文件夹自动纳入新论文。

**成功标准**：
1. `pm2 start` 后，浏览器访问 `http://<host>:8888` 即可看到所有 PDF 已自动入库、补全元数据、生成 AI 总结与标签。
2. 新论文丢进 `papers/` 后，无需重启，定时扫描自动入库并完成 AI 处理。
3. 每个模块（扫描/解析/arXiv/AI/存储）边界清晰，可单独替换或测试。

## 2. 已确认决策

| 维度 | 选择 | 备注 |
|---|---|---|
| 服务形态 | Node.js 薄服务（`server.js`）serve 静态前端 + REST API | 无前端构建步骤 |
| 进程管理 | pm2 托管，监听 `0.0.0.0:8888` | 不 watch 源码目录 |
| AI 接口 | 统一 OpenAI 兼容（指向 New API gateway） | 配 `baseURL` + `apiKey` + `model` |
| 标签 | AI 全自动生成 + 全局字典去重归并 | 用户可事后合并/重命名 |
| PDF 提取 | 轻量文本提取（pdfjs-dist） | 日后可换 MinerU（只改 `parser.js`） |
| 元数据 | 查 arXiv API 补全 + AI 兜底 | 文件名无 arXiv ID，需匹配策略 |
| 存储 | JSON 文件（`data/papers.json`） | atomic write + 排他锁 |
| 架构组织 | 方案 B：适度模块化 | 每个文件单一职责 |

### 2.1 开放问题的默认决策（YAGNI）

| 问题 | 默认 | 可后续调整 |
|---|---|---|
| 笔记编辑器 | 双栏：左编辑 markdown，右 marked.js + katex 实时预览 | 若嫌重可退化为单栏 + tab 预览 |
| 论文关系链（引用/对比） | **暂不做** | 后续可加 `related[]` 字段 |
| 标签层级 | 扁平（`RLHF`），无 `parent/child` | 后续可加命名空间 `RL/preference` |

## 3. 范围

### 3.1 包含（v1）
- 文件夹增量扫描入库（指纹去重）
- PDF 轻量文本提取 + 全文存盘（供搜索）
- arXiv API 元数据补全（标题匹配 + 置信度判定）+ AI 兜底
- AI 一次调用产出 总结 + 标签（+ 兜底元数据）
- 标签全局字典去重归并 + 事后治理（合并/重命名/删除）
- Web 页面：列表筛选搜索、详情三 tab（总结/笔记/PDF）、markdown 实时预览、PDF 原生预览
- 笔记/星标/阅读状态编辑与持久化
- 手动触发扫描 + 手动重生成总结/重解析
- pm2 部署到 `0.0.0.0:8888`

### 3.2 不包含（v1，刻意排除）
- 论文关系链 / 知识图谱
- 多用户 / 鉴权（纯内网单用户工具）
- 标签层级、标签颜色自定义
- MinerU 结构化解析（留接口，v1 不接）
- arXiv 自动下载（只管理已有 PDF）

## 4. 架构（方案 B：适度模块化）

```
┌─────────────────────────────────────────────────────────┐
│  浏览器（静态前端 public/，无构建）                         │
│   index.html + app.js(ESM) + styles.css + vendor/        │
└──────────────────────────┬──────────────────────────────┘
                           │ REST + 静态 PDF
┌──────────────────────────▼──────────────────────────────┐
│  server.js   (HTTP 入口：路由编排 + 静态托管)              │
└──┬──────────┬──────────┬──────────┬──────────┬──────────┘
   │          │          │          │          │
┌──▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐
│scanner│ │ parser │ │ arxiv  │ │  ai    │ │ store  │
│ 扫描+ │ │ pdfjs  │ │ 元数据 │ │ OpenAI │ │ JSON   │
│ 指纹  │ │ 文本   │ │ 补全   │ │ 兼容   │ │ +锁    │
└──────┘ └────────┘ └────────┘ └────────┘ └────────┘
   │          │          │          │          │
   └──────────┴──────────┴──────────┴──────────▼── data/
        异步处理流水线（串行 worker）          papers.json
```

**模块边界**：
- `scanner`：只发现文件、算指纹、维护队列；不解析、不上网。
- `parser`：只把 PDF 转纯文本；不上网、不调 AI。
- `arxiv`：只查 arXiv API 补元数据；不做总结。
- `ai`：只做生成（总结/标签/兜底元数据）；不碰存储。
- `store`：只管 JSON 读写 + 锁；不知道业务语义。

任一模块可独立替换：换 MinerU 改 `parser`，换模型改 `config`，换 SQLite 改 `store`。

## 5. 目录结构

```
ai_paper_wiki/
├── papers/                    # 用户 PDF（只读扫描）
├── data/
│   ├── papers.json            # 主存储
│   ├── papers.json.lock       # 写锁
│   └── text/                  # 提取的全文（<id>.txt）
├── config.json                # 端口/AI/arxiv/扫描/提示词
├── server.js                  # HTTP 入口
├── lib/
│   ├── scanner.js
│   ├── parser.js
│   ├── arxiv.js
│   ├── ai.js
│   ├── store.js
│   └── util.js
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── vendor/                # marked/katex/dompurify（本地化）
├── package.json
├── ecosystem.config.cjs       # pm2 配置
└── README.md
```

## 6. 数据模型

### 6.1 `papers.json` 顶层
```jsonc
{
  "version": 1,
  "tags": ["RLHF", "data-selection", "fine-tuning"],   // 全局标签字典
  "papers": { "<id>": { /* Paper */ }, ... }
}
```

### 6.2 Paper 对象
```jsonc
{
  "id": "a1b2c3d4e5f60718",        // sha1(fileContent) 前 16 位
  "filename": "2026-Zhao 等-A Survey of Large Language Models.pdf",
  "filepath": "papers/2026-Zhao 等-A Survey...pdf",
  "fileMtime": 1718630400000,
  "fileSize": 5853703,
  "addedAt": 1718630400000,

  "title": "A Survey of Large Language Models",
  "authors": ["Wayne Xin Zhao"],
  "year": 2023,
  "arxivId": "2303.18223",
  "arxivUrl": "https://arxiv.org/abs/2303.18223",
  "abstract": "...",
  "metaSource": "arxiv",           // arxiv | ai-fallback | filename
  "metaConfidence": 0.92,

  "fulltextChars": 84210,
  "fulltextPath": "data/text/a1b2c3d4e5f60718.txt",

  "summary": "## TL;DR\n...",       // markdown
  "summaryModel": "deepseek-chat",
  "summaryAt": 1718630500000,
  "tags": ["survey", "llm"],

  "notes": "",                      // 用户手写 markdown，与 summary 分离
  "starred": false,
  "readStatus": "unread",           // unread | reading | done

  "status": "ready",                // pending|parsing|enriching|summarizing|ready|error|missing
  "error": null,
  "updatedAt": 1718630500000
}
```

**关键设计**：
- `id` 用文件内容 sha1 → **改名/移动不丢笔记**。
- `summary`（AI，可重生成）与 `notes`（用户）**分离**，重总结不覆盖笔记。
- `status` 状态机驱动前端骨架屏。
- 全文存盘而非塞进 JSON，避免 JSON 膨胀；支撑全文搜索。

## 7. 核心流程

### 7.1 增量扫描（scanner.js）
- 启动全量扫 `papers/*.pdf`；之后每 `scanIntervalMinutes`（默认 5）增量扫。
- 指纹 `{sha1, size, mtime}`。新增/变更 → 入库 `status:pending`，入队列。
- 文件被删 → 标 `status:"missing"`（保留笔记，不物理删除）。
- 暴露 `enqueueScan()` 供手动 `POST /api/scan` 调用。

### 7.2 处理流水线（串行 worker）
```
pending → parser(fulltext) → arxiv(metadata) → ai(summary+tags) → ready
       ↘ 任一步抛错 → status:error（记 error，前端可重试单步）
```
- **串行**：避免并发压垮本地 AI / 触发 arXiv 限速（arXiv 要求 ≤1 req/3s）。
- 每步只更新 `status` 并 atomic 写盘，崩溃重启可续。

### 7.3 arXiv 元数据补全（arxiv.js）
文件名无 arXiv ID，匹配策略：
1. 从文件名清洗候选标题（去 `年份-`、`作者 等 -`、`Pre_`/`JAIR_` 前缀、`_billingual`/`_bilingual` 后缀、扩展名）。
2. 文件名不可靠时，取 PDF 首页文本前若干行作候选标题。
3. 调 arXiv search API：`GET http://export.arxiv.org/api/query?search_query=ti:"<title>"&max_results=3`（Atom XML 解析）。
4. 置信度：标题规范化后编辑距离相似度 ≥ `titleSimilarityThreshold`（默认 0.75）AND（作者集合有交集 OR 摘要前 200 字有重叠）→ 采纳 `metaSource:"arxiv"`。
5. 不达标 → 留空，由 `ai.js` 在总结时顺手抽取 title/authors/year，`metaSource:"ai-fallback"`，前端标注"推断元数据"。
6. 请求间隔 ≥ 3s（满足 arXiv 礼貌限速）。

### 7.4 AI 总结 + 标签（ai.js）
- 单次 chat completion，要求 JSON 输出：
  ```json
  {
    "tldr": "...",
    "contributions": ["...", "..."],
    "method": "...",
    "tags": ["...", "..."],
    "metadata": { "title": "...", "authors": [...], "year": 2024 }  // 仅 ai-fallback 时填
  }
  ```
- 输入：`abstract`（arxiv 有则优先）+ 全文前 `maxInputChars`（默认 24000）字符。
- 标签：复用已有全局字典中相近标签 + 允许新增；写回前**去重归并**到顶层 `tags[]`（同义词合并，防 `RLHF`/`rlhf`/`人类反馈强化学习` 爆炸）。
- 输出组装为 markdown 存入 `summary`。
- Prompt 模板存 `config.summaryPrompt`，可调。

### 7.5 预览
- **PDF 原文**：`<embed src="/papers/<encoded-name>">`；`server.js` 对 `papers/` 做带 HTTP range 的静态托管，大文件流式加载。
- **markdown**：`marked.js` + `katex`（公式）+ `dompurify`（XSS），均本地化在 `public/vendor/`，内网无外网可用。

## 8. 后端 API（server.js）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 静态前端 |
| GET | `/papers/<name>` | PDF 原文（range 支持） |
| GET | `/api/papers` | 列表，`?tag=&q=&status=&sort=&starred=` |
| GET | `/api/papers/:id` | 单篇详情 |
| PATCH | `/api/papers/:id` | 改 notes/starred/readStatus/tags |
| POST | `/api/papers/:id/summarize` | 重生成 AI 总结 |
| POST | `/api/papers/:id/parse` | 重解析（如换 MinerU） |
| POST | `/api/scan` | 手动触发扫描 |
| GET | `/api/tags` | 标签字典 + 计数 |
| PATCH | `/api/tags` | 合并/重命名/删除标签 |
| GET | `/api/stats` | 统计（总数/已总结/标签分布） |

响应统一 `{ ok: true, data }` 或 `{ ok: false, error }`。

## 9. 前端（public/）

三栏自适应布局：
```
┌──────────────────────────────────────────────────────────────┐
│ PaperWiki  [🔍 搜索___]  [全部▾][未读▾][标签▾]  ⟳扫描         │
├────────────┬─────────────────────────────────────────────────┤
│ 列表(左)    │ 详情(右)                                         │
│            │ [标题/作者/年份/状态]  ★ 已读  arXiv↗              │
│ ● Zhao 2023│ [总结][笔记][PDF原文]  ← tab                       │
│   survey   │ ─ markdown 渲染（总结） / 双栏编辑+预览（笔记）─    │
│ ○ R1 2025  │                                                  │
└────────────┴──────────────────────────────────────────────────┘
```
- 列表项：标题、作者年份、标签、阅读状态圆点；多标签 AND 筛选 + 全文搜索 + 排序。
- 总结 tab：只读 markdown 渲染。
- 笔记 tab：左编辑 markdown，右 `marked`+`katex` 实时预览，失焦/`Ctrl+S` 自动保存。
- PDF tab：浏览器原生预览。

## 10. 配置（config.json）
```jsonc
{
  "host": "0.0.0.0",
  "port": 8888,
  "papersDir": "papers",
  "scanIntervalMinutes": 5,
  "ai": {
    "baseURL": "http://your-newapi-gateway/v1",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat",
    "maxInputChars": 24000,
    "timeoutMs": 120000
  },
  "arxiv": { "enabled": true, "titleSimilarityThreshold": 0.75 },
  "summaryPrompt": "<内置默认，可覆盖>"
}
```

## 11. 部署（pm2）
```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'paper-wiki',
    script: 'server.js',
    watch: false,                 // 扫描靠定时器，不 watch 源码/论文目录
    env: { NODE_ENV: 'production' },
    max_memory_restart: '512M'
  }]
};
```
- `pm2 start ecosystem.config.cjs` → `0.0.0.0:8888`
- `pm2 save && pm2 startup` → 开机自启

## 12. 错误处理与边界
- **JSON 并发写**：`store.js` 排他锁 + atomic write（临时文件 + rename）。
- **AI 限速/超时**：单篇超时 + 重试 1 次；失败进 `status:error`，前端单步重试。
- **大 PDF**：静态托管 range；文本提取超时保护（单篇上限秒数）。
- **arXiv 匹配错**：低置信度一律 `metaSource:"ai-fallback"` 并前端提示，支持手动改标题后重查。
- **文件被删**：标 `missing` 不删数据，避免误删笔记。
- **AI 输出非 JSON**：兜底用正则/降级为纯文本总结，记 warning。

## 13. 未来演进（v2+，不在本次范围）
- 接 MinerU 高质量结构化解析（替换 `parser.js`）。
- 论文关系链 / 引用对比。
- SQLite 替换 JSON（论文量 > 500 时）。
- 标签层级与颜色。
- 向量检索（语义相似论文推荐）。
