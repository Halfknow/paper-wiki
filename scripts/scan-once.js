// 不启动 HTTP，仅扫描一次并把队列里的论文处理完，用于初始化或排错。
// 用法：npm run scan   或   node scripts/scan-once.js
const path = require('path');
const fs = require('fs');
const { loadStore, saveStore, mergeTags, mergeTopics, mergeConcepts } = require('../lib/store');
const { createScanner } = require('../lib/scanner');
const parser = require('../lib/parser');
const arxiv = require('../lib/arxiv');
const ai = require('../lib/ai');
const { cleanFilenameToTitle, createRateLimiter } = require('../lib/util');

(async () => {
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const storePath = path.join(root, 'data', 'papers.json');
  const store = await loadStore(storePath);
  const deps = {
    parser,
    arxiv: { ...arxiv, cleanFilenameToTitle },
    ai, config,
    rateLimitArxiv: createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000),
    saveStore: (s) => saveStore(storePath, s),
    mergeTags, mergeTopics, mergeConcepts,
  };
  const scanner = createScanner({
    store, storePath,
    papersDir: path.resolve(root, config.papersDir || 'papers'),
    deps, scanIntervalMs: 0,
  });
  const r = await scanner.scan();
  console.log('scan result:', r);

  // 等待队列排空（无 pending/parsing/enriching/summarizing），最多 15 分钟
  const BUSY = ['pending', 'parsing', 'enriching', 'summarizing'];
  const deadline = Date.now() + 15 * 60 * 1000;
  const check = () => {
    const busy = Object.values(store.papers).filter((p) => BUSY.includes(p.status));
    if (busy.length === 0 || Date.now() > deadline) {
      const counts = Object.values(store.papers).reduce((acc, p) => {
        acc[p.status] = (acc[p.status] || 0) + 1; return acc;
      }, {});
      console.log('done, status counts:', counts);
      process.exit(0);
    }
    setTimeout(check, 2000);
  };
  setTimeout(check, 2000);
})().catch((e) => { console.error(e); process.exit(1); });
