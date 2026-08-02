// 一次性迁移：旧 JSON 数据（data/spaces.json + data/spaces/<id>/{papers.json, text/*.txt}，
// 或更老的扁平 data/papers.json + data/text）→ PostgreSQL。幂等可重跑（upsert 语义）。
//
// papersDir 映射规则（v3：所有空间目录必须在 PAPERS_ROOT 挂载根内）：
//   每个空间映射为根内子目录 <spaceId>（default → default）。脚本结束时打印「把旧目录的 PDF
//   移入 <PAPERS_ROOT>/<spaceId>/」的指引；文件按原文件名放入后，filepath 由运行时派生自动对齐，
//   即使改了名，下次扫描也会按 sha1 对账自愈。
//
// 用法（宿主直连 PG）：  DATABASE_URL=postgres://... node scripts/migrate-json-to-pg.js [legacyDataDir=./data]
// 用法（容器内）：       docker compose run --rm -v ./data:/legacy-data app node scripts/migrate-json-to-pg.js /legacy-data
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadStore } = require('../src/core/store');

/**
 * 执行迁移（核心逻辑，供 CLI 与测试复用）。
 * @param {string} legacyDataDir 旧 data 目录（含 spaces.json 或扁平 papers.json）
 * @param {object} repo lib/db.js createRepository 返回值（调用方负责 db.migrate()）
 * @param {object} opts { papersRoot } 仅用于打印迁移指引
 * @returns {Promise<{spaces: Array<{id, papers, texts}>, instructions: Array<string>}>}
 */
async function migrateJsonToPg(legacyDataDir, repo, opts = {}) {
  const results = [];
  const instructions = [];
  const spacesJson = path.join(legacyDataDir, 'spaces.json');
  let legacySpaces = [];
  let activeSpaceId = 'default';

  if (fs.existsSync(spacesJson)) {
    const reg = JSON.parse(await fsp.readFile(spacesJson, 'utf8'));
    legacySpaces = (reg.spaces || []).map((s) => ({
      id: String(s.id),
      name: String(s.name || s.id),
      legacyPapersDir: String(s.papersDir || 'papers'),
      scanIntervalMinutes: Number(s.scanIntervalMinutes) || 5,
      lastScanAt: Number(s.lastScanAt) || 0,
      createdAt: Number(s.createdAt) || Date.now(),
      storePath: path.join(legacyDataDir, 'spaces', String(s.id), 'papers.json'),
      textDir: path.join(legacyDataDir, 'spaces', String(s.id), 'text'),
    }));
    activeSpaceId = String(reg.activeSpaceId || 'default');
  } else if (fs.existsSync(path.join(legacyDataDir, 'papers.json'))) {
    // 更老的扁平结构（v2.5 之前）：单库 → default 空间
    legacySpaces = [
      {
        id: 'default',
        name: '默认',
        legacyPapersDir: 'papers',
        scanIntervalMinutes: 5,
        lastScanAt: 0,
        createdAt: Date.now(),
        storePath: path.join(legacyDataDir, 'papers.json'),
        textDir: path.join(legacyDataDir, 'text'),
      },
    ];
  } else {
    throw new Error(`旧数据不存在：${legacyDataDir} 下既无 spaces.json 也无 papers.json`);
  }

  for (const sp of legacySpaces) {
    // v3 目录映射：根内子目录 = 空间 id
    const newDir = sp.id;
    await repo.upsertSpaceMeta({
      id: sp.id,
      name: sp.name,
      papersDir: newDir,
      scanIntervalMinutes: sp.scanIntervalMinutes,
      lastScanAt: sp.lastScanAt,
      createdAt: sp.createdAt,
    });

    // store：文件版 loadStore（自带 v1→v2 迁移/损坏自愈）→ filename 收敛为 basename → saveSpaceStore
    let paperCount = 0;
    if (fs.existsSync(sp.storePath)) {
      const store = await loadStore(sp.storePath);
      for (const p of Object.values(store.papers || {})) {
        // basename 兼容 Windows 路径分隔符：迁移脚本跑在 Linux 容器里，path.basename 不认
        // 旧数据（Windows 时代）的 D:\... 反斜杠绝对路径 → 先把 \ 归一成 / 再取 basename。
        p.filename = p.filename || (p.filepath ? path.basename(String(p.filepath).replace(/\\/g, '/')) : null);
        delete p.filepath; // 绝对路径丢弃：v3 由 papersDir+filename 运行时派生
        p.fulltextPath = null;
      }
      await repo.saveSpaceStore(sp.id, store);
      paperCount = Object.keys(store.papers || {}).length;
    }

    // 全文：data/.../text/<paperId>.txt → paper_texts
    let textCount = 0;
    if (fs.existsSync(sp.textDir)) {
      for (const f of await fsp.readdir(sp.textDir)) {
        if (!/\.txt$/.test(f)) continue;
        const pid = f.replace(/\.txt$/, '');
        try {
          await repo.savePaperText(sp.id, pid, await fsp.readFile(path.join(sp.textDir, f), 'utf8'));
          textCount++;
        } catch (e) {
          console.error(`[migrate] 全文导入失败 ${sp.id}/${pid}:`, e.message);
        }
      }
    }

    const rootHint = opts.papersRoot || '<PAPERS_ROOT>';
    instructions.push(
      `空间「${sp.name}」(${sp.id})：把旧目录 ${sp.legacyPapersDir} 的 PDF 移入 ${path.join(String(rootHint), newDir)}/`,
    );
    results.push({ id: sp.id, papers: paperCount, texts: textCount });
  }

  if (legacySpaces.find((s) => s.id === activeSpaceId)) {
    await repo.setActiveSpaceId(activeSpaceId);
  }
  return { spaces: results, instructions };
}

async function main() {
  const legacyDataDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data'));
  const { createDb, createRepository } = require('../src/db');
  const db = createDb({ connectionString: process.env.DATABASE_URL });
  await db.migrate();
  const repo = createRepository(db);
  const papersRoot = process.env.PAPERS_ROOT || path.join(__dirname, '..', 'papers');
  const r = await migrateJsonToPg(legacyDataDir, repo, { papersRoot });
  console.log('迁移完成：');
  for (const s of r.spaces) console.log(`  空间 ${s.id}: ${s.papers} 篇论文, ${s.texts} 篇全文`);
  console.log('\n下一步（物理文件就位，文件名不变即自动对齐；改名也会被 sha1 对账自愈）：');
  for (const i of r.instructions) console.log('  - ' + i);
  await db.close();
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { migrateJsonToPg };
