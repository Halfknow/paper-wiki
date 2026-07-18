/**
 * 全文检索辅助：查询词解析 + 命中片段（snippet）提取与高亮。
 *
 * 设计（v3.1 全文检索）：
 * - SQL 侧只负责「哪些论文命中 + 排序」（lib/db.js searchFulltext：英文 tsvector/GIN，中文/降级 ILIKE）；
 * - 片段提取在 Node 侧做：只对命中的前 N 篇加载全文，统一了 tsquery / ILIKE 两条路径的 snippet 逻辑，
 *   也避免 SQL ts_headline 对中文无能为力的问题。
 * - 输出 snippet 是**已转义的 HTML**（命中词包 <mark>），前端直接 innerHTML。
 */

/** 是否含 CJK 字符（中日韩）：含则 tsquery 分词无意义，走 ILIKE 子串路径 */
function hasCjk(s) {
  return /[一-鿿぀-ヿ가-힯]/.test(String(s || ''));
}

/** 查询串 → 检索词数组：去引号、按空白切分、去重（保留原大小写无意义，统一小写）。
 *  CJK 查询整串作为单一词（不切分）。 */
function splitTerms(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  if (hasCjk(s)) return [s.replace(/["“”]/g, '').trim()].filter(Boolean);
  const terms = s
    .replace(/["“”]/g, ' ')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2); // 单字母噪声太大
  return [...new Set(terms)];
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 从全文提取命中片段。
 * @param {string} text 论文全文
 * @param {string[]} terms 检索词（splitTerms 输出）
 * @param {object} opts { window: 每侧上下文字符数, maxSnippets, maxMatchesPerTerm }
 * @returns {{ snippets: string[], matches: number }} snippets 为转义后 HTML（命中词 <mark>）
 */
function buildSnippets(text, terms, opts = {}) {
  const window = opts.window ?? 70;
  const maxSnippets = opts.maxSnippets ?? 3;
  const maxMatchesPerTerm = opts.maxMatchesPerTerm ?? 50;
  const raw = String(text || '');
  if (!raw || !terms || !terms.length) return { snippets: [], matches: 0 };
  const lower = raw.toLowerCase();

  // 1) 收集所有命中区间 [start, end)
  const hits = [];
  for (const term of terms) {
    const t = String(term).toLowerCase();
    if (!t) continue;
    let idx = 0;
    let n = 0;
    while (n < maxMatchesPerTerm) {
      idx = lower.indexOf(t, idx);
      if (idx === -1) break;
      hits.push([idx, idx + t.length]);
      idx += t.length;
      n++;
    }
  }
  if (!hits.length) return { snippets: [], matches: 0 };
  hits.sort((a, b) => a[0] - b[0]);

  // 2) 命中区间扩上下文窗口并合并重叠 → 片段区间（每片段记录其内部命中）
  const frags = [];
  for (const [s, e] of hits) {
    const ws = Math.max(0, s - window);
    const we = Math.min(raw.length, e + window);
    const last = frags[frags.length - 1];
    if (last && ws <= last.end) {
      last.end = Math.max(last.end, we);
      last.marks.push([s, e]);
    } else {
      frags.push({ start: ws, end: we, marks: [[s, e]] });
    }
  }

  // 3) 前 maxSnippets 个片段 → 转义 HTML + <mark>（先按原文位置切段再逐段转义，避免转义后偏移错位）
  const snippets = [];
  for (const f of frags.slice(0, maxSnippets)) {
    let html = '';
    let cur = f.start;
    for (const [ms, me] of f.marks) {
      if (ms < cur) continue; // 同窗口内重叠命中已被并入前一个 mark 的展示
      html += escapeHtml(raw.slice(cur, ms));
      html += '<mark>' + escapeHtml(raw.slice(ms, me)) + '</mark>';
      cur = me;
    }
    html += escapeHtml(raw.slice(cur, f.end));
    // 换行折叠为空格（snippet 单行展示）
    html = html.replace(/\s+/g, ' ').trim();
    snippets.push((f.start > 0 ? '…' : '') + html + (f.end < raw.length ? '…' : ''));
  }
  return { snippets, matches: hits.length };
}

module.exports = { hasCjk, splitTerms, buildSnippets, escapeHtml };
