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
    c: { id: 'c', fileSize: 30, status: 'missing' },
  };
  const scanned = [
    { id: 'a', size: 10 },
    { id: 'b', size: 99 },
    { id: 'd', size: 40 },
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
  await new Promise((res) => setTimeout(res, 50));
  const paper = Object.values(store.papers)[0];
  assert.ok(paper, '应有论文入库');
  assert.strictEqual(paper.status, 'ready');
  assert.ok(paper.summary.includes('TL;DR'));
  assert.ok(paper.tags.includes('demo'));
  assert.strictEqual(paper.metaSource, 'ai-fallback');
  scanner.stop();
});
