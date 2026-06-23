const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTitle,
  titleSimilarity,
  cleanFilenameToTitle,
  sleep,
  createRateLimiter,
  parseArxivUrl,
  safeFilename,
  buildPaperFilename,
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
  assert.strictEqual(
    cleanFilenameToTitle('2026-Zhao 等-A Survey of Large Language Models.pdf'),
    'A Survey of Large Language Models',
  );
  assert.strictEqual(
    cleanFilenameToTitle(
      'DeepSeek-AI 等 - 2024 - DeepSeek LLM Scaling Open-Source Language Models with Longtermism.pdf',
    ),
    'DeepSeek LLM Scaling Open-Source Language Models with Longtermism',
  );
  assert.strictEqual(
    cleanFilenameToTitle('Pre_2024_The Ultimate Guide to Fine-Tuning LLMs.pdf'),
    'The Ultimate Guide to Fine-Tuning LLMs',
  );
  assert.strictEqual(cleanFilenameToTitle('JAIR_2025_A Survey on Data Selection.pdf'), 'A Survey on Data Selection');
  assert.strictEqual(cleanFilenameToTitle('Some Paper_billingual.pdf'), 'Some Paper');
});

test('createRateLimiter 保证最小间隔', async () => {
  const lim = createRateLimiter(50);
  const t0 = Date.now();
  await lim();
  await lim();
  await lim();
  assert.ok(Date.now() - t0 >= 100, '三次调用至少间隔 100ms');
});

test('parseArxivUrl 解析 abs/pdf/html 网址与裸 ID', () => {
  // abs 网址
  let r = parseArxivUrl('https://arxiv.org/abs/2401.12345');
  assert.strictEqual(r.arxivId, '2401.12345');
  assert.strictEqual(r.pdfUrl, 'https://arxiv.org/pdf/2401.12345.pdf');
  // abs 带版本号 → 去版本号
  r = parseArxivUrl('https://arxiv.org/abs/2401.12345v2');
  assert.strictEqual(r.arxivId, '2401.12345');
  // pdf 网址（含版本与 .pdf 后缀）
  r = parseArxivUrl('https://arxiv.org/pdf/2401.12345v2.pdf');
  assert.strictEqual(r.arxivId, '2401.12345');
  assert.strictEqual(r.pdfUrl, 'https://arxiv.org/pdf/2401.12345.pdf');
  // html 网址
  r = parseArxivUrl('https://arxiv.org/html/2401.12345v1');
  assert.strictEqual(r.arxivId, '2401.12345');
  // 裸 ID（带版本）
  r = parseArxivUrl('  2401.12345v3  ');
  assert.strictEqual(r.arxivId, '2401.12345');
  // 老格式分类 ID
  r = parseArxivUrl('https://arxiv.org/abs/cs.AI/0701001');
  assert.strictEqual(r.arxivId, 'cs.ai/0701001');
  assert.strictEqual(r.pdfUrl, 'https://arxiv.org/pdf/cs.ai/0701001.pdf');
});

test('parseArxivUrl 对非法输入返回 null', () => {
  assert.strictEqual(parseArxivUrl('https://example.com/x'), null);
  assert.strictEqual(parseArxivUrl('not a url at all'), null);
  assert.strictEqual(parseArxivUrl(''), null);
  assert.strictEqual(parseArxivUrl(null), null);
  // 非 arXiv 的 http 网址（含类似 ID 形式但 host 不对）
  assert.strictEqual(parseArxivUrl('https://example.org/abs/2401.12345'), null);
});

test('safeFilename 去除文件系统非法字符并净化', () => {
  assert.strictEqual(safeFilename('DAPO: An Open-Source LLM'), 'DAPO An Open-Source LLM');
  assert.strictEqual(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(safeFilename('trailing dots...'), 'trailing dots');
  assert.strictEqual(safeFilename('  spaced   out  '), 'spaced out');
  assert.strictEqual(safeFilename(''), '');
  assert.strictEqual(safeFilename(null), '');
  assert.ok(safeFilename('x'.repeat(300), { maxLen: 50 }).length <= 50);
});

test('buildPaperFilename 生成 「作者 等 - 年份 - 标题.pdf」', () => {
  assert.strictEqual(
    buildPaperFilename({
      authors: ['Kai Han', 'Yunhe Wang'],
      year: 2024,
      title: 'A Survey on Visual Transformer',
      arxivId: '2012.12556',
    }),
    'Han 等 - 2024 - A Survey on Visual Transformer.pdf',
  );
  assert.strictEqual(
    buildPaperFilename({ authors: ['Jeong'], year: '2024', title: 'Fine-tuning Methods', arxivId: 'x' }),
    'Jeong - 2024 - Fine-tuning Methods.pdf',
  );
  // 标题含非法字符（冒号）
  assert.strictEqual(
    buildPaperFilename({ authors: ['Yu', 'B'], year: 2025, title: 'DAPO: An Open-Source System', arxivId: 'x' }),
    'Yu 等 - 2025 - DAPO An Open-Source System.pdf',
  );
});

test('buildPaperFilename 缺字段时的回退', () => {
  // 无标题 → 回退 arxivId
  assert.strictEqual(
    buildPaperFilename({ authors: ['A'], year: 2024, title: '', arxivId: '2401.00001' }),
    '2401.00001.pdf',
  );
  // 无作者 → 「年份 - 标题」
  assert.strictEqual(
    buildPaperFilename({ authors: [], year: 2024, title: 'Lonely Title', arxivId: 'x' }),
    '2024 - Lonely Title.pdf',
  );
  // 无年份 → 「作者 等 - 标题」
  assert.strictEqual(
    buildPaperFilename({ authors: ['Han', 'X'], year: null, title: 'No Year', arxivId: 'x' }),
    'Han 等 - No Year.pdf',
  );
  // 全缺但有 arxivId
  assert.strictEqual(
    buildPaperFilename({ authors: [], year: null, title: '', arxivId: '2401.00002' }),
    '2401.00002.pdf',
  );
  // 全缺且无 arxivId → null
  assert.strictEqual(buildPaperFilename({ authors: [], year: null, title: '', arxivId: null }), null);
});

test('buildPaperFilename 长标题截断（含 .pdf 总长 ≤ 180）', () => {
  const fn = buildPaperFilename({ authors: ['Han'], year: 2024, title: 'T'.repeat(400), arxivId: 'x' });
  assert.ok(fn.endsWith('.pdf'));
  assert.ok(fn.length <= 180, 'filename 总长应受限, 实际=' + fn.length);
});
