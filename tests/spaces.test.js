const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { newDb } = require('pg-mem');
const { createDb, createRepository } = require('../src/db');
const { createSpaceManager, resolvePapersDir, DEFAULT_SPACE_ID } = require('../src/services/spaces');

/** pg-mem repo + 临时 papersRoot 的 manager（每个 test 独立） */
async function makeManager(globalConfig) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = createDb({ createPool: () => new Pool() });
  await db.migrate();
  const repo = createRepository(db);
  const papersRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsp-'));
  const manager = createSpaceManager({
    repo,
    papersRoot,
    globalConfig: globalConfig || { scanIntervalMinutes: 5 },
  });
  return {
    manager,
    repo,
    db,
    papersRoot,
    cleanup: async () => {
      await db.close().catch(() => {});
      fs.rmSync(papersRoot, { recursive: true, force: true });
    },
  };
}

test('ensureRegistry 首次建 default 空间并落库', async () => {
  const { manager, repo, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const reg = await repo.loadRegistry();
    assert.strictEqual(reg.activeSpaceId, DEFAULT_SPACE_ID);
    assert.ok(reg.spaces.find((s) => s.id === DEFAULT_SPACE_ID && s.name === '默认'));
    assert.strictEqual(reg.spaces[0].scanIntervalMinutes, 5);
    assert.strictEqual(reg.spaces[0].papersDir, 'default');
  } finally {
    await cleanup();
  }
});

test('listSpaces/getSpace/getActiveSpace 基本读取', async () => {
  const { manager, cleanup } = await makeManager({ scanIntervalMinutes: 10 });
  try {
    await manager.ensureRegistry();
    assert.strictEqual(manager.getActiveSpaceId(), DEFAULT_SPACE_ID);
    assert.ok(manager.getActiveSpace());
    assert.ok(manager.getSpace(DEFAULT_SPACE_ID));
    assert.strictEqual(manager.listSpaces().length, 1);
  } finally {
    await cleanup();
  }
});

test('createSpace 建新空间（默认根内子目录 <id>）并可取空 store', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'AI', papersDir: 'papers-ai' });
    assert.strictEqual(sp.name, 'AI');
    assert.ok(sp.id && sp.id !== DEFAULT_SPACE_ID);
    assert.ok(fs.existsSync(path.join(papersRoot, 'papers-ai')));
    const store = await manager.getSpaceStore(sp.id);
    assert.deepStrictEqual(store.papers, {});
    const sp2 = await manager.createSpace({ name: '无目录' });
    assert.strictEqual(sp2.papersDir, '无目录'); // 默认用空间名做子目录（名↔文件夹联动）
    assert.ok(fs.existsSync(path.join(papersRoot, '无目录')));
  } finally {
    await cleanup();
  }
});

test('createSpace 拒绝越界目录与嵌套冲突', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    await assert.rejects(() => manager.createSpace({ name: 'X', papersDir: '../evil' }), /挂载根内/);
    // 与 default 的子目录嵌套 → 冲突
    await assert.rejects(() => manager.createSpace({ name: 'Y', papersDir: 'default/sub' }), /嵌套/);
  } finally {
    await cleanup();
  }
});

test('renameSpace 改名并持久化 + 文件夹同步改名（名↔文件夹联动）', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    // default 初始目录 'default'，放一个文件验证物理迁移
    const oldDir = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    fs.writeFileSync(path.join(oldDir, 'keep.pdf'), 'x');
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers.p1 = { id: 'p1', filename: 'keep.pdf', status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, store);

    const sp = await manager.renameSpace(DEFAULT_SPACE_ID, '我的库');
    assert.strictEqual(sp.name, '我的库');
    assert.strictEqual(sp.papersDir, '我的库', '文件夹名应同步为空间名');
    assert.ok(fs.existsSync(path.join(papersRoot, '我的库', 'keep.pdf')), '文件应随目录改名');
    assert.ok(!fs.existsSync(path.join(papersRoot, 'default')), '旧目录不再存在');
    // 内存 store 的派生 filepath 已刷新
    const cur = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    assert.strictEqual(cur.papers.p1.filepath, path.join(papersRoot, '我的库', 'keep.pdf'));
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getSpace(DEFAULT_SPACE_ID).name, '我的库');
    assert.strictEqual(manager.getSpace(DEFAULT_SPACE_ID).papersDir, '我的库');
  } finally {
    await cleanup();
  }
});

test('renameSpace 名称含非法字符 → 目录名净化；净化后为空 → 回退空间 id', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: '正常' });
    await manager.renameSpace(sp.id, 'A/B:C*D?');
    assert.strictEqual(manager.getSpace(sp.id).papersDir, 'A B C D', '非法字符净化为空格并折叠');
    assert.ok(fs.existsSync(path.join(papersRoot, 'A B C D')));
    await manager.renameSpace(sp.id, '///***');
    assert.strictEqual(manager.getSpace(sp.id).papersDir, sp.id, '净化后为空 → 回退 id');
  } finally {
    await cleanup();
  }
});

test('renameSpace 仅大小写差异改名（llm → LLM）在大小写不敏感文件系统上放行', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'llm' });
    fs.writeFileSync(path.join(papersRoot, 'llm', 'x.pdf'), 'x');
    const r = await manager.renameSpace(sp.id, 'LLM');
    assert.strictEqual(r.papersDir, 'LLM');
    assert.ok(fs.existsSync(path.join(papersRoot, 'LLM', 'x.pdf')));
    const names = fs.readdirSync(papersRoot);
    assert.ok(names.includes('LLM') && !names.includes('llm'), '目录实际大小写应已更新');
  } finally {
    await cleanup();
  }
});

test('renameSpace 目标目录冲突 → 拒绝且名称不变', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const a = await manager.createSpace({ name: 'AAA' });
    await manager.createSpace({ name: 'BBB' });
    await assert.rejects(() => manager.renameSpace(a.id, 'BBB'), /相同或互相嵌套|已存在/);
    assert.strictEqual(manager.getSpace(a.id).name, 'AAA', '失败时名称保持不变');
    assert.strictEqual(manager.getSpace(a.id).papersDir, 'AAA');
  } finally {
    await cleanup();
  }
});

test('createSpace 同名空间 → 目录冲突拒绝（名↔文件夹联动的自然约束）', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    await manager.createSpace({ name: '重名' });
    await assert.rejects(() => manager.createSpace({ name: '重名' }), /相同或互相嵌套/);
  } finally {
    await cleanup();
  }
});

test('deleteSpace 删库数据但保留物理 PDF 文件夹', async () => {
  const { manager, repo, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: '临时', papersDir: 'papers-tmp' });
    const pdfPath = path.join(papersRoot, 'papers-tmp', 'keep.pdf');
    fs.writeFileSync(pdfPath, 'pdf-content');
    const store = await manager.getSpaceStore(sp.id);
    store.papers.p1 = { id: 'p1', filename: 'keep.pdf', status: 'ready' };
    await manager.saveSpaceStore(sp.id, store);
    await repo.savePaperText(sp.id, 'p1', 'text');
    const r = await manager.deleteSpace(sp.id);
    assert.ok(fs.existsSync(pdfPath), '物理 PDF 文件应保留');
    assert.strictEqual(r.papersDirKept, 'papers-tmp');
    assert.ok(!manager.getSpace(sp.id));
    assert.strictEqual(await repo.getPaperText(sp.id, 'p1'), null); // 库数据已级联删
  } finally {
    await cleanup();
  }
});

test('deleteSpace 拒绝删除 default；删 active 自动切回 default', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    await assert.rejects(() => manager.deleteSpace(DEFAULT_SPACE_ID), /默认空间/);
    const sp = await manager.createSpace({ name: '激活测试' });
    await manager.setActiveSpace(sp.id);
    assert.strictEqual(manager.getActiveSpaceId(), sp.id);
    await manager.deleteSpace(sp.id);
    assert.strictEqual(manager.getActiveSpaceId(), DEFAULT_SPACE_ID);
  } finally {
    await cleanup();
  }
});

test('setActiveSpace 切换并持久化；拒绝不存在的空间', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    await manager.setActiveSpace(sp.id);
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getActiveSpaceId(), sp.id);
    await assert.rejects(() => manager.setActiveSpace('nope'), /空间不存在/);
  } finally {
    await cleanup();
  }
});

test('resolveSpacePapersDir 解析为根内绝对路径', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const abs = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    assert.ok(path.isAbsolute(abs));
    assert.strictEqual(abs, path.resolve(papersRoot, 'default')); // default 绑 'default' 子目录
  } finally {
    await cleanup();
  }
});

test('getSpaceStore 派生 filepath（papersDir+filename），save 后不落库', async () => {
  const { manager, repo, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers.p1 = { id: 'p1', filename: 'a.pdf', title: 'A', status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, store);
    await manager._reloadFromDisk();
    const reload = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    assert.strictEqual(reload.papers.p1.filepath, path.join(papersRoot, 'default', 'a.pdf')); // 运行时派生
    const raw = await repo.loadSpaceStore(DEFAULT_SPACE_ID);
    assert.strictEqual(raw.papers.p1.filepath, undefined); // 库里没有 filepath
  } finally {
    await cleanup();
  }
});

test('getSpaceStore/saveSpaceStore 隔离：两空间同 id paper 互不影响', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    const storeA = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    const storeB = await manager.getSpaceStore(sp.id);
    storeA.papers.paper1 = { id: 'paper1', title: 'A空间', tags: ['x'], status: 'ready' };
    storeB.papers.paper1 = { id: 'paper1', title: 'B空间', tags: ['y'], status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, storeA);
    await manager.saveSpaceStore(sp.id, storeB);
    await manager._reloadFromDisk();
    const reloadA = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    const reloadB = await manager.getSpaceStore(sp.id);
    assert.strictEqual(reloadA.papers.paper1.title, 'A空间');
    assert.strictEqual(reloadB.papers.paper1.title, 'B空间');
    assert.deepStrictEqual(reloadA.papers.paper1.tags, ['x']);
    assert.deepStrictEqual(reloadB.papers.paper1.tags, ['y']);
  } finally {
    await cleanup();
  }
});

test('saveStoreBinder 返回单参闭包（遵守陷阱1）', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers.p1 = { id: 'p1', status: 'ready' };
    const save = manager.saveStoreBinder(DEFAULT_SPACE_ID);
    assert.strictEqual(typeof save, 'function');
    assert.strictEqual(save.length, 1); // 单参
    await save(store);
    await manager._reloadFromDisk();
    assert.ok((await manager.getSpaceStore(DEFAULT_SPACE_ID)).papers.p1);
  } finally {
    await cleanup();
  }
});

test('textStoreBinder 提供 load/save/remove（PG paper_texts）', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const ts = manager.textStoreBinder(DEFAULT_SPACE_ID);
    assert.strictEqual(await ts.load('p1'), null);
    await ts.save('p1', '全文');
    assert.strictEqual(await ts.load('p1'), '全文');
    await ts.remove('p1');
    assert.strictEqual(await ts.load('p1'), null);
  } finally {
    await cleanup();
  }
});

test('setScanInterval 持久化 + minScheduledIntervalMs 取最小；0=关闭', async () => {
  const { manager, cleanup } = await makeManager({ scanIntervalMinutes: 5 });
  try {
    await manager.ensureRegistry();
    await manager.setScanInterval(DEFAULT_SPACE_ID, 10);
    const sp = await manager.createSpace({ name: 'B' });
    await manager.setScanInterval(sp.id, 2);
    assert.strictEqual(manager.minScheduledIntervalMs(), 2 * 60 * 1000);
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getSpace(sp.id).scanIntervalMinutes, 2);
    await manager.setScanInterval(DEFAULT_SPACE_ID, 0);
    await manager.setScanInterval(sp.id, 0);
    assert.strictEqual(manager.minScheduledIntervalMs(), 0);
    assert.strictEqual(manager.scheduledSpaces().length, 0);
  } finally {
    await cleanup();
  }
});

test('resolvePapersDir 根内解析 + 越界拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwrp-'));
  try {
    const abs = resolvePapersDir(root, 'sub/dir');
    assert.strictEqual(abs, path.resolve(root, 'sub/dir'));
    assert.ok(fs.existsSync(abs), '应自动 mkdir');
    assert.strictEqual(resolvePapersDir(root, '.'), path.resolve(root));
    assert.throws(() => resolvePapersDir(root, '../out'), /挂载根内/);
    assert.throws(() => resolvePapersDir(root, path.join(os.tmpdir(), 'elsewhere')), /挂载根内/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spacesView 返回 activeSpaceId + 精简列表（含 paperCount）', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    const view = await manager.spacesView();
    assert.strictEqual(view.activeSpaceId, DEFAULT_SPACE_ID);
    assert.strictEqual(view.spaces.length, 2);
    assert.ok(view.spaces.find((s) => s.id === sp.id && s.name === 'B'));
    for (const s of view.spaces) {
      assert.strictEqual(typeof s.paperCount, 'number');
      assert.ok(s.paperCount >= 0);
    }
  } finally {
    await cleanup();
  }
});

// ---- papersDir 改绑：预检 → move/rebind（v3 绑定语义重设计）----

const { sha1OfFile } = require('../src/core/util');

/** 在目录写一个内容确定的假 PDF，返回其 paper id（sha1 前 16） */
async function writePdf(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content);
  return (await sha1OfFile(fp)).slice(0, 16);
}

test('previewPapersDirChange：sha1 对账报告（匹配/将缺失/新文件）', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const oldDir = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    // 库内两篇：p1 会出现在新目录（同内容），p2 不会
    const id1 = await writePdf(oldDir, 'a.pdf', '%PDF-1.4 AAA');
    const id2 = await writePdf(oldDir, 'b.pdf', '%PDF-1.4 BBB');
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers[id1] = { id: id1, filename: 'a.pdf', title: 'A', status: 'ready' };
    store.papers[id2] = { id: id2, filename: 'b.pdf', title: 'B', status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, store);
    // 新目录：a 的同内容副本（可改名）+ 一个全新文件
    await writePdf(path.join(papersRoot, 'newdir'), 'renamed-a.pdf', '%PDF-1.4 AAA');
    await writePdf(path.join(papersRoot, 'newdir'), 'fresh.pdf', '%PDF-1.4 FRESH');
    const r = await manager.previewPapersDirChange(DEFAULT_SPACE_ID, 'newdir');
    assert.strictEqual(r.pdfCount, 2);
    assert.strictEqual(r.matched, 1);
    assert.strictEqual(r.willMissing, 1);
    assert.strictEqual(r.newFiles, 1);
    assert.strictEqual(r.missingList[0].id, id2);
    // 预检不产生任何修改
    assert.strictEqual(manager.getSpace(DEFAULT_SPACE_ID).papersDir, 'default');
  } finally {
    await cleanup();
  }
});

test('applyPapersDirChange(move)：物理搬移 + filename/filepath 同步 + 撞名加 id 后缀', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const oldDir = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    const id1 = await writePdf(oldDir, 'a.pdf', '%PDF-1.4 AAA');
    const id2 = await writePdf(oldDir, 'b.pdf', '%PDF-1.4 BBB');
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers[id1] = { id: id1, filename: 'a.pdf', title: 'A', status: 'ready' };
    store.papers[id2] = { id: id2, filename: 'b.pdf', title: 'B', status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, store);
    await manager._reloadFromDisk(); // 让 filepath 派生生效
    // 新目录预置一个同名不同内容的 b.pdf（制造撞名）
    await writePdf(path.join(papersRoot, 'moved'), 'b.pdf', '%PDF-1.4 OTHER');
    const r = await manager.applyPapersDirChange(DEFAULT_SPACE_ID, 'moved', 'move');
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.papersDir, 'moved');
    const newDir = path.join(papersRoot, 'moved');
    const reload = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    // a 直接搬过去
    assert.ok(fs.existsSync(path.join(newDir, 'a.pdf')), 'a.pdf 应已物理搬移');
    assert.ok(!fs.existsSync(path.join(oldDir, 'a.pdf')), '旧目录不应残留');
    assert.strictEqual(reload.papers[id1].filepath, path.join(newDir, 'a.pdf'));
    // b 撞名 → 加 (id) 后缀
    const bName = 'b (' + id2 + ').pdf';
    assert.strictEqual(reload.papers[id2].filename, bName, '撞名应加 id 后缀');
    assert.ok(fs.existsSync(path.join(newDir, bName)));
    assert.strictEqual(reload.papers[id2].status, 'ready');
  } finally {
    await cleanup();
  }
});

test('applyPapersDirChange(rebind)：按 sha1 对账，匹配复活/无匹配标 missing', async () => {
  const { manager, papersRoot, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const oldDir = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    const id1 = await writePdf(oldDir, 'a.pdf', '%PDF-1.4 AAA');
    const id2 = await writePdf(oldDir, 'b.pdf', '%PDF-1.4 BBB');
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers[id1] = { id: id1, filename: 'a.pdf', title: 'A', status: 'missing' }; // 曾标缺失
    store.papers[id2] = { id: id2, filename: 'b.pdf', title: 'B', status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, store);
    // 用户自己把 a 挪去了新目录（改了名），b 没挪
    await writePdf(path.join(papersRoot, 'rebound'), 'a-moved.pdf', '%PDF-1.4 AAA');
    const r = await manager.applyPapersDirChange(DEFAULT_SPACE_ID, 'rebound', 'rebind');
    assert.strictEqual(r.papersDir, 'rebound');
    assert.strictEqual(r.missing, 1);
    const reload = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    assert.strictEqual(reload.papers[id1].filename, 'a-moved.pdf', '匹配上的更新 filename');
    assert.strictEqual(reload.papers[id1].status, 'ready', 'missing 被复活');
    assert.strictEqual(reload.papers[id1].filepath, path.join(papersRoot, 'rebound', 'a-moved.pdf'));
    assert.strictEqual(reload.papers[id2].status, 'missing', '无匹配标 missing');
  } finally {
    await cleanup();
  }
});

test('applyPapersDirChange 校验：越界 / 与其他空间冲突 / 非法 mode', async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B', papersDir: 'space-b' });
    await assert.rejects(() => manager.applyPapersDirChange(DEFAULT_SPACE_ID, '../out', 'move'), /挂载根内/);
    await assert.rejects(() => manager.applyPapersDirChange(DEFAULT_SPACE_ID, 'space-b', 'move'), /相同或互相嵌套/);
    await assert.rejects(() => manager.applyPapersDirChange(DEFAULT_SPACE_ID, 'space-b/sub', 'move'), /嵌套/);
    await assert.rejects(() => manager.applyPapersDirChange(DEFAULT_SPACE_ID, 'ok-dir', 'wat'), /mode/);
    assert.ok(sp);
  } finally {
    await cleanup();
  }
});
