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

// 委托 logger（保持 38 处现有调用零改动；行为 = info 级）。
// 直接 console.log 的历史写法已被 logger 取代，详见 src/core/logger.js。
const logger = require('./logger').root;
function log(...args) {
  logger.info(args.join(' '));
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

/**
 * 零依赖 HTTPS GET（返回解析后的 JSON），自动尊崇 HTTP_PROXY/HTTPS_PROXY 环境变量。
 * 用于调用 Google 免费翻译端点等外部服务（Node 原生 fetch 不读代理环境变量，需手动隧道）。
 * - 无代理：直接 https.get
 * - 有代理：向代理发 CONNECT 建隧道，隧道 socket 上跑 TLS
 * - 自动解 chunked transfer-encoding
 * @param {string} url 完整 https URL
 * @param {{timeout?:number, headers?:object}} [opts]
 * @returns {Promise<any>} 解析后的 JSON
 */
function proxyFetchJson(url, opts = {}) {
  const http = require('http');
  const https = require('https');
  const tls = require('tls');
  const u = new URL(url);
  const timeout = opts.timeout || 15000;
  const headers = opts.headers || {};
  const proxy =
    u.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), timeout);
    const done = (fn, v) => {
      clearTimeout(timer);
      fn(v);
    };

    // 无代理：直接 https.get
    if (!proxy) {
      const req = https.get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(reject, new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          try {
            done(resolve, parseJsonLenient(decodeChunked(buf)));
          } catch (e) {
            done(reject, new Error('JSON 解析失败'));
          }
        });
      });
      req.on('error', (e) => done(reject, e));
      return;
    }

    // 有代理：CONNECT 隧道
    const pu = new URL(proxy);
    const connectReq = http.request({
      host: pu.hostname,
      port: pu.port || 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        done(reject, new Error(`代理 CONNECT 失败：${res.statusCode}`));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: u.hostname }, () => {
        const path = u.pathname + u.search;
        const reqLines = [`GET ${path} HTTP/1.1`, `Host: ${u.hostname}`, 'Connection: close'];
        for (const [k, v] of Object.entries(headers)) reqLines.push(`${k}: ${v}`);
        tlsSock.write(reqLines.join('\r\n') + '\r\n\r\n');
      });
      let buf = '';
      // TLS 可能分多个 record 下发；用 idle 计时器判断「一段时间无新数据 = 传完」再解析，
      // 避免 end 事件在 chunked 末尾 0\r\n\r\n 收齐前触发导致 body 截断。
      let idle = null;
      const settle = () => {
        const sep = buf.indexOf('\r\n\r\n');
        const headBlock = sep >= 0 ? buf.slice(0, sep) : '';
        const body = sep >= 0 ? buf.slice(sep + 4) : buf;
        // 非 chunked 且有 Content-Length：校验 body 是否收齐，未齐则等下一片
        const clMatch = /content-length:\s*(\d+)/i.exec(headBlock);
        if (clMatch && body.length < parseInt(clMatch[1], 10)) return;
        try {
          done(resolve, parseJsonLenient(decodeChunked(body)));
        } catch (e) {
          done(reject, new Error('JSON 解析失败'));
        }
      };
      tlsSock.on('data', (c) => {
        buf += c.toString();
        if (idle) clearTimeout(idle);
        idle = setTimeout(settle, 200); // 200ms 无新数据 → 视为传完
      });
      tlsSock.on('end', () => {
        if (idle) clearTimeout(idle);
        settle();
      });
      tlsSock.on('error', (e) => {
        if (idle) clearTimeout(idle);
        done(reject, e);
      });
    });
    connectReq.on('error', (e) => done(reject, e));
    connectReq.end();
  });
}

/** 从可能含 chunked 残留/尾部垃圾的字符串里提取首个完整 JSON 值。
 *  Google 端点返回 [[...]]，chunked 解码后偶有尾部 \r\n0\r\n\r\n 残留导致 JSON.parse 失败。
 *  这里用括号配平找首个完整 JSON 数组/对象的边界。 */
function parseJsonLenient(s) {
  s = s.trim();
  // 先试直接 parse
  try {
    return JSON.parse(s);
  } catch {}
  // 失败则按括号配平截断（首个 [ 或 { 到配平位置）
  const open = s.search(/[[{]/);
  if (open < 0) throw new Error('JSON 解析失败');
  const first = s[open];
  const close = first === '[' ? ']' : '}';
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === first) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(s.slice(open, i + 1));
  }
  throw new Error('JSON 解析失败');
}

/** 解码 HTTP chunked transfer-encoding 的 body。非 chunked 则原样返回。
 *  chunked 格式：<size hex>\r\n<size 字节数据>\r\n... 0\r\n\r\n */
function decodeChunked(body) {
  // 启发：chunked body 以十六进制 chunk size 行开头（如 "5a\r\n..."）
  const firstNl = body.indexOf('\r\n');
  const head = firstNl >= 0 ? body.slice(0, firstNl) : '';
  if (!/^[0-9a-fA-F]+$/.test(head)) return body; // 非 chunked
  let out = '';
  let p = 0;
  while (p < body.length) {
    const nl = body.indexOf('\r\n', p);
    if (nl < 0) break;
    const size = parseInt(body.slice(p, nl).trim(), 16);
    if (!size) break; // 0 chunk = 结束
    const dataStart = nl + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > body.length) {
      out += body.slice(dataStart);
      break;
    } // 截断保护
    out += body.slice(dataStart, dataEnd);
    p = dataEnd + 2; // 跳过 chunk 数据 + 尾部 \r\n
  }
  return out;
}

/** 从文件名里提取 arXiv ID（比 parseArxivUrl 宽：
 *  - parseArxivUrl 只认「整串是裸 ID / arxiv.org URL」；
 *  - 本函数还认文件名中**任意位置**的 ID：标准下载命名 `[2306.02781v4] Title.pdf`、
 *    括号内 ID、老格式 `cs.AI/0701001`。
 *  防误报：新格式 ID 约束 YYMM 的 MM ∈ 01-12（避免把 2024.0101 这类日期/版本号当 ID）。
 *  返回 { arxivId, pdfUrl, via } 或 null。via: 'bare'|'inline'（供调用方决定置信度）。 */
function extractArxivIdFromFilename(name) {
  const s = String(name || '').replace(/\.pdf$/i, '').trim();
  if (!s) return null;
  // 1) 整串裸 ID / arxiv.org URL（沿用严格解析）
  const bare = parseArxivUrl(s);
  if (bare) return { arxivId: bare.arxivId, pdfUrl: bare.pdfUrl, via: 'bare' };
  // 2) 新格式 ID 出现在任意位置（MM 约束 01-12 防日期误报），可选 v 后缀
  const m = /(?:^|[^0-9])([0-9]{2}(?:0[1-9]|1[0-2])\.[0-9]{4,5})(?:v\d+)?(?:[^0-9]|$)/.exec(s);
  if (m) {
    const arxivId = m[1];
    return { arxivId, pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`, via: 'inline' };
  }
  // 3) 老格式 分类/NNNNNNN（如 cs.AI/0701001、hep-th/9901001），任意位置
  const old = /(?:^|[^a-zA-Z0-9])([a-z-]+(?:\.[a-z]{2})?\/[0-9]{7})(?:v\d+)?(?:[^0-9]|$)/i.exec(s);
  if (old) {
    const [cat, num] = old[1].split('/');
    const arxivId = cat.toLowerCase() + '/' + num;
    return { arxivId, pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`, via: 'inline' };
  }
  return null;
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
  extractArxivIdFromFilename,
  safeFilename,
  buildPaperFilename,
  proxyFetchJson,
  parseJsonLenient,
  decodeChunked,
};
