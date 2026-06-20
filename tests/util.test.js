const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTitle, titleSimilarity, cleanFilenameToTitle, sleep, createRateLimiter, parseArxivUrl,
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
