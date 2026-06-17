# PaperWiki — 本地 arXiv 论文管理站

一个**薄**的本地 Web 服务：扫描 `papers/*.pdf`，自动提取文本、查 arXiv 补全元数据、用 OpenAI 兼容接口（如你的 New API gateway）生成总结与标签，并提供一个可筛选/搜索/编辑笔记/预览 PDF 与 Markdown 的页面。

## 功能

- 📁 **持续扫描**：增量扫描 `papers/`，按文件内容 sha1 识别新增/变更（改名/移动不丢笔记）
- 🏷️ **AI 全自动标签**：AI 生成总结时一并产出标签，全局字典去重归并，可事后合并/重命名/删除
- 📝 **笔记 + 实时预览**：Markdown 编辑器，左侧编辑、右侧 `marked` + KaTeX 实时预览，自动保存
- 🔍 **搜索与筛选**：按标题/摘要/总结/笔记/标签全文搜索，按标签/阅读状态/星标筛选
- 📄 **PDF 预览**：浏览器原生预览，大文件 HTTP range 流式加载
- 🔗 **arXiv 元数据**：按文件名清洗标题查 arXiv API 补全（匹配失败则 AI 兜底并标注）
- ♻️ **可替换模块**：换 MinerU 解析只改 `lib/parser.js`，换模型只改 `config.json`

## 安装

```bash
npm install
cp config.example.json config.json
# 编辑 config.json：把 ai.baseURL / apiKey / model 改成你的 New API gateway
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
pm2 restart paper-wiki      # 改完 config 后重启
```

局域网其他机器访问 `http://<本机IP>:8888`。

### 仅扫描一次（不启动 HTTP）

```bash
npm run scan        # 扫描并处理完队列后退出
```

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8888` | 监听地址 |
| `papersDir` | `papers` | PDF 目录 |
| `scanIntervalMinutes` | `5` | 增量扫描间隔 |
| `ai.baseURL` | — | OpenAI 兼容接口（New API gateway 的 `/v1`） |
| `ai.apiKey` | — | 接口密钥 |
| `ai.model` | — | 模型名，如 `deepseek-chat` |
| `ai.maxInputChars` | `24000` | 送入模型的全文截断长度 |
| `arxiv.enabled` | `true` | 是否查 arXiv 补元数据 |
| `arxiv.titleSimilarityThreshold` | `0.75` | 标题匹配阈值 |
| `arxiv.minIntervalMs` | `3000` | arXiv API 调用最小间隔（礼貌限速） |

## 工作方式

1. 启动时全量扫描，之后每 `scanIntervalMinutes` 增量扫描。
2. 每篇论文走流水线（串行，避免压垮本地 AI / 触发 arXiv 限速）：
   `提取全文 → 查 arXiv 补元数据 → AI 生成总结+标签`
3. 状态存 `data/papers.json`；全文存 `data/text/<id>.txt`。
4. 页面 10 秒轮询，处理中的论文状态会自动刷新。

## 目录结构

```
papers/        你的 PDF（只读扫描）
data/          papers.json + text/（运行时数据，已 gitignore）
config.json    实际配置（已 gitignore，含 key）；模板见 config.example.json
lib/           后端模块：util/store/parser/arxiv/ai/scanner/api
public/        前端静态页（无构建，原生 ESM）
scripts/       scan-once.js（CLI 扫描）
server.js      HTTP 入口
ecosystem.config.cjs   pm2 配置
```

## 测试

```bash
npm test            # node --test，跑 lib 各模块单元测试
```

## 后续可扩展（v2）

- 接 MinerU 做高质量结构化解析（替换 `lib/parser.js`）
- 论文关系链 / 引用对比
- SQLite 替换 JSON（论文量 > 500 时）
- 向量检索（语义相似论文推荐）
