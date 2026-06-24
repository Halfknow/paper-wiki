#!/usr/bin/env node
/**
 * 从最近的每日备份恢复论文总结（summary/summaryModel/summaryAt）。
 *
 * 背景：重复文件覆盖 bug 曾把 111 篇论文的总结清空成 "## TL;DR" 占位。
 * 标签已通过 API PATCH 恢复（旧服务白名单含 tags），但 summary 不在旧白名单，
 * 无法热恢复 → 必须停服务后跑本脚本恢复文件，再启服务加载。
 *
 * 用法（严格按顺序）：
 *   1. 停服务：taskkill /PID <8888端口PID> /F  （或关掉跑 npm start 的终端）
 *   2. 运行：  node scripts/restore-summaries.js
 *   3. 启服务：npm start  （或 pm2 restart）
 *
 * 幂等：已有正确总结的论文不会被改动。
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
const backups = fs
  .readdirSync(backupDir)
  .filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .reverse()
  .map((f) => path.join(backupDir, f));
if (!backups.length) {
  console.error('找不到任何备份');
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
fs.copyFileSync(storePath, storePath + '.bak-sum-' + Date.now());

let restored = 0;
for (const [id, cp] of Object.entries(store.papers)) {
  if (!cp) continue;
  // 找一个备份里同 id 且有真实总结的记录
  for (const bp of backups) {
    let b;
    try {
      b = JSON.parse(fs.readFileSync(bp, 'utf8'));
    } catch {
      continue;
    }
    const rec = b.papers && b.papers[id];
    if (rec && (rec.summary || '').length > 9) {
      // 已有正确总结且与备份一致则跳过
      if ((cp.summary || '').length > 9 && cp.summary === rec.summary) break;
      cp.summary = rec.summary;
      cp.summaryModel = rec.summaryModel || null;
      cp.summaryAt = rec.summaryAt || null;
      cp.updatedAt = Date.now();
      restored++;
      break;
    }
  }
}

fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
const has = Object.values(store.papers).filter((p) => (p.summary || '').length > 9).length;
console.log(`已恢复 ${restored} 篇论文的总结。当前有总结: ${has} / ${Object.keys(store.papers).length}`);
console.log('\n现在可以启动服务了：npm start');
