# PaperWiki 全平台 + 上云改造方向报告

> 目标形态:**多租户云服务(Web SaaS)+ 桌面 App(Tauri)**,采用 **BYO-key**(用户自带 AI Key)模式。
> 本文基于对 `lib/*.js`、`server.js`、`public/*`、`ecosystem.config.cjs`、测试与 CI 的逐文件调研,给出分层改造方向。
> 调研覆盖约 9600 行代码。

---

## 0. 结论先行(TL;DR)

**好消息**:这个代码库的工程质量在「个人项目」里属于上乘——大量使用依赖注入(`deps` 传 `parser/arxiv/ai/saveStore`、`fetchImpl` 可注入、`applySettingsOverride` 返回新对象不污染原 config)、有 142 例单测 + Playwright e2e、批注的 JSON 退化问题(陷阱 9)有正经的归一化层、store 有损坏自愈 + 备份。**云化改造的「可动手性」比绝大多数同类项目好。**

**核心障碍**:当前架构的**每一个核心假设**都是「单机单用户本地工具」:

1. `data/papers.json` 单文件 JSON + 进程内 `writeChain` 串行锁 → **头号障碍,无法多租户、无法多实例**
2. `papers/*.pdf` 本地目录扫描(`scanner.js` 用 sha1 指纹增量 diff) → 云上没有"本地目录"概念
3. `ecosystem.config.cjs` 强制 `instances:1`(否则写锁失效) → **无状态横向扩展的对立面**
4. `lib/api.js` **零鉴权** + `server.js` 默认绑 `127.0.0.1` → 多租户必须全套认证/授权/数据隔离
5. `store.settings` 存**明文 apiKey / S2 key** → BYO-key 必须加密存储
6. AI 调用(parse→arxiv→summarize→tags→concepts→chat→discover)**全无用量计量** → BYO-key 下仍需配额防滥用

**BYO-key 的红利**:你**完全绕开了 SaaS 最贵的部分**——平台不承担 AI 推理成本、不需要 token 计量计费、不需要模型网关的额度风控。剩下的硬骨头是:多租户隔离、密钥加密、文件对象存储、任务队列拆 worker、桌面端打包。

---

## 1. 目标架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  客户端                                                          │
│  ┌──────────────────┐   ┌──────────────────────────────────────┐ │
│  │ Web SPA          │   │ 桌面 App (Tauri)                     │ │
│  │ (public/* 复用)  │   │  ├ Webview 复用 SPA                    │ │
│  │                  │   │  ├ 本地 papers/ 扫描(私有部署卖点)     │ │
│  │ HTTPS → CDN      │   │  └ Rust 侧进程(可选本地 PDF 预处理)   │ │
│  └────────┬─────────┘   └──────────────┬───────────────────────┘ │
└───────────┼─────────────────────────────┼─────────────────────────┘
            │                             │
            ▼                             ▼
┌───────────────────────────────────────────────────────────────────┐
│  API 层 (无状态,可水平扩展)  ← 替换 server.js 的单进程模型          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Fastify/Express + 鉴权中间件(JWT/OAuth) + 限流 + 租户上下文  │ │
│  │   每个请求注入 req.userId → 所有 store 查询加 userId 过滤    │ │
│  └─────────────────┬───────────────────────────────────────────┘ │
└────────────────────┼──────────────────────────────────────────────┘
                     │
        ┌────────────┼─────────────┬──────────────────┐
        ▼            ▼             ▼                  ▼
┌──────────────┐ ┌────────────┐ ┌──────────────┐ ┌─────────────────┐
│ 关系/文档库  │ │ 对象存储   │ │ 任务队列+    │ │ 外部数据源      │
│ (替代        │ │ (替代      │ │ Worker 池    │ │ (保留,加租户    │
│  papers.json)│ │  papers/)  │ │ (替代 scanner│ │  限速/配额)     │
│              │ │            │ │  串行队列)   │ │                 │
│ Postgres     │ │ S3/OSS/COS ││ Redis/BullMQ ││ arXiv / S2 /     │
│ + Drizzle    │ │            ││ + N worker   ││ OpenAlex         │
└──────────────┘ └────────────┘ └──────┬───────┘ └─────────────────┘
                                      │
                                      ▼
                              ┌───────────────┐
                              │ 用户 AI 网关  │  BYO-key
                              │ (加密存储的   │  用户 key 加密在
                              │  per-user)    │  KMS / DB,
                              │               │  调用时解密注入
                              └───────────────┘
```

**关键设计原则**:

- **API 层无状态**:把 `lib/store.js` 的内存态(`const store = await loadStore(...)`)拆成「每次请求按 userId 查库」。这是云化的第一刀。
- **保留现有的「模块职责切分」**:`parser/arxiv/ai/discover/util/annotations` 这几个模块基本不动,只改它们的**数据存取后端**。它们的依赖注入设计正是为此而生的。
- **桌面端是私有部署的天然载体**:Tauri 打包时保留本地 `papers/` 扫描模式,可作为「不想把 PDF 上云」用户的卖点。

---

## 2. 分层改造详解

### 2.1 数据层(头号改造:`lib/store.js` → 持久化 + 多租户)

这是**整个改造里最硬、风险最高、价值最大**的一块。

#### 现状诊断(已读 `lib/store.js` 全部 370 行)

```js
// 进程内串行写锁
let writeChain = Promise.resolve();
async function saveStore(storePath, store) {
  const run = writeChain.then(async () => { ... await fsp.rename(tmp, storePath); });
  writeChain = run.catch(() => {});
  await run;
}
```

- 单文件 `papers.json`,**整个库一次性 JSON.stringify 写盘**。
- `loadStore` 启动时全量读进内存,`server.js` 一直持有这个 `store` 对象,所有读写都在内存对象上操作,定期 `saveStore` 落盘。
- 写锁是**进程内**的 `writeChain` Promise 链(`AGENTS.md` 明确说"靠 pm2 `instances:1` 守护;多实例会写坏 papers.json")。

#### 为什么必须换

| 场景 | 单机现状 | 云上的崩坏 |
|---|---|---|
| 多租户 | 一个 `papers.json` 装一个用户的数据 | 必须 per-user 隔离,单文件做不到 |
| 多实例 | `instances:1` 强约束 | 横向扩展瞬间数据错乱 |
| 大库 | `AGENTS.md` 自己写 ">500 篇建议迁 SQLite" | 全量 stringify 在几千篇时就开始卡 |
| 并发写 | 进程内锁 | 多容器/多地域无法共享锁 |
| 备份/审计 | `backupStore` 每日复制 JSON | 需要 DB 级快照 + 审计日志 |

#### 改造方向:Postgres + ORM(推荐),保留迁移路径

**选型理由**:
- 数据模型已经是结构化的(papers/tags/topics/folders/concepts/settings),关系清晰,**天然适合关系库**。
- 原作者自己标注了 ">500 篇建议迁 SQLite"——方向一致,只是云上直接上 Postgres(托管、备份、扩展都省心)。
- JSONB 列可保留"灵活字段"语义(annotations、settings),不必把每张表都拍平。

**最小侵入的迁移策略——保留 `store` 抽象,换底层**:

```
当前:   const store = await loadStore(path)   // 内存对象
        store.papers[id] = ...; saveStore(store)

目标:   const store = await loadStore(userId) // 从 DB 按租户装配
        // store 仍是「内存对象」形状,但 load/save 背后是 DB
```

具体地,把 `lib/store.js` 拆成两层:

1. **保留**所有纯函数逻辑(`normalizePaper` / `mergeTags` / `mergeTopics` / `mergeConcepts` / `conceptIdFor` / `normalizeAnnotations` 调用等)——这些是**业务规则**,与存储无关,原样复用。
2. **替换** `loadStore` / `saveStore` / `backupStore` 的实现为 DB 后端。`migrateStore` 仍保留,用于把老 `papers.json` 一次性导入(v1→v2 逻辑 + DB schema 的 seed)。

**表结构草案**(贴合现有数据模型,加 `userId`):

```sql
users        (id, email, createdAt, ...)              -- 新增
papers       (id, userId, filename, filepath→objectKey, title, authors(JSONB),
              summary, tags(JSONB), topics(JSONB), summaryModel, summaryAt,
              rating, starred, readStatus, status, error, fulltextChars,
              annotations(JSONB), readProgress(JSONB), notes, chat(JSONB),
              addedAt, updatedAt)                      -- 加 userId + 索引
folders      (id, userId, name, color, createdAt)
concepts     (id, userId, term, definition, paperIds(JSONB), createdAt, updatedAt)
settings     (userId PK, summaryPrompt, tagsPrompt, ai(JSONB加密), arxiv(JSONB),
              discover(JSONB加密), scanIntervalMinutes, updatedAt)
paper_concepts (paperId, conceptId)                    -- 多对多(替代 paperIds 数组)
```

**写锁问题**:DB 用行锁 / `SELECT ... FOR UPDATE` / 事务替代进程内 `writeChain`,天然多实例安全。`scanner.js` 里所有 `await deps.saveStore(store)` 调用点都改为「事务提交」语义。

**迁移脚本**:`scripts/migrate-json-to-pg.js`——读 `data/papers.json`,走现有 `migrateStore` 逻辑,按 userId=「单机原 owner」灌进 DB。给现有用户提供「本地库一键上云」的平滑路径。

#### 关于 sha1-content-id 模型(优点,务必保留)

```js
// scanner.js fingerprintAll
const id = (await sha1OfFile(it.filepath)).slice(0, 16);
```

paper id = **内容 sha1**,与文件名无关。这是**跨用户去重的天然基础**——云上可以做「内容寻址存储」(content-addressed storage):同一篇论文多用户导入,对象存储只存一份,DB 里多个 userId 引用同一 objectKey。**省存储 + 加速**。务必保留这个设计,不要改成 UUID。

---

### 2.2 文件层(`papers/*.pdf` → 对象存储)

#### 现状

- `papers/` 本地目录,`scanner.scanDir` 遍历 `.pdf`,`fingerprintAll` 算 sha1,`diffPapers` 增量。
- `server.js` 用 `serveStatic` + range 支持(`/papers/<rel>`,限 `papersDir` 内防越界)直接喂 PDF 给浏览器。
- 全文 `data/text/<id>.txt` 旁路存储。
- `processOne` 里会 `fsp.rename` 改文件名(规范命名),`DELETE` 会 `fs.rmSync` 删 PDF。

#### 改造方向

**云侧**:PDF 落对象存储(S3 / 阿里云 OSS / 腾讯云 COS),DB 只存 `objectKey`。全文文本(text/<id>.txt)直接进 DB 的 `fulltext` 列或单独表(反正要喂给 AI,从 DB 读比从对象存储读快)。

**关键改造点**(按出现频率排序):

1. **`POST /api/import`**(下载 arXiv PDF):`arxiv.downloadPaperPdf(url, destPath)` 改为「下载到内存/临时文件 → 上传对象存储 → 记 objectKey」。`lib/arxiv.js` 的 `downloadPaperPdf` 已经是注入式的,只需新增一个 `uploadPdf(objectKey, buffer)` 步骤。
2. **PDF 预览访问**(`/papers/<file>`):改成签名 URL(presigned URL),前端拿到临时 URL 直连对象存储,API 层不经手大文件流量。这对成本和延迟都好。
3. **`scanner.processOne` 的 `extractText`**(`lib/parser.js`):`pdfjs-dist` 需要 `Uint8Array`,目前 `fsp.readFile(filepath)`。改为「从对象存储拉到内存 Buffer」。`parser.js` 已经是 `new Uint8Array(await fsp.readFile(filepath))`,换成 `new Uint8Array(await objectStore.get(objectKey))` 即可,接口几乎不变。
4. **DELETE 清理**(`deletePapersCleanup`):`fs.rmSync(abs)` 改成 `objectStore.delete(objectKey)`。
5. **改名逻辑**(`processOne` 第 4 步 `fsp.rename`):**对象存储没有"改名",只有 objectKey**。规范命名只能改 DB 里的 `filename`(展示用),`objectKey` 用 sha1-id 一次性确定。这段 rename 逻辑在云上**直接删掉**。

**桌面端特殊处理**:Tauri 版保留本地 `papers/` 扫描模式(`scanner.js` 原逻辑),作为「不上云 PDF」的卖点。通过运行时判断 `mode: 'cloud' | 'local'` 切换 `objectStore` 的实现:云端用 S3 client,桌面端用一个 `LocalFsStore` 类(包装现有 `fsp` 调用)。**这就是依赖注入的价值**——`deps` 里塞不同实现即可,业务代码不动。

---

### 2.3 进程模型与流水线(`scanner.js` 串行队列 → 任务队列 + Worker)

#### 现状(已读 `lib/scanner.js` 全部 566 行)

```js
function createScanner({ store, ... }) {
  const queue = [];
  let processing = false;
  async function pump() {
    if (processing) return;          // 进程内串行
    processing = true;
    while (queue.length) { await processOne(queue.shift()); }
  }
}
```

- 串行队列,一次只处理一篇,理由是「避免压垮本地 AI / 触发 arXiv 限速」。
- `processOne` 串行跑:parse → arxiv → summarize → tags → rename → save。
- `reschedule` 热改扫描间隔,`drain` 优雅关停。

#### 改造方向:Redis + BullMQ(或 Cloud Tasks)

**为什么拆**:
- API 容器要**无状态、可秒级伸缩**,不能扛着「正在 AI 总结的长任务」。
- 多租户下,不同用户的论文处理要**并行**,单队列串行会成为瓶颈。
- `parse`(CPU 密集,pdfjs)和 `ai`(IO 密集,等模型)性质不同,可以分队列、分 worker 配额。

**拆法**:

| 队列 | 内容 | worker 特点 |
|---|---|---|
| `parse` | PDF 解析(pdfjs,提取全文) | CPU 密集,可独立扩容 |
| `enrich` | arXiv 元数据(全局限速) | IO 密集 + 全局速率限制 |
| `ai-summary` | 总结(Markdown) | IO 密集,等用户 key 的网关 |
| `ai-tags` | 标签/主题(JSON) | 同上 |
| `ai-concepts` | 概念抽取 | 同上 |

**关键约束保留**:
- **arXiv 全局限速**(`createRateLimiter(3000ms)`)在云上必须**全局共享**(Redis 计数器 / 分布式限流),不能每个 worker 各自限速,否则 N 个 worker = N 倍速率 = 被 arXiv 封。`lib/util.js` 的 `createRateLimiter` 要替换成基于 Redis 的版本。
- **BYO-key 下,AI 调用串行/并行可放宽**:因为每个用户用自己的 key,用户间不共享速率。可以 per-user 并行,per-user 内仍串行(避免用户自己的 key 被限速)。

**代码改造的友好点**:`processOne` 是一个**纯函数式的串行步骤序列**,把它拆成队列任务几乎是「把每段 `setStatus(id, 'parsing')` 之间的代码抽成一个 job handler」。现有的 `deps` 注入(`parser/arxiv/ai/saveStore`)让 worker 可以复用全部业务逻辑。

**优雅关停**:`scanner.drain(5000)` 的语义(等当前篇落盘)在云上变成「worker 处理完当前 job 后优雅退出」,BullMQ 原生支持。

---

### 2.4 鉴权与多租户隔离(**从零搭建**,最大新增工作量)

#### 现状

- `lib/api.js`:**零鉴权**,所有路由裸奔。`GET /api/papers` 返回全部论文,无 user 概念。
- `server.js` 默认 `127.0.0.1` 规避暴露。
- `AGENTS.md` 明确「无鉴权——多人/公网部署需自行加」。

#### 改造方向

**1. 身份认证**(选一):
- **OAuth 第三方登录**(GitHub / Google):开发者社区友好,起步最快。PaperWiki 的用户就是研究者,GitHub 登录契合。
- **邮箱 + 密码 / Magic Link**:用 Clerk / Auth0 / Supabase Auth 等托管服务,**强烈推荐自托管起步别自己写**——密码哈希、重置流程、session 管理坑极深。

**2. API 中间件**:每个请求解析 JWT → 注入 `req.userId`。所有 store 查询加 `WHERE userId = ?`。

**3. 数据隔离的系统性保证**(关键,防泄漏):
- 在**数据访问层(DAL)**统一强制 `userId` 过滤,不要在每个 handler 里手写(漏一处就泄漏)。
- 推荐:Postgres 用 **Row-Level Security (RLS)**,即使应用层漏了,DB 层也兜底。这是多租户 SaaS 的金标准。
- 单测里加一组**「跨租户隔离测试」**:用 user A 的 token 去 `GET /api/papers/:id`(B 的论文),必须 404(不是 403,避免探测)。

**4. 限流**:per-user + per-IP 的令牌桶(尤其在 BYO-key 下,防止有人把你的服务当 AI 网关白嫖算力——即使 key 是他自己的,你的 worker 算力是你的)。

**鉴权落地对现有 API 的改造**:所有路由 handler 签名从 `handle(req, res, body)` 改为 `handle(req, res, body)`,内部从 `req.userId` 取租户。改动面广但机械。`lib/api.js` 里 `Object.values(store.papers)` 这类全量遍历,全部改成 `dal.listPapers(userId, filters)`。

---

### 2.5 配置与密钥存储(BYO-key 的核心安全点)

#### 现状(已读 `lib/ai.js` 的 `applySettingsOverride` + `lib/api.js` 的设置端点)

- `config.json`:全局 AI key(明文,gitignore)。
- `store.settings`:运行时覆盖,**明文存 apiKey / S2 key**(在 `papers.json` 里裸奔)。
- `applySettingsOverride`:返回新对象,不污染原 config(设计干净)。
- 设置端点有掩码回显协议(`maskKey`,前端传回纯星号视为"不改")。

#### 改造方向:per-user 设置 + 密钥加密

**1. 全局 `config.json` 消失**:云上没有"全局配置文件",所有服务级配置走**环境变量 / Secret Manager**(AWS Secrets Manager / 阿里云 KMS / Docker secrets)。

**2. `store.settings` → per-user `settings` 表**,密钥字段**必须加密存储**:

```
DB: settings(userId, summaryPrompt, tagsPrompt,
             ai_baseurl, ai_model, ai_apikey_encrypted,  ← 加密
             discover_s2key_encrypted, ...)                ← 加密
```

**3. 加密方案**(BYO-key 的命脉):
- 用**信封加密(envelope encryption)**:每个用户的 key 用一个 DEK(数据密钥)加密,DEK 用 KMS 的主密钥加密后存 DB。
- 应用层解密只在**调用 AI 的瞬间**进行,**绝不**把明文 key 返回前端(`aiSettingsView` 的掩码回显逻辑保留并强化)。
- `applySettingsOverride` 这个函数**保留**(它已经是返回新对象、不污染原 config 的纯函数),只是它的输入来源从「内存 store.settings」变成「DB 解密后的 per-user 配置」。

**4. BYO-key 的调用边界**(重要安全决策,二选一):

| 方案 | 做法 | 优缺点 |
|---|---|---|
| **A. 后端代调(推荐)** | 用户 key 加密存 DB,worker 调 AI 时解密注入 `Authorization` | 体验好(前端无感);但平台经手明文 key(虽只在内存瞬间),需严格审计 + 内存不落地 |
| **B. 前端直调** | key 只存浏览器(localStorage/IndexedDB),前端直接打 AI 网关 | 平台完全不碰 key,安全责任清晰;但 CORS/跨域、流式 SSE 跨域、PDF 全文要传到前端等问题多 |

**推荐 A**,因为现有架构(chat 的 SSE、总结的批量 worker)都是后端发起的,改成 B 要重写整个调用链。A 的安全边界靠:**加密存储 + 信封密钥 + 调用瞬间解密 + 不写日志 + 掩码回显 + 内存用完即清**。

**5. `claude.js` 子进程调用**:`spawn('claude', ...)` 在云容器里**几乎一定不可用**(无头环境鉴权失败,`AGENTS.md` 陷阱 15 已述)。发现功能的 `buildDiscoveryQuery` 三级兜底(claude → GLM 网关 → 原始)**务必保留兜底链**,云上默认走网关(`queryEngine: 'gateway'`)。

---

### 2.6 前端(Web SPA + 桌面 Tauri)

#### 现状(已读 `index.html` + `app.js` 头部 + grep 全部函数)

- **零构建 ESM**:`public/*.js` 浏览器直加载,`/vendor/*` 映射 node_modules。
- `app.js` 2956 行单文件,`state.papers` 在 `refresh()` 里 `GET /api/papers` **一次性拉全量**,前端做筛选/排序。
- `reader.js` 1316 行,pdf.js `PDFViewer` 集成,批注/缩放/双页/续读/AI 对话。
- `styles.css` 1744 行,Indigo 主题,grid + flex 三栏布局。

#### 改造方向 A:Web 端

**好消息**:零构建 ESM 架构**可以直接保留**,前期甚至不用上构建工具。改造重点:

1. **鉴权**:加一个登录页 + token 存 localStorage,所有 `fetch` 包一层带 `Authorization: Bearer`。`app.js` 顶部的 `api/jget/jsend` 改造一次,全局生效。
2. **全量加载问题**(`refresh()` 拉全量):库一大就会卡。改成**分页 + 虚拟列表**(服务端 `GET /api/papers?cursor=&limit=50`),前端只渲染可视区。这是体验上的硬伤,但可以**分阶段**——先做服务端分页,前端虚拟列表用 `IntersectionObserver` 懒渲染。
3. **PDF 访问**:从 `/papers/<file>` 改成「先 `GET /api/papers/:id/pdf-url` 拿签名 URL,再喂给 pdf.js」。`reader.js` 改一个加载入口。
4. **搜索**:`q.q` 现在前端 `.includes()` 搜全量内存,大库不行 → 走 Postgres 全文索引(`tsvector`)或 Meilisearch/Typesense。

**关于是否上框架(React/Vue)**:
- **短期不上**:现有 2956 行 `app.js` 是命令式 DOM 操作,改造成框架成本巨大且无明显收益。
- **长期考虑**:如果要做复杂交互(协作、实时同步),再评估迁移到框架。但**PDF 阅读器(`reader.js`)无论如何都要保留**——pdf.js 的 viewer 集成是这套系统最值钱、最脆的部分(陷阱 6-11 全在这里),换框架重写风险极高。

**响应式适配**:`styles.css` 的 grid 三栏在小屏要重排(侧栏抽屉化、详情上下堆叠)。PDF 阅读器工具栏(`reader-bar`)在窄屏要折叠。这是纯 CSS 工作,**不涉及逻辑重写**。

#### 改造方向 B:桌面端 Tauri

**为什么是 Tauri 而非 Electron**:
- 体积小(Rust 后端 vs Electron 的 Chromium)、内存省、安全模型好。
- **可以保留本地 `papers/` 扫描模式**——这是桌面端区别于 Web 端的核心卖点("PDF 不上云,你的数据留在本机")。

**架构**:

```
Tauri App
├─ Webview: 加载 public/* (同一套前端,稍作适配)
├─ Rust 侧:
│   ├ 本地 HTTP server(嵌入 server.js 的逻辑,或直接 tauri command)
│   ├ papers/ 目录扫描(可复用 JS scanner,通过 tauri 调用)
│   └ 可选:Rust 实现 PDF 预处理(更快)
└─ 配置:本地 config.json(回归单机模式)
```

**关键决策:桌面端是否连云?**
- **选项 1:桌面端 = 纯本地**(单机模式,保留现在的所有逻辑,只是打包成 App)。改动最小,但和"云服务"脱节。
- **选项 2:桌面端 = 云客户端 + 本地模式开关**(默认连云账号,可选"本地模式"不上传 PDF)。**推荐**,兼顾 SaaS 用户增长和隐私卖点。
- 选项 2 下,桌面端通过同一个 API 层访问云端数据,本地模式则 fallback 到内嵌的本地 server。

**双模式抽象**:前文 2.2 提到的 `objectStore` 接口(云端 S3 / 本地 fs)正好服务于这里。`mode === 'local'` 用 `LocalFsStore`,`mode === 'cloud'` 用 `CloudObjectStore`。**业务代码(scanner/parser/api)一套,存储后端切换**——这又是依赖注入红利的体现。

---

### 2.7 工程化、部署与运维

#### 现状

- node --test(142 例)+ Playwright e2e,CI 两 job(lint-and-unit / e2e)。
- ESLint + Prettier,**仅覆盖 lib/server/tests**(public/ 排除,因无分号风格)。
- pm2 单实例,`backupStore` 每日备份 JSON。

#### 改造方向

**1. 容器化 + 编排**:
- `Dockerfile`(多阶段构建,基础镜像 `node:20-alpine`)。
- `docker-compose.yml`(本地起 Postgres + Redis + app)。
- 生产:**不要 pm2**。用容器编排(Kubernetes / 阿里云 ACK / AWS ECS / 甚至轻量的 Railway/Fly.io)。pm2 的 `instances:1` 约束在多容器下**完全失效**,这是迁出 pm2 的硬理由。

**2. 测试增强**:
- 现有单测基本可复用(`lib/*.js` 的纯函数逻辑不变)。
- **新增**:多租户隔离测试(跨 user 访问必须 404)、密钥加密/解密往返测试、对象存储 mock 测试、队列任务幂等性测试。
- e2e:加一个「登录 → 导入 → 看到自己的论文 → 切另一个用户看不到」的流程。

**3. 可观测性**(本地工具完全没有,云上必须):
- 结构化日志(JSON 日志,带 userId / requestId),接 Loki/ELK/云日志。
- 指标(论文处理耗时、AI 调用成功率、队列积压),接 Prometheus。
- 错误追踪(Sentry)。
- `GET /api/health` 保留,但升级为含 DB/Redis/对象存储依赖检查的深度探活。

**4. 备份**:`backupStore` 的每日 JSON 备份 → DB 的托管快照(RDS 自动备份)+ 对象存储版本控制。**Point-in-time recovery** 用 DB 自带能力。

**5. 配置管理**:`config.json` → 12-factor 环境变量。建议用 `zod` 做 env 校验,启动即验,避免运行时才报错。

---

## 3. 改造阶段规划(建议分 5 期)

> 原则:**每期都可独立交付、可回滚、不破坏现有单机用户**。单机模式作为「兜底私有部署」长期保留。

### 第 1 期:基础设施抽离(2-3 周)— 低风险高复用

**目标**:不动业务逻辑,把「存储/进程」假设抽象成接口,为后续替换铺路。

- [ ] 把 `lib/store.js` 的 `loadStore/saveStore` 抽成 `Store` 接口,现有 JSON 实现成为 `JsonFileStore`。
- [ ] 把文件访问(`fsp.readFile` / `serveStatic`)抽成 `ObjectStore` 接口,现有实现成为 `LocalFsStore`。
- [ ] 把 `scanner.js` 的 `processOne` 步骤拆成独立函数(仍串行调用),为后续变队列任务做准备。
- [ ] 把 `config.json` 读取改成「env 优先 + config 兜底」,为云上无 config.json 做准备。
- [ ] **验收**:单测全绿,e2e 全绿,单机行为完全不变。

**为什么先做这期**:依赖注入的脚手架搭好后,后面每期的替换都是「实现一个新类」,不再动业务逻辑。

### 第 2 期:数据层上 Postgres(2-3 周)— 最高风险

**目标**:替换存储后端,单机模式也改用 SQLite/Postgres(可选,或保留 JSON)。

- [ ] 定义 DB schema(+ Drizzle/Prisma ORM)。
- [ ] 实现 `PostgresStore`,通过第 1 期的 `Store` 接口接入。
- [ ] 写 `scripts/migrate-json-to-pg.js`,把现有 `papers.json` 灌进 DB。
- [ ] 单机模式:可用 SQLite(Native bindings,零运维)作为本地 DB,与云 Postgres 共用 schema。
- [ ] **验收**:导入 500 篇论文,列表/搜索/详情性能不退化;数据往返无损。

### 第 3 期:鉴权 + 多租户(2-3 周)— 新增工作量最大

**目标**:加用户体系,数据隔离。

- [ ] 接 Clerk/Supabase Auth(不自建)。
- [ ] API 中间件 + `req.userId` 注入。
- [ ] Postgres RLS 兜底隔离。
- [ ] 所有 store 查询加 userId。
- [ ] 跨租户隔离测试套件。
- [ ] **验收**:两个用户互不可见;单机模式(无登录)仍可用。

### 第 4 期:任务队列 + Worker + 对象存储(2-3 周)— 云化成型

**目标**:无状态 API + 异步处理 + PDF 上云。

- [ ] BullMQ + Redis,把 `processOne` 拆成队列任务。
- [ ] 全局 arXiv 限速改 Redis 分布式限流。
- [ ] `ObjectStore` 的 S3/OSS 实现,PDF 走签名 URL。
- [ ] API 容器 + Worker 容器分离部署。
- [ ] **验收**:API 可水平扩展(起 3 个实例不报错);导入流程异步化后前端有进度反馈。

### 第 5 期:BYO-key 加密 + 桌面端 + 上线(3-4 周)

**目标**:安全闭环 + 桌面 App + 生产部署。

- [ ] KMS 信封加密 per-user key。
- [ ] `applySettingsOverride` 接加密后的配置。
- [ ] BYO-key 安全审计(密钥不落日志、内存清理)。
- [ ] Tauri 打包(Webview 复用 + 本地模式)。
- [ ] 容器编排上线 + 可观测性接入。
- [ ] **验收**:安全审计通过;桌面端可登录云端账号 + 切本地模式;生产稳定运行。

**总计约 11-16 周(3-4 个月)**,假设 1-2 人全职。若保留单机模式作为开源版本长期维护,需要额外持续投入。

---

## 4. 风险清单与避坑指南

按风险等级排序:

### 🔴 致命级(不做会数据丢失/泄漏)

1. **多租户隔离必须 DB 级兜底(RLS)**:仅靠应用层 `WHERE userId` 早晚会漏。一处遗漏 = 用户看到别人的论文/笔记/批注。**这是 SaaS 的信任底线**。
2. **密钥绝不落盘明文 / 不入日志**:`applySettingsOverride` 解密后的 effConfig 含明文 key,任何 `log()` / 错误上报都不能打印它。现有 `maskedRawConfig` 的脱敏逻辑要扩展到所有日志路径。
3. **写锁迁移不能丢事务语义**:`writeChain` 保证「processOne 整篇原子写」。换 DB 后,`processOne` 的多步(parse 写全文 + arxiv 写元数据 + ai 写 summary + save)**必须在一个事务里**,否则中途崩溃会留下半成品状态(陷阱 1 的精神延续)。
4. **pdf.js viewer 集成(陷阱 6-11)不要动**:`reader.js` 的 1316 行是无数踩坑换来的,绝对值(spread 空白页、annotationEditorMode 枚举、quadPoints JSON 退化、cursor 模式禁用层……)。云化只改「PDF 从哪加载」(签名 URL),**不改 viewer 内部**。

### 🟠 高风险

5. **arXiv 全局限速必须分布式**:多 worker 各自限速 = N 倍速率 = 被 ban。这是 `AGENTS.md` 反复强调的礼貌限速,云上尤其重要(出口 IP 可能共享)。
6. **claude 子进程在云上必死**:`lib/claude.js` 的 `spawn('claude')` 在容器里 99% ENOENT 或 401。发现功能必须强制 `queryEngine: 'gateway'`,兜底链不能删。
7. **全量加载的性能悬崖**:`refresh()` 一次拉所有论文,几百篇还行,几千篇前端就卡死。第 2 期就要开始做分页,别等到用户投诉。
8. **sha1-id 撞库**:内容寻址去重是优点,但要防「恶意构造相同 sha1 的不同内容」(理论极难,但跨用户去重时要注意隔离)。

### 🟡 中风险

9. **批注坐标格式(陷阱 9)在 DB 里要保持**:`annotations` 用 JSONB 存,`normalizeAnnotations` 的双向归一化逻辑必须保留在写入/读取边界。
10. **配置覆盖语义(陷阱 19)要平移**:`applySettingsOverride` 的两套合并规则(`!== undefined && !== ''` vs `!== undefined`)是踩过坑的,迁到 per-user 配置时不能简化掉,否则 `false`/`0` 又被吞。
11. **桌面端与云端的 schema 同步**:双模式共用 schema,升级时要同时考虑本地 SQLite 和云 Postgres。

### 🟢 低风险(改造友好)

12. AI 调用层(`lib/ai.js`):纯函数 + 注入式,几乎不动。
13. arXiv/S2/OpenAlex 数据源层:只加全局限速,逻辑不动。
14. 提示词体系(陷阱 18 两次独立调用):保持不变,BYO-key 下用户可自定义提示词仍是卖点。

---

## 5. 技术选型推荐清单

| 层 | 推荐 | 备选 | 理由 |
|---|---|---|---|
| 运行时 | Node 20(保留) | Bun | 现有代码无缝,生态成熟 |
| Web 框架 | **Fastify** | Express/Hono | 比 Express 快、插件生态好、TS 友好;现有 `http.createServer` 逻辑易迁移 |
| DB | **Postgres**(云)+ SQLite(桌面) | PlanetScale/Supabase | JSONB 支持灵活字段 + RLS 多租户;SQLite 给桌面零运维 |
| ORM | **Drizzle** | Prisma/Kysely | 类型安全、SQL 透明、运行时轻;Prisma 太重 |
| 对象存储 | 云厂商原生(S3/OSS/COS) | MinIO(自托管) | 用哪家云就用哪家存储,降本 |
| 队列 | **BullMQ**(Redis) | Cloud Tasks/SQS | Node 生态成熟、优先级/重试/延迟队列全 |
| 鉴权 | **Clerk / Supabase Auth** | 自建/Lucia | 别自建,坑深;Supabase 顺便给 DB |
| 密钥 | 云 KMS(信封加密) | Vault | 用云厂商 KMS 最省心 |
| 桌面 | **Tauri 2.0** | Electron | 体积/内存/安全优势;Rust 侧可做重活 |
| 部署 | 容器 + 云托管(Fly.io/Railway/阿里云) | K8s(后期) | 小团队别一上来就 K8s |

---

## 6. 给你的几个战略性建议

1. **保留单机模式作为开源免费版,云服务作为商业化版本**。这符合 BYO-key 的调性(愿意自部署的用户用自己的 key,不和你抢生意),也给项目引流。双模式的技术代价(第 1 期抽象 + 桌面端)是值得的。

2. **第 1 期(抽象)和第 2 期(DB)是地基,宁可慢不要省**。这两期做完,后续每期都是「加新类」,风险可控。跳过抽象直接上 DB,会把业务逻辑和存储逻辑搅在一起,后期动弹不得。

3. **鉴权用托管服务,别自己写**。 Clerk/Supabase Auth 月费几十刀,省下的开发时间和避开的漏洞价值远超于此。把精力花在多租户**数据隔离**上,那才是这个产品的核心风险点。

4. **PDF 阅读器(`reader.js`)是产品护城河,不要在云化中重写它**。它的 1316 行踩坑代码是真正的资产。云化只碰「PDF 从哪来」,不碰「PDF 怎么渲染/批注」。

5. **BYO-key 是聪明的选择,但要把"平台经手 key"的安全边界做到极致**。建议做一次正式的安全设计评审:加密存储 → 信封密钥 → 调用瞬间解密 → 不落日志 → 掩码回显 → 内存清理。这条链路任何一个环节漏了,BYO-key 的信任承诺就崩了。

6. **先 Web 后桌面**。Web SaaS 先跑通(第 1-4 期),验证商业模式和用户量,再投桌面端(第 5 期)。桌面端的工作量容易被低估(Tauri 的 Rust 侧、本地/云双模式、打包签名分发)。

---

## 附录:现有代码的「云化友好度」逐文件评估

| 文件 | 行数 | 云化改动量 | 说明 |
|---|---|---|---|
| `lib/store.js` | 370 | 🔴 重写 | load/save/backup 换 DB;纯函数(merge*/normalize*)保留 |
| `lib/scanner.js` | 566 | 🟠 中 | processOne 拆队列任务;串行逻辑保留为单 worker 内 |
| `lib/api.js` | 987 | 🟠 中 | 加鉴权中间件 + userId 过滤;路由结构不动 |
| `lib/ai.js` | 476 | 🟢 小 | applySettingsOverride 接加密配置;调用逻辑不动 |
| `lib/discover.js` | 528 | 🟢 小 | 加全局限速注入;逻辑不动 |
| `lib/arxiv.js` | 149 | 🟢 极小 | 限速器换分布式;逻辑不动 |
| `lib/parser.js` | 54 | 🟢 极小 | readFile 换 objectStore.get;逻辑不动 |
| `lib/claude.js` | 81 | 🟡 中 | 云上禁用,强制走网关 |
| `lib/util.js` | 143 | 🟢 极小 | rateLimiter 换 Redis 版;其余不动 |
| `lib/annotations.js` | 55 | 🟢 不动 | 纯归一化逻辑 |
| `server.js` | 213 | 🔴 重写 | http.createServer → Fastify;静态/vendor 路由保留 |
| `public/app.js` | 2956 | 🟠 中 | 加鉴权 fetch + 分页;DOM 逻辑不动 |
| `public/reader.js` | 1316 | 🟢 小 | PDF 加载入口换签名 URL;viewer 不动 |
| `public/styles.css` | 1744 | 🟢 小 | 响应式适配;主题不动 |
| `public/index.html` | 627 | 🟢 小 | 加登录页;结构不动 |

**总评**:~9600 行里,**真正要重写的只有 `store.js` + `server.js`(~580 行)**,中改 4 个文件,**其余 80% 是小改或不改**。这是一份相当健康的云化起点。

---

*本报告基于 2026-06-25 的代码库快照。改造期间请以最新代码为准,并同步更新 `AGENTS.md` 的陷阱清单。*
