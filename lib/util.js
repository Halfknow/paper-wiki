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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  return t
    .toLowerCase()
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
  s = s.replace(/^(pre|jair|arxiv)[_\-\s]*\d{4}[_\-\s]*/i, ''); // 去前缀+年份
  s = s.replace(/[_]+/g, ' '); // 下划线→空格
  s = s.replace(/\s*\b\d{4}\b\s*[-—–]\s*/g, ' '); // 去「年份-」/「- 年份 -」
  s = s.replace(/\s*\b\d{4}\b/g, ' '); // 去孤立年份
  s = s.replace(/[\w.-]+(?:\s+等|\s+et al\.?)\s*[-—–]?\s*/i, ' '); // 去「作者 等 [-]」
  s = s.replace(/\s*(billingual|bilingual)\s*$/i, ''); // 去双语后缀
  return s.replace(/\s+/g, ' ').trim();
}

/** 把任意字符串净化成合法文件名片段：去 Windows/POSIX 非法字符、折叠空白、去尾部空格/点、限长。
 *  注意只处理「文件名主体」，扩展名由调用方拼接。 */
function safeFilename(name, opts = {}) {
  const maxLen = opts.maxLen ?? 200;
  let s = String(name == null ? '' : name);
  // < > : " / \ | ? * 与控制字符 → 空格（连字符/空格保留）（冒号常见于标题如「DAPO: ...」，置空格后折叠）
  s = s.replace(/[<>:"/\\|?*]/g, ' ');
  s = s.replace(/\p{Cc}/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  s = s.replace(/[ .]+$/g, '').trim(); // Windows 不允许文件名以空格或点结尾
  return s;
}

/** 生成「作者 等 - 年份 - 标题.pdf」式文件名（对齐库内 Zotero 风格命名）。
 *  - 作者取首位作者的姓（最后一个空格分词）；多作者追加「 等」。
 *  - 缺标题 → 回退 <arxivId>.pdf；全缺且无 arxivId → null（由调用方再兜底）。
 *  - 含 .pdf 的总长限制在 180 以内（标题侧截断），避免超长路径。 */
function buildPaperFilename({ authors, year, title, arxivId } = {}) {
  const titleClean = safeFilename(String(title || ''));
  if (!titleClean) {
    return arxivId ? `${safeFilename(String(arxivId).replace(/\//g, '_')) || 'paper'}.pdf` : null;
  }
  const list = Array.isArray(authors) ? authors.filter(Boolean) : [];
  let namePart = '';
  if (list.length) {
    const surname = safeFilename(String(list[0]).trim().split(/\s+/).pop() || '');
    if (surname) namePart = surname + (list.length > 1 ? ' 等' : '');
  }
  const yearPart = year ? String(year).slice(0, 4) : '';
  const prefix = [namePart, yearPart].filter(Boolean).join(' - ');
  const budget = Math.max(20, 180 - 4 - (prefix ? prefix.length + 3 : 0)); // 4=".pdf"，3=" - "
  const titlePart = safeFilename(titleClean, { maxLen: budget });
  const base = [prefix, titlePart].filter(Boolean).join(' - ');
  return base + '.pdf';
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** 解析 arXiv 网址或 ID，返回 { arxivId, pdfUrl, raw } 或 null（无法识别）。
 *  支持三种网址 + 裸 ID：
 *    abs:  https://arxiv.org/abs/2401.12345 / .../abs/2401.12345v2
 *    pdf:  https://arxiv.org/pdf/2401.12345  / .../pdf/2401.12345v2.pdf
 *    html: https://arxiv.org/html/2401.12345v1
 *    裸 ID: 2401.12345 / 2401.12345v2 / 老格式 cs.AI/0701001
 *  arxivId 统一去掉版本号（vN），下载 PDF 取最新版。 */
function parseArxivUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  // 新格式 ID：YYMM.NNNNN 或 YYMM.NNNNNvN；老格式：分类/NNNNNNN（如 cs.AI/0701001）
  // 覆盖三种路径前缀（abs/pdf/html）与裸 ID 两种情况。
  const m = /(?:arxiv\.org\/(?:abs|pdf|html)\/|^)([0-9]{4}\.[0-9]{4,5}|[a-z.-]+\/[0-9]{7})(?:v\d+)?/i.exec(s);
  if (!m) return null;
  // 排除"裸 ID 含路径但不是 arxiv 网址"的误判：若 s 含 http 但 host 非 arxiv.org，判失败
  if (/^https?:\/\//i.test(s) && !/arxiv\.org/i.test(s)) return null;
  let arxivId = m[1].replace(/\.$/, '');
  // 老格式分类前缀大小写规范化（cs.ai → cs.AI），便于展示，不影响下载
  if (arxivId.includes('/')) {
    const [cat, num] = arxivId.split('/');
    arxivId = cat.toLowerCase() + '/' + num;
  }
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  return { arxivId, pdfUrl, raw: s };
}

module.exports = {
  sha1OfFile,
  sleep,
  createRateLimiter,
  normalizeTitle,
  titleSimilarity,
  cleanFilenameToTitle,
  log,
  parseArxivUrl,
  safeFilename,
  buildPaperFilename,
};
