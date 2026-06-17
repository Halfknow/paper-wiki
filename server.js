const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadStore, saveStore, mergeTags } = require('./lib/store');
const { createScanner } = require('./lib/scanner');
const parser = require('./lib/parser');
const arxiv = require('./lib/arxiv');
const ai = require('./lib/ai');
const { cleanFilenameToTitle, createRateLimiter, log } = require('./lib/util');
const { createApiRouter } = require('./lib/api');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.woff': 'font/woff',
};

// node_modules 中的浏览器库 → /vendor/* 映射
const VENDOR_MAP = {
  '/vendor/marked.js': ['marked', 'marked.min.js'],
  '/vendor/dompurify.js': ['dompurify', 'dist/purify.min.js'],
  '/vendor/katex.js': ['katex', 'dist/katex.min.js'],
  '/vendor/katex.css': ['katex', 'dist/katex.min.css'],
};

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error('缺少 config.json，请复制 config.example.json 为 config.json 并填写 AI 配置');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function serveStatic(req, res, filePath) {
  let st;
  try { st = await fsp.stat(filePath); }
  catch { res.writeHead(404); return res.end('Not found'); }
  if (st.isDirectory()) return serveStatic(req, res, path.join(filePath, 'index.html'));
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start > end) [start, end] = [end, start];
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const config = loadConfig();
  const storePath = path.join(__dirname, 'data', 'papers.json');
  const store = await loadStore(storePath);
  const papersDir = path.resolve(__dirname, config.papersDir || 'papers');

  const rateLimitArxiv = createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000);
  const deps = {
    parser, arxiv: { ...arxiv, cleanFilenameToTitle }, ai,
    config, rateLimitArxiv,
    saveStore: (s) => saveStore(storePath, s),
    mergeTags,
  };
  const scanner = createScanner({
    store, storePath, papersDir, deps,
    scanIntervalMs: (config.scanIntervalMinutes || 5) * 60 * 1000,
  });
  const router = createApiRouter({ store, save: (s) => saveStore(storePath, s), scanner, config });

  const PUBLIC_DIR = path.join(__dirname, 'public');
  const NM = path.join(__dirname, 'node_modules');

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);

      // PDF 原文（range 支持）
      if (pathname.startsWith('/papers/')) {
        const rel = pathname.slice('/papers/'.length);
        const abs = path.resolve(papersDir, rel);
        if (!abs.startsWith(papersDir)) { res.writeHead(400); return res.end('Bad path'); }
        return serveStatic(req, res, abs);
      }

      // vendor（node_modules 映射 + katex 字体目录）
      if (pathname.startsWith('/vendor/')) {
        if (VENDOR_MAP[pathname]) {
          const [pkg, file] = VENDOR_MAP[pathname];
          return serveStatic(req, res, path.join(NM, pkg, file));
        }
        // katex.css 引用 fonts/...，相对 /vendor/katex.css 解析为 /vendor/fonts/...
        if (pathname.startsWith('/vendor/fonts/')) {
          const rel = pathname.slice('/vendor/fonts/'.length);
          return serveStatic(req, res, path.join(NM, 'katex', 'dist', 'fonts', rel));
        }
        res.writeHead(404); return res.end('Not found');
      }

      // API
      if (pathname.startsWith('/api/')) {
        const body = await readBody(req);
        return router.handle(req, res, body);
      }

      // 静态前端
      let fp = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(400); return res.end('Bad path'); }
      return serveStatic(req, res, fp);
    } catch (e) {
      log('server error', e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  });

  scanner.start();
  server.listen(config.port || 8888, config.host || '0.0.0.0', () => {
    log(`PaperWiki listening on http://${config.host || '0.0.0.0'}:${config.port || 8888}`);
  });

  const shutdown = () => { scanner.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { loadConfig, serveStatic, MIME };
