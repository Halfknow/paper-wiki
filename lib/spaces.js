const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { loadStore, saveStore, emptyStore } = require('./store');
const { log } = require('./util');

/**
 * 空间管理器：每个空间是一个完全隔离的库（独立的 papers/tags/topics/folders/concepts/settings
 * + 独立的 papersDir 绑定 + 独立的 text/backups 目录）。
 *
 * 物理布局：
 *   <dataDir>/spaces.json              注册表 { version, activeSpaceId, spaces:[...] }
 *   <dataDir>/spaces/<id>/papers.json  per-space store（复用 lib/store.js，签名不变）
 *   <dataDir>/spaces/<id>/text/        per-space 全文
 *   <dataDir>/spaces/<id>/backups/     per-space 备份
 *
 * 注册表项：{ id, name, papersDir, createdAt, scanIntervalMinutes, lastScanAt }
 *   - papersDir：相对项目根或绝对路径，由 resolvePapersDir 统一解析（收口历史上 5 处各自 path.resolve）
 *   - scanIntervalMinutes：per-space 扫描节奏（0=关闭该空间定时扫描）；默认值取 globalConfig.scanIntervalMinutes ?? 5
 *
 * 关键约束（对应 AGENTS.md 陷阱）：
 *   - paper id = sha1(内容)，同 PDF 跨空间是各自 store 里的独立条目（符合隔离语义）。
 *   - 单进程内串行写锁由 lib/store.js 的模块级 writeChain 保证（所有空间共享，instances:1 下安全）。
 *   - 迁移幂等：检测到旧 data/papers.json 且无 spaces.json 时一次性迁入 default 空间。
 */

const REGISTRY_VERSION = 1;
const DEFAULT_SPACE_ID = 'default';
const DEFAULT_SPACE_NAME = '默认';

/** 注册表原子写串行锁（与 store.js 的 writeChain 同模式，单进程内足够） */
let registryWriteChain = Promise.resolve();

function defaultScanInterval(globalConfig) {
  const n = Number(globalConfig && globalConfig.scanIntervalMinutes);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

function emptyRegistry(globalConfig) {
  return {
    version: REGISTRY_VERSION,
    activeSpaceId: DEFAULT_SPACE_ID,
    spaces: [
      {
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAME,
        papersDir: (globalConfig && globalConfig.papersDir) || 'papers',
        createdAt: Date.now(),
        scanIntervalMinutes: defaultScanInterval(globalConfig),
        lastScanAt: 0,
      },
    ],
  };
}

function registryPath(dataDir) {
  return path.join(dataDir, 'spaces.json');
}

function spacesDir(dataDir) {
  return path.join(dataDir, 'spaces');
}

function spaceDir(dataDir, id) {
  return path.join(spacesDir(dataDir), id);
}

function spaceStorePath(dataDir, id) {
  return path.join(spaceDir(dataDir, id), 'papers.json');
}

/** 统一解析空间绑定的文件夹（收口历史 5 处 path.resolve(__dirname, config.papersDir)）。
 *  绝对路径直接用；相对路径相对 projectRoot 解析。返回绝对路径，并确保目录存在。 */
function resolvePapersDir(projectRoot, papersDir) {
  const rel = String(papersDir || 'papers');
  const abs = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

async function loadRegistryRaw(dataDir) {
  const p = registryPath(dataDir);
  let raw;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.spaces)) return null;
    return data;
  } catch {
    // 注册表损坏：备份后回退到新建（与 store.js 的自愈策略一致，但空间注册表很小，回新建即可）
    const bak = p + '.corrupt-' + Date.now();
    try {
      await fsp.copyFile(p, bak);
      console.error('[spaces] spaces.json 损坏，已备份到', bak);
    } catch (e) {
      console.error('[spaces] 损坏注册表备份失败', e && e.message);
    }
    return null;
  }
}

async function saveRegistry(dataDir, registry) {
  const run = registryWriteChain.then(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = registryPath(dataDir) + '.tmp';
    const content = JSON.stringify(registry, null, 2);
    if (!content || content[0] !== '{') {
      throw new Error('saveRegistry: 序列化结果非 JSON 对象');
    }
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, registryPath(dataDir));
  });
  registryWriteChain = run.catch(() => {});
  await run;
}

/**
 * 一次性迁移：把旧的扁平 data/papers.json + data/text + data/backups 迁入 default 空间。
 * 触发条件：spaces.json 不存在 且 (旧 papers.json 存在 或 data/text 或 data/backups 存在)。
 * 幂等：迁完写 spaces.json，下次启动检测到 spaces.json 存在则跳过。
 * 迁移前自动 backup 原 papers.json 到 data/papers.json.pre-spaces-<ts> 防万一。
 */
async function migrateLegacyIfNeeded(dataDir, projectRoot, globalConfig) {
  const regExists = fs.existsSync(registryPath(dataDir));
  if (regExists) return false; // 已是多空间结构，无需迁移

  const legacyStore = path.join(dataDir, 'papers.json');
  const legacyText = path.join(dataDir, 'text');
  const legacyBackups = path.join(dataDir, 'backups');
  const hasLegacy = fs.existsSync(legacyStore) || fs.existsSync(legacyText) || fs.existsSync(legacyBackups);
  if (!hasLegacy) return false;

  const destDir = spaceDir(dataDir, DEFAULT_SPACE_ID);
  fs.mkdirSync(destDir, { recursive: true });

  // 迁前备份原 papers.json（防迁移失败丢数据，可手动还原）
  if (fs.existsSync(legacyStore)) {
    const ts = Date.now();
    try {
      await fsp.copyFile(legacyStore, legacyStore + '.pre-spaces-' + ts);
    } catch (e) {
      console.error('[spaces] 迁移前备份原 papers.json 失败', e && e.message);
    }
  }

  // 移动文件（rename 跨同 fs 原子；若失败则尝试 copy+unlink 兜底）
  const move = async (src, destFile) => {
    if (!fs.existsSync(src)) return;
    try {
      await fsp.rename(src, destFile);
    } catch (e) {
      await fsp.copyFile(src, destFile);
      await fsp.unlink(src).catch(() => {});
    }
  };
  await move(legacyStore, spaceStorePath(dataDir, DEFAULT_SPACE_ID));
  if (fs.existsSync(legacyText)) await move(legacyText, path.join(destDir, 'text'));
  if (fs.existsSync(legacyBackups)) await move(legacyBackups, path.join(destDir, 'backups'));

  const registry = emptyRegistry(globalConfig);
  registry.spaces[0].papersDir = (globalConfig && globalConfig.papersDir) || 'papers';
  await saveRegistry(dataDir, registry);
  log('[spaces] 已迁移旧 papers.json/text/backups 到 default 空间');
  return true;
}

/**
 * 创建空间管理器。
 * @param {string} dataDir 绝对路径，通常 <projectRoot>/data
 * @param {string} projectRoot 绝对路径，用于解析相对 papersDir
 * @param {object} globalConfig 全局 config.json（作为新空间的默认模板 + applySettingsOverride 兜底）
 */
function createSpaceManager(dataDir, projectRoot, globalConfig) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(spacesDir(dataDir), { recursive: true });

  let registry = null;
  // 每空间的 store 内存缓存：id -> store 对象（懒加载，首次 getSpaceStore 时 load）
  const storeCache = new Map();

  async function ensureRegistry() {
    if (registry) return registry;
    await migrateLegacyIfNeeded(dataDir, projectRoot, globalConfig);
    const loaded = await loadRegistryRaw(dataDir);
    if (loaded && loaded.spaces && loaded.spaces.length) {
      registry = normalizeRegistry(loaded);
    } else {
      registry = normalizeRegistry(emptyRegistry(globalConfig));
      await saveRegistry(dataDir, registry);
    }
    return registry;
  }
  function normalizeRegistry(reg) {
    reg.version = REGISTRY_VERSION;
    reg.spaces = Array.isArray(reg.spaces) ? reg.spaces : [];
    for (const s of reg.spaces) {
      s.id = String(s.id);
      s.name = String(s.name || '未命名');
      s.papersDir = String(s.papersDir || 'papers');
      s.createdAt = Number(s.createdAt) || 0;
      s.scanIntervalMinutes =
        s.scanIntervalMinutes != null ? Number(s.scanIntervalMinutes) : defaultScanInterval(globalConfig);
      s.lastScanAt = Number(s.lastScanAt) || 0;
    }
    // 保证 default 空间存在（永不删除）
    if (!reg.spaces.find((s) => s.id === DEFAULT_SPACE_ID)) {
      reg.spaces.unshift({
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAME,
        papersDir: (globalConfig && globalConfig.papersDir) || 'papers',
        createdAt: Date.now(),
        scanIntervalMinutes: defaultScanInterval(globalConfig),
        lastScanAt: 0,
      });
    }
    if (!reg.spaces.find((s) => s.id === reg.activeSpaceId)) reg.activeSpaceId = DEFAULT_SPACE_ID;
    return reg;
  }

  async function getRegistry() {
    return (await ensureRegistry()).slice ? registry : registry;
  }

  function listSpaces() {
    return registry ? registry.spaces.slice() : [];
  }

  function getSpace(id) {
    if (!registry) return null;
    return registry.spaces.find((s) => s.id === id) || null;
  }

  function getActiveSpaceId() {
    return registry ? registry.activeSpaceId : DEFAULT_SPACE_ID;
  }

  function getActiveSpace() {
    return getSpace(getActiveSpaceId());
  }

  /** 该空间的 store 路径（含 text/backups 同目录推导，与 scanner 的 path.dirname(storePath) 约定一致） */
  function getStorePath(id) {
    return spaceStorePath(dataDir, id);
  }

  /** 懒加载并缓存某空间的 store（首次访问时从磁盘 load，之后返回内存引用） */
  async function getSpaceStore(id) {
    if (!getSpace(id)) return null;
    if (storeCache.has(id)) return storeCache.get(id);
    const sp = getStorePath(id);
    const store = await loadStore(sp);
    storeCache.set(id, store);
    return store;
  }

  /** 保存某空间的 store（单参闭包语义，遵守陷阱 1：scanner 调 saveSpaceStore(id)(store)） */
  async function saveSpaceStore(id, store) {
    const sp = getSpace(id);
    if (!sp) throw new Error('saveSpaceStore: unknown space ' + id);
    storeCache.set(id, store);
    await saveStore(getStorePath(id), store);
  }

  /** 单参闭包工厂：供 scanner/api 注入 deps.saveStore = saveStoreBinder(id) */
  function saveStoreBinder(id) {
    return (store) => saveSpaceStore(id, store);
  }

  /** 统一解析某空间绑定的 papersDir 为绝对路径（收口陷阱） */
  function resolveSpacePapersDir(id) {
    const sp = getSpace(id);
    if (!sp) return resolvePapersDir(projectRoot, 'papers');
    return resolvePapersDir(projectRoot, sp.papersDir);
  }

  /** 解析某空间的全文目录（scanner 的 textDir = path.dirname(storePath)/text） */
  function resolveSpaceTextDir(id) {
    return path.join(path.dirname(getStorePath(id)), 'text');
  }

  async function createSpace({ name, papersDir } = {}) {
    await ensureRegistry();
    const cleanName = String(name || '未命名').trim();
    const dir = String(papersDir || '').trim();
    if (!cleanName) throw new Error('空间名不能为空');
    // 空间 id：基于 name+时间戳+随机 的短 hash（注册表用，非论文内容哈希）
    const id = crypto
      .createHash('sha1')
      .update(cleanName + Date.now() + Math.random())
      .digest('hex')
      .slice(0, 8);
    const resolvedDir = dir || path.join('papers', id);
    // 确保空间数据目录 + papersDir 存在
    fs.mkdirSync(spaceDir(dataDir, id), { recursive: true });
    resolvePapersDir(projectRoot, resolvedDir);
    const space = {
      id,
      name: cleanName,
      papersDir: resolvedDir,
      createdAt: Date.now(),
      scanIntervalMinutes: defaultScanInterval(globalConfig),
      lastScanAt: 0,
    };
    registry.spaces.push(space);
    await saveRegistry(dataDir, registry);
    // 预建空 store 落盘（确保该空间目录有合法 papers.json，scanner/backup 能直接用）
    await saveStore(spaceStorePath(dataDir, id), emptyStore());
    return space;
  }

  async function renameSpace(id, name) {
    const sp = getSpace(id);
    if (!sp) throw new Error('空间不存在: ' + id);
    if (id === DEFAULT_SPACE_ID) {
      // default 改名允许（用户可改成「AI」等），但 id 不变
    }
    sp.name = String(name || '未命名').trim() || sp.name;
    await saveRegistry(dataDir, registry);
    return sp;
  }

  /** 改空间绑定的文件夹（用户核心需求：设置中手动改绑定文件夹）。
   *  新目录不存在则自动 mkdir。已入库论文的 filepath 仍指向旧位置——不自动搬移 PDF
   *  （避免大批量文件操作的风险），下次扫描会在新目录发现新文件；旧文件可由用户手动移入。 */
  async function changePapersDir(id, newDir) {
    const sp = getSpace(id);
    if (!sp) throw new Error('空间不存在: ' + id);
    const dir = String(newDir || '').trim();
    if (!dir) throw new Error('文件夹路径不能为空');
    resolvePapersDir(projectRoot, dir); // 校验可写 + 自动 mkdir
    sp.papersDir = dir;
    await saveRegistry(dataDir, registry);
    return sp;
  }

  /** 删空间：只删该空间的 store+text+backups 数据，保留物理 PDF 文件夹（用户文件不碰）。
   *  若删的是 active 则切回 default。default 空间不可删。 */
  async function deleteSpace(id) {
    if (id === DEFAULT_SPACE_ID) throw new Error('默认空间不可删除');
    const sp = getSpace(id);
    if (!sp) throw new Error('空间不存在: ' + id);
    registry.spaces = registry.spaces.filter((s) => s.id !== id);
    if (registry.activeSpaceId === id) registry.activeSpaceId = DEFAULT_SPACE_ID;
    await saveRegistry(dataDir, registry);
    storeCache.delete(id);
    // 删空间数据目录（papers.json / text / backups），保留物理 PDF 文件夹
    const dir = spaceDir(dataDir, id);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (e) {
      log('[spaces] 删除空间数据目录失败', id, e.message);
    }
    return { deleted: id, papersDirKept: sp.papersDir };
  }

  async function setActiveSpace(id) {
    if (!getSpace(id)) throw new Error('空间不存在: ' + id);
    registry.activeSpaceId = id;
    await saveRegistry(dataDir, registry);
    return getActiveSpace();
  }

  /** 更新空间的扫描节奏（reschedule 时调用，持久化到注册表） */
  async function setScanInterval(id, minutes) {
    const sp = getSpace(id);
    if (!sp) throw new Error('空间不存在: ' + id);
    let n = Number(minutes);
    if (!Number.isFinite(n) || n < 0) n = 0;
    sp.scanIntervalMinutes = n;
    await saveRegistry(dataDir, registry);
    return sp;
  }

  /** 标记空间的最后扫描时间（scan 完成后调用） */
  async function markScanned(id) {
    const sp = getSpace(id);
    if (!sp) return;
    sp.lastScanAt = Date.now();
    await saveRegistry(dataDir, registry);
  }

  /** 所有需要定时扫描的空间（scanIntervalMinutes > 0） */
  function scheduledSpaces() {
    return listSpaces().filter((s) => Number(s.scanIntervalMinutes) > 0);
  }

  /** 单一定时器间隔：取所有 scheduled 空间的最小间隔（GCD 近似），每次 tick 由 scan 内部按 per-space lastScanAt 判定 */
  function minScheduledIntervalMs() {
    const arr = scheduledSpaces().map((s) => Number(s.scanIntervalMinutes) * 60 * 1000);
    if (!arr.length) return 0;
    return Math.min(...arr);
  }

  /** 列出所有空间的精简视图（给 GET /api/spaces 用） */
  /** 空间视图（供 GET /api/spaces）：含 paperCount，便于管理弹窗展示。
   *  getSpaceStore 懒加载+缓存，首次会读盘 load；之后命中 storeCache 为 O(1)。 */
  async function spacesView() {
    const out = [];
    for (const s of listSpaces()) {
      let paperCount = 0;
      try {
        const store = await getSpaceStore(s.id);
        if (store && store.papers) paperCount = Object.keys(store.papers).length;
      } catch { /* 读盘失败按 0 计，不阻断列表 */ }
      out.push({
        id: s.id,
        name: s.name,
        papersDir: s.papersDir,
        createdAt: s.createdAt,
        scanIntervalMinutes: s.scanIntervalMinutes,
        lastScanAt: s.lastScanAt,
        paperCount,
      });
    }
    return { activeSpaceId: getActiveSpaceId(), spaces: out };
  }

  /** 遍历所有空间各自备份（替代 server.js 的单一 backupStore 调用） */
  async function backupAllSpaces() {
    const { backupStore } = require('./store');
    for (const sp of listSpaces()) {
      try {
        await backupStore(getStorePath(sp.id));
      } catch (e) {
        log('[spaces] backup failed for space', sp.id, e && e.message);
      }
    }
  }

  return {
    // 生命周期
    ensureRegistry,
    // 读取
    listSpaces,
    getSpace,
    getActiveSpaceId,
    getActiveSpace,
    getStorePath,
    getSpaceStore,
    resolveSpacePapersDir,
    resolveSpaceTextDir,
    spacesView,
    scheduledSpaces,
    minScheduledIntervalMs,
    // 写入（持久化注册表）
    createSpace,
    renameSpace,
    changePapersDir,
    deleteSpace,
    setActiveSpace,
    setScanInterval,
    markScanned,
    // store 读写
    saveSpaceStore,
    saveStoreBinder,
    backupAllSpaces,
    // 暴露给测试/脚本
    _dataDir: dataDir,
    _projectRoot: projectRoot,
    _reloadFromDisk: async () => {
      registry = null;
      storeCache.clear();
      await ensureRegistry();
    },
  };
}

module.exports = {
  createSpaceManager,
  resolvePapersDir,
  migrateLegacyIfNeeded,
  DEFAULT_SPACE_ID,
  REGISTRY_VERSION,
};
