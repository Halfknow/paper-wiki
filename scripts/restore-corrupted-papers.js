#!/usr/bin/env node
/**
 * 修复「重复内容文件覆盖导致的数据丢失」：从最近的每日备份恢复被空记录覆盖的论文。
 *
 * 背景（v2.4 修复前 bug）：papers/ 若存在两份内容相同但文件名不同的 PDF（如规范名 +
 * 裸 arXiv ID 名副本），sha1 相同 → 同 id → scan 的空初始化覆盖已 enrich 的记录，
 * title/summary/tags 全清空、filepath 指向错误文件。
 *
 * 用法：先停服务（pm2 stop paper-wiki 或 Ctrl+C），再运行
 *   node scripts/restore-corrupted-papers.js
 * 然后重启服务（pm2 restart paper-wiki）。lib/scanner.js 已修复，重启后不再覆盖。
 *
 * 幂等：可多次运行；已正确（filepath 文件存在 + title 非空）的记录不会被改动。
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '..', 'data');
const storePath = path.join(dataDir, 'papers.json');
const backupDir = path.join(dataDir, 'backups');

if (!fs.existsSync(storePath)) {
  console.error('找不到', storePath);
  process.exit(1);
}

// 找所有备份，按日期降序
const backups = fs
  .readdirSync(backupDir)
  .filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .reverse()
  .map((f) => path.join(backupDir, f));

if (!backups.length) {
  console.error('找不到任何备份，无法恢复');
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
// 备份当前文件以防万一
const bak = storePath + '.bak-restore-' + Date.now();
fs.copyFileSync(storePath, bak);

let fixed = 0;
for (const [id, cur] of Object.entries(store.papers)) {
  const fileOk = cur.filepath && fs.existsSync(cur.filepath);
  const enriched = cur.title || (cur.summary && cur.summary.length > 9) || (cur.tags && cur.tags.length);
  // 只有「文件不存在 / 元数据空」的损坏记录才尝试恢复
  if (fileOk && enriched && cur.status !== 'missing') continue;

  // 在备份里找同 id 的「健康」记录（filepath 文件存在 + 有 title）
  let best = null;
  for (const bp of backups) {
    let b;
    try {
      b = JSON.parse(fs.readFileSync(bp, 'utf8'));
    } catch {
      continue;
    }
    const rec = b.papers && b.papers[id];
    if (rec && rec.filepath && fs.existsSync(rec.filepath) && rec.title) {
      best = { rec, file: path.basename(bp) };
      break;
    }
  }
  if (!best) continue;

  // 合并：用备份的元数据/filepath，保留当前用户数据（rating/annotations/notes/...）
  store.papers[id] = {
    ...best.rec,
    rating: cur.rating ?? best.rec.rating ?? 0,
    starred: cur.starred ?? best.rec.starred ?? false,
    annotations: cur.annotations ?? best.rec.annotations ?? null,
    notes: cur.notes ?? best.rec.notes ?? '',
    readProgress: cur.readProgress ?? best.rec.readProgress ?? null,
    readStatus: cur.readStatus ?? best.rec.readStatus ?? 'unread',
    folders: cur.folders ?? best.rec.folders ?? [],
    updatedAt: Date.now(),
    status: 'ready',
    error: null,
  };
  fixed++;
  console.log(`✓ 恢复 ${id} → ${JSON.stringify(best.rec.filename).slice(0, 50)} (来自 ${best.file})`);
}

if (fixed > 0) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  console.log(`\n已修复 ${fixed} 篇记录，写回 papers.json。原文件备份：${path.basename(bak)}`);
} else {
  console.log('\n没有需要修复的损坏记录（所有论文均正常）。');
  fs.unlinkSync(bak);
}
