// 不启动 HTTP，仅扫描一次并把队列里的论文处理完，用于初始化或排错。
// 多空间版：默认扫所有空间；--space <id> 只扫指定空间。
// 用法：npm run scan   或   node scripts/scan-once.js [--space <id>]
const path = require('path');
const fs = require('fs');
const { mergeTags, mergeTopics, mergeConcepts } = require('../lib/store');
const { createMultiSpaceScanner } = require('../lib/scanner');
const { createSpaceManager } = require('../lib/spaces');
const parser = require('../lib/parser');
const arxiv = require('../lib/arxiv');
const ai = require('../lib/ai');
const { cleanFilenameToTitle, createRateLimiter, log } = require('../lib/util');

(async () => {
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const dataDir = path.join(root, 'data');

  // 解析 --space 参数
  const spaceArg = process.argv.includes('--space') ? process.argv[process.argv.indexOf('--space') + 1] : null;

  const manager = createSpaceManager(dataDir, root, config);
  await manager.ensureRegistry();

  const deps = {
    parser,
    arxiv: { ...arxiv, cleanFilenameToTitle },
    ai,
    config,
    rateLimitArxiv: createRateLimiter((config.arxiv && config.arxiv.minIntervalMs) || 3000),
    mergeTags,
    mergeTopics,
    mergeConcepts,
  };
  const scanner = createMultiSpaceScanner({ manager, deps });

  if (spaceArg) {
    const r = await scanner.scanSpace(spaceArg);
    log('scan result (' + spaceArg + '):', r);
  } else {
    const results = await scanner.scan({ dueOnly: false });
    log('scan result (all spaces):', results);
  }

  // 等待共享队列排空（无 pending/parsing/enriching/summarizing），最多 15 分钟
  const BUSY = ['pending', 'parsing', 'enriching', 'summarizing'];
  const deadline = Date.now() + 15 * 60 * 1000;
  const check = async () => {
    // 汇总所有空间的 busy 数
    let totalBusy = 0;
    const counts = {};
    for (const sp of manager.listSpaces()) {
      const store = await manager.getSpaceStore(sp.id);
      for (const p of Object.values(store.papers)) {
        if (BUSY.includes(p.status)) totalBusy++;
        counts[p.status] = (counts[p.status] || 0) + 1;
      }
    }
    if (totalBusy === 0 || Date.now() > deadline) {
      log('done, status counts (all spaces):', counts);
      process.exit(0);
    }
    setTimeout(check, 2000);
  };
  setTimeout(check, 2000);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
