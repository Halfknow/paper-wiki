const { XMLParser } = require('fast-xml-parser');
const fsp = require('fs').promises;
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
    const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
    const authors = (Array.isArray(e.author) ? e.author : [e.author])
      .map((a) => (a && a.name ? a.name : null))
      .filter(Boolean);
    const pdfLink = links.find((l) => l && l['@_type'] === 'application/pdf');
    return {
      title: (e.title || '').replace(/\s+/g, ' ').trim(),
      id: e.id || '',
      summary: (e.summary || '').replace(/\s+/g, ' ').trim(),
      published: e.published || '',
      authors,
      primaryCategory: (e['arxiv:primary_category'] && e['arxiv:primary_category']['@_term']) || null,
      pdfUrl:
        (pdfLink && pdfLink['@_href']) ||
        links.map((l) => l && l['@_href']).find((h) => h && /\/pdf[/.]/.test(h)) ||
        null,
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
  let best = null,
    bestScore = 0;
  for (const e of entries) {
    const score = titleSimilarity(candidateTitle, e.title);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (!best || bestScore < threshold) return { best: null, confidence: bestScore, source: 'none' };
  return { best, confidence: bestScore, source: 'arxiv' };
}

/** 查询 arXiv（注入 fetchImpl 便于测试）。
 *  - 第 3 参数兼容旧的数字（minIntervalMs）与新对象 { minIntervalMs, timeoutMs, maxRetries }；
 *    限速间隔由调用方（scanner 的 rateLimitArxiv）统一管控，这里仅在 >0 时补一次礼貌 sleep。
 *  - 单次请求加 AbortSignal.timeout，对超时/网络错误/429/5xx 做有限重试，
 *    避免 arXiv 偶发挂起时把串行流水线永久卡在一个 worker 上。 */
async function searchArxiv(query, fetchImpl = fetch, optsOrInterval = {}) {
  const opts = typeof optsOrInterval === 'number' ? { minIntervalMs: optsOrInterval } : optsOrInterval || {};
  const minIntervalMs = opts.minIntervalMs || 0;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxRetries = opts.maxRetries ?? 2;
  if (minIntervalMs > 0) await sleep(minIntervalMs);
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&start=0&max_results=3`;
  const baseHeaders = { 'User-Agent': 'PaperWiki/1.0 (local research tool)' };
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // fetch 层错误（AbortError 超时 / TypeError 网络层）一律可重试
      lastErr = e && e.name === 'AbortError' ? new Error(`arxiv timeout (${timeoutMs}ms)`) : e;
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    }
    if (res.ok) return { entries: parseAtom(await res.text()), query };
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    lastErr = new Error(`arxiv HTTP ${res.status}`);
    // 不可重试（4xx 等）立即抛，绝不退避重试
    if (!retryable) throw lastErr;
    if (attempt < maxRetries) await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, …
  }
  throw lastErr;
}

/** 下载 arXiv PDF 到本地 destPath（注入 fetchImpl 便于测试）。
 *  - 超时默认 60s（PDF 可能几 MB）；
 *  - 双重校验：content-type 含 application/pdf，或缓冲区前 5 字节是 %PDF- 魔数，
 *    防 arXiv 偶尔返回限流/错误页但状态 200；
 *  - 返回 destPath。 */
async function downloadPaperPdf(url, destPath, fetchImpl = fetch, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'PaperWiki/1.0 (local research tool)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/pdf') && buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('下载内容不是 PDF（可能是 arXiv 限流页或错误页），请稍后重试或检查网络/代理');
  }
  await fsp.writeFile(destPath, buf);
  return destPath;
}

module.exports = { newParser, parseAtom, extractArxivId, pickBest, searchArxiv, downloadPaperPdf };
