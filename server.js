const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { mergeTags, mergeTopics, mergeConcepts } = require('./lib/store');
const { createMultiSpaceScanner } = require('./lib/scanner');
const { createSpaceManager } = require('./lib/spaces');
const parser = require('./lib/parser');
const arxiv = require('./lib/arxiv');
const ai = require('./lib/ai');
const { cleanFilenameToTitle, createRateLimiter, log } = require('./lib/util');
const { createApiRouter } = require('./lib/api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
};

// node_modules 中的浏览器库 → /vendor/* 映射
const VENDOR_MAP = {
  '/vendor/marked.js': ['marked', 'marked.min.js'],
  '/vendor/dompurify.js': ['dompurify', 'dist/purify.min.js'],
  '/vendor/katex.js': ['katex', 'dist/katex.min.js'],
  '/vendor/katex.css': ['katex', 'dist/katex.min.css'],
  // pdf.js 主库 + worker（浏览器侧用 ES module）
  '/vendor/pdfjs.js': ['pdfjs-dist', 'build/pdf.min.mjs'],
  '/vendor/pdfjs.worker.js': ['pdfjs-dist', 'build/pdf.worker.min.mjs'],
  // pdf.js viewer 组件（PDFViewer/PDFPageView/AnnotationEditorLayer 等）+ 配套样式
  '/vendor/pdfjs-viewer.js': ['pdfjs-dist', 'web/pdf_viewer.mjs'],
  '/vendor/pdfjs-viewer.css': ['pdfjs-dist', 'web/pdf_viewer.css'],
};

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error('缺少 config.json，请复制 config.example.json 为 config.json 并填写 AI 配置');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function serveStatic(req, res, filePath, extraHeaders) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    res.writeHead(404);
    return res.end('Not found');
  }
  if (st.isDirectory()) return serveStatic(req, res, path.join(filePath, 'index.html'), extraHeaders);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start > end) [start, end] = [end, start];
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
      ...extraHeaders,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type, ...extraHeaders });
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
  const projectRoot = __dirname;
  const dataDir = path.join(projectRoot, 'data');

  // 空间管理器：首次启动自动把旧 data/papers.json 迁入 default 空间（幂等）
  const manager = createSpaceManager(dataDir, projectRoot, config);
  await manager.ensureRegistry();

  const rateLimitArxiv = createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000);
  const deps = {
    parser,
    arxiv: { ...arxiv, cleanFilenameToTitle },
    ai,
    config, // 全局 config（作为各空间 applySettingsOverride 的基底 + 新空间默认模板）
    rateLimitArxiv,
    mergeTags,
    mergeTopics,
    mergeConcepts,
  };
  const scanner = createMultiSpaceScanner({ manager, deps });
  const router = createApiRouter({ manager, scanner, globalConfig: config });

  const PUBLIC_DIR = path.join(__dirname, 'public');
  const NM = path.join(__dirname, 'node_modules');

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);
      const q = parsed.searchParams;

      // PDF 原文（range 支持）。多空间：?space=<id> 指定空间，无参回 active 空间。
      if (pathname.startsWith('/papers/')) {
        const rel = pathname.slice('/papers/'.length);
        const spaceId = q.get('space') || manager.getActiveSpaceId();
        const papersDir = manager.resolveSpacePapersDir(spaceId);
        const abs = path.resolve(papersDir, rel);
        // 路径穿越守卫：必须在解析后的 papersDir 内
        if (!abs.startsWith(papersDir + path.sep) && abs !== papersDir) {
          res.writeHead(400);
          return res.end('Bad path');
        }
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
        // pdf.js viewer（pdf_viewer.css 里 url(images/...) 相对解析为 /vendor/images/...）
        if (pathname.startsWith('/vendor/images/')) {
          const rel = pathname.slice('/vendor/images/'.length);
          return serveStatic(req, res, path.join(NM, 'pdfjs-dist', 'web', 'images', rel));
        }
        res.writeHead(404);
        return res.end('Not found');
      }

      // API
      if (pathname.startsWith('/api/')) {
        const body = await readBody(req);
        return router.handle(req, res, body);
      }

      // 静态前端：前端源码（html/js/css）禁缓存，避免浏览器用旧 JS 导致改动不生效（本地开发工具，资源极小）
      const fp = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      if (!fp.startsWith(PUBLIC_DIR)) {
        res.writeHead(400);
        return res.end('Bad path');
      }
      return serveStatic(req, res, fp, { 'Cache-Control': 'no-cache, must-revalidate' });
    } catch (e) {
      log('server error', e.message);
      if (!res.headersSent) {
        const isProd = process.env.NODE_ENV === 'production';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        // 生产模式不回传内部错误细节（可能含路径/栈信息），只回通用错误
        res.end(JSON.stringify({ ok: false, error: isProd ? 'Internal Server Error' : e.message }));
      }
    }
  });

  scanner.start();
  // 每日定时备份（每 6 小时检查一次，遍历所有空间各自 backup，backupStore 内部按天去重）
  const backupTimer = setInterval(() => manager.backupAllSpaces().catch(() => {}), 6 * 60 * 60 * 1000);
  backupTimer.unref();
  manager.backupAllSpaces().catch(() => {}); // 启动即备一次
  const port = process.env.PORT || config.port || 8888;
  const host = process.env.HOST || config.host || '127.0.0.1';
  server.listen(port, host, () => {
    log(`PaperWiki listening on http://${host}:${port}`);
  });

  // 优雅关停：停定时器 → 等当前论文处理完落盘（drain，最多 5s）→ 关 HTTP → 兜底强制退出。
  // pm2 的 kill_timeout（见 ecosystem.config.cjs）必须 > drain+server.close 的耗时，否则会被 SIGKILL。
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    scanner.stop();
    try {
      await scanner.drain(5000);
      log('shutdown: drained in-flight pipeline');
    } catch (e) {
      log('shutdown drain error', e && e.message);
    }
    server.close(() => process.exit(0));
    // 兜底：即便 server.close 因 keep-alive 连接卡住，也确保最终退出
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { loadConfig, serveStatic, MIME };
