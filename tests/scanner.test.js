const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { diffPapers, createScanner, createMultiSpaceScanner } = require('../src/services/scanner');
const { cleanFilenameToTitle } = require('../src/core/util');

/** 内存版全文存取（v3：替代 data/text/<id>.txt 的 textStore 注入） */
function memTextStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    load: async (id) => (m.has(id) ? m.get(id) : null),
    save: async (id, t) => {
      m.set(id, t);
    },
    remove: async (id) => {
      m.delete(id);
    },
    _map: m,
  };
}

test('diffPapers 计算 added/changed/missing', () => {
  const existing = {
    a: { id: 'a', fileSize: 10, status: 'ready' },
    b: { id: 'b', fileSize: 20, status: 'ready' },
    c: { id: 'c', fileSize: 30, status: 'missing' },
  };
  const scanned = [
    { id: 'a', size: 10 },
    { id: 'b', size: 99 },
    { id: 'd', size: 40 },
  ];
  const d = diffPapers(existing, scanned);
  assert.deepStrictEqual(
    d.added.map((x) => x.id),
    ['d'],
  );
  assert.deepStrictEqual(
    d.changed.map((x) => x.id),
    ['b'],
  );
  assert.deepStrictEqual(
    d.missing.map((x) => x.id),
    [],
  );
});

test('fingerprintAll 对内容相同的重复文件去重（同 id 只保留一条，防 scan 覆盖丢数据）', async () => {
  const { fingerprintAll } = require('../src/services/scanner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwfp-'));
  // 两个内容完全相同的 PDF（不同文件名）→ 同 sha1 → 同 id
  const content = Buffer.from('%PDF-1.4\n%duplicate-content\n');
  fs.writeFileSync(path.join(dir, 'paper-A.pdf'), content);
  fs.writeFileSync(path.join(dir, '2402.06196.pdf'), content);
  const items = (await require('../src/services/scanner').scanDir(dir)).map((it) => ({
    filepath: it.filepath,
    filename: it.filename,
    size: it.size,
    mtime: it.mtime,
  }));
  const fp = await fingerprintAll(items);
  // 关键：两个文件只产出一条指纹（去重），不产生重复 id
  assert.strictEqual(fp.length, 1, '内容相同的重复文件应去重为一条');
  const ids = fp.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, '不应有重复 id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scan 不用空记录覆盖已 enrich 的论文（防 id 冲突丢数据）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwovr-'));
  const storePath = path.join(dir, 'papers.json');
  const content = Buffer.from('%PDF-1.4\n%same\n');
  fs.writeFileSync(path.join(dir, 'real.pdf'), content);
  // store 里已有同 id 的已处理记录（title/summary/tags 齐全，模拟被重复文件覆盖前的状态）
  const { sha1OfFile } = require('../src/core/util');
  const id = (await sha1OfFile(path.join(dir, 'real.pdf'))).slice(0, 16);
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      [id]: {
        id,
        filename: 'real.pdf',
        filepath: path.join(dir, 'real.pdf'),
        status: 'ready',
        title: '重要标题',
        summary: '## TL;DR\n已有总结',
        tags: ['x'],
        topics: [],
        addedAt: 1,
        updatedAt: 1,
      },
    },
  };
  const deps = {
    parser: { extractText: async () => ({ text: 't', charCount: 1, numPages: 1 }) },
    ai: {
      summarize: async () => '',
      extractTagsTopics: async () => ({ tags: [], topics: [] }),
      buildSummaryMarkdown: () => '',
      applySettingsOverride: (c) => c,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async (s) => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps });
  await scanner.scan();
  // 关键：已 enrich 的记录未被空初始化覆盖
  assert.strictEqual(store.papers[id].title, '重要标题', 'title 不应被覆盖');
  assert.ok(store.papers[id].summary.includes('已有总结'), 'summary 不应被覆盖');
  assert.deepStrictEqual(store.papers[id].tags, ['x'], 'tags 不应被覆盖');
  fs.rmSync(dir, { recursive: true, force: true });
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

  const store = { version: 1, tags: [], papers: {} };
  const processed = [];
  const deps = {
    parser: { extractText: async () => ({ text: '全文内容', charCount: 5, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async () => ({ entries: [] }),
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      summarize: async () => '## TL;DR\n短\n\n## 关键贡献\n- x\n\n## 方法\nm',
      extractTagsTopics: async () => ({
        tags: ['demo'],
        topics: [],
        metadata: { title: 'Sample', authors: ['A'], year: 2024 },
      }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: (s, tags) => {
      s.tags = Array.from(new Set([...s.tags, ...tags]));
    },
    config: { ai: { model: 'm' }, arxiv: {} },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  assert.ok(r.added >= 1);
  await new Promise((res) => setTimeout(res, 50));
  const paper = Object.values(store.papers)[0];
  assert.ok(paper, '应有论文入库');
  assert.strictEqual(paper.status, 'ready');
  assert.ok(paper.summary.includes('TL;DR'));
  assert.ok(paper.tags.includes('demo'));
  assert.strictEqual(paper.metaSource, 'ai-fallback');
  scanner.stop();
});

test('processOne 已知 arxivId 时用 id: 精确查元数据（URL 导入路径）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan2-'));
  fs.writeFileSync(path.join(dir, '2401.12345.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));
  const storePath = path.join(dir, 'papers.json');
  // 预置一篇带 arxivId 的论文（模拟 URL 导入后入库、待处理）
  const store = {
    version: 2,
    tags: [],
    papers: {
      abc123: {
        id: 'abc123',
        filename: '2401.12345.pdf',
        filepath: path.join(dir, '2401.12345.pdf'),
        title: '',
        authors: [],
        arxivId: '2401.12345',
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  // 记录 searchArxiv 收到的 query，验证走的是 id: 精确查而非 ti: 标题猜
  let usedQuery = null;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async (query) => {
        usedQuery = query;
        return {
          entries: [
            {
              title: 'A Real Paper Title',
              authors: ['Author One'],
              summary: 'abstract',
              id: 'http://arxiv.org/abs/2401.12345v1',
              primaryCategory: 'cs.AI',
            },
          ],
        };
      },
      pickBest: () => {
        throw new Error('不应走到 pickBest（已知 arxivId 应跳过标题相似度匹配）');
      },
      extractArxivId: () => '2401.12345',
    },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: ['x'], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: (s, t) => {
      s.tags = Array.from(new Set([...s.tags, ...t]));
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: true } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['abc123']);
  await new Promise((res) => setTimeout(res, 80));
  const p = store.papers['abc123'];
  assert.strictEqual(usedQuery, 'id:2401.12345', '应使用 id: 精确查询而非 ti: 猜标题');
  assert.strictEqual(p.status, 'ready');
  assert.strictEqual(p.title, 'A Real Paper Title');
  assert.strictEqual(p.metaSource, 'arxiv');
  assert.strictEqual(p.metaConfidence, 1);
  scanner.stop();
});

test('processOne 裸ID文件名自动识别 → id: 精确查 + 补年份 + 重命名为规范名', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan3-'));
  fs.writeFileSync(path.join(dir, '2012.12556.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));
  const storePath = path.join(dir, 'papers.json');
  // 模拟 scan() 捡入的孤立裸ID文件：arxivId 为空
  const store = {
    version: 2,
    tags: [],
    papers: {
      bd631: {
        id: 'bd631',
        filename: '2012.12556.pdf',
        filepath: path.join(dir, '2012.12556.pdf'),
        title: '',
        authors: [],
        year: null,
        arxivId: null,
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let usedQuery = null;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle,
      searchArxiv: async (query) => {
        usedQuery = query;
        return {
          entries: [
            {
              title: 'A Survey on Visual Transformer',
              authors: ['Kai Han', 'Yunhe Wang'],
              summary: 'abstract',
              id: 'http://arxiv.org/abs/2012.12556v3',
              primaryCategory: 'cs.CV',
              published: '2020-12-23T00:00:00Z',
            },
          ],
        };
      },
      pickBest: () => {
        throw new Error('裸ID应识别后走 id: 查询，不应走 pickBest');
      },
      extractArxivId: () => '2012.12556',
    },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: ['vision-transformer'], topics: ['计算机视觉'], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: (s, t) => {
      s.tags = Array.from(new Set([...s.tags, ...t]));
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: true } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['bd631']);
  await new Promise((res) => setTimeout(res, 100));
  const p = store.papers['bd631'];
  assert.strictEqual(usedQuery, 'id:2012.12556', '裸ID文件名应被识别为 arxivId 并走 id: 精确查');
  assert.strictEqual(p.title, 'A Survey on Visual Transformer');
  assert.strictEqual(p.year, '2020', '应从 arxiv published 补年份');
  assert.strictEqual(p.filename, 'Han 等 - 2020 - A Survey on Visual Transformer.pdf', '应重命名为规范名');
  assert.ok(fs.existsSync(path.join(dir, p.filename)), '规范名文件应存在');
  assert.ok(!fs.existsSync(path.join(dir, '2012.12556.pdf')), '旧裸ID文件应已被改名');
  assert.strictEqual(p.filepath, path.join(dir, p.filename));
  scanner.stop();
});

test('reschedule 热改定时扫描间隔（新间隔触发多次扫描；reschedule(0) 关闭）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwresched-'));
  const storePath = path.join(dir, 'papers.json');
  const store = { version: 2, tags: [], papers: {} };
  let saves = 0;
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 0 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async () => ({ entries: [] }),
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {
      saves++;
    },
    mergeTags: () => {},
    config: { ai: {}, arxiv: {} },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.reschedule(0.001); // 0.001 分钟 ≈ 60ms
  await new Promise((r) => setTimeout(r, 220));
  scanner.reschedule(0); // 关闭定时扫描
  const after = saves;
  assert.ok(after >= 2, `新间隔应触发多次扫描，实际 saveStore=${after}`);
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(saves, after, 'reschedule(0) 后不应再触发扫描');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne arxiv 段读 effConfig（store.settings.arxiv.enabled:false 热关闭补全）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwarxiveff-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));
  const storePath = path.join(dir, 'papers.json');
  const store = {
    version: 2,
    tags: [],
    settings: { arxiv: { enabled: false } }, // 运行时关闭，覆盖 config 的默认开启
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        abstract: 'A',
        authors: ['A'],
        year: 2024,
        arxivId: null,
        tags: [],
        topics: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let searchCalled = false;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle,
      searchArxiv: async () => {
        searchCalled = true;
        return { entries: [] };
      },
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      // 真实合并语义：store.settings.arxiv 覆盖 config.arxiv
      applySettingsOverride: (config, settings) => ({
        ...config,
        arxiv: { ...config.arxiv, ...((settings && settings.arxiv) || {}) },
      }),
    },
    saveStore: async () => {},
    mergeTags: (s, t) => {
      s.tags = Array.from(new Set([...s.tags, ...t]));
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: true } }, // config 默认开启
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(
    searchCalled,
    false,
    'effConfig.arxiv.enabled=false 时不应调用 searchArxiv（说明读的是 effConfig 而非 config）',
  );
  assert.strictEqual(store.papers.x.status, 'ready');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne 空总结不被当作成功（存可重试占位、不写误导性空 TL;DR）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan4-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));
  const storePath = path.join(dir, 'papers.json');
  const store = {
    version: 2,
    tags: [],
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        authors: ['A'],
        year: 2024,
        arxivId: null,
        tags: [],
        topics: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle,
      searchArxiv: async () => ({ entries: [] }),
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      // 模型返回空字符串（瞬时失败 / 被网关清空）
      summarize: async () => '',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => (md && String(md).trim() ? md : '*（总结生成失败，可点击「重新总结」重试）*'),
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: (s, t) => {
      s.tags = Array.from(new Set([...s.tags, ...t]));
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((res) => setTimeout(res, 80));
  const p = store.papers['x'];
  assert.ok(!p.summary.startsWith('## TL;DR'), '空总结不应写成误导性的空 TL;DR');
  assert.match(p.summary, /重新总结|失败/, '应给出可重试占位');
  assert.strictEqual(p.summaryAt, null, '失败时不应标记 summaryAt（便于重试识别）');
  assert.deepStrictEqual(p.tags, [], '空总结不应产生标签');
  scanner.stop();
});

test('retagPapers 重新打标 + 标签/主题库联动（多的入库、少的清除）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwretag-'));
  // 两篇论文：a 原有标签 oldtag/主题 旧主题；b 原有标签 keep。
  // 重新打标后：a→newtag/新主题，b→keep。oldtag/旧主题 被所有论文放弃 → 应从字典清除；newtag 新增入库。
  const textStore = memTextStore({ a: '论文a全文', b: '论文b全文' });
  const store = {
    version: 2,
    tags: ['oldtag', 'keep'],
    topics: ['旧主题'],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', tags: ['oldtag'], topics: ['旧主题'], updatedAt: 0 },
      b: { id: 'b', title: 'B', tags: ['keep'], topics: [], updatedAt: 0 },
    },
  };
  let aiCalls = 0;
  const deps = {
    parser: {},
    ai: {
      extractTagsTopics: async ({ title }) => {
        aiCalls++;
        if (title === 'A') return { tags: ['newtag'], topics: ['新主题'] };
        return { tags: ['keep'], topics: [] };
      },
      applySettingsOverride: (c) => c,
      buildSummaryMarkdown: (md) => md,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async (s) => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore, papersDir: dir, deps });
  const r = await scanner.retagPapers(['a', 'b']);
  assert.strictEqual(r.processed, 2);
  assert.strictEqual(aiCalls, 2);
  // a 的标签/主题被新结果覆盖
  assert.deepStrictEqual(store.papers.a.tags, ['newtag'], 'a 标签覆盖');
  assert.deepStrictEqual(store.papers.a.topics, ['新主题'], 'a 主题覆盖');
  assert.deepStrictEqual(store.papers.b.tags, ['keep'], 'b 不变');
  // 字典联动：oldtag 清除、newtag 入库；keep 保留；旧主题清除、新主题入库
  assert.ok(store.tags.includes('newtag') && !store.tags.includes('oldtag'), '字典：newtag 入 oldtag 出');
  assert.ok(store.tags.includes('keep'), '字典：keep 保留');
  assert.ok(store.topics.includes('新主题') && !store.topics.includes('旧主题'), '字典主题联动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chatPaper 透传 extraIds：读额外论文全文 + 持久化 user.extraIds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwchat-'));
  // 主论文 a + 额外论文 b（a @ 引用 b）
  const textStore = memTextStore({ a: '主论文全文', b: '额外论文全文' });
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: {
      a: { id: 'a', title: '主论文', abstract: '主摘要', chat: [], status: 'ready' },
      b: { id: 'b', title: '额外论文', abstract: '额外摘要', status: 'ready' },
    },
  };
  let capturedExtra;
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 1 }) },
    ai: {
      chatPaper: async (args) => {
        capturedExtra = args.extraPapers; // 捕获透传的 extraPapers
        return '回复';
      },
      applySettingsOverride: (c) => c,
      buildSummaryMarkdown: (md) => md,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async (s) => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore, papersDir: dir, deps });
  const r = await scanner.chatPaper('a', '对比一下', { extraIds: ['b'] });
  assert.strictEqual(r.reply, '回复');
  // extraPapers 透传：含额外论文 b 的 title/abstract/fulltext
  assert.ok(Array.isArray(capturedExtra) && capturedExtra.length === 1, 'extraPapers 透传 1 篇');
  assert.strictEqual(capturedExtra[0].title, '额外论文');
  assert.strictEqual(capturedExtra[0].fulltext, '额外论文全文', '读取额外论文全文');
  // 持久化：user 消息带 extraIds
  const userMsg = store.papers.a.chat.find((m) => m.role === 'user');
  assert.ok(userMsg, 'user 消息已落盘');
  assert.deepStrictEqual(userMsg.extraIds, ['b'], 'user.extraIds 持久化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chatPaper 无 extraIds 时不挂 extraIds 字段（向后兼容）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwchat2-'));
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { a: { id: 'a', title: 'T', abstract: 'A', chat: [], status: 'ready' } },
  };
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 1 }) },
    ai: { chatPaper: async () => '回复', applySettingsOverride: (c) => c, buildSummaryMarkdown: (md) => md },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async (s) => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps });
  await scanner.chatPaper('a', '普通问题');
  const userMsg = store.papers.a.chat.find((m) => m.role === 'user');
  assert.ok(userMsg.extraIds === undefined, '无引用时不挂 extraIds 字段');
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 建一个最小可用的 manager（两空间，各带一个占位 PDF；pg-mem 持久化） */
async function makeMultiSpaceSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwms-'));
  const { newDb } = require('pg-mem');
  const { createDb, createRepository } = require('../src/db');
  const { createSpaceManager } = require('../src/services/spaces');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = createDb({ createPool: () => new Pool() });
  await db.migrate();
  const repo = createRepository(db);
  const manager = createSpaceManager({
    repo,
    papersRoot: root,
    globalConfig: { scanIntervalMinutes: 5, ai: { model: 'm' }, arxiv: { enabled: false } },
  });
  await manager.ensureRegistry();
  // 在 default 空间放一个 PDF
  const defDir = manager.resolveSpacePapersDir('default');
  fs.writeFileSync(path.join(defDir, 'a.pdf'), Buffer.from('%PDF-1.4\n%A\n'));
  // 第二个空间
  const sp2 = await manager.createSpace({ name: 'B', papersDir: 'papers-b' });
  const bDir = manager.resolveSpacePapersDir(sp2.id);
  fs.writeFileSync(path.join(bDir, 'b.pdf'), Buffer.from('%PDF-1.4\n%B\n'));
  return { manager, root, sp2, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function multiSpaceDeps() {
  return {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async () => ({ entries: [] }),
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      summarize: async ({ title }) => `## TL;DR\n${title || 'x'}`,
      extractTagsTopics: async ({ title }) => ({
        tags: [String(title || 'x').toLowerCase()],
        topics: [],
        metadata: { title: title || 'X' },
      }),
      extractConcepts: async () => [{ term: '概念A', definition: '定义' }],
      chatPaper: async () => '回复内容',
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
    mergeTags: (s, tags) => {
      s.tags = Array.from(new Set([...(s.tags || []), ...tags]));
    },
    mergeTopics: () => {},
    mergeConcepts: () => [],
  };
}

test('createMultiSpaceScanner.scan 扫描所有空间，各空间论文隔离', async () => {
  const { manager, sp2, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    const results = await scanner.scan({ dueOnly: false });
    // 等流水线处理完
    await scanner.drain(1000);
    assert.ok(results.length >= 2, '应扫两个空间');
    const storeA = await manager.getSpaceStore('default');
    const storeB = await manager.getSpaceStore(sp2.id);
    assert.ok(Object.keys(storeA.papers).length >= 1, 'default 有论文');
    assert.ok(Object.keys(storeB.papers).length >= 1, 'B 空间有论文');
    // 各自处理为 ready
    for (const p of Object.values(storeA.papers)) assert.strictEqual(p.status, 'ready');
    for (const p of Object.values(storeB.papers)) assert.strictEqual(p.status, 'ready');
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('createMultiSpaceScanner 共享单一串行队列（不会并发处理两空间）', async () => {
  const { manager, sp2, cleanup } = await makeMultiSpaceSetup();
  try {
    let concurrent = 0;
    let maxConcurrent = 0;
    const deps = multiSpaceDeps();
    // 包一层 extractText 计数并发
    const origParser = deps.parser;
    deps.parser = {
      extractText: async (...args) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return origParser.extractText(...args);
      },
    };
    const scanner = createMultiSpaceScanner({ manager, deps });
    await scanner.scan({ dueOnly: false });
    await scanner.drain(2000);
    assert.strictEqual(maxConcurrent, 1, '应严格串行，最大并发=1');
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('createMultiSpaceScanner.reschedule(spaceId,minutes) per-space 改间隔并重算定时器', async () => {
  const { manager, sp2, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    await scanner.reschedule('default', 10);
    await scanner.reschedule(sp2.id, 2);
    // 最小间隔 = 2 分钟
    assert.strictEqual(manager.minScheduledIntervalMs(), 2 * 60 * 1000);
    // 持久化到注册表
    assert.strictEqual(manager.getSpace(sp2.id).scanIntervalMinutes, 2);
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('createMultiSpaceScanner.scanSpace 手动扫单个空间', async () => {
  const { manager, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    const r = await scanner.scanSpace('default');
    await scanner.drain(1000);
    assert.ok(r.added >= 1);
    const store = await manager.getSpaceStore('default');
    assert.ok(Object.keys(store.papers).length >= 1);
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('createMultiSpaceScanner.extractConcepts/retagPapers/chatPaper 带 spaceId 首参', async () => {
  const { manager, sp2, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    await scanner.scan({ dueOnly: false });
    await scanner.drain(1000);
    const storeA = await manager.getSpaceStore('default');
    const idA = Object.keys(storeA.papers)[0];
    // retagPapers(spaceId, ids)
    const r = await scanner.retagPapers('default', [idA]);
    assert.ok(r.processed >= 1);
    // extractConcepts(spaceId, ids)
    const c = await scanner.extractConcepts('default', [idA]);
    assert.ok(Object.keys(c).includes('processed'));
    // chatPaper(spaceId, id, message)
    const ch = await scanner.chatPaper('default', idA, '你好');
    assert.ok(typeof ch.reply === 'string');
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('scan missing 熔断：大面积缺失（>5 且 >50%）不翻转状态', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwfuse-'));
  const store = { version: 2, tags: [], papers: {} };
  // 库内 8 篇，目录为空（模拟挂载失效/目录被清空）
  for (let i = 0; i < 8; i++) {
    const id = 'p' + i;
    store.papers[id] = { id, filename: id + '.pdf', filepath: path.join(dir, id + '.pdf'), status: 'ready', tags: [] };
  }
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 0 }) },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {},
    mergeTags: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  assert.strictEqual(r.missingFuse, true, '应触发熔断');
  for (const p of Object.values(store.papers)) {
    assert.strictEqual(p.status, 'ready', '熔断时不应翻转任何状态');
  }
  assert.ok(scanner.getFuseState(), '熔断状态可查询');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scan missing 少量缺失（≤5 或 ≤50%）正常标 missing，无熔断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwfuse2-'));
  const store = { version: 2, tags: [], papers: {} };
  // 8 篇，其中 6 篇文件真实存在、2 篇缺失 → 正常标记
  const { sha1OfFile } = require('../src/core/util');
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, 'f' + i + '.pdf'), Buffer.from('%PDF-1.4 file' + i));
  }
  for (let i = 0; i < 6; i++) {
    const fp = path.join(dir, 'f' + i + '.pdf');
    const id = (await sha1OfFile(fp)).slice(0, 16);
    store.papers[id] = {
      id,
      filename: 'f' + i + '.pdf',
      filepath: fp,
      fileSize: fs.statSync(fp).size,
      status: 'ready',
      tags: [],
    };
  }
  store.papers.gone1 = {
    id: 'gone1',
    filename: 'g1.pdf',
    filepath: path.join(dir, 'g1.pdf'),
    status: 'ready',
    tags: [],
  };
  store.papers.gone2 = {
    id: 'gone2',
    filename: 'g2.pdf',
    filepath: path.join(dir, 'g2.pdf'),
    status: 'ready',
    tags: [],
  };
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 0 }) },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {},
    mergeTags: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  assert.strictEqual(r.missingFuse, false);
  assert.strictEqual(store.papers.gone1.status, 'missing');
  assert.strictEqual(store.papers.gone2.status, 'missing');
  assert.strictEqual(scanner.getFuseState(), null);
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== generateNoteCards（AI 笔记骨架） ====================

test('generateNoteCards：正常路径拆出 skeleton 卡（## 分段）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwnc-'));
  const store = { version: 2, tags: [], papers: { p1: { id: 'p1', filename: 'a.pdf', title: 'T', abstract: 'ab', status: 'ready' } } };
  let gotPrompt;
  const deps = {
    parser: { extractText: async () => ({ text: 't', charCount: 1, numPages: 1 }) },
    ai: {
      applySettingsOverride: (c) => c,
      generateNotes: async ({ prompt }) => { gotPrompt = prompt; return '## 🎯 研究问题\n问题正文\n## 🔧 方法拆解\n方法正文'; },
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore({ p1: '全文' }), papersDir: dir, deps });
  const r = await scanner.generateNoteCards('p1');
  assert.strictEqual(r.cards.length, 2);
  assert.strictEqual(r.cards[0].type, 'skeleton');
  assert.strictEqual(r.cards[0].title, '🎯 研究问题');
  assert.strictEqual(r.cards[0].body, '问题正文');
  assert.ok(r.cards[0].id && r.cards[0].createdAt > 0);
  assert.strictEqual(gotPrompt, undefined, '无 settings/config 覆盖时 prompt 为 undefined（ai 层回退默认）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generateNoteCards：notesPrompt 三级回退（settings > config）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwnc-'));
  const store = {
    version: 2, tags: [],
    papers: { p1: { id: 'p1', filename: 'a.pdf', title: 'T', status: 'ready' } },
    settings: { notesPrompt: '空间自定义提示词' },
  };
  let gotPrompt;
  const deps = {
    parser: { extractText: async () => ({ text: 't', charCount: 1, numPages: 1 }) },
    ai: { applySettingsOverride: (c) => c, generateNotes: async ({ prompt }) => { gotPrompt = prompt; return '## A\nx'; } },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false }, notesPrompt: 'config 提示词' },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore({ p1: '全文' }), papersDir: dir, deps });
  await scanner.generateNoteCards('p1');
  assert.strictEqual(gotPrompt, '空间自定义提示词', 'settings.notesPrompt 优先于 config');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('generateNoteCards：无全文且无摘要 → error；模型输出无 ## → error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwnc-'));
  const store = {
    version: 2, tags: [],
    papers: {
      p1: { id: 'p1', filename: 'a.pdf', title: 'T', status: 'ready' },       // 无全文无摘要
      p2: { id: 'p2', filename: 'b.pdf', title: 'T2', abstract: 'ab', status: 'ready' }, // 有摘要无全文
    },
  };
  const deps = {
    parser: { extractText: async () => ({ text: 't', charCount: 1, numPages: 1 }) },
    ai: { applySettingsOverride: (c) => c, generateNotes: async () => '没有标题的连续文本' },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps });
  const r1 = await scanner.generateNoteCards('p1');
  assert.ok(r1.error, '无内容时返回 error');
  assert.deepStrictEqual(r1.cards, []);
  const r2 = await scanner.generateNoteCards('p2');
  assert.ok(r2.error, '输出无 ## 拆不出卡时返回 error（防写入整段文本卡）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createMultiSpaceScanner.generateNoteCards 透传到对应空间子扫描器', async () => {
  const { manager, root, cleanup } = await makeMultiSpaceSetup();
  try {
    const deps = multiSpaceDeps();
    deps.ai.generateNotes = async ({ title }) => `## 🎯 研究问题\n${title || 'x'}的问题`;
    const ms = createMultiSpaceScanner({ manager, deps });
    await ms.scan(); // 让 default 空间的 a.pdf 入库
    await ms.drain();
    const store = await manager.getSpaceStore('default');
    const pid = Object.keys(store.papers)[0];
    const r = await ms.generateNoteCards('default', pid);
    assert.strictEqual(r.cards.length, 1);
    assert.strictEqual(r.cards[0].type, 'skeleton');
    const rBad = await ms.generateNoteCards('no-such-space', pid);
    assert.ok(rBad.error, '空间不存在返回 error 而非抛错');
  } finally { cleanup(); }
});

// ==================== processOne 缺失/错误分支 ====================

test('processOne 文件不在磁盘上：标 missing 并跳过整条流水线（不解析全文）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmissing-'));
  const store = {
    version: 2,
    tags: [],
    papers: {
      gone: {
        id: 'gone',
        filename: 'gone.pdf',
        filepath: path.join(dir, 'gone.pdf'), // 文件不存在
        title: 'T',
        authors: [],
        arxivId: null,
        tags: [],
        topics: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let parseCalled = false;
  let summarizeCalled = false;
  const deps = {
    parser: {
      extractText: async () => {
        parseCalled = true;
        return { text: 'x', charCount: 1, numPages: 1 };
      },
    },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: {
      summarize: async () => {
        summarizeCalled = true;
        return '## TL;DR\nt';
      },
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['gone']);
  await new Promise((r) => setTimeout(r, 60));
  const p = store.papers.gone;
  assert.strictEqual(p.status, 'missing', '文件缺失应标 missing');
  assert.match(p.error, /缺失/, '应写入缺失原因');
  assert.strictEqual(parseCalled, false, '缺失文件不应进入 extractText');
  assert.strictEqual(summarizeCalled, false, '缺失文件不应进入 summarize');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne 顶层 catch：ENOENT 归为 missing（与扫描缺失语义一致）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwenoent-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%x\n')); // 文件存在，但解析抛 ENOENT
  const store = {
    version: 2,
    tags: [],
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        authors: [],
        arxivId: null,
        tags: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  const deps = {
    parser: {
      extractText: async () => {
        const e = new Error('ENOENT: no such file or directory, open ...');
        e.code = 'ENOENT';
        throw e;
      },
    },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(store.papers.x.status, 'missing', 'ENOENT 应归为 missing 而非 error');
  assert.match(store.papers.x.error, /ENOENT/);
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne 顶层 catch：非 ENOENT 错误归为 error 并记录错误信息', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwerr-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%x\n'));
  const store = {
    version: 2,
    tags: [],
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        authors: [],
        arxivId: null,
        tags: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  const deps = {
    parser: {
      extractText: async () => {
        throw new Error('pdf 解析失败：加密文件');
      },
    },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(store.papers.x.status, 'error', '普通错误应标 error');
  assert.strictEqual(store.papers.x.error, 'pdf 解析失败：加密文件', 'error 字段应记录原始错误信息');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== arXiv 元数据补全分支 ====================

test('processOne 非裸ID文件名走 ti: 搜索 + pickBest 命中，写入 arxiv 元数据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwti-'));
  fs.writeFileSync(path.join(dir, 'attention is all you need.pdf'), Buffer.from('%PDF-1.4\n%x\n'));
  const store = {
    version: 2,
    tags: [],
    papers: {
      p1: {
        id: 'p1',
        filename: 'attention is all you need.pdf',
        filepath: path.join(dir, 'attention is all you need.pdf'),
        title: '',
        authors: [],
        year: null,
        arxivId: null,
        tags: [],
        topics: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let usedQuery = null;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f.replace(/\.pdf$/i, ''),
      searchArxiv: async (query) => {
        usedQuery = query;
        return {
          entries: [
            {
              title: 'Attention Is All You Need',
              authors: ['Ashish Vaswani', 'Noam Shazeer'],
              summary: 'abstract',
              id: 'http://arxiv.org/abs/1706.03762v5',
              primaryCategory: 'cs.CL',
              published: '2017-06-12T00:00:00Z',
            },
          ],
        };
      },
      pickBest: (candidate, entries) => ({ best: entries[0], confidence: 0.92, source: 'arxiv' }),
      extractArxivId: () => '1706.03762',
    },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: (s, t) => {
      s.tags = Array.from(new Set([...s.tags, ...t]));
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: true } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['p1']);
  await new Promise((r) => setTimeout(r, 80));
  const p = store.papers.p1;
  assert.strictEqual(usedQuery, 'ti:"attention is all you need"', '非裸ID应走 ti: 标题搜索');
  assert.strictEqual(p.status, 'ready');
  assert.strictEqual(p.title, 'Attention Is All You Need');
  assert.strictEqual(p.year, '2017', '从 published 补年份');
  assert.strictEqual(p.arxivId, '1706.03762');
  assert.strictEqual(p.arxivUrl, 'http://arxiv.org/abs/1706.03762v5');
  assert.strictEqual(p.metaSource, 'arxiv');
  assert.strictEqual(p.metaConfidence, 0.92, 'ti: 路径用 pickBest 的置信度');
  assert.strictEqual(p.filename, 'attention is all you need.pdf', '非裸ID文件名不应被改名');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne arXiv 调用抛错被吞掉，流水线继续走到 summarize', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwarxivthrow-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%x\n'));
  const store = {
    version: 2,
    tags: [],
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        authors: ['A'],
        year: 2024,
        arxivId: null,
        tags: [],
        topics: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let summarizeCalled = false;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle: (f) => f,
      searchArxiv: async () => {
        throw new Error('arxiv 网关超时');
      },
      pickBest: () => ({ best: null, confidence: 0, source: 'none' }),
      extractArxivId: () => null,
    },
    ai: {
      summarize: async () => {
        summarizeCalled = true;
        return '## TL;DR\nt';
      },
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    config: { ai: { model: 'm' }, arxiv: { enabled: true } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  const p = store.papers.x;
  assert.strictEqual(summarizeCalled, true, 'arxiv 抛错不应阻断 summarize');
  assert.strictEqual(p.status, 'ready', '流水线应继续完成');
  assert.strictEqual(p.error, null);
  assert.ok(!p.metaSource, 'arxiv 失败不应写入元数据');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processOne 重命名撞名：第二篇同名规范名加 (arxivId) 后缀区分', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwrename-'));
  fs.writeFileSync(path.join(dir, '2401.11111.pdf'), Buffer.from('%PDF-1.4\n%A\n'));
  fs.writeFileSync(path.join(dir, '2401.22222.pdf'), Buffer.from('%PDF-1.4\n%B\n'));
  const mkPaper = (id, fn) => ({
    id,
    filename: fn,
    filepath: path.join(dir, fn),
    title: '',
    authors: [],
    year: null,
    arxivId: null,
    tags: [],
    topics: [],
    status: 'pending',
    error: null,
    updatedAt: 0,
  });
  const store = {
    version: 2,
    tags: [],
    papers: { p1: mkPaper('p1', '2401.11111.pdf'), p2: mkPaper('p2', '2401.22222.pdf') },
  };
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: {
      cleanFilenameToTitle,
      // 两篇返回相同标题/作者/年份 → 规范名相同 → 第二篇撞名
      searchArxiv: async (query) => ({
        entries: [
          {
            title: 'Same Title',
            authors: ['John Doe'],
            summary: 'abstract',
            id: query.includes('11111') ? 'http://arxiv.org/abs/2401.11111v1' : 'http://arxiv.org/abs/2401.22222v1',
            primaryCategory: 'cs.AI',
            published: '2024-01-01T00:00:00Z',
          },
        ],
      }),
      pickBest: () => {
        throw new Error('裸ID不应走 pickBest');
      },
      extractArxivId: (best) => (best.id.includes('11111') ? '2401.11111' : '2401.22222'),
    },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    config: { ai: { model: 'm' }, arxiv: { enabled: true } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['p1', 'p2']); // 串行队列：p1 先处理
  await new Promise((r) => setTimeout(r, 200));
  const p1 = store.papers.p1;
  const p2 = store.papers.p2;
  assert.strictEqual(p1.filename, 'Doe - 2024 - Same Title.pdf', 'p1 先占规范名');
  assert.strictEqual(p2.filename, 'Doe - 2024 - Same Title (2401.22222).pdf', 'p2 撞名加 arxivId 后缀');
  assert.ok(fs.existsSync(path.join(dir, p1.filename)), 'p1 规范名文件存在');
  assert.ok(fs.existsSync(path.join(dir, p2.filename)), 'p2 带后缀文件存在');
  assert.strictEqual(p1.filepath, path.join(dir, p1.filename));
  assert.strictEqual(p2.filepath, path.join(dir, p2.filename));
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== 概念抽取（processOne 内） ====================

test('processOne 自动抽取概念：mergeConcepts 返回 newIds 写入 p.conceptIds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwconcept-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%x\n'));
  const store = {
    version: 2,
    tags: [],
    concepts: [],
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        abstract: 'A',
        authors: ['A'],
        year: 2024,
        arxivId: null,
        tags: [],
        topics: [],
        conceptIds: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
  let gotItems = null;
  let gotPid = null;
  const deps = {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      extractConcepts: async () => [{ term: 'MoE', definition: '混合专家' }],
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
    },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    mergeConcepts: (s, items, pid) => {
      gotItems = items;
      gotPid = pid;
      return ['c1', 'c2'];
    },
    config: { ai: { model: 'm' }, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  const p = store.papers.x;
  assert.strictEqual(p.status, 'ready');
  assert.deepStrictEqual(gotItems, [{ term: 'MoE', definition: '混合专家' }], 'extractConcepts 结果透传给 mergeConcepts');
  assert.strictEqual(gotPid, 'x', 'mergeConcepts 收到论文 id');
  assert.deepStrictEqual(p.conceptIds, ['c1', 'c2'], 'newIds 写入 p.conceptIds');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== 中间态自愈 ====================

test('scan 中间态自愈：卡在 summarizing 但有完整 summary 的论文翻为 ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwheal-'));
  const { sha1OfFile } = require('../src/core/util');
  fs.writeFileSync(path.join(dir, 'a.pdf'), Buffer.from('%PDF-1.4\n%A\n'));
  fs.writeFileSync(path.join(dir, 'b.pdf'), Buffer.from('%PDF-1.4\n%B\n'));
  const idA = (await sha1OfFile(path.join(dir, 'a.pdf'))).slice(0, 16);
  const idB = (await sha1OfFile(path.join(dir, 'b.pdf'))).slice(0, 16);
  const store = { version: 2, tags: [], papers: {} };
  // a：卡在 summarizing，但 summary 有实质内容（≥30字）+ summaryAt → 应自愈为 ready
  store.papers[idA] = {
    id: idA,
    filename: 'a.pdf',
    filepath: path.join(dir, 'a.pdf'),
    fileSize: fs.statSync(path.join(dir, 'a.pdf')).size,
    status: 'summarizing',
    summaryAt: Date.now(),
    summary: '## TL;DR\n' + '已有完整总结内容'.repeat(5),
    error: '遗留错误',
    tags: [],
  };
  // b：卡在 summarizing，summary 太短（占位/空）→ 不自愈，保持原状
  store.papers[idB] = {
    id: idB,
    filename: 'b.pdf',
    filepath: path.join(dir, 'b.pdf'),
    fileSize: fs.statSync(path.join(dir, 'b.pdf')).size,
    status: 'summarizing',
    summaryAt: Date.now(),
    summary: '太短',
    tags: [],
  };
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 0 }) },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: { applySettingsOverride: (c) => c },
    saveStore: async () => {},
    mergeTags: () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.scan();
  assert.strictEqual(r.healed, 1, '只自愈有实质 summary 的那一篇');
  assert.strictEqual(store.papers[idA].status, 'ready', 'a 应被翻为 ready');
  assert.strictEqual(store.papers[idA].error, null, '自愈后清空遗留 error');
  assert.strictEqual(store.papers[idB].status, 'summarizing', 'b 总结太短不自愈（需重新入队）');
  scanner.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== chatPaper 重新生成 / 中止 / 附图 / 模型徽章 ====================

test('chatPaper regenerate：弹出末尾 user+assistant 对，用该 user 内容重问，历史缩短', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwregen-'));
  const textStore = memTextStore({ a: '主全文', b: 'B全文' });
  const store = {
    version: 2,
    tags: [],
    settings: {},
    papers: {
      a: {
        id: 'a',
        title: '主论文',
        abstract: '主摘要',
        status: 'ready',
        chat: [
          { role: 'user', content: '第一问', ts: 1 },
          { role: 'assistant', content: '第一答', ts: 2 },
          { role: 'user', content: '第二问', ts: 3, extraIds: ['b'] },
          { role: 'assistant', content: '第二答', ts: 4 },
        ],
      },
      b: { id: 'b', title: 'B论文', abstract: 'B摘要', status: 'ready' },
    },
  };
  let captured = null;
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 1 }) },
    ai: {
      chatPaper: async (args) => {
        captured = args;
        return '新答';
      },
      applySettingsOverride: (c) => c,
      buildSummaryMarkdown: (md) => md,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore, papersDir: dir, deps });
  const r = await scanner.chatPaper('a', '被忽略的问题', { regenerate: true });
  assert.strictEqual(r.reply, '新答');
  assert.strictEqual(captured.message, '第二问', 'regenerate 用被丢弃 user 的内容重问');
  assert.deepStrictEqual(
    captured.history,
    [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ],
    'history 缩短（不含被丢弃的最后一轮）',
  );
  assert.ok(Array.isArray(captured.extraPapers) && captured.extraPapers[0].title === 'B论文', '回退取被丢弃 user 的 extraIds');
  const chat = store.papers.a.chat;
  assert.strictEqual(chat.length, 4, '旧对被丢弃、新对写入，总长不变');
  assert.strictEqual(chat[1].content, '第一答');
  assert.strictEqual(chat[2].content, '第二问');
  assert.deepStrictEqual(chat[2].extraIds, ['b'], '新 user 消息保留引用');
  assert.strictEqual(chat[3].content, '新答');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chatPaper 客户端中止（onToken 返回 false）：不落盘未完成的回复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwabort-'));
  const store = {
    version: 2,
    tags: [],
    settings: {},
    papers: {
      a: {
        id: 'a',
        title: 'T',
        abstract: 'A',
        status: 'ready',
        chat: [
          { role: 'user', content: '旧问', ts: 1 },
          { role: 'assistant', content: '旧答', ts: 2 },
        ],
      },
    },
  };
  let saves = 0;
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 1 }) },
    ai: {
      chatPaper: async (args) => {
        // 模拟流式：回调返回 false（客户端已断开），AI 层返回已累积的部分
        args.onToken('部分', 'content');
        return '部分回复';
      },
      applySettingsOverride: (c) => c,
      buildSummaryMarkdown: (md) => md,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async () => {
      saves++;
    },
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore({ a: '全文' }), papersDir: dir, deps });
  const r = await scanner.chatPaper('a', '新问', { onToken: () => false });
  assert.strictEqual(r.aborted, true, '应标记 aborted');
  assert.strictEqual(r.reply, '部分回复');
  assert.strictEqual(store.papers.a.chat.length, 2, '中止时不落盘新消息');
  assert.strictEqual(store.papers.a.chat[1].content, '旧答', '原聊天保持原样');
  assert.strictEqual(saves, 0, '中止时不调 saveStore');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chatPaper 附图持久化（最多 4 张）+ chatParams.model 写 assistant 模型徽章', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwimg-'));
  const store = {
    version: 2,
    tags: [],
    settings: {},
    papers: { a: { id: 'a', title: 'T', abstract: 'A', status: 'ready', chat: [] } },
  };
  let captured = null;
  const deps = {
    parser: { extractText: async () => ({ text: '', charCount: 0, numPages: 1 }) },
    ai: {
      chatPaper: async (args) => {
        captured = args;
        return '图中是架构图';
      },
      applySettingsOverride: (c) => c,
      buildSummaryMarkdown: (md) => md,
    },
    arxiv: {},
    rateLimitArxiv: async () => {},
    config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
  };
  const scanner = createScanner({ store, textStore: memTextStore({ a: '全文' }), papersDir: dir, deps });
  const images = ['img1', 'img2', 'img3', 'img4', 'img5', 'img6'];
  await scanner.chatPaper('a', '解释这张图', { images, chatParams: { model: 'gpt-4o' } });
  const userMsg = store.papers.a.chat.find((m) => m.role === 'user');
  const aiMsg = store.papers.a.chat.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(userMsg.images, ['img1', 'img2', 'img3', 'img4'], 'user 消息附图最多持久化 4 张');
  assert.strictEqual(aiMsg.model, 'gpt-4o', 'chatParams.model 显式覆盖时挂模型徽章');
  assert.deepStrictEqual(captured.images, images, 'images 透传给 ai.chatPaper');
  assert.strictEqual(captured.chatParams.model, 'gpt-4o', 'chatParams 透传');
  // 无 chatParams 时 assistant 不挂 model 字段
  await scanner.chatPaper('a', '普通问题');
  const aiMsg2 = store.papers.a.chat.filter((m) => m.role === 'assistant')[1];
  assert.ok(!('model' in aiMsg2), '无模型覆盖时不挂 model 字段');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== 多空间：dueOnly 到点判定 / invalidate 缓存 ====================

test('createMultiSpaceScanner.scan({dueOnly:true}) 跳过未到点的空间（per-space lastScanAt）', async () => {
  const { manager, sp2, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    // 首扫：lastScanAt=0，两空间都到点
    const r1 = await scanner.scan({ dueOnly: true });
    await scanner.drain(1000);
    assert.strictEqual(r1.length, 2, 'lastScanAt=0 时两空间都到点');
    // 立刻再扫：markScanned 已更新 lastScanAt，两空间 5 分钟内未到点 → 全跳过
    const r2 = await scanner.scan({ dueOnly: true });
    assert.strictEqual(r2.length, 0, '未到点的空间应被跳过');
    // 把 sp2 间隔改为 0（不调度 = 每次视为到点）→ dueOnly 只扫 sp2
    await scanner.reschedule(sp2.id, 0);
    const r3 = await scanner.scan({ dueOnly: true });
    await scanner.drain(1000);
    assert.strictEqual(r3.length, 1, 'interval=0 的空间不受 dueOnly 限制');
    assert.strictEqual(r3[0].spaceId, sp2.id);
    scanner.stop();
  } finally {
    cleanup();
  }
});

test('createMultiSpaceScanner.invalidate(spaceId) 丢弃缓存的子扫描器', async () => {
  const { manager, cleanup } = await makeMultiSpaceSetup();
  try {
    const scanner = createMultiSpaceScanner({ manager, deps: multiSpaceDeps() });
    const s1 = await scanner._subFor('default');
    const s1b = await scanner._subFor('default');
    assert.strictEqual(s1, s1b, '未 invalidate 前子扫描器走缓存（同一引用）');
    scanner.invalidate('default');
    const s2 = await scanner._subFor('default');
    assert.notStrictEqual(s1, s2, 'invalidate 后应重建子扫描器');
    assert.notStrictEqual(s1.scanner, s2.scanner, '内部 scanner 也是新实例');
    scanner.stop();
  } finally {
    cleanup();
  }
});
