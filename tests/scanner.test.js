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
      summarize: async () => ({
        tldr: '短',
        contributions: ['x'],
        method: 'm',
        tags: ['demo'],
        metadata: { title: 'Sample', authors: ['A'], year: 2024 },
      }),
      buildSummaryMarkdown: (o) => '## TL;DR\n' + o.tldr,
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
      summarize: async () => ({ tldr: 't', contributions: [], method: '', tags: ['x'], metadata: {} }),
      buildSummaryMarkdown: (o) => o.tldr,
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
      summarize: async () => ({ tldr: 't', contributions: [], method: '', tags: ['vision-transformer'], topics: ['计算机视觉'] }),
      buildSummaryMarkdown: (o) => (o ? '## TL;DR\n' + (o.tldr || '') : 'FAILED'),
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

test('processOne 空总结不被当作成功（存可重试占位、不写误导性空 TL;DR）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan4-'));
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%placeholder\n'));
  const storePath = path.join(dir, 'papers.json');
  const store = {
    version: 2,
    tags: [],
    papers: {
      x: { id: 'x', filename: 'x.pdf', filepath: path.join(dir, 'x.pdf'), title: 'T', authors: ['A'], year: 2024, arxivId: null, tags: [], topics: [], status: 'pending', error: null, updatedAt: 0 },
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
      summarize: async () => ({}), // 模型返回空对象（瞬时失败）
      buildSummaryMarkdown: (o) => (o ? '## TL;DR\n' + (o.tldr || '') : '*（总结生成失败，可点击「重新总结」重试）*'),
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
