#!/usr/bin/env node
// 修正「内容已就绪但 status 卡在中间态」的论文：
//   规则：论文已有 summary（非占位）+ summaryAt，但 status 仍为
//         pending/parsing/enriching/summarizing → 翻成 ready。
//
// 背景：processOne 在写完 summary+tags 后、跑到 `status='ready'`（scanner.js:318）
//   之前若进程被中断，store 会留下 status 残留为最后一个 setStatus 的中间态
//   （通常是 pending，因 pending 是 scan() 新增时的初始态）。重启后 diffPapers
//   不把未变文件当 changed，于是这些论文永远停在中间态，前端状态圆点不变绿。
//
// 幂等：只翻转「有实质 summary + 有 summaryAt + status 非终态」的论文；
//   已 ready/error/missing 的不动；空 summary 的不动（那才是真没处理好）。
//
// 用法（容器内，DATABASE_URL 已指向 postgres 服务）：
//   node scripts/fix-stale-status.js            # dry-run，只打印待改清单
//   node scripts/fix-stale-status.js --apply     # 真正写入

const { createDb, createRepository } = require('../src/db/index.js');

// 占位总结判定：buildSummaryMarkdown(null) 产出的占位很短且无实质内容。
// 真实总结至少含 "## TL;DR" 后跟内容。阈值 30 字符区分占位与真实总结。
const MIN_SUMMARY_LEN = 30;
const STALE_STATUSES = ['pending', 'parsing', 'enriching', 'summarizing'];

async function fixStaleStatus(repo, { apply = false } = {}) {
  const registry = await repo.loadRegistry();
  const spaces = registry.spaces || [];
  const report = [];
  let totalFixed = 0;

  for (const space of spaces) {
    const sid = space.id;
    let store;
    try {
      store = await repo.loadSpaceStore(sid);
    } catch (e) {
      report.push({ spaceId: sid, skipped: `load failed: ${e.message}` });
      continue;
    }
    const stale = [];
    for (const p of Object.values(store.papers || {})) {
      if (!p) continue;
      if (!STALE_STATUSES.includes(p.status)) continue;
      const summary = String(p.summary || '').trim();
      if (summary.length < MIN_SUMMARY_LEN) continue; // 空/占位总结 = 真没处理好，不翻
      if (!p.summaryAt) continue; // 没 summaryAt = 总结步骤未成功，不翻
      stale.push({
        id: p.id,
        title: (p.title || p.filename || '').slice(0, 60),
        status: p.status,
        summaryLen: summary.length,
        summaryAt: p.summaryAt,
      });
      p.status = 'ready';
      p.error = null;
      p.updatedAt = Date.now();
    }
    if (!stale.length) {
      report.push({ spaceId: sid, name: space.name, fixed: 0 });
      continue;
    }
    if (apply) {
      await repo.saveSpaceStore(sid, store); // hash-diff 事务保存
    }
    totalFixed += stale.length;
    report.push({ spaceId: sid, name: space.name, fixed: stale.length, papers: stale, applied: apply });
  }
  return { report, totalFixed };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = createDb({ connectionString: process.env.DATABASE_URL });
  await db.migrate();
  const repo = createRepository(db);

  console.log(apply ? '=== APPLY 模式：将写入数据库 ===' : '=== DRY-RUN 模式（加 --apply 真正写入）===');
  const { report, totalFixed } = await fixStaleStatus(repo, { apply });

  for (const r of report) {
    if (r.skipped) {
      console.log(`\n[${r.spaceId}] 跳过：${r.skipped}`);
      continue;
    }
    if (!r.fixed) {
      console.log(`\n[${r.spaceId}] ${r.name || ''} — 无需修正`);
      continue;
    }
    console.log(`\n[${r.spaceId}] ${r.name || ''} — 待修正 ${r.fixed} 篇${r.applied ? '（已写入）' : ''}:`);
    for (const p of r.papers) {
      console.log(`   ${p.id.slice(0, 12)}  ${p.status.padEnd(12)} → ready   summary=${p.summaryLen}字  《${p.title}》`);
    }
  }
  console.log(`\n合计 ${apply ? '修正' : '待修正'} ${totalFixed} 篇。`);
  if (!apply && totalFixed > 0) {
    console.log('\n确认无误后，运行：node scripts/fix-stale-status.js --apply');
  }
  process.exit(0);
}

module.exports = { fixStaleStatus, MIN_SUMMARY_LEN, STALE_STATUSES };

if (require.main === module) {
  main().catch((e) => {
    console.error('失败：', e);
    process.exit(1);
  });
}
