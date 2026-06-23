const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { diffPapers, createScanner } = require('../lib/scanner');
const { cleanFilenameToTitle } = require('../lib/util');

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
  const { fingerprintAll } = require('../lib/scanner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwfp-'));
  // 两个内容完全相同的 PDF（不同文件名）→ 同 sha1 → 同 id
  const content = Buffer.from('%PDF-1.4\n%duplicate-content\n');
  fs.writeFileSync(path.join(dir, 'paper-A.pdf'), content);
  fs.writeFileSync(path.join(dir, '2402.06196.pdf'), content);
  const items = (await require('../lib/scanner').scanDir(dir)).map((it) => ({
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
  const { sha1OfFile } = require('../lib/util');
  const id = (await sha1OfFile(path.join(dir, 'real.pdf'))).slice(0, 16);
  const store = {
    version: 2, tags: [], topics: [], folders: [], concepts: [],
    papers: {
      [id]: {
        id, filename: 'real.pdf', filepath: path.join(dir, 'real.pdf'),
        status: 'ready', title: '重要标题', summary: '## TL;DR\n已有总结',
        tags: ['x'], topics: [], addedAt: 1, updatedAt: 1,
      },
    },
  };
  const deps = {
    parser: { extractText: async () => ({ text: 't', charCount: 1, numPages: 1 }) },
    ai: { summarize: async () => '', extractTagsTopics: async () => ({ tags: [], topics: [] }), buildSummaryMarkdown: () => '', applySettingsOverride: (c) => c },
    arxiv: {}, rateLimitArxiv: async () => {}, config: { ai: {}, arxiv: { enabled: false } },
    saveStore: async (s) => {}, mergeTags: () => {}, mergeTopics: () => {},
  };
  const scanner = createScanner({ store, storePath, papersDir: dir, deps });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
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
  const scanner = createScanner({ store, storePath, papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((res) => setTimeout(res, 80));
  const p = store.papers['x'];
  assert.ok(!p.summary.startsWith('## TL;DR'), '空总结不应写成误导性的空 TL;DR');
  assert.match(p.summary, /重新总结|失败/, '应给出可重试占位');
  assert.strictEqual(p.summaryAt, null, '失败时不应标记 summaryAt（便于重试识别）');
  assert.deepStrictEqual(p.tags, [], '空总结不应产生标签');
  scanner.stop();
});
