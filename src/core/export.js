'use strict';

// 论文导出纯逻辑：BibTeX / CSV。零 IO，可独立单测。
// 数据全部来自 summaryView 已有的字段（title/authors/year/abstract/arxivId/arxivUrl/primaryCategory 等）。

const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM：Excel 打开中文 CSV 不乱码（避免源码藏不可见字符）

/** BibTeX 引用 key：第一作者姓 + 年份 + 标题首个实词，如 vaswani2017attention。 */
function bibtexKey(p, used) {
  const firstAuthor = Array.isArray(p.authors) && p.authors.length ? String(p.authors[0]) : '';
  // 取姓（"Last, First" 取逗号前；"First Last" 取末词），只留字母
  const surname = (firstAuthor.includes(',') ? firstAuthor.split(',')[0] : firstAuthor.split(/\s+/).pop() || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const year = String(p.year || '').replace(/[^0-9]/g, '').slice(0, 4);
  const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'for', 'and', 'with', 'to', 'via', 'is', 'are']);
  const titleWord = String(p.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .find((w) => w && !STOP.has(w));
  let key = `${surname || 'paper'}${year || 'nd'}${titleWord || 'untitled'}`;
  // 同库撞 key 时加字母后缀（vaswani2017attentiona / b / c…），保证 BibTeX 编译器不报重复键
  if (used) {
    let k = key,
      i = 0;
    while (used.has(k)) k = key + String.fromCharCode(97 + i++);
    key = k;
    used.add(key);
  }
  return key;
}

/** BibTeX 值清洗：折叠空白 + 剥花括号（BibTeX 无可靠转义，剥除比写坏库更稳）。 */
function bibVal(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, '')
    .trim();
}

/** 论文列表 → BibTeX 文本。有 arxivId 的用 @article + eprint/archivePrefix（arXiv 标准写法），
 *  无 arXiv 的用 @misc + url（若有）。标题整体再包一层 {} 保护大小写（BibTeX 风格指南惯例）。 */
function papersToBibtex(list) {
  const used = new Set();
  const entries = [];
  for (const p of list || []) {
    if (!p) continue;
    const key = bibtexKey(p, used);
    const fields = [];
    fields.push(`  title = {{${bibVal(p.title) || bibVal(p.filename) || 'Untitled'}}}`);
    if (Array.isArray(p.authors) && p.authors.length) {
      fields.push(`  author = {${p.authors.map(bibVal).filter(Boolean).join(' and ')}}`);
    }
    if (p.year) fields.push(`  year = {${bibVal(p.year)}}`);
    if (p.abstract) fields.push(`  abstract = {${bibVal(p.abstract)}}`);
    let type = 'misc';
    if (p.arxivId) {
      type = 'article';
      fields.push(`  eprint = {${bibVal(p.arxivId)}}`);
      fields.push(`  archivePrefix = {arXiv}`);
      if (p.primaryCategory) fields.push(`  primaryClass = {${bibVal(p.primaryCategory)}}`);
    }
    const url = p.arxivUrl || (p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : null);
    if (url) fields.push(`  url = {${bibVal(url)}}`);
    entries.push(`@${type}{${key},\n${fields.join(',\n')}\n}`);
  }
  return entries.join('\n\n') + (entries.length ? '\n' : '');
}

/** CSV 字段：包双引号 + 内部双引号翻倍（RFC 4180）。 */
function csvCell(s) {
  return `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = [
  ['id', (p) => p.id],
  ['title', (p) => p.title],
  ['authors', (p) => (p.authors || []).join('; ')],
  ['year', (p) => p.year],
  ['arxiv_id', (p) => p.arxivId],
  ['arxiv_url', (p) => p.arxivUrl || (p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : '')],
  ['primary_category', (p) => p.primaryCategory],
  ['tags', (p) => (p.tags || []).join('; ')],
  ['topics', (p) => (p.topics || []).join('; ')],
  ['rating', (p) => p.rating || 0],
  ['read_status', (p) => p.readStatus],
  ['status', (p) => p.status],
  ['added_at', (p) => (p.addedAt ? new Date(p.addedAt).toISOString() : '')],
  ['filename', (p) => p.filename],
];

/** 论文列表 → CSV 文本（CRLF 行尾 + UTF-8 BOM，Excel 直接打开不乱码不错行）。 */
function papersToCsv(list) {
  const lines = [CSV_COLUMNS.map(([name]) => csvCell(name)).join(',')];
  for (const p of list || []) {
    if (!p) continue;
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(p))).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { papersToBibtex, papersToCsv, bibtexKey };
