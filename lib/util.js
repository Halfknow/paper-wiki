const crypto = require('crypto');
const fs = require('fs');

/** 流式计算文件 sha1，避免大 PDF 一次性入内存 */
function sha1OfFile(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 串行限速器：返回 async fn，调用它会排队，保证两次进入间隔 >= minIntervalMs */
function createRateLimiter(minIntervalMs) {
  let nextAt = 0;
  return async function throttled() {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    if (wait > 0) await sleep(wait);
    nextAt = Math.max(now, nextAt) + minIntervalMs;
  };
}

/** 标题规范化：小写、去 LaTeX、去非字母数字（unicode 感知）、折叠空白 */
function normalizeTitle(t) {
  if (!t) return '';
  return t.toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 基于 token 集合的 Jaccard 相似度，0~1 */
function titleSimilarity(a, b) {
  const sa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 从文件名清洗候选标题，针对本仓库的不统一命名格式 */
function cleanFilenameToTitle(filename) {
  let s = filename.replace(/\.pdf$/i, '');
  s = s.replace(/^(pre|jair|arxiv)[_\-\s]*\d{4}[_\-\s]*/i, '');      // 去前缀+年份
  s = s.replace(/[_]+/g, ' ');                                        // 下划线→空格
  s = s.replace(/\s*\b\d{4}\b\s*[-—–]\s*/g, ' ');                     // 去「年份-」/「- 年份 -」
  s = s.replace(/\s*\b\d{4}\b/g, ' ');                                // 去孤立年份
  s = s.replace(/[\w\.\-]+(?:\s+等|\s+et al\.?)\s*[-—–]?\s*/i, ' ');  // 去「作者 等 [-]」
  s = s.replace(/\s*(billingual|bilingual)\s*$/i, '');                // 去双语后缀
  return s.replace(/\s+/g, ' ').trim();
}

function log(...args) { console.log(new Date().toISOString(), ...args); }

module.exports = {
  sha1OfFile, sleep, createRateLimiter, normalizeTitle, titleSimilarity, cleanFilenameToTitle, log,
};
