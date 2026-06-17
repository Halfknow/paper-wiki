# arXiv 论文管理站（PaperWiki）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 Node.js 薄服务，扫描本地 `papers/*.pdf`，自动提取文本、补全 arXiv 元数据、用 OpenAI 兼容接口生成总结与标签，提供一个可筛选/搜索/编辑笔记/预览 PDF 与 markdown 的 Web 页面，由 pm2 托管在 `0.0.0.0:8888`。

**Architecture:** 方案 B（适度模块化）。`server.js` 为 HTTP 入口，按关注点拆 `lib/{util,store,parser,arxiv,ai,scanner,api}.js`，每模块单一职责、可独立替换/测试。前端为 `public/` 下的无构建原生 ESM 单页应用。

**Tech Stack:** Node.js（CommonJS）、内置 `http` + `node:test` + `fetch`、`pdfjs-dist`（PDF 文本）、`fast-xml-parser`（arXiv Atom）、`marked`+`katex`+`dompurify`（前端渲染，装在 node_modules 由 server 映射为 `/vendor/`）、pm2。

**约定：**
- 工作目录为项目根 `D:/open_source_project/0.1_inbox/ai_paper_wiki`（下文命令默认在此目录）。
- 测试命令：`npm test`（= `node --test`）。
- 每个 lib 模块的可测逻辑抽成**纯函数**走 TDD；IO/网络部分通过依赖注入（`fetchImpl`、`deps`）支持 mock。
- 代码注释保持简洁，匹配现有风格。
- Windows 下用 Git Bash 运行命令；`cd` 请用绝对路径避免权限弹窗。

---

## File Structure（每个文件的职责）

| 文件 | 职责 |
|---|---|
| `package.json` | 依赖、脚本（`start`/`test`）、CommonJS |
| `config.example.json` | 配置模板（端口/AI/arxiv/扫描/提示词） |
| `config.json` | 实际配置（被 gitignore，含 key） |
| `lib/util.js` | 纯工具：sha1、sleep、限速器、标题规范化、相似度、文件名清洗、log |
| `lib/store.js` | JSON 存储：load/save（atomic+进程内锁）、paper 增改查、标签归并 |
| `lib/parser.js` | pdfjs 文本提取：`joinTextContent`（纯）、`extractText`（IO） |
| `lib/arxiv.js` | arXiv 补全：`parseAtom`/`pickBest`/`extractArxivId`（纯）、`searchArxiv`（IO） |
| `lib/ai.js` | OpenAI 兼容：`buildMessages`/`parseAiJson`/`buildSummaryMarkdown`（纯）、`summarize`（IO） |
| `lib/scanner.js` | 扫描+流水线：`scanDir`/`diffPapers`（可测）、`createScanner`（编排） |
| `lib/api.js` | REST 路由 + 视图函数 |
| `server.js` | HTTP 入口：静态托管（含 PDF range）、vendor 映射、API 分发、main() |
| `public/index.html` | 页面结构 |
| `public/styles.css` | 三栏布局与组件样式 |
| `public/app.js` | 状态/渲染/事件/markdown 渲染（ESM） |
| `ecosystem.config.cjs` | pm2 配置 |
| `README.md` | 安装、配置、运行、pm2 说明 |
| `tests/*.test.js` | 各模块单元测试 |

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `config.example.json`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "paper-wiki",
  "version": "1.0.0",
  "private": true,
  "description": "Thin local web service to manage arXiv PDFs with AI summaries, tags, notes and preview.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "scan": "node -e \"require('./scripts/scan-once.js')\""
  },
  "dependencies": {
    "dompurify": "^3.1.6",
    "fast-xml-parser": "^4.5.0",
    "katex": "^0.16.11",
    "marked": "^14.1.3",
    "pdfjs-dist": "^4.7.76"
  },
  "engines": { "node": ">=18.17" }
}
```

- [ ] **Step 2: 创建 `config.example.json`**

```json
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
  "arxiv": { "enabled": true, "titleSimilarityThreshold": 0.75, "minIntervalMs": 3000 },
  "summaryPrompt": ""
}
```

- [ ] **Step 3: 安装依赖并生成实际配置**

Run:
```bash
npm install
cp config.example.json config.json
```
Expected: `node_modules/` 生成，`config.json` 出现（被 gitignore 忽略）。

- [ ] **Step 4: 验证 Node 与依赖可加载**

Run:
```bash
node -e "require('fast-xml-parser'); console.log('xml ok')" && \
node -e "import('pdfjs-dist/legacy/build/pdf.mjs').then(()=>console.log('pdf ok'))"
```
Expected: 打印 `xml ok` 与 `pdf ok`。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json config.example.json
git commit -m "chore: project scaffold and dependencies"
```

---

## Task 2: lib/util.js（纯工具，TDD）

**Files:**
- Create: `lib/util.js`
- Test: `tests/util.test.js`

- [ ] **Step 1: 写失败测试 `tests/util.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTitle, titleSimilarity, cleanFilenameToTitle, sleep, createRateLimiter,
} = require('../lib/util');

test('normalizeTitle 小写化、去标点、折叠空白、去 LaTeX', () => {
  assert.strictEqual(normalizeTitle('A Survey of $L^2$ Losses!'), 'a survey of losses');
  assert.strictEqual(normalizeTitle(''), '');
});

test('titleSimilarity 用 Jaccard，相同标题=1，无关≈0', () => {
  assert.strictEqual(titleSimilarity('A Survey of LLMs', 'A Survey of LLMs'), 1);
  assert.ok(titleSimilarity('A Survey of Large Language Models', 'survey of large language models a') > 0.6);
  assert.strictEqual(titleSimilarity('cats', 'quantum gravity'), 0);
});

test('cleanFilenameToTitle 处理各种命名格式', () => {
  assert.strictEqual(cleanFilenameToTitle('2026-Zhao 等-A Survey of Large Language Models.pdf'),
    'A Survey of Large Language Models');
  assert.strictEqual(cleanFilenameToTitle('DeepSeek-AI 等 - 2024 - DeepSeek LLM Scaling Open-Source Language Models with Longtermism.pdf'),
    'DeepSeek LLM Scaling Open-Source Language Models with Longtermism');
  assert.strictEqual(cleanFilenameToTitle('Pre_2024_The Ultimate Guide to Fine-Tuning LLMs.pdf'),
    'The Ultimate Guide to Fine-Tuning LLMs');
  assert.strictEqual(cleanFilenameToTitle('JAIR_2025_A Survey on Data Selection.pdf'),
    'A Survey on Data Selection');
  assert.strictEqual(cleanFilenameToTitle('Some Paper_billingual.pdf'), 'Some Paper');
});

test('createRateLimiter 保证最小间隔', async () => {
  const lim = createRateLimiter(50);
  const t0 = Date.now();
  await lim(); await lim(); await lim();
  assert.ok(Date.now() - t0 >= 100, '三次调用至少间隔 100ms');
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/util'`）。

- [ ] **Step 3: 实现 `lib/util.js`**

```js
const crypto = require('crypto');
const fs = require('fs');

/** 流式计算文件 sha1，避免大 PDF 一次性入内存 */
function sha1OfFile(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 串行限速器：返回 async fn，调用它会排队，保证两次进入间隔 >= minIntervalMs */
function createRateLimiter(minIntervalMs) {
  let nextAt = 0;
  return async function throttled() {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    if (wait > 0) await sleep(wait);
    nextAt = Math.max(now, nextAt) + minIntervalMs;
  };
}

/** 标题规范化：小写、去 LaTeX、去非字母数字（unicode 感知）、折叠空白 */
function normalizeTitle(t) {
  if (!t) return '';
  return t.toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 基于 token 集合的 Jaccard 相似度，0~1 */
function titleSimilarity(a, b) {
  const sa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 从文件名清洗候选标题，针对本仓库的不统一命名格式 */
function cleanFilenameToTitle(filename) {
  let s = filename.replace(/\.pdf$/i, '');
  s = s.replace(/^(pre|jair|arxiv)[_\-\s]*\d{4}[_\-\s]*/i, ''); // 去前缀
  s = s.replace(/^\d{4}[_\-\s]+/, '');                            // 去开头年份
  s = s.replace(/^[^-—–]*?(?:\s+等|\bet al\.?)\s*[-—–]\s*/i, ''); // 去「作者 等 -」
  s = s.replace(/[^\d][-_]\s*(billingual|bilingual)$/i, '');      // 去后缀
  s = s.replace(/[_]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function log(...args) { console.log(new Date().toISOString(), ...args); }

module.exports = {
  sha1OfFile, sleep, createRateLimiter, normalizeTitle, titleSimilarity, cleanFilenameToTitle, log,
};
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（util 的 4 个测试全过）。

> 若 `cleanFilenameToTitle` 的 '作者 等 -' 用例失败，检查正则是否在「先去年份前缀」后被触发——年份已去，需确保 `^[^-—–]*?(?:\s+等…)` 仍能匹配剩余字符串开头。如必要把该步拆成"先去 ` 等 -` 再去前缀"。

- [ ] **Step 5: Commit**

```bash
git add lib/util.js tests/util.test.js
git commit -m "feat(util): hashing, rate limiter, title normalize/similarity/filename cleaning"
```

---

## Task 3: lib/store.js（JSON 存储，TDD）

**Files:**
- Create: `lib/store.js`
- Test: `tests/store.test.js`

- [ ] **Step 1: 写失败测试 `tests/store.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadStore, saveStore, upsertPaper, patchPaper, mergeTags } = require('../lib/store');

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
  return path.join(dir, 'papers.json');
}

test('loadStore 文件不存在时返回空 store', async () => {
  const store = await loadStore(tmpStorePath());
  assert.deepStrictEqual(store.papers, {});
  assert.deepStrictEqual(store.tags, []);
});

test('saveStore 原子写并可重新 load', async () => {
  const p = tmpStorePath();
  const store = { version: 1, tags: [], papers: {} };
  upsertPaper(store, { id: 'x1', title: 'T', status: 'ready' });
  await saveStore(p, store);
  const again = await loadStore(p);
  assert.ok(again.papers.x1);
  assert.strictEqual(again.papers.x1.title, 'T');
});

test('patchPaper 仅更新给定字段并刷新 updatedAt', async () => {
  const store = { version: 1, tags: [], papers: {} };
  upsertPaper(store, { id: 'x1', notes: '', status: 'ready' });
  const before = store.papers.x1.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  patchPaper(store, 'x1', { notes: 'hi', starred: true });
  assert.strictEqual(store.papers.x1.notes, 'hi');
  assert.strictEqual(store.papers.x1.starred, true);
  assert.strictEqual(store.papers.x1.status, 'ready'); // 未传字段保留
  assert.ok(store.papers.x1.updatedAt > before);
});

test('mergeTags 大小写不敏感去重，保留首次大小写', () => {
  const store = { version: 1, tags: ['RLHF'], papers: {} };
  mergeTags(store, ['rlhf', 'Data-Selection', 'fine-tuning']);
  assert.deepStrictEqual(store.tags.sort(), ['Data-Selection', 'RLHF', 'fine-tuning'].sort());
});

test('saveStore 串行化并发写不交错', async () => {
  const p = tmpStorePath();
  const store = { version: 1, tags: [], papers: {} };
  await Promise.all([
    saveStore(p, { ...store, tags: ['a'] }),
    saveStore(p, { ...store, tags: ['b'] }),
    saveStore(p, { ...store, tags: ['c'] }),
  ]);
  const final = await loadStore(p);
  assert.deepStrictEqual(final.tags.length, 1); // 每次 save 整体覆盖，最后一个胜出且文件完整
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/store'`）。

- [ ] **Step 3: 实现 `lib/store.js`**

```js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 进程内串行写锁：单 pm2 实例下足够保证 papers.json 不交错
let writeChain = Promise.resolve();

function ensureDataDir(storePath) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'text'), { recursive: true });
}

function emptyStore() { return { version: 1, tags: [], papers: {} }; }

async function loadStore(storePath) {
  ensureDataDir(storePath);
  try {
    const raw = await fsp.readFile(storePath, 'utf8');
    const data = JSON.parse(raw);
    data.papers = data.papers || {};
    data.tags = data.tags || [];
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyStore();
    throw e;
  }
}

async function saveStore(storePath, store) {
  const run = writeChain.then(async () => {
    ensureDataDir(storePath);
    const tmp = storePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, storePath); // atomic on same filesystem
  });
  writeChain = run.catch(() => {}); // 单次失败不阻塞后续
  await run;
}

function getPaper(store, id) { return store.papers[id] || null; }

function upsertPaper(store, paper) {
  const prev = store.papers[paper.id] || {};
  store.papers[paper.id] = { ...prev, ...paper, updatedAt: Date.now() };
  return store.papers[paper.id];
}

function patchPaper(store, id, patch) {
  const p = store.papers[id];
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: Date.now() });
  return p;
}

/** 大小写不敏感地把新标签并入全局字典，保留首次出现的写法 */
function mergeTags(store, newTags) {
  const map = new Map(store.tags.map((t) => [t.toLowerCase(), t]));
  for (const raw of newTags || []) {
    const t = String(raw).trim();
    const key = t.toLowerCase();
    if (key && !map.has(key)) map.set(key, t);
  }
  store.tags = [...map.values()].sort();
  return store.tags;
}

module.exports = {
  ensureDataDir, emptyStore, loadStore, saveStore,
  getPaper, upsertPaper, patchPaper, mergeTags,
};
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（util + store 全过）。

- [ ] **Step 5: Commit**

```bash
git add lib/store.js tests/store.test.js
git commit -m "feat(store): JSON store with atomic writes, in-process lock, tag merging"
```

---

## Task 4: lib/parser.js（pdfjs 文本提取）

**Files:**
- Create: `lib/parser.js`
- Test: `tests/parser.test.js`

> 说明：`joinTextContent` 是纯函数走单测；`extractText` 依赖真实 pdfjs，用 `papers/` 中任一现有 PDF 做一次冒烟测试（若无 PDF 则跳过）。

- [ ] **Step 1: 写失败测试 `tests/parser.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { joinTextContent, extractText } = require('../lib/parser');

test('joinTextContent 拼接多页 items 为文本，页间空行', () => {
  const pages = [
    { items: [{ str: 'Hello ' }, { str: 'World' }] },
    { items: [{ str: 'Page 2' }] },
  ];
  const out = joinTextContent(pages);
  assert.strictEqual(out, 'Hello World\n\nPage 2');
});

test('joinTextContent 折叠多余空白', () => {
  const out = joinTextContent([{ items: [{ str: 'a   b' }, { str: '  c' }] }]);
  assert.strictEqual(out, 'a b c');
});

test('extractText 对真实 PDF 提取非空文本（冒烟）', async (t) => {
  const dir = path.join(__dirname, '..', 'papers');
  if (!fs.existsSync(dir)) return t.skip('no papers/ dir');
  const pdf = fs.readdirSync(dir).find((f) => /\.pdf$/i.test(f));
  if (!pdf) return t.skip('no pdf to smoke-test');
  const { text, charCount, numPages } = await extractText(path.join(dir, pdf));
  assert.ok(numPages >= 1);
  assert.ok(charCount > 0);
  assert.ok(text.length > 0);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/parser'`）。

- [ ] **Step 3: 实现 `lib/parser.js`**

```js
const fsp = require('fs/promises');

/** 把 pdfjs 的 textContent.pages 拼接为纯文本：每页内部 join，页间空行 */
function joinTextContent(pages) {
  return pages
    .map((page) => (page.items || [])
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n\n');
}

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try { return await import('pdfjs-dist/legacy/build/pdf.mjs'); } // Node 友好，无 DOM worker
      catch { return await import('pdfjs-dist/build/pdf.mjs'); }
    })();
  }
  return pdfjsPromise;
}

/** 提取 PDF 全文。返回 { text, charCount, numPages } */
async function extractText(filepath) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await fsp.readFile(filepath));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(await page.getTextContent());
  }
  const numPages = doc.numPages;
  const text = joinTextContent(pages);
  try { await doc.destroy(); } catch {}
  return { text, charCount: text.length, numPages };
}

module.exports = { joinTextContent, extractText };
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（`joinTextContent` 两例通过；冒烟测试用真实 PDF 通过或 skip）。

> 若 pdfjs 报 worker/字体错误：确认使用的是 `legacy/build/pdf.mjs`；若仍报 `useSystemFonts` 相关警告可忽略（不影响文本）。如某 PDF 提取为空，多为扫描版 PDF（无文本层），属预期，后续由 AI 兜底元数据。

- [ ] **Step 5: Commit**

```bash
git add lib/parser.js tests/parser.test.js
git commit -m "feat(parser): pdfjs text extraction with page-aware joining"
```

---

## Task 5: lib/arxiv.js（arXiv 元数据补全，TDD）

**Files:**
- Create: `lib/arxiv.js`
- Test: `tests/arxiv.test.js`

- [ ] **Step 1: 写失败测试 `tests/arxiv.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { parseAtom, extractArxivId, pickBest, searchArxiv } = require('../lib/arxiv');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2303.18223v1</id>
    <title>A Survey of Large Language Models</title>
    <summary>Language is essentially a complex, intricate system...</summary>
    <published>2023-03-31T17:59:45Z</published>
    <author><name>Wayne Xin Zhao</name></author>
    <author><name>Kun Zhou</name></author>
    <link href="http://arxiv.org/pdf/2303.18223v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1234.56789v1</id>
    <title>Unrelated Paper About Quantum Gravity</title>
    <summary>zzz</summary>
    <published>2020-01-01T00:00:00Z</published>
    <author><name>Nobody</name></author>
  </entry>
</feed>`;

test('parseAtom 解析 entries，提取 title/authors/summary/pdfUrl', () => {
  const entries = parseAtom(SAMPLE);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].title, 'A Survey of Large Language Models');
  assert.deepStrictEqual(entries[0].authors, ['Wayne Xin Zhao', 'Kun Zhou']);
  assert.ok(entries[0].summary.startsWith('Language is'));
  assert.strictEqual(entries[0].pdfUrl, 'http://arxiv.org/pdf/2303.18223v1');
});

test('extractArxivId 从 abs URL 抽取 id', () => {
  assert.strictEqual(extractArxivId({ id: 'http://arxiv.org/abs/2303.18223v2' }), '2303.18223');
  assert.strictEqual(extractArxivId({ id: 'garbage' }), null);
});

test('pickBest 选相似度最高且过阈值的条目', () => {
  const entries = parseAtom(SAMPLE);
  const r = pickBest('A Survey of Large Language Models', entries, { threshold: 0.5 });
  assert.ok(r.best);
  assert.strictEqual(r.best.title, 'A Survey of Large Language Models');
  assert.ok(r.confidence >= 0.5);
  assert.strictEqual(r.source, 'arxiv');
});

test('pickBest 无匹配时返回 source none', () => {
  const entries = parseAtom(SAMPLE);
  const r = pickBest('Cat Photosynthesis', entries, { threshold: 0.75 });
  assert.strictEqual(r.best, null);
  assert.strictEqual(r.source, 'none');
});

test('searchArxiv 用注入的 fetch 并解析', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => SAMPLE });
  const { entries } = await searchArxiv('survey', fakeFetch, 0);
  assert.strictEqual(entries.length, 2);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/arxiv'`）。

- [ ] **Step 3: 实现 `lib/arxiv.js`**

```js
const { XMLParser } = require('fast-xml-parser');
const { titleSimilarity, sleep } = require('./util');

const ARXIV_API = 'http://export.arxiv.org/api/query';

function newParser() {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
}

/** 从 Atom XML 解析出标准化的 entries */
function parseAtom(xml, parser = newParser()) {
  const doc = parser.parse(xml);
  const feed = doc.feed || {};
  let entries = feed.entry;
  if (!entries) return [];
  entries = Array.isArray(entries) ? entries : [entries];
  return entries.map((e) => {
    const links = Array.isArray(e.link) ? e.link : (e.link ? [e.link] : []);
    const authors = (Array.isArray(e.author) ? e.author : [e.author])
      .map((a) => (a && a.name) ? a.name : null).filter(Boolean);
    return {
      title: (e.title || '').replace(/\s+/g, ' ').trim(),
      id: e.id || '',
      summary: (e.summary || '').replace(/\s+/g, ' ').trim(),
      published: e.published || '',
      authors,
      primaryCategory: (e['arxiv:primary_category'] && e['arxiv:primary_category']['@_term']) || null,
      pdfUrl: links.map((l) => l && l['@_href']).filter((h) => h && h.endsWith('.pdf'))[0] || null,
    };
  });
}

function extractArxivId(entry) {
  const m = /abs\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/.exec(entry.id || '');
  return m ? m[1] : null;
}

/** 从候选标题挑出最佳匹配，返回 { best, confidence, source } */
function pickBest(candidateTitle, entries, opts = {}) {
  const threshold = opts.threshold ?? 0.75;
  let best = null, bestScore = 0;
  for (const e of entries) {
    const score = titleSimilarity(candidateTitle, e.title);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (!best || bestScore < threshold) return { best: null, confidence: bestScore, source: 'none' };
  return { best, confidence: bestScore, source: 'arxiv' };
}

/** 查询 arXiv（注入 fetchImpl 便于测试）。简单 sleep 保证调用间隔礼貌。 */
async function searchArxiv(query, fetchImpl = fetch, minIntervalMs = 0) {
  if (minIntervalMs > 0) await sleep(minIntervalMs);
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&start=0&max_results=3`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'PaperWiki/1.0 (local research tool)' } });
  if (!res.ok) throw new Error(`arxiv HTTP ${res.status}`);
  const xml = await res.text();
  return { entries: parseAtom(xml), query };
}

module.exports = { newParser, parseAtom, extractArxivId, pickBest, searchArxiv };
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（util + store + parser + arxiv 全过）。

- [ ] **Step 5: Commit**

```bash
git add lib/arxiv.js tests/arxiv.test.js
git commit -m "feat(arxiv): atom parsing, similarity-based best match, fetchable search"
```

---

## Task 6: lib/ai.js（OpenAI 兼容总结/标签，TDD）

**Files:**
- Create: `lib/ai.js`
- Test: `tests/ai.test.js`

- [ ] **Step 1: 写失败测试 `tests/ai.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildMessages, parseAiJson, buildSummaryMarkdown, summarize } = require('../lib/ai');

const CFG = { ai: { baseURL: 'http://gw/v1', apiKey: 'k', model: 'm', maxInputChars: 100, timeoutMs: 1000 } };

test('buildMessages 截断全文到 maxInputChars 并含 system prompt', () => {
  const long = 'x'.repeat(500);
  const msgs = buildMessages({ title: 'T', abstract: 'A', fulltext: long, maxInputChars: 100 });
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('T'));
  assert.ok(msgs[1].content.length < 500);
});

test('parseAiJson 容忍代码块包裹与前后噪声', () => {
  assert.deepStrictEqual(parseAiJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseAiJson('noise {"a":2} trailing'), { a: 2 });
  assert.strictEqual(parseAiJson('not json'), null);
  assert.strictEqual(parseAiJson(''), null);
});

test('buildSummaryMarkdown 组装 TL;DR/贡献/方法', () => {
  const md = buildSummaryMarkdown({ tldr: '短', contributions: ['c1', 'c2'], method: 'M' });
  assert.ok(md.includes('## TL;DR'));
  assert.ok(md.includes('- c1'));
  assert.ok(md.includes('## 方法'));
});

test('buildSummaryMarkdown 处理 null', () => {
  assert.ok(buildSummaryMarkdown(null).includes('失败'));
});

test('summarize 调用注入的 fetch 并解析 JSON 输出', async () => {
  const fakeFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://gw/v1/chat/completions');
    assert.strictEqual(opts.headers.Authorization, 'Bearer k');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"tldr":"t","tags":["a"]}\n```' } }] }),
    };
  };
  const obj = await summarize({ title: 'T', abstract: 'A', fulltext: 'F', config: CFG, fetchImpl: fakeFetch });
  assert.strictEqual(obj.tldr, 't');
  assert.deepStrictEqual(obj.tags, ['a']);
});

test('summarize 非 2xx 抛错', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => summarize({ config: CFG, fetchImpl: fakeFetch }), /401/);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/ai'`）。

- [ ] **Step 3: 实现 `lib/ai.js`**

```js
const DEFAULT_PROMPT = `你是一位 AI/ML 论文研究员。阅读给定论文，输出严格的 JSON：
{
  "tldr": "一句话总结（中文，≤80字）",
  "contributions": ["关键贡献1", "关键贡献2"],
  "method": "方法简述（中文，3-5句）",
  "tags": ["lower-case-english-tag", ...],
  "metadata": { "title": "", "authors": [], "year": null }
}
要求：tags 为 3-6 个小写英文短语（用连字符）；metadata 仅在标题/作者/年份缺失时填写，否则字段留空。只输出 JSON。`;

function buildMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请按指定 JSON 格式输出。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 从模型文本输出解析 JSON，容忍代码块/前后噪声；失败返回 null */
function parseAiJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function buildSummaryMarkdown(obj) {
  if (!obj) return '*（总结生成失败，可点击「重新总结」重试）*';
  const lines = [];
  lines.push(`## TL;DR\n${obj.tldr || ''}`);
  if (Array.isArray(obj.contributions) && obj.contributions.length) {
    lines.push('## 关键贡献\n' + obj.contributions.map((c) => `- ${c}`).join('\n'));
  }
  if (obj.method) lines.push(`## 方法\n${obj.method}`);
  return lines.join('\n\n');
}

/** 调用 OpenAI 兼容 /chat/completions。fetchImpl 可注入。 */
async function summarize({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { baseURL, apiKey, model, maxInputChars, timeoutMs = 120000 } = config.ai;
  const messages = buildMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetchImpl(`${String(baseURL).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages, temperature: 0.3, response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseAiJson(text);
}

module.exports = { DEFAULT_PROMPT, buildMessages, parseAiJson, buildSummaryMarkdown, summarize };
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（所有模块测试全过）。

- [ ] **Step 5: Commit**

```bash
git add lib/ai.js tests/ai.test.js
git commit -m "feat(ai): openai-compatible summarizer with robust json parsing"
```

---

## Task 7: lib/scanner.js（扫描 + 处理流水线，TDD）

**Files:**
- Create: `lib/scanner.js`
- Test: `tests/scanner.test.js`

- [ ] **Step 1: 写失败测试 `tests/scanner.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { diffPapers, createScanner } = require('../lib/scanner');

test('diffPapers 计算 added/changed/missing', () => {
  const existing = {
    a: { id: 'a', fileSize: 10, status: 'ready' },
    b: { id: 'b', fileSize: 20, status: 'ready' },
    c: { id: 'c', fileSize: 30, status: 'missing' }, // 已 missing 不重复计
  };
  const scanned = [
    { id: 'a', size: 10 },        // 不变
    { id: 'b', size: 99 },        // 变了
    { id: 'd', size: 40 },        // 新增
  ];
  const d = diffPapers(existing, scanned);
  assert.deepStrictEqual(d.added.map((x) => x.id), ['d']);
  assert.deepStrictEqual(d.changed.map((x) => x.id), ['b']);
  assert.deepStrictEqual(d.missing.map((x) => x.id), []);
});

test('createScanner.scan 发现新 PDF 入库并入队，流水线将其处理为 ready', async () => {
  const papersDir = path.join(__dirname, '..', 'papers');
  let sample;
  try {
    sample = fs.existsSync(papersDir) && fs.readdirSync(papersDir).find((f) => /\.pdf$/i.test(f));
  } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan-'));
  const storePath = path.join(dir, 'papers.json');
  // 有真实 PDF 就复用；否则写占位（extractText 已被 mock，内容不重要）
  if (sample) fs.copyFileSync(path.join(papersDir, sample), path.join(dir, 'sample.pdf'));
  else fs.writeFileSync(path.join(dir, 'sample.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));

  const processed = [];
  const store = { version: 1, tags: [], papers: {} };
  const deps = {
    parser: { extractText: async () => ({ text: '全文内容', charCount: 5, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async () => ({ entries: [] }),
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      summarize: async () => ({ tldr: '短', contributions: ['x'], method: 'm', tags: ['demo'], metadata: { title: 'Sample', authors: ['A'], year: 2024 } }),
      buildSummaryMarkdown: (o) => '## TL;DR\n' + o.tldr,
    },
    saveStore: async () => {},
    mergeTags: (s, tags) => { s.tags = Array.from(new Set([...s.tags, ...tags])); },
    config: { ai: { model: 'm' }, arxiv: {} },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  assert.ok(r.added >= 1);
  // 等待队列处理完
  await new Promise((res) => setTimeout(res, 50));
  const paper = Object.values(store.papers)[0];
  assert.ok(paper, '应有论文入库');
  assert.strictEqual(paper.status, 'ready');
  assert.ok(paper.summary.includes('TL;DR'));
  assert.ok(paper.tags.includes('demo'));
  assert.strictEqual(paper.metaSource, 'ai-fallback');
  scanner.stop();
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/scanner'`）。

- [ ] **Step 3: 实现 `lib/scanner.js`**

```js
const fsp = require('fs/promises');
const path = require('path');
const { sha1OfFile, log } = require('./util');

/** 扫描目录下所有 PDF 文件信息 */
async function scanDir(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/\.pdf$/i.test(name)) continue;
    const filepath = path.join(dir, name);
    try {
      const st = await fsp.stat(filepath);
      if (!st.isFile()) continue;
      out.push({ filepath, filename: name, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out;
}

/** 对每个 PDF 计算 sha1(前16位) 作为稳定 id */
async function fingerprintAll(items) {
  const out = [];
  for (const it of items) {
    const id = (await sha1OfFile(it.filepath)).slice(0, 16);
    out.push({ ...it, id });
  }
  return out;
}

/** 对比现有 papers 与扫描指纹，算 added/changed/missing */
function diffPapers(existingPapers, scanned) {
  const scannedIds = new Set(scanned.map((s) => s.id));
  const added = [], changed = [];
  for (const s of scanned) {
    const cur = existingPapers[s.id];
    if (!cur) added.push(s);
    else if (cur.fileSize !== s.size || cur.status === 'missing') changed.push(s);
  }
  const missing = Object.values(existingPapers)
    .filter((p) => !scannedIds.has(p.id) && p.status !== 'missing');
  return { added, changed, missing };
}

/** 创建扫描器：负责增量扫描 + 串行处理流水线 */
function createScanner({ store, storePath, papersDir, deps, scanIntervalMs }) {
  const queue = [];
  let processing = false;
  let timer = null;

  function enqueue(ids) { for (const id of ids) queue.push(id); pump(); }

  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try { await processOne(id); }
        catch (e) { log('process error', id, e.message); }
      }
    } finally { processing = false; }
  }

  async function processOne(id) {
    const p = store.papers[id];
    if (!p) return;
    const textDir = path.join(path.dirname(storePath), 'text');
    try {
      // 1) 解析全文
      setStatus(id, 'parsing');
      const { text } = await deps.parser.extractText(p.filepath);
      const textPath = path.join(textDir, `${id}.txt`);
      await fsp.writeFile(textPath, text || '', 'utf8');
      store.papers[id].fulltextChars = text.length;
      store.papers[id].fulltextPath = textPath;

      // 2) arXiv 元数据
      if (deps.config.arxiv && deps.config.arxiv.enabled !== false) {
        setStatus(id, 'enriching');
        const candidate = deps.arxiv.cleanFilenameToTitle(p.filename);
        try {
          await deps.rateLimitArxiv();
          const { entries } = await deps.arxiv.searchArxiv(`ti:"${candidate}"`, fetch, deps.config.arxiv.minIntervalMs || 0);
          const { best, confidence, source } = deps.arxiv.pickBest(candidate, entries, { threshold: deps.config.arxiv.titleSimilarityThreshold });
          if (best && source === 'arxiv') {
            Object.assign(store.papers[id], {
              title: best.title, authors: best.authors, abstract: best.summary,
              arxivId: deps.arxiv.extractArxivId(best), arxivUrl: best.id,
              primaryCategory: best.primaryCategory, metaSource: 'arxiv', metaConfidence: confidence,
            });
          }
        } catch (e) { log('arxiv error', id, e.message); }
      }

      // 3) AI 总结 + 标签
      setStatus(id, 'summarizing');
      const obj = await deps.ai.summarize({
        title: store.papers[id].title, abstract: store.papers[id].abstract,
        fulltext: text, config: deps.config,
      });
      if (obj) {
        store.papers[id].summary = deps.ai.buildSummaryMarkdown(obj);
        store.papers[id].summaryModel = deps.config.ai.model;
        store.papers[id].summaryAt = Date.now();
        if (Array.isArray(obj.tags)) {
          store.papers[id].tags = obj.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
          deps.mergeTags(store, store.papers[id].tags);
        }
        if (!store.papers[id].title && obj.metadata) {
          store.papers[id].title = obj.metadata.title || p.filename.replace(/\.pdf$/i, '');
          store.papers[id].authors = obj.metadata.authors || [];
          store.papers[id].year = obj.metadata.year || null;
          store.papers[id].metaSource = store.papers[id].metaSource || 'ai-fallback';
        }
      }
      store.papers[id].status = 'ready';
      store.papers[id].error = null;
    } catch (e) {
      store.papers[id].status = 'error';
      store.papers[id].error = e.message;
      log('pipeline error', id, e.message);
    } finally {
      store.papers[id].updatedAt = Date.now();
      await deps.saveStore(storePath, store);
    }
  }

  function setStatus(id, status) { store.papers[id].status = status; }

  async function scan() {
    log('scanning', papersDir);
    const items = await scanDir(papersDir);
    const fp = await fingerprintAll(items);
    const { added, changed, missing } = diffPapers(store.papers, fp);
    for (const s of added) {
      store.papers[s.id] = {
        id: s.id, filename: s.filename, filepath: s.filepath,
        fileMtime: s.mtime, fileSize: s.size, addedAt: Date.now(),
        title: '', authors: [], year: null, abstract: '',
        arxivId: null, arxivUrl: null, primaryCategory: null,
        metaSource: null, metaConfidence: 0,
        fulltextChars: 0, fulltextPath: null,
        summary: '', summaryModel: null, summaryAt: null, tags: [],
        notes: '', starred: false, readStatus: 'unread',
        status: 'pending', error: null, updatedAt: Date.now(),
      };
    }
    for (const s of changed) {
      store.papers[s.id].status = 'pending';
      store.papers[s.id].fileSize = s.size;
    }
    for (const m of missing) store.papers[m.id].status = 'missing';
    await deps.saveStore(storePath, store);
    enqueue([...added, ...changed].map((s) => s.id));
    return { added: added.length, changed: changed.length, missing: missing.length };
  }

  function start() {
    scan().catch((e) => log('initial scan error', e.message));
    if (scanIntervalMs > 0) {
      timer = setInterval(() => scan().catch((e) => log('scan error', e.message)), scanIntervalMs);
    }
  }
  function stop() { if (timer) clearInterval(timer); }

  return { scan, enqueue, start, stop, processOne };
}

module.exports = { scanDir, fingerprintAll, diffPapers, createScanner };
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: PASS（含 scanner 的 `diffPapers` 与 `createScanner.scan` 流水线用例）。

- [ ] **Step 5: Commit**

```bash
git add lib/scanner.js tests/scanner.test.js
git commit -m "feat(scanner): incremental scan, fingerprint diff, serial processing pipeline"
```

---

## Task 8: lib/api.js + server.js（HTTP 服务）

**Files:**
- Create: `lib/api.js`
- Create: `server.js`
- Test: `tests/api.test.js`

- [ ] **Step 1: 写失败测试 `tests/api.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApiRouter } = require('../lib/api');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try { await handler(req, res, body); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/papers 返回列表视图（不含全文/notes 大字段可选）', async () => {
  const store = { version: 1, tags: ['rlhf'], papers: {
    a: { id: 'a', title: 'T1', tags: ['rlhf'], status: 'ready', readStatus: 'unread', starred: false, addedAt: 1 },
  } };
  const ctx = { store, save: async () => {}, scanner: { scan: async () => ({ added: 0 }) }, config: { ai: {} } };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data[0].id, 'a');
  server.close();
});

test('GET /api/papers 支持标签与全文 q 筛选', async () => {
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'Alpha', tags: ['rlhf'], status: 'ready', addedAt: 1, summary: '', notes: '', abstract: '' },
    b: { id: 'b', title: 'Beta', tags: ['data'], status: 'ready', addedAt: 2, summary: '', notes: '', abstract: '' },
  } };
  const router = createApiRouter({ store, save: async () => {}, scanner: { scan: async () => ({}) }, config: { ai: {} } });
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byTag = await call(port, 'GET', '/api/papers?tag=rlhf');
  assert.strictEqual(byTag.json.data.length, 1);
  assert.strictEqual(byTag.json.data[0].id, 'a');
  const byQ = await call(port, 'GET', '/api/papers?q=beta');
  assert.strictEqual(byQ.json.data[0].id, 'b');
  server.close();
});

test('PATCH /api/papers/:id 更新 notes/starred 并持久化', async () => {
  const store = { version: 1, tags: [], papers: {
    a: { id: 'a', title: 'T', notes: '', starred: false, status: 'ready', updatedAt: 0 },
  } };
  let saved = null;
  const router = createApiRouter({ store, save: async (s) => { saved = s; }, scanner: { scan: async () => ({}) }, config: { ai: {} } });
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', { notes: 'my note', starred: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.papers.a.notes, 'my note');
  assert.strictEqual(store.papers.a.starred, true);
  assert.ok(saved, 'save should be called');
  server.close();
});

test('GET /api/tags 返回字典+计数', async () => {
  const store = { version: 1, tags: ['rlhf', 'data'], papers: {
    a: { id: 'a', tags: ['rlhf'], status: 'ready' },
    b: { id: 'b', tags: ['rlhf', 'data'], status: 'ready' },
  } };
  const router = createApiRouter({ store, save: async () => {}, scanner: { scan: async () => ({}) }, config: { ai: {} } });
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/tags');
  const counts = Object.fromEntries(r.json.data.map((t) => [t.name, t.count]));
  assert.strictEqual(counts.rlhf, 2);
  assert.strictEqual(counts.data, 1);
  server.close();
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/api'`）。

- [ ] **Step 3: 实现 `lib/api.js`**

```js
const { log } = require('./util');

/** 列表视图：去掉超长大字段，保留前端列表所需 */
function summaryView(p) {
  return {
    id: p.id, filename: p.filename, title: p.title,
    authors: p.authors, year: p.year,
    status: p.status, error: p.error,
    metaSource: p.metaSource, metaConfidence: p.metaConfidence,
    arxivId: p.arxivId, arxivUrl: p.arxivUrl,
    tags: p.tags || [], starred: !!p.starred,
    readStatus: p.readStatus, addedAt: p.addedAt, updatedAt: p.updatedAt,
    hasSummary: !!p.summary, hasNotes: !!p.notes,
    summaryExcerpt: p.summary ? p.summary.slice(0, 160) : '',
  };
}

/** 详情视图：含完整 summary / notes */
function detailView(p) {
  return { ...summaryView(p), summary: p.summary || '', notes: p.notes || '',
    abstract: p.abstract || '', fulltextChars: p.fulltextChars || 0 };
}

function createApiRouter(ctx) {
  const { store, save, scanner, config } = ctx;

  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const method = req.method;

    const ok = (data) => send(res, 200, { ok: true, data });
    const fail = (code, error) => send(res, code, { ok: false, error });

    // GET /api/papers
    if (pathname === '/api/papers' && method === 'GET') {
      let list = Object.values(store.papers);
      if (q.tag) list = list.filter((p) => (p.tags || []).includes(q.tag));
      if (q.status) list = list.filter((p) => p.status === q.status);
      if (q.starred === '1') list = list.filter((p) => p.starred);
      if (q.readStatus) list = list.filter((p) => p.readStatus === q.readStatus);
      if (q.q) {
        const needle = q.q.toLowerCase();
        list = list.filter((p) => [p.title, p.abstract, p.summary, p.notes, ...(p.tags || [])]
          .join(' ').toLowerCase().includes(needle));
      }
      const sort = q.sort || 'addedDesc';
      list.sort((a, b) => (sort === 'titleAsc')
        ? (a.title || '').localeCompare(b.title || '')
        : (b.addedAt || 0) - (a.addedAt || 0));
      return ok(list.map(summaryView));
    }

    // GET /api/papers/:id
    const detail = /^\/api\/papers\/([\w.-]+)$/.exec(pathname);
    if (detail && method === 'GET') {
      const p = store.papers[detail[1]];
      return p ? ok(detailView(p)) : fail(404, 'Not found');
    }

    // PATCH /api/papers/:id
    if (detail && method === 'PATCH') {
      const p = store.papers[detail[1]];
      if (!p) return fail(404, 'Not found');
      const patch = JSON.parse(body || '{}');
      const allowed = ['notes', 'starred', 'readStatus', 'tags', 'title'];
      for (const k of allowed) if (k in patch) p[k] = patch[k];
      if (Array.isArray(patch.tags)) {
        p.tags = patch.tags;
        mergeInto(store, patch.tags);
      }
      p.updatedAt = Date.now();
      await save(store);
      return ok(detailView(p));
    }

    // POST /api/papers/:id/summarize  或  /parse
    const action = /^\/api\/papers\/([\w.-]+)\/(summarize|parse)$/.exec(pathname);
    if (action && method === 'POST') {
      const id = action[1];
      const p = store.papers[id];
      if (!p) return fail(404, 'Not found');
      // 重新处理：放回队列
      scanner.enqueue([id]);
      return ok({ queued: id });
    }

    // POST /api/scan
    if (pathname === '/api/scan' && method === 'POST') {
      const r = await scanner.scan();
      return ok(r);
    }

    // GET /api/tags
    if (pathname === '/api/tags' && method === 'GET') {
      const counts = {};
      for (const p of Object.values(store.papers)) for (const t of (p.tags || [])) counts[t] = (counts[t] || 0) + 1;
      return ok((store.tags || []).map((name) => ({ name, count: counts[name] || 0 })).sort((a, b) => b.count - a.count));
    }

    // PATCH /api/tags  { from, to } 合并  或  { rename:{from,to} } / { delete:'name' }
    if (pathname === '/api/tags' && method === 'PATCH') {
      const op = JSON.parse(body || '{}');
      if (op.merge && op.into) {
        for (const p of Object.values(store.papers)) {
          if ((p.tags || []).includes(op.merge)) {
            p.tags = Array.from(new Set(p.tags.map((t) => t === op.merge ? op.into : t)));
          }
        }
      } else if (op.delete) {
        for (const p of Object.values(store.papers)) p.tags = (p.tags || []).filter((t) => t !== op.delete);
      }
      // 重建字典
      const set = new Set();
      for (const p of Object.values(store.papers)) for (const t of (p.tags || [])) set.add(t);
      store.tags = [...set].sort();
      await save(store);
      return ok({ tags: store.tags });
    }

    // GET /api/stats
    if (pathname === '/api/stats' && method === 'GET') {
      const all = Object.values(store.papers);
      return ok({
        total: all.length,
        ready: all.filter((p) => p.status === 'ready').length,
        error: all.filter((p) => p.status === 'error').length,
        processing: all.filter((p) => ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)).length,
      });
    }

    return fail(404, 'No route');
  }

  return { handle };
}

function mergeInto(store, tags) {
  const map = new Map((store.tags || []).map((t) => [t.toLowerCase(), t]));
  for (const raw of tags) {
    const t = String(raw).trim();
    if (t && !map.has(t.toLowerCase())) map.set(t.toLowerCase(), t);
  }
  store.tags = [...map.values()].sort();
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

module.exports = { createApiRouter, summaryView, detailView };
```

- [ ] **Step 4: 实现 `server.js`**

```js
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadStore, saveStore, mergeTags } = require('./lib/store');
const { createScanner } = require('./lib/scanner');
const parser = require('./lib/parser');
const arxiv = require('./lib/arxiv');
const ai = require('./lib/ai');
const { cleanFilenameToTitle, createRateLimiter, log } = require('./lib/util');
const { createApiRouter } = require('./lib/api');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const VENDOR_MAP = {
  '/vendor/marked.js': ['marked', 'marked.min.js'],
  '/vendor/dompurify.js': ['dompurify', 'dist/purify.min.js'],
  '/vendor/katex.js': ['katex', 'dist/katex.min.js'],
  '/vendor/katex.css': ['katex', 'dist/katex.min.css'],
};

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error('缺少 config.json，请复制 config.example.json 为 config.json 并填写 AI 配置');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function serveStatic(req, res, filePath, download) {
  let st;
  try { st = await fsp.stat(filePath); }
  catch { res.writeHead(404); return res.end('Not found'); }
  if (st.isDirectory()) return serveStatic(req, res, path.join(filePath, 'index.html'));
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start > end) [start, end] = [end, start];
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const config = loadConfig();
  const storePath = path.join(__dirname, 'data', 'papers.json');
  const store = await loadStore(storePath);
  const papersDir = path.resolve(__dirname, config.papersDir || 'papers');

  const rateLimitArxiv = createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000);
  const deps = {
    parser, arxiv: { ...arxiv, cleanFilenameToTitle }, ai,
    config, rateLimitArxiv,
    saveStore: (s) => saveStore(storePath, s),
    mergeTags,
  };
  const scanner = createScanner({
    store, storePath, papersDir, deps,
    scanIntervalMs: (config.scanIntervalMinutes || 5) * 60 * 1000,
  });
  const router = createApiRouter({ store, save: (s) => saveStore(storePath, s), scanner, config });

  const PUBLIC_DIR = path.join(__dirname, 'public');
  const NM = path.join(__dirname, 'node_modules');

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);

      // PDF 原文（range 支持）
      if (pathname.startsWith('/papers/')) {
        const rel = pathname.slice('/papers/'.length);
        const abs = path.resolve(papersDir, rel);
        if (!abs.startsWith(papersDir)) { res.writeHead(400); return res.end('Bad path'); }
        return serveStatic(req, res, abs);
      }

      // vendor（node_modules 映射 + katex 字体目录）
      if (pathname.startsWith('/vendor/')) {
        if (VENDOR_MAP[pathname]) {
          const [pkg, file] = VENDOR_MAP[pathname];
          return serveStatic(req, res, path.join(NM, pkg, file));
        }
        if (pathname.startsWith('/vendor/katex-fonts/')) {
          const rel = pathname.slice('/vendor/katex-fonts/'.length);
          return serveStatic(req, res, path.join(NM, 'katex', 'dist', 'fonts', rel));
        }
        res.writeHead(404); return res.end('Not found');
      }

      // API
      if (pathname.startsWith('/api/')) {
        const body = await readBody(req);
        return router.handle(req, res, body);
      }

      // 静态前端
      let fp = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(400); return res.end('Bad path'); }
      return serveStatic(req, res, fp);
    } catch (e) {
      log('server error', e.message);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    }
  });

  scanner.start();
  server.listen(config.port || 8888, config.host || '0.0.0.0', () => {
    log(`PaperWiki listening on http://${config.host || '0.0.0.0'}:${config.port || 8888}`);
  });

  const shutdown = () => { scanner.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { loadConfig, serveStatic, MIME };
```

- [ ] **Step 5: 跑测试看通过**

Run: `npm test`
Expected: PASS（所有测试，含 api 的 4 个用例）。

- [ ] **Step 6: Commit**

```bash
git add lib/api.js server.js tests/api.test.js
git commit -m "feat(server): http server with static/pdf/vendor serving and rest api"
```

---

## Task 9: 前端 public/（单页应用）

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`

> 前端无构建：原生 ESM，markdown 用 marked + katex + dompurify（已由 server 映射为 `/vendor/*`）。难以单元测试，以"启动服务后访问验证"作为验收（见 Task 10）。

- [ ] **Step 1: 创建 `public/index.html`**

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PaperWiki</title>
  <link rel="stylesheet" href="/vendor/katex.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">📚 PaperWiki</div>
    <input id="search" type="search" placeholder="搜索标题/摘要/总结/笔记/标签…" />
    <select id="filter-status"><option value="">全部状态</option><option value="ready">已就绪</option><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读</option><option value="error">出错</option><option value="pending">处理中</option></select>
    <select id="filter-tag"><option value="">全部标签</option></select>
    <label class="star"><input id="filter-starred" type="checkbox" /> 仅看星标</label>
    <button id="btn-scan" title="手动扫描文件夹">⟳ 扫描</button>
    <span id="stats" class="stats"></span>
  </header>

  <main class="layout">
    <aside class="list-pane">
      <ul id="paper-list" class="paper-list"></ul>
    </aside>

    <section id="detail" class="detail-pane">
      <div class="empty">从左侧选择一篇论文</div>
    </section>
  </main>

  <script src="/vendor/marked.js"></script>
  <script src="/vendor/dompurify.js"></script>
  <script src="/vendor/katex.js"></script>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 `public/styles.css`**

```css
:root { --bg:#0f1115; --panel:#171a21; --panel2:#1f2430; --border:#2a3140; --text:#e6e8ec; --muted:#9aa4b2; --accent:#6ea8fe; --green:#4ec9b0; --red:#f48771; --yellow:#d7ba7d; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
.topbar { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:10; flex-wrap:wrap; }
.brand { font-weight:700; font-size:16px; white-space:nowrap; }
#search { flex:1; min-width:180px; padding:7px 10px; background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:6px; }
select, .star { background:var(--panel2); border:1px solid var(--border); color:var(--text); padding:6px 8px; border-radius:6px; }
.star { display:flex; align-items:center; gap:4px; }
button { background:var(--accent); color:#0f1115; border:0; padding:7px 12px; border-radius:6px; cursor:pointer; font-weight:600; }
button.ghost { background:var(--panel2); color:var(--text); border:1px solid var(--border); }
.stats { color:var(--muted); font-size:12px; }
.layout { display:grid; grid-template-columns:340px 1fr; height:calc(100vh - 53px); }
.list-pane { overflow:auto; border-right:1px solid var(--border); background:var(--panel); }
.paper-list { list-style:none; margin:0; padding:6px; }
.paper-item { padding:10px; border-radius:8px; cursor:pointer; border:1px solid transparent; }
.paper-item:hover { background:var(--panel2); }
.paper-item.active { background:var(--panel2); border-color:var(--accent); }
.paper-item .pt { font-weight:600; margin-bottom:3px; }
.paper-item .pm { color:var(--muted); font-size:12px; }
.paper-item .tags { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
.tag { background:var(--panel2); border:1px solid var(--border); color:var(--muted); padding:1px 7px; border-radius:10px; font-size:11px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; }
.dot.ready{background:var(--green);} .dot.error{background:var(--red);} .dot.busy{background:var(--yellow);} .dot.missing{background:var(--muted);}
.detail-pane { overflow:auto; padding:20px 26px; }
.empty { color:var(--muted); text-align:center; margin-top:40vh; }
.dh { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.dh h2 { margin:0; font-size:18px; flex:1; min-width:200px; }
.tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin:12px 0; }
.tab { padding:8px 14px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; }
.tab.active { color:var(--text); border-color:var(--accent); }
.md { max-width:820px; }
.md h1,.md h2,.md h3{color:var(--text);} .md code{background:var(--panel2);padding:1px 5px;border-radius:4px;}
.notes-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; max-width:1100px; }
.notes-grid textarea { width:100%; min-height:420px; background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:12px; font:13px/1.6 ui-monospace,Consolas,monospace; resize:vertical; }
.md-preview { padding:6px 2px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:14px; }
.badge { font-size:11px; padding:1px 7px; border-radius:4px; border:1px solid var(--border); color:var(--muted); }
.badge.warn { color:var(--yellow); border-color:var(--yellow); }
iframe.pdf { width:100%; height:calc(100vh - 200px); border:1px solid var(--border); border-radius:8px; }
```

- [ ] **Step 3: 创建 `public/app.js`**

```js
const api = (p, opt) => fetch(p, opt).then((r) => r.json());

const state = {
  papers: [], tags: [], current: null, tab: 'summary',
  filter: { q: '', status: '', tag: '', starred: false },
};

const $ = (id) => document.getElementById(id);

function statusDot(p) {
  if (p.status === 'ready') return 'ready';
  if (p.status === 'error') return 'error';
  if (p.status === 'missing') return 'missing';
  return 'busy';
}

async function refresh() {
  const params = new URLSearchParams();
  if (state.filter.q) params.set('q', state.filter.q);
  if (state.filter.status) {
    if (['unread', 'reading', 'done'].includes(state.filter.status)) params.set('readStatus', state.filter.status);
    else params.set('status', state.filter.status);
  }
  if (state.filter.tag) params.set('tag', state.filter.tag);
  if (state.filter.starred) params.set('starred', '1');
  const [{ data: papers }, { data: tags }, { data: stats }] = await Promise.all([
    api('/api/papers?' + params), api('/api/tags'), api('/api/stats'),
  ]);
  state.papers = papers || [];
  state.tags = tags || [];
  $('stats').textContent = `${stats.ready}/${stats.total} 已就绪 · ${stats.processing} 处理中 · ${stats.error} 出错`;
  renderList();
  renderTagFilter();
  if (state.current) renderDetail(); // 刷新当前详情
}

function renderList() {
  const ul = $('paper-list');
  ul.innerHTML = '';
  for (const p of state.papers) {
    const li = document.createElement('li');
    li.className = 'paper-item' + (state.current === p.id ? ' active' : '');
    li.innerHTML = `
      <div class="pt"><span class="dot ${statusDot(p)}"></span>${escapeHtml(p.title || p.filename)}</div>
      <div class="pm">${(p.authors || []).slice(0,2).join(', ')}${p.authors && p.authors.length>2?' 等':''} · ${p.year||''} ${p.starred?'★':''}</div>
      <div class="tags">${(p.tags||[]).slice(0,5).map((t)=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`;
    li.onclick = () => select(p.id);
    ul.appendChild(li);
  }
  if (!state.papers.length) ul.innerHTML = '<li class="paper-item">暂无论文，把 PDF 放入 papers/ 并点「扫描」</li>';
}

function renderTagFilter() {
  const sel = $('filter-tag');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部标签</option>' +
    state.tags.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${t.count})</option>`).join('');
  sel.value = cur;
}

async function select(id) {
  state.current = id;
  const { data: p } = await api('/api/papers/' + encodeURIComponent(id));
  state.detail = p;
  renderList();
  renderDetail();
}

function renderDetail() {
  const p = state.detail;
  if (!p) { $('detail').innerHTML = '<div class="empty">从左侧选择一篇论文</div>'; return; }
  const meta = `${(p.authors||[]).join(', ') || '未知作者'}${p.year?' · '+p.year:''}` +
    (p.arxivUrl ? ` · <a href="${p.arxivUrl}" target="_blank">arXiv ${p.arxivId||''} ↗</a>` : '') +
    (p.metaSource === 'ai-fallback' ? ' · <span class="badge warn">元数据为 AI 推断</span>' : ` · <span class="badge">${p.metaSource||''}</span>`);
  $('detail').innerHTML = `
    <div class="dh">
      <h2>${escapeHtml(p.title || p.filename)}</h2>
      <button class="ghost" id="b-star">${p.starred?'★ 已收藏':'☆ 收藏'}</button>
      <select id="sel-read"><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读</option></select>
      <button id="b-resume">⟳ 重新总结</button>
    </div>
    <div class="meta">${meta}</div>
    <div class="tags">${(p.tags||[]).map((t)=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    <div class="tabs">
      <div class="tab ${state.tab==='summary'?'active':''}" data-tab="summary">总结</div>
      <div class="tab ${state.tab==='notes'?'active':''}" data-tab="notes">笔记</div>
      <div class="tab ${state.tab==='pdf'?'active':''}" data-tab="pdf">PDF 原文</div>
    </div>
    <div id="tab-body"></div>`;
  $('sel-read').value = p.readStatus || 'unread';
  $('b-star').onclick = () => patch(p.id, { starred: !p.starred });
  $('sel-read').onchange = (e) => patch(p.id, { readStatus: e.target.value });
  $('b-resume').onclick = async () => { await api('/api/papers/'+p.id+'/summarize', { method: 'POST' }); setTimeout(refresh, 500); };
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => { state.tab = t.dataset.tab; renderDetail(); });
  renderTabBody();
}

function renderTabBody() {
  const p = state.detail;
  const body = $('tab-body');
  if (state.tab === 'summary') {
    body.innerHTML = `<div class="md">${renderMd(p.summary || '*（尚无总结，处理中或点击「重新总结」）*')}</div>`;
  } else if (state.tab === 'notes') {
    body.innerHTML = `<div class="notes-grid">
      <textarea id="notes-edit" placeholder="用 Markdown 记笔记，右侧实时预览（支持 $公式$）…">${escapeHtml(p.notes||'')}</textarea>
      <div class="md md-preview" id="notes-preview"></div></div>`;
    const te = $('notes-edit'), pv = $('notes-preview');
    const render = () => { pv.innerHTML = renderMd(te.value); };
    render();
    let saveTimer;
    te.oninput = () => { render(); clearTimeout(saveTimer); saveTimer = setTimeout(() => patch(p.id, { notes: te.value }, true), 800); };
    te.onkeydown = (e) => { if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); patch(p.id, { notes: te.value }); } };
  } else if (state.tab === 'pdf') {
    body.innerHTML = `<iframe class="pdf" src="/papers/${encodeURIComponent(p.filename)}"></iframe>`;
  }
}

async function patch(id, fields, silent) {
  await api('/api/papers/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
  if (!silent && state.detail) { state.detail = { ...state.detail, ...fields }; renderDetail(); }
}

function renderMd(md) {
  const raw = marked.parse(md || '', { breaks: true });
  let html = DOMPurify.sanitize(raw);
  // 行内/块级 LaTeX
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => katex.renderToString(e, { displayMode: true, throwOnError: false }));
  html = html.replace(/\$([^$\n]+?)\$/g, (_, e) => katex.renderToString(e, { displayMode: false, throwOnError: false }));
  return html;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function bind() {
  $('search').oninput = (e) => { state.filter.q = e.target.value; clearTimeout(window._t); window._t = setTimeout(refresh, 250); };
  $('filter-status').onchange = (e) => { state.filter.status = e.target.value; refresh(); };
  $('filter-tag').onchange = (e) => { state.filter.tag = e.target.value; refresh(); };
  $('filter-starred').onchange = (e) => { state.filter.starred = e.target.checked; refresh(); };
  $('btn-scan').onclick = async () => { await api('/api/scan', { method: 'POST' }); setTimeout(refresh, 500); };
}

bind();
refresh();
setInterval(refresh, 10000); // 轻量轮询，让处理中的论文状态自动更新
```

- [ ] **Step 4: 启动服务做冒烟验证（需先填好 `config.json` 的真实 AI 配置）**

Run:
```bash
node server.js &
sleep 2
curl -s http://127.0.0.1:8888/api/stats
```
Expected: 返回 `{"ok":true,"data":{"total":N,...}}`；浏览器打开 `http://127.0.0.1:8888` 看到页面（即使此时仍在处理）。

> 验证后 `kill %1` 停止（Task 10 用 pm2 正式托管）。

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat(web): static SPA with list/filter/search, summary/notes/pdf tabs"
```

---

## Task 10: pm2 配置 + README + 端到端验证

**Files:**
- Create: `ecosystem.config.cjs`
- Create: `README.md`
- Create: `scripts/scan-once.js`（可选：CLI 跑一次扫描不入常驻）

- [ ] **Step 1: 创建 `ecosystem.config.cjs`**

```js
module.exports = {
  apps: [{
    name: 'paper-wiki',
    script: 'server.js',
    cwd: __dirname,
    watch: false,                 // 扫描靠定时器；不 watch 避免改 data/ 误重启
    instances: 1,                 // 单实例：保证 JSON 进程内锁有效
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '512M',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    time: true,
  }],
};
```

- [ ] **Step 2: 创建 `scripts/scan-once.js`**

```js
// 不启动 HTTP，仅跑一次扫描并退出。供 npm run scan 或排错使用。
const path = require('path');
const fs = require('fs');
const { loadStore, saveStore, mergeTags } = require('../lib/store');
const { createScanner } = require('../lib/scanner');
const parser = require('../lib/parser');
const arxiv = require('../lib/arxiv');
const ai = require('../lib/ai');
const { cleanFilenameToTitle, createRateLimiter } = require('../lib/util');

(async () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const root = path.join(__dirname, '..');
  const storePath = path.join(root, 'data', 'papers.json');
  const store = await loadStore(storePath);
  const deps = {
    parser, arxiv: { ...arxiv, cleanFilenameToTitle }, ai, config,
    rateLimitArxiv: createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000),
    saveStore: (s) => saveStore(storePath, s), mergeTags,
  };
  const scanner = createScanner({ store, storePath, papersDir: path.resolve(root, config.papersDir), deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  console.log('scan result:', r);
  // 等待队列排空
  setTimeout(() => process.exit(0), 60_000);
})();
```

- [ ] **Step 3: 创建 `README.md`**

````markdown
# PaperWiki — 本地 arXiv 论文管理站

扫描 `papers/*.pdf`，自动提取文本、补全 arXiv 元数据、用 OpenAI 兼容接口生成总结与标签，提供一个可筛选/搜索/编辑笔记/预览 PDF 与 Markdown 的 Web 页面。

## 安装

```bash
npm install
cp config.example.json config.json
# 编辑 config.json：填入 ai.baseURL / apiKey / model（指向你的 New API gateway）
```

## 运行（开发）

```bash
npm start            # node server.js
# 浏览器打开 http://localhost:8888
```

## 运行（生产，pm2 托管 0.0.0.0:8888）

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # 开机自启
pm2 logs paper-wiki         # 查看日志
pm2 restart paper-wiki      # 改完 config 后重启
```

访问 `http://<本机IP>:8888`。

## 配置说明（config.json）

| 字段 | 说明 |
|---|---|
| `host` / `port` | 监听地址，默认 `0.0.0.0:8888` |
| `papersDir` | PDF 目录，默认 `papers` |
| `scanIntervalMinutes` | 增量扫描间隔，默认 5 |
| `ai.baseURL/apiKey/model` | OpenAI 兼容接口（New API gateway） |
| `ai.maxInputChars` | 送入模型的全文截断长度，默认 24000 |
| `arxiv.enabled` | 是否查 arXiv 补元数据 |
| `arxiv.titleSimilarityThreshold` | 标题匹配阈值，默认 0.75 |

## 工作方式

1. 启动/定时扫描 `papers/`，按文件 sha1 识别新增/变更。
2. 每篇走流水线：提取文本 → 查 arXiv 补元数据（不达标则 AI 兜底）→ AI 生成总结+标签。
3. 所有状态存 `data/papers.json`；全文存 `data/text/<id>.txt`。
4. 页面可搜索、按标签/状态/星标筛选，编辑 Markdown 笔记（实时预览，支持 LaTeX），预览 PDF 原文。

## 目录

```
papers/        你的 PDF（只读）
data/          papers.json + text/（运行时数据，已 gitignore）
lib/           后端模块
public/        前端静态页
```
````

- [ ] **Step 4: 跑全部测试**

Run: `npm test`
Expected: PASS（所有测试通过）。

- [ ] **Step 5: 端到端验证（pm2 + 真实 8888）**

Run:
```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
sleep 5
pm2 logs paper-wiki --lines 20 --nostream
curl -s http://0.0.0.0:8888/api/stats
```
Expected:
- pm2 显示 `paper-wiki` 状态 `online`。
- 日志出现 `PaperWiki listening on http://0.0.0.0:8888` 与扫描日志。
- `curl` 返回 `{"ok":true,"data":{"total":<你的论文数>,...}}`。
- 浏览器打开 `http://<本机IP>:8888`：左侧出现论文列表，点开看到总结/笔记/PDF 三个 tab，笔记 tab 左编辑右实时预览，PDF tab 能预览。

- [ ] **Step 6: Commit**

```bash
git add ecosystem.config.cjs scripts/ README.md
git commit -m "chore: pm2 config, scan-once script, and README"
```

---

## 验收清单（实现完成后逐项确认）

- [ ] `npm test` 全绿
- [ ] `pm2 start ecosystem.config.cjs` 后 `0.0.0.0:8888` 可访问
- [ ] 启动后 `papers/` 中的 PDF 被自动入库、生成总结与标签
- [ ] 向 `papers/` 新增 PDF，等待一个扫描周期后自动出现
- [ ] 页面可按标签/状态/星标筛选，可搜索标题/摘要/总结/笔记/标签
- [ ] 笔记 tab 支持 Markdown + LaTeX 实时预览并自动保存
- [ ] PDF tab 能预览原文（含大文件 range 加载）
- [ ] 改名/移动 PDF 后笔记不丢失（基于 sha1 id）
- [ ] arXiv 匹配失败的论文标记「元数据为 AI 推断」
