# PaperWiki — 本地 arXiv 论文管理站

一个**薄**的本地 Web 服务：扫描 `papers/*.pdf`，自动提取文本、查 arXiv 补全元数据、用 OpenAI 兼容接口（如你的 New API gateway / 智谱 / DeepSeek）生成总结、细粒度标签、粗粒度主题与**概念清单**，并提供一个亮色的可筛选/搜索/编辑笔记/独立 PDF 阅读器页面。

## 功能

- 📁 **持续扫描**：增量扫描 `papers/`，按文件内容 sha1 识别新增/变更（改名/移动不丢笔记）
- ☀️ **亮色主题**：白底 + 浅灰面板 + 蓝色强调，长时间阅读不刺眼
- 🗂️ **虚拟收藏夹**：在页面里建文件夹（如「精读 / 待复现 / 综述」），一篇论文可属多个收藏夹，与磁盘目录解耦
- 🏷️ **双维度筛选**：
  - **标签 tag**（细粒度英文技术词，AI 自动生成，全局字典去重，可合并/重命名/删除）
  - **主题 topic**（AI 给的 1–3 个中文大方向，如「推理 / 数据选择」，作为一级筛选维度）
- 📝 **笔记 + 实时预览**：Markdown 编辑器，左侧编辑、右侧 `marked` + KaTeX 实时预览，自动保存
- 🔍 **搜索与筛选**：按标题/摘要/总结/笔记/标签/主题全文搜索，按标签/主题/收藏夹/阅读状态/星标筛选，支持最近添加/最近更新/标题排序
- 📄 **独立 PDF 阅读器**：点「打开 PDF」进入**全屏阅读器**（pdf.js 自定义渲染），不再挤在详情页
  - ⤴️ **续读**：自动记录页码 + 滚动位置，下次打开从上次的位置接着读
  - 工具栏：上/下页、页码跳转、缩放
- 🧠 **AI 概念清单**：所有论文涉及的关键概念由 AI 抽取后维护在一份清单里（去重归并），页面有专门入口查看/搜索/编辑，可导出 Markdown
  - 选中多篇论文 → 「抽取并追加概念」，AI 只返回**新**概念追加到清单后
- ✏️ **可调提示词**：顶栏「提示词」入口在线编辑总结 system prompt，写入 store 即时生效（无需重启），留空则用内置默认；可折叠查看默认提示词参考
- 🔗 **arXiv 元数据**：按文件名清洗标题查 arXiv API 补全（匹配失败则 AI 兜底并标注）
- ♻️ **可替换模块**：换 MinerU 解析只改 `lib/parser.js`，换模型只改 `config.json`

## 安装

```bash
npm install
cp config.example.json config.json
# 编辑 config.json：把 ai.baseURL / apiKey / model 改成你的网关
```

> Node 版本要求 ≥ 18.17。若用 [fnm](https://github.com/Schniz/fnm) 管理多版本，先 `fnm use`。

## 运行

### 开发（前台）

```bash
npm start            # node server.js
# 浏览器打开 http://localhost:8888
```

### 生产（pm2 托管 0.0.0.0:8888）

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # 开机自启
pm2 logs paper-wiki         # 查看日志
pm2 restart paper-wiki      # 改完 config 或升级代码后重启
```

局域网其他机器访问 `http://<本机IP>:8888`。

> 升级到 v2 后**需要重启服务**（`pm2 restart paper-wiki`）才能加载新的后端路由；前端静态页是即时读取的，无需重启。

### 仅扫描一次（不启动 HTTP）

```bash
npm run scan        # 扫描并处理完队列后退出
```

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8888` | 监听地址 |
| `papersDir` | `papers` | PDF 目录 |
| `scanIntervalMinutes` | `5` | 增量扫描间隔（`0` 表示只扫一次） |
| `ai.baseURL` | — | OpenAI 兼容接口（网关的 `/v1`） |
| `ai.apiKey` | — | 接口密钥 |
| `ai.model` | — | 模型名，如 `glm-4.5` / `deepseek-chat` |
| `ai.maxInputChars` | `24000` | 送入模型的全文截断长度 |
| `ai.timeoutMs` | `120000` | 单次 AI 调用超时 |
| `arxiv.enabled` | `true` | 是否查 arXiv 补元数据 |
| `arxiv.titleSimilarityThreshold` | `0.75` | 标题匹配阈值 |
| `arxiv.minIntervalMs` | `3000` | arXiv API 调用最小间隔（礼貌限速） |
| `summaryPrompt` | — | 自定义总结 system prompt（留空用内置） |

## 工作方式

1. 启动时全量扫描，之后每 `scanIntervalMinutes` 增量扫描。
2. 每篇论文走流水线（串行，避免压垮本地 AI / 触发 arXiv 限速）：
   `提取全文 → 查 arXiv 补元数据 → AI 生成总结 + 标签 + 主题 + 概念`
3. 状态存 `data/papers.json`；全文存 `data/text/<id>.txt`；概念清单也存于 `papers.json` 的 `concepts` 字段。
4. 页面 10 秒轮询（阅读器打开时暂停），处理中的论文状态会自动刷新。

## 数据结构（store v2）

`data/papers.json`：

```
{
  version: 2,
  papers: { [id]: { ..., tags, topics, folders, readProgress, conceptIds } },
  tags:    [...],            // 细粒度标签字典
  topics:  [...],            // 粗粒度主题字典
  folders: [ { id, name, color, createdAt } ],   // 虚拟收藏夹
  concepts:[ { id, term, definition, paperIds, createdAt } ]  // AI 概念清单
}
```

旧版（v1）数据启动时自动迁移：补齐缺失的 `topics/folders/concepts` 字段，每篇论文补 `topics/folders/readProgress/conceptIds`。

## 目录结构

```
papers/        你的 PDF（只读扫描）
data/          papers.json + text/（运行时数据，已 gitignore）
config.json    实际配置（已 gitignore，含 key）；模板见 config.example.json
lib/           后端模块：util/store/parser/arxiv/ai/scanner/api
public/        前端静态页（无构建，原生 ESM）
  ├─ index.html   三栏布局（侧栏/列表/详情）+ 阅读器 + 概念清单视图
  ├─ app.js       主逻辑：路由/列表/详情 tab/收藏夹/主题/概念清单/多选抽取
  ├─ reader.js    pdf.js 自定义阅读器（续读）
  └─ styles.css   亮色主题
scripts/       scan-once.js（CLI 扫描）
server.js      HTTP 入口
ecosystem.config.cjs   pm2 配置
```

## REST API（节选）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/papers` | 列表，支持 `q/tag/topic/folder/status/readStatus/starred/sort` |
| GET | `/api/papers/:id` | 详情（含 summary/notes） |
| PATCH | `/api/papers/:id` | 更新 notes/starred/readStatus/tags/topics/folders/readProgress |
| POST | `/api/papers/:id/summarize` | 重新总结（含主题/概念） |
| POST | `/api/papers/concepts` | body `{ids:[...]}`：对选中论文**增量抽取**概念 |
| POST | `/api/scan` | 手动扫描 |
| GET/PATCH | `/api/tags` | 标签字典（合并/删除） |
| GET | `/api/topics` | 主题字典 + 计数 |
| GET/POST/PATCH/DELETE | `/api/folders[/:id]` | 收藏夹 CRUD |
| GET | `/api/concepts` | 概念清单（`?q=`/`?paper=`） |
| GET | `/api/concepts.md` | 概念清单 Markdown 文档 |
| PATCH/DELETE | `/api/concepts/:id` | 编辑/删除概念 |
| GET | `/api/settings` | 读取 summaryPrompt + configPrompt + 内置默认 |
| PUT | `/api/settings/summary-prompt` | body `{value}`：更新总结提示词（空串=恢复默认） |
| GET | `/api/stats` | 统计（含 folders/topics/concepts 计数） |

## 测试

```bash
npm test            # node --test，跑 lib 各模块单元测试
```

覆盖 store v2 迁移、topics/concepts/folders 辅助函数、AI prompt/增量抽取解析、API 新端点与筛选。

## 后续可扩展（v3）

- 接 MinerU 做高质量结构化解析（替换 `lib/parser.js`）
- 论文关系链 / 引用对比
- SQLite 替换 JSON（论文量 > 500 时）
- 向量检索（语义相似论文推荐）
- 概念间关系图（哪些概念常共现）
