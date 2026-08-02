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
} = require('../src/core/util');

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

// ==================== 追加：sha1OfFile / 相似度边界 / 文件名边界 / 宽松 JSON ====================

test('sha1OfFile：与 crypto 参考值一致；文件不存在时 rejects', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const { sha1OfFile } = require('../src/core/util');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsha-'));
  try {
    const f = path.join(dir, 'a.bin');
    const content = 'PaperWiki sha1 测试内容 with mixed content';
    fs.writeFileSync(f, content, 'utf8');
    const expect = crypto.createHash('sha1').update(content, 'utf8').digest('hex');
    assert.strictEqual(await sha1OfFile(f), expect, '流式 sha1 应与一次性计算一致');
    await assert.rejects(() => sha1OfFile(path.join(dir, 'nope.bin')), '缺失文件应 reject');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('titleSimilarity 边界：都空→1、一空一非空→0', () => {
  assert.strictEqual(titleSimilarity('', ''), 1);
  assert.strictEqual(titleSimilarity(null, ''), 1, 'null 归一为空串');
  assert.strictEqual(titleSimilarity('', 'Some Title'), 0);
  assert.strictEqual(titleSimilarity('Some Title', ''), 0);
});

test('buildPaperFilename：arxivId 含 /（老格式）→ 净化为 _；空作者姓回退', () => {
  // 无标题 → 回退 arxivId；老格式 cs.AI/0701001 的 / 被替换为 _
  assert.strictEqual(buildPaperFilename({ title: '', arxivId: 'cs.AI/0701001' }), 'cs.AI_0701001.pdf');
  // 空字符串作者被过滤 → 无 namePart
  assert.strictEqual(
    buildPaperFilename({ authors: [''], year: 2024, title: 'Solo Work', arxivId: 'x' }),
    '2024 - Solo Work.pdf',
  );
  // 纯空白作者：trim 后无 surname → namePart 为空，同样回退
  assert.strictEqual(
    buildPaperFilename({ authors: ['   '], year: 2024, title: 'Solo Work', arxivId: 'x' }),
    '2024 - Solo Work.pdf',
  );
});

test('cleanFilenameToTitle：arxiv_ 前缀、et al 变体、年份区间', () => {
  assert.strictEqual(cleanFilenameToTitle('arxiv_2023_My Cool Paper.pdf'), 'My Cool Paper');
  assert.strictEqual(cleanFilenameToTitle('Smith et al. - My Paper.pdf'), 'My Paper');
  assert.strictEqual(cleanFilenameToTitle('Smith et al - Title Here.pdf'), 'Title Here');
  assert.strictEqual(cleanFilenameToTitle('2020-2021 Annual Report.pdf'), 'Annual Report');
});

test('parseJsonLenient：括号配平截掉尾部垃圾；完全非法时抛错', () => {
  const { parseJsonLenient } = require('../src/core/util');
  // 直接 parse 成功路径
  assert.deepStrictEqual(parseJsonLenient('{"a":1}'), { a: 1 });
  // 尾部 chunked 残留（\r\n0\r\n\r\n）→ 配平截断
  assert.deepStrictEqual(parseJsonLenient('{"a":1}\r\n0\r\n\r\n'), { a: 1 });
  // Google 翻译风格数组 + 尾部垃圾
  assert.deepStrictEqual(parseJsonLenient('[[["译文","src"]]]xyz trailing'), [[['译文', 'src']]]);
  // 字符串内含括号不影响配平
  assert.deepStrictEqual(parseJsonLenient('{"a":"} not end"}garbage'), { a: '} not end' });
  // 完全无 JSON → 抛错
  assert.throws(() => parseJsonLenient('no json here'), /JSON 解析失败/);
});

test('decodeChunked：正常 chunked 解码、截断保护、非 chunked 直通', () => {
  const { decodeChunked } = require('../src/core/util');
  // 标准 chunked body
  assert.strictEqual(decodeChunked('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n'), 'Wikipedia');
  // 声明长度大于实际 → 截断保护：取剩余数据后停止
  assert.strictEqual(decodeChunked('5\r\nWik'), 'Wik');
  // 非 chunked（无十六进制头）→ 原样返回
  assert.strictEqual(decodeChunked('plain body'), 'plain body');
  assert.strictEqual(decodeChunked('{"a":1}'), '{"a":1}');
});

test('extractArxivIdFromFilename：裸 ID / 方括号下载命名 / 任意位置 / 老格式 / 防误报', () => {
  const { extractArxivIdFromFilename: f } = require('../src/core/util');
  // 整串裸 ID（沿用 parseArxivUrl 严格解析，trap 14 语义不变）
  assert.strictEqual(f('2306.02781.pdf').arxivId, '2306.02781');
  assert.strictEqual(f('2306.02781').via, 'bare');
  // 标准下载命名 [id] Title
  assert.strictEqual(f('[2306.02781v4] An Automated Survey of Generative AI.pdf').arxivId, '2306.02781');
  assert.strictEqual(f('[2306.02781v4] An Automated Survey of Generative AI.pdf').via, 'inline');
  // 任意位置（括号内 / 名称内嵌）
  assert.strictEqual(f('论文备份 (2401.12345).pdf').arxivId, '2401.12345');
  assert.strictEqual(f('paper hep-th/9901001 v2.pdf').arxivId, 'hep-th/9901001');
  // 老格式分类前缀小写规范化
  assert.strictEqual(f('cs.AI/0701001.pdf').arxivId, 'cs.ai/0701001');
  // 防误报：非 ID 文件名 / 无有效月份
  assert.strictEqual(f('Pre_2025_Survey.pdf'), null);
  assert.strictEqual(f('normal title.pdf'), null);
  assert.strictEqual(f(''), null);
  assert.strictEqual(f(null), null);
  // 月份约束：13 月不算 ID（inline 分支；bare 分支是 parseArxivUrl 既有宽松语义，不在此约束）
  assert.strictEqual(f('report 2413.9999.pdf'), null);
});
