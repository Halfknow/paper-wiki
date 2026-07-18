const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSpaceManager, migrateLegacyIfNeeded, resolvePapersDir, DEFAULT_SPACE_ID } = require('../lib/spaces');

/** 建一个临时 dataDir + projectRoot 的 manager（每个 test 独立目录） */
function makeManager(globalConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsp-'));
  const dataDir = path.join(root, 'data');
  const manager = createSpaceManager(dataDir, root, globalConfig || { scanIntervalMinutes: 5, papersDir: 'papers' });
  return { manager, root, dataDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('ensureRegistry 首次建 default 空间并写 spaces.json', async () => {
  const { manager, dataDir, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'));
    assert.strictEqual(reg.version, 1);
    assert.strictEqual(reg.activeSpaceId, DEFAULT_SPACE_ID);
    assert.ok(reg.spaces.find((s) => s.id === DEFAULT_SPACE_ID && s.name === '默认'));
    assert.strictEqual(reg.spaces[0].scanIntervalMinutes, 5);
  } finally {
    cleanup();
  }
});

test('listSpaces/getSpace/getActiveSpace 基本读取', async () => {
  const { manager, cleanup } = makeManager({ scanIntervalMinutes: 10 });
  try {
    await manager.ensureRegistry();
    assert.strictEqual(manager.getActiveSpaceId(), DEFAULT_SPACE_ID);
    assert.ok(manager.getActiveSpace());
    assert.ok(manager.getSpace(DEFAULT_SPACE_ID));
    assert.strictEqual(manager.listSpaces().length, 1);
  } finally {
    cleanup();
  }
});

test('createSpace 建新空间并预建空 store', async () => {
  const { manager, dataDir, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'AI', papersDir: 'papers-ai' });
    assert.strictEqual(sp.name, 'AI');
    assert.ok(sp.id);
    assert.notStrictEqual(sp.id, DEFAULT_SPACE_ID);
    // store 文件已预建
    assert.ok(fs.existsSync(path.join(dataDir, 'spaces', sp.id, 'papers.json')));
    // papersDir 已创建
    const store = await manager.getSpaceStore(sp.id);
    assert.ok(store.papers);
    cleanup();
  } catch (e) {
    cleanup();
    throw e;
  }
});

test('createSpace 无 papersDir 时默认相对 papers/<id>', async () => {
  const { manager, root, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: '无目录' });
    assert.ok(sp.papersDir);
    // 绑定目录应已创建（resolvePapersDir 自动 mkdir）
    assert.ok(fs.existsSync(path.resolve(root, sp.papersDir)));
  } finally {
    cleanup();
  }
});

test('renameSpace 改名（default 也允许改显示名）', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.renameSpace(DEFAULT_SPACE_ID, '我的库');
    assert.strictEqual(sp.name, '我的库');
    // 重新加载验证持久化
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getSpace(DEFAULT_SPACE_ID).name, '我的库');
  } finally {
    cleanup();
  }
});

test('changePapersDir 改绑定文件夹并自动创建目录（核心需求）', async () => {
  const { manager, root, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.changePapersDir(DEFAULT_SPACE_ID, 'papers-new/sub');
    assert.strictEqual(sp.papersDir, 'papers-new/sub');
    // 目录已自动创建
    assert.ok(fs.existsSync(path.resolve(root, 'papers-new/sub')));
    // 持久化
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getSpace(DEFAULT_SPACE_ID).papersDir, 'papers-new/sub');
  } finally {
    cleanup();
  }
});

test('changePapersDir 支持绝对路径', async () => {
  const { manager, cleanup } = makeManager();
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsp-abs-'));
  try {
    await manager.ensureRegistry();
    const sp = await manager.changePapersDir(DEFAULT_SPACE_ID, abs);
    assert.ok(path.isAbsolute(sp.papersDir));
  } finally {
    cleanup();
    fs.rmSync(abs, { recursive: true, force: true });
  }
});

test('deleteSpace 删数据但保留物理 PDF 文件夹', async () => {
  const { manager, dataDir, root, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: '临时', papersDir: 'papers-tmp' });
    // 在物理 PDF 目录里放一个文件，验证删除后它还在
    const pdfPath = path.resolve(root, 'papers-tmp', 'keep.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, 'pdf-content');
    const r = await manager.deleteSpace(sp.id);
    // 数据目录已删
    assert.ok(!fs.existsSync(path.join(dataDir, 'spaces', sp.id)));
    // 物理 PDF 保留
    assert.ok(fs.existsSync(pdfPath), '物理 PDF 文件应保留');
    assert.strictEqual(r.papersDirKept, sp.papersDir);
    // 空间从列表移除
    assert.ok(!manager.getSpace(sp.id));
  } finally {
    cleanup();
  }
});

test('deleteSpace 拒绝删除 default 空间', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    await assert.rejects(() => manager.deleteSpace(DEFAULT_SPACE_ID), /默认空间/);
  } finally {
    cleanup();
  }
});

test('deleteSpace active 后自动切回 default', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: '激活测试' });
    await manager.setActiveSpace(sp.id);
    assert.strictEqual(manager.getActiveSpaceId(), sp.id);
    await manager.deleteSpace(sp.id);
    assert.strictEqual(manager.getActiveSpaceId(), DEFAULT_SPACE_ID);
  } finally {
    cleanup();
  }
});

test('setActiveSpace 切换 active 并持久化', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    await manager.setActiveSpace(sp.id);
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getActiveSpaceId(), sp.id);
  } finally {
    cleanup();
  }
});

test('setActiveSpace 拒绝不存在的空间', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    await assert.rejects(() => manager.setActiveSpace('nope'), /空间不存在/);
  } finally {
    cleanup();
  }
});

test('resolveSpacePapersDir 解析为绝对路径', async () => {
  const { manager, root, cleanup } = makeManager({ papersDir: 'papers' });
  try {
    await manager.ensureRegistry();
    const abs = manager.resolveSpacePapersDir(DEFAULT_SPACE_ID);
    assert.ok(path.isAbsolute(abs));
    assert.strictEqual(abs, path.resolve(root, 'papers'));
  } finally {
    cleanup();
  }
});

test('getSpaceStore/saveSpaceStore 隔离：两空间同名 paper 互不影响', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    const storeA = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    const storeB = await manager.getSpaceStore(sp.id);
    storeA.papers.paper1 = { id: 'paper1', title: 'A空间', tags: ['x'], status: 'ready' };
    storeB.papers.paper1 = { id: 'paper1', title: 'B空间', tags: ['y'], status: 'ready' };
    await manager.saveSpaceStore(DEFAULT_SPACE_ID, storeA);
    await manager.saveSpaceStore(sp.id, storeB);
    // 重新加载验证隔离
    await manager._reloadFromDisk();
    const reloadA = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    const reloadB = await manager.getSpaceStore(sp.id);
    assert.strictEqual(reloadA.papers.paper1.title, 'A空间');
    assert.strictEqual(reloadB.papers.paper1.title, 'B空间');
    assert.deepStrictEqual(reloadA.papers.paper1.tags, ['x']);
    assert.deepStrictEqual(reloadB.papers.paper1.tags, ['y']);
  } finally {
    cleanup();
  }
});

test('saveStoreBinder 返回单参闭包（遵守陷阱1：scanner deps.saveStore 单参）', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const store = await manager.getSpaceStore(DEFAULT_SPACE_ID);
    store.papers.p1 = { id: 'p1', status: 'ready' };
    const save = manager.saveStoreBinder(DEFAULT_SPACE_ID);
    assert.strictEqual(typeof save, 'function');
    assert.strictEqual(save.length, 1); // 单参
    await save(store); // 不应抛
    assert.ok(fs.existsSync(manager.getStorePath(DEFAULT_SPACE_ID)));
  } finally {
    cleanup();
  }
});

test('setScanInterval 持久化 + minScheduledIntervalMs 取最小', async () => {
  const { manager, cleanup } = makeManager({ scanIntervalMinutes: 5 });
  try {
    await manager.ensureRegistry();
    await manager.setScanInterval(DEFAULT_SPACE_ID, 10);
    const sp = await manager.createSpace({ name: 'B' });
    await manager.setScanInterval(sp.id, 2);
    // 最小间隔 = 2 分钟
    assert.strictEqual(manager.minScheduledIntervalMs(), 2 * 60 * 1000);
    // 持久化
    await manager._reloadFromDisk();
    assert.strictEqual(manager.getSpace(sp.id).scanIntervalMinutes, 2);
  } finally {
    cleanup();
  }
});

test('setScanInterval 0 = 关闭该空间定时扫描', async () => {
  const { manager, cleanup } = makeManager({ scanIntervalMinutes: 5 });
  try {
    await manager.ensureRegistry();
    await manager.setScanInterval(DEFAULT_SPACE_ID, 0);
    // default 关了定时 → 没有任何 scheduled 空间
    assert.strictEqual(manager.minScheduledIntervalMs(), 0);
    assert.strictEqual(manager.scheduledSpaces().length, 0);
  } finally {
    cleanup();
  }
});

test('迁移：旧 papers.json/text/backups 迁入 default 空间', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmig-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 造旧数据
  const oldStore = {
    version: 2,
    tags: ['legacy'],
    topics: [],
    folders: [],
    concepts: [],
    settings: { ai: { model: 'x' } },
    papers: { p1: { id: 'p1', title: '老论文', tags: ['legacy'], status: 'ready' } },
  };
  fs.writeFileSync(path.join(dataDir, 'papers.json'), JSON.stringify(oldStore));
  fs.mkdirSync(path.join(dataDir, 'text'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'text', 'p1.txt'), '全文内容');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'backups', 'papers-2024-01-01.json'), '{}');
  try {
    const migrated = await migrateLegacyIfNeeded(dataDir, root, { papersDir: 'papers', scanIntervalMinutes: 5 });
    assert.ok(migrated, '应触发迁移');
    // 旧文件已移走
    assert.ok(!fs.existsSync(path.join(dataDir, 'papers.json')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'text')));
    // 迁入 default 空间
    const destStore = path.join(dataDir, 'spaces', DEFAULT_SPACE_ID, 'papers.json');
    assert.ok(fs.existsSync(destStore));
    const loaded = JSON.parse(fs.readFileSync(destStore, 'utf8'));
    assert.strictEqual(loaded.papers.p1.title, '老论文');
    assert.deepStrictEqual(loaded.tags, ['legacy']);
    // 全文也迁了
    assert.ok(fs.existsSync(path.join(dataDir, 'spaces', DEFAULT_SPACE_ID, 'text', 'p1.txt')));
    // 注册表已建
    const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'spaces.json'), 'utf8'));
    assert.strictEqual(reg.spaces[0].papersDir, 'papers');
    // 迁移前备份还在（.pre-spaces-<ts>）
    const backups = fs.readdirSync(dataDir).filter((f) => /\.pre-spaces-/.test(f));
    assert.ok(backups.length >= 1, '应留迁移前备份');
    // 二次调用幂等（不再迁移）
    const again = await migrateLegacyIfNeeded(dataDir, root, { papersDir: 'papers' });
    assert.strictEqual(again, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('迁移：spaces.json 已存在时不迁移（幂等）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmig2-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 既有旧 papers.json 又有 spaces.json → 不应迁移
  fs.writeFileSync(path.join(dataDir, 'papers.json'), '{"version":2,"papers":{}}');
  fs.writeFileSync(
    path.join(dataDir, 'spaces.json'),
    JSON.stringify({
      version: 1,
      activeSpaceId: 'default',
      spaces: [{ id: 'default', name: '默认', papersDir: 'papers' }],
    }),
  );
  try {
    const migrated = await migrateLegacyIfNeeded(dataDir, root, { papersDir: 'papers' });
    assert.strictEqual(migrated, false);
    // 旧 papers.json 仍在原位（未被移动）
    assert.ok(fs.existsSync(path.join(dataDir, 'papers.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('迁移：既无旧数据也无 spaces.json 时不触发', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmig3-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const migrated = await migrateLegacyIfNeeded(dataDir, root, { papersDir: 'papers' });
    assert.strictEqual(migrated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePapersDir 绝对路径直接用，相对路径相对 root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwrp-'));
  try {
    const abs = resolvePapersDir(root, 'sub/dir');
    assert.strictEqual(abs, path.resolve(root, 'sub/dir'));
    assert.ok(fs.existsSync(abs), '应自动 mkdir');
    const absPath = resolvePapersDir(root, path.join(root, 'abs'));
    assert.ok(path.isAbsolute(absPath));
    assert.ok(fs.existsSync(absPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spacesView 返回 activeSpaceId + 空间精简列表（含 paperCount）', async () => {
  const { manager, cleanup } = makeManager();
  try {
    await manager.ensureRegistry();
    const sp = await manager.createSpace({ name: 'B' });
    const view = await manager.spacesView();
    assert.strictEqual(view.activeSpaceId, DEFAULT_SPACE_ID);
    assert.strictEqual(view.spaces.length, 2);
    assert.ok(view.spaces.find((s) => s.id === sp.id && s.name === 'B'));
    // paperCount：每项均为数字（空库为 0）
    for (const s of view.spaces) {
      assert.strictEqual(typeof s.paperCount, 'number');
      assert.ok(s.paperCount >= 0);
    }
  } finally {
    cleanup();
  }
});
