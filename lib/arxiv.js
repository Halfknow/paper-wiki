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
    const pdfLink = links.find((l) => l && l['@_type'] === 'application/pdf');
    return {
      title: (e.title || '').replace(/\s+/g, ' ').trim(),
      id: e.id || '',
      summary: (e.summary || '').replace(/\s+/g, ' ').trim(),
      published: e.published || '',
      authors,
      primaryCategory: (e['arxiv:primary_category'] && e['arxiv:primary_category']['@_term']) || null,
      pdfUrl: (pdfLink && pdfLink['@_href'])
        || links.map((l) => l && l['@_href']).find((h) => h && /\/pdf[/.]/.test(h))
        || null,
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
