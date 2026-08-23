const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log, safeFilename } = require('../core/util');

/**
 * 空间管理器（v3：PostgreSQL 持久化）：每个空间是一个完全隔离的库
 * （独立的 papers/tags/topics/folders/concepts/settings + 独立的 papersDir 绑定 + 独立全文）。
 *
 * v3 变化（对应 spec docs/superpowers/specs/2026-07-18-postgres-docker-migration-design.md）：
 * - 注册表（原 data/spaces.json）与 per-space store（原 data/spaces/<id>/papers.json）全部入 PG，
 *   经 lib/db.js 的 repository 读写；内存 store 形状（v2 结构）与对外方法签名不变。
 * - papersDir 一律是 **papersRoot 根内的相对路径**（Docker 场景 papersRoot=/papers 挂载根），
 *   resolvePapersDir 强校验不得越界；'.' 表示根本身。
 * - **filepath 是运行时派生字段**：load 时由 papersDir+filename 合成，不落库（绑定 desync 根因修复）。
 * - 全文经 textStoreBinder(id) 提供的 {load,save,remove} 读写 PG paper_texts（原 data/text/<id>.txt）。
 * - papersDir 改绑走「预检 → move/rebind → 原子执行」（previewPapersDirChange/applyPapersDirChange），
 *   不再允许直接改字符串。
 *
 * 关键约束（对应 AGENTS.md 陷阱）：
 * - paper id = sha1(内容)，同 PDF 跨空间是各自 store 里的独立条目（符合隔离语义）。
 * - 串行写锁在 repository 内（writeChain），单容器单进程下安全。
 * - deps.saveStore 仍是单参闭包（saveStoreBinder），陷阱 1 继续成立。
 */

const DEFAULT_SPACE_ID = 'default';
const DEFAULT_SPACE_NAME = '默认';

function defaultScanInterval(globalConfig) {
  const n = Number(globalConfig && globalConfig.scanIntervalMinutes);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** 解析 papersRoot 根内的相对目录：越界（../、绝对路径逃逸）即抛错；自动 mkdir；返回绝对路径。 */
function resolvePapersDir(papersRoot, papersDir) {
  const rel = String(papersDir == null || papersDir === '' ? '.' : papersDir);
  const abs = path.resolve(papersRoot, rel);
  const relCheck = path.relative(path.resolve(papersRoot), abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`文件夹必须在挂载根内（papersRoot=${papersRoot}）：${papersDir}`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** 文件移动：rename 优先，跨设备（EXDEV）回退 copy+unlink */
async function moveFile(src, dest) {
  const fsp = fs.promises;
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src).catch(() => {});
  }
}

/** 空间名 → 文件夹名（名↔文件夹联动）：净化非法字符（Windows 目录同文件名规则）；净化后为空回退空间 id */
function dirNameForSpace(name, id) {
  const s = safeFilename(String(name || ''), { maxLen: 80 });
  return s || id;
}

/** 撞名加 id 后缀：a.pdf → a (p1).pdf */
function withIdSuffix(filename, id) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  return `${base} (${id})${ext}`;
}

/**
 * 创建空间管理器。
 * @param {object} opts
 * @param {object} opts.repo lib/db.js createRepository 返回值
 * @param {string} opts.papersRoot 绝对路径，所有空间 papersDir 的挂载根（容器内 /papers）
 * @param {object} opts.globalConfig 全局 config.json（新空间默认模板 + applySettingsOverride 兜底）
 */
function createSpaceManager({ repo, papersRoot, globalConfig }) {
  if (!repo) throw new Error('createSpaceManager: 缺少 repo');
  if (!papersRoot || !path.isAbsolute(papersRoot)) throw new Error('createSpaceManager: papersRoot 必须是绝对路径');
  fs.mkdirSync(papersRoot, { recursive: true });

  let registry = null; // { activeSpaceId, spaces: [...] } 内存态，源于 PG
  const storeCache = new Map(); // spaceId -> store 内存引用（与 scanner/api 共享）
  const storeLoads = new Map(); // spaceId -> 进行中的 getSpaceStore Promise（并发去重）

  function normalizeSpace(s) {
    return {
      id: String(s.id),
      name: String(s.name || '未命名'),
      papersDir: String(s.papersDir || '.'),
      createdAt: Number(s.createdAt) || 0,
      scanIntervalMinutes:
        s.scanIntervalMinutes != null ? Number(s.scanIntervalMinutes) : defaultScanInterval(globalConfig),
      lastScanAt: Number(s.lastScanAt) || 0,
    };
  }

  async function ensureRegistry() {
    if (registry) return registry;
    const loaded = await repo.loadRegistry();
    if (loaded && loaded.spaces.length) {
      registry = { activeSpaceId: loaded.activeSpaceId, spaces: loaded.spaces.map(normalizeSpace) };
      if (!registry.spaces.find((s) => s.id === registry.activeSpaceId)) {
        registry.activeSpaceId = registry.spaces.find((s) => s.id === DEFAULT_SPACE_ID)
          ? DEFAULT_SPACE_ID
          : registry.spaces[0].id;
        await repo.setActiveSpaceId(registry.activeSpaceId);
      }
    } else {
      // default 也绑子目录（不绑 '.' 根本身）：否则任何新空间的子目录都与之嵌套冲突
      const def = normalizeSpace({
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAME,
        papersDir: DEFAULT_SPACE_ID,
        createdAt: Date.now(),
        scanIntervalMinutes: defaultScanInterval(globalConfig),
        lastScanAt: 0,
      });
      await repo.upsertSpaceMeta(def);
      await repo.setActiveSpaceId(def.id);
      registry = { activeSpaceId: def.id, spaces: [def] };
    }
    return registry;
  }

  // ---- 全局 AI 渠道（v3.19）：channels + activeChannelId 跨空间共享，落 app_state['globalAi']。
  //      提示词等其他设置仍 per-space。优先级：全局渠道 → per-space settings.ai.channels（旧数据
  //      兜底）→ 旧版顶层三元组 → config.json。各空间残留的 per-space channels 副本不删除，
  //      全局清空时它们重新生效。 ----
  let globalAiCache; // undefined=未加载；null=库中没有；{channels,activeChannelId}=已配置

  async function loadGlobalAi() {
    if (globalAiCache !== undefined) return globalAiCache;
    const raw = await repo.getAppState('globalAi');
    globalAiCache =
      raw && Array.isArray(raw.channels) && raw.channels.length
        ? { channels: raw.channels, activeChannelId: raw.activeChannelId || null }
        : null;
    return globalAiCache;
  }

  /** 同步读（调用点都在 ensureGlobalAi/任意 await 之后，缓存必然已热） */
  function getGlobalAi() {
    return globalAiCache || null;
  }

  /** 全量替换全局渠道。obj=null 或空 channels = 清除全局渠道（回落 per-space/三元组/config）。 */
  async function saveGlobalAi(obj) {
    const clean =
      obj && Array.isArray(obj.channels) && obj.channels.length
        ? { channels: obj.channels, activeChannelId: obj.activeChannelId || null }
        : null;
    await repo.setAppState('globalAi', clean);
    globalAiCache = clean;
    return clean;
  }

  /** 启动迁移：库中无全局渠道时，把现有某个空间的 per-space 渠道提升为全局。
   *  选取顺序：active 空间 → default → 其余（渠道多者优先）。原空间副本保留（降级为兜底）。 */
  async function ensureGlobalAi() {
    await loadGlobalAi();
    if (globalAiCache) return globalAiCache;
    const channelsOf = (store) => {
      const chs = store && store.settings && store.settings.ai && store.settings.ai.channels;
      return Array.isArray(chs) && chs.length ? chs : null;
    };
    const ordered = listSpaces().sort((a, b) => {
      const rank = (s) => (s.id === registry.activeSpaceId ? 0 : s.id === DEFAULT_SPACE_ID ? 1 : 2);
      return rank(a) - rank(b);
    });
    let picked = null;
    for (const sp of ordered) {
      const store = await getSpaceStore(sp.id);
      const chs = channelsOf(store);
      if (chs && (!picked || chs.length > picked.channels.length)) {
        picked = { channels: chs, activeChannelId: store.settings.ai.activeChannelId || null };
        if (sp.id === registry.activeSpaceId || sp.id === DEFAULT_SPACE_ID) break; // 优先级高的命中即收
      }
    }
    if (picked) await saveGlobalAi(picked);
    return globalAiCache;
  }

  function listSpaces() {
    return registry ? registry.spaces.slice() : [];
  }

  function getSpace(id) {
    if (!registry) return null;
    return registry.spaces.find((s) => s.id === id) || null;
  }

  function mustSpace(id) {
    const sp = getSpace(id);
    if (!sp) throw new Error('空间不存在: ' + id);
    return sp;
  }

  function getActiveSpaceId() {
    return registry ? registry.activeSpaceId : DEFAULT_SPACE_ID;
  }

  function getActiveSpace() {
    return getSpace(getActiveSpaceId());
  }

  /** 统一解析某空间绑定的 papersDir 为绝对路径（根内强校验） */
  function resolveSpacePapersDir(id) {
    const sp = getSpace(id);
    return resolvePapersDir(papersRoot, sp ? sp.papersDir : '.');
  }

  /** 懒加载并缓存某空间的 store（首次从 PG 组装，之后返回内存引用）。
   *  每篇 paper 的 filepath 在此派生（papersDir+filename），不落库。
   *  in-flight 去重：启动首扫与首个 API 请求常并发加载同一空间，无去重会各自 load 出
   *  两个 store 对象、cache 只留一个——后拿到旧对象的请求保存时把先到的修改静默回滚。 */
  async function getSpaceStore(id) {
    if (!getSpace(id)) return null;
    if (storeCache.has(id)) return storeCache.get(id);
    if (storeLoads.has(id)) return storeLoads.get(id);
    const p = (async () => {
      const store = await repo.loadSpaceStore(id);
      deriveFilepaths(id, store);
      storeCache.set(id, store);
      return store;
    })();
    storeLoads.set(id, p);
    try {
      return await p;
    } finally {
      storeLoads.delete(id);
    }
  }

  function deriveFilepaths(id, store) {
    const dir = resolveSpacePapersDir(id);
    for (const p of Object.values(store.papers || {})) {
      p.filepath = p.filename ? path.join(dir, p.filename) : null;
    }
  }

  /** 保存某空间的 store（repo hash-diff，只写变化行；filepath 由 repo 剥除） */
  async function saveSpaceStore(id, store) {
    mustSpace(id);
    storeCache.set(id, store);
    await repo.saveSpaceStore(id, store);
  }

  /** 单参闭包工厂：供 scanner/api 注入 deps.saveStore = saveStoreBinder(id)（遵守陷阱 1） */
  function saveStoreBinder(id) {
    return (store) => saveSpaceStore(id, store);
  }

  /** 全文存取闭包（PG paper_texts）：注入 scanner/api 替代 data/text/<id>.txt */
  function textStoreBinder(id) {
    return {
      load: (pid) => repo.getPaperText(id, pid),
      save: (pid, text) => repo.savePaperText(id, pid, text),
      remove: (pid) => repo.removePaperText(id, pid),
    };
  }

  async function createSpace({ name, papersDir } = {}) {
    await ensureRegistry();
    const cleanName = String(name || '未命名').trim();
    if (!cleanName) throw new Error('空间名不能为空');
    const id = crypto
      .createHash('sha1')
      .update(cleanName + Date.now() + Math.random())
      .digest('hex')
      .slice(0, 8);
    const dir = String(papersDir || '').trim() || dirNameForSpace(cleanName, id); // 默认用空间名做子目录（名↔文件夹联动）
    resolvePapersDir(papersRoot, dir); // 越界校验 + mkdir
    assertNoDirConflict(null, dir);
    const space = normalizeSpace({
      id,
      name: cleanName,
      papersDir: dir,
      createdAt: Date.now(),
      scanIntervalMinutes: defaultScanInterval(globalConfig),
      lastScanAt: 0,
    });
    await repo.upsertSpaceMeta(space);
    registry.spaces.push(space);
    return space;
  }

  /** 改名（名↔文件夹联动）：文件夹名同步为净化后的空间名（物理 rename 目录，派生 filepath 自动对齐）。
   *  目录冲突/占用时整体拒绝（名称也不改），保证名称与目录不发生分叉。
   *  想把空间指向自定义目录用改绑向导（applyPapersDirChange），改名后会再次被联动覆盖——这是有意语义。 */
  async function renameSpace(id, name) {
    const sp = mustSpace(id);
    const cleanName = String(name || '未命名').trim() || sp.name;
    const newDir = dirNameForSpace(cleanName, id);
    if (newDir !== sp.papersDir) {
      assertNoDirConflict(id, newDir); // 与其他空间目录相同/嵌套 → throw（名称保持不变）
      const oldAbs = resolvePapersDir(papersRoot, sp.papersDir); // 确保旧目录存在（可 rename）
      const newAbs = path.resolve(papersRoot, newDir); // dirNameForSpace 输出为单段安全名，必在根内
      // 仅大小写差异（llm → LLM）视为同一目录：Windows/NTFS 大小写不敏感，existsSync 会误报「已存在」，
      // 而大小写-only rename 是合法操作，必须放行
      const caseOnly = oldAbs.toLowerCase() === newAbs.toLowerCase();
      if (!caseOnly && fs.existsSync(newAbs)) throw new Error(`目标文件夹已存在：${newDir}`);
      await fs.promises.rename(oldAbs, newAbs);
      sp.papersDir = newDir;
      const store = storeCache.get(id);
      if (store) deriveFilepaths(id, store); // 内存派生 filepath 即时刷新（不产生 DB 写）
      log(`[spaces] 空间 ${id} 改名联动：文件夹 → ${newDir}`);
    }
    sp.name = cleanName;
    await repo.upsertSpaceMeta(sp);
    return sp;
  }

  /** 删空间：PG 五表级联删数据，保留物理 PDF 文件夹（用户文件不碰）。
   *  删 active 则切回 default。default 空间不可删。 */
  async function deleteSpace(id) {
    if (id === DEFAULT_SPACE_ID) throw new Error('默认空间不可删除');
    const sp = mustSpace(id);
    await repo.deleteSpaceRow(id);
    registry.spaces = registry.spaces.filter((s) => s.id !== id);
    storeCache.delete(id);
    if (registry.activeSpaceId === id) {
      registry.activeSpaceId = DEFAULT_SPACE_ID;
      await repo.setActiveSpaceId(DEFAULT_SPACE_ID);
    }
    return { deleted: id, papersDirKept: sp.papersDir };
  }

  async function setActiveSpace(id) {
    mustSpace(id);
    registry.activeSpaceId = id;
    await repo.setActiveSpaceId(id);
    return getActiveSpace();
  }

  async function setScanInterval(id, minutes) {
    const sp = mustSpace(id);
    let n = Number(minutes);
    if (!Number.isFinite(n) || n < 0) n = 0;
    sp.scanIntervalMinutes = n;
    await repo.upsertSpaceMeta(sp);
    return sp;
  }

  async function markScanned(id) {
    const sp = getSpace(id);
    if (!sp) return;
    sp.lastScanAt = Date.now();
    await repo.upsertSpaceMeta(sp);
  }

  function scheduledSpaces() {
    return listSpaces().filter((s) => Number(s.scanIntervalMinutes) > 0);
  }

  function minScheduledIntervalMs() {
    const arr = scheduledSpaces().map((s) => Number(s.scanIntervalMinutes) * 60 * 1000);
    if (!arr.length) return 0;
    return Math.min(...arr);
  }

  async function spacesView() {
    const out = [];
    for (const s of listSpaces()) {
      let paperCount = 0;
      try {
        const store = await getSpaceStore(s.id);
        if (store && store.papers) paperCount = Object.keys(store.papers).length;
      } catch {
        /* 读库失败按 0 计，不阻断列表 */
      }
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

  // -------------------------------------------------------------------------
  // papersDir 改绑：预检 → 明确意图（move/rebind）→ 原子执行
  // -------------------------------------------------------------------------

  /** 目录冲突校验：不得与其他空间的绑定目录相同或互为父子（否则两个扫描器会 rename 竞争）。
   *  excludeId 为本空间 id（改绑时排除自己）。 */
  function assertNoDirConflict(excludeId, newDir) {
    const target = path.resolve(papersRoot, String(newDir || '.'));
    for (const s of listSpaces()) {
      if (s.id === excludeId) continue;
      const other = path.resolve(papersRoot, s.papersDir || '.');
      const a = path.relative(other, target);
      const b = path.relative(target, other);
      const same = a === '';
      const nested = (!a.startsWith('..') && !path.isAbsolute(a)) || (!b.startsWith('..') && !path.isAbsolute(b));
      if (same || nested) {
        throw new Error(`目录与空间「${s.name}」的绑定（${s.papersDir}）相同或互相嵌套`);
      }
    }
  }

  /** 预检报告：新目录 PDF 数 / sha1 匹配数 / 将缺失数 / 新文件数（不做任何修改）。
   *  fingerprint 依赖延迟 require lib/scanner（避免模块环）。 */
  async function previewPapersDirChange(id, newDir) {
    mustSpace(id);
    const { scanDir, fingerprintAll } = require('./scanner');
    const abs = resolvePapersDir(papersRoot, newDir);
    assertNoDirConflict(id, newDir);
    const store = await getSpaceStore(id);
    const fp = await fingerprintAll(await scanDir(abs));
    const inLib = new Set(Object.keys(store.papers || {}));
    const matchedIds = new Set(fp.map((f) => f.id).filter((pid) => inLib.has(pid)));
    const missingList = [...inLib]
      .filter((pid) => !matchedIds.has(pid))
      .map((pid) => ({
        id: pid,
        title: store.papers[pid].title || null,
        filename: store.papers[pid].filename || null,
      }));
    return {
      newDir: String(newDir),
      pdfCount: fp.length,
      matched: matchedIds.size,
      willMissing: missingList.length,
      newFiles: fp.length - matchedIds.size,
      missingList,
    };
  }

  /**
   * 执行改绑。mode:
   * - 'move'  ：把本空间所有已入库且存在的 PDF 从旧目录搬到新目录（撞名加 (id) 后缀），
   *             单篇失败记 errors[] 并标 missing，不中断整体（文件先动、库后记，重跑 rebind 可对账修复）。
   * - 'rebind'：文件已在新位置（或指向现成文件夹），按 sha1 对账：匹配的更新 filename 并复活 missing，
   *             无匹配的标 missing；新文件交给随后的 scan 正常入库。
   * 两种模式最后统一：改 papersDir → 派生刷新 filepath → save（repo 事务）。
   */
  async function applyPapersDirChange(id, newDir, mode) {
    const sp = mustSpace(id);
    if (mode !== 'move' && mode !== 'rebind') throw new Error('mode 必须是 move 或 rebind');
    const { scanDir, fingerprintAll } = require('./scanner');
    const newAbs = resolvePapersDir(papersRoot, newDir);
    assertNoDirConflict(id, newDir);
    const store = await getSpaceStore(id);
    const errors = [];

    if (mode === 'move') {
      for (const p of Object.values(store.papers || {})) {
        if (!p.filepath || !fs.existsSync(p.filepath)) {
          p.status = 'missing';
          continue;
        }
        let name = p.filename || path.basename(p.filepath);
        let target = path.join(newAbs, name);
        if (path.resolve(target) === path.resolve(p.filepath)) continue; // 已在目标位置
        if (fs.existsSync(target)) {
          name = withIdSuffix(name, p.id);
          target = path.join(newAbs, name);
        }
        try {
          await moveFile(p.filepath, target);
          p.filename = name;
          if (p.status === 'missing') p.status = 'ready';
        } catch (e) {
          errors.push({ id: p.id, error: e.message });
          p.status = 'missing';
        }
      }
    } else {
      const fp = await fingerprintAll(await scanDir(newAbs));
      const byId = new Map(fp.map((f) => [f.id, f]));
      for (const p of Object.values(store.papers || {})) {
        const hit = byId.get(p.id);
        if (hit) {
          p.filename = hit.filename;
          if (p.status === 'missing') p.status = 'ready';
        } else {
          p.status = 'missing';
        }
      }
    }

    sp.papersDir = String(newDir);
    await repo.upsertSpaceMeta(sp);
    deriveFilepaths(id, store);
    await saveSpaceStore(id, store);
    log(`[spaces] 空间 ${id} papersDir 改绑(${mode}) → ${newDir}，errors=${errors.length}`);
    return {
      mode,
      papersDir: sp.papersDir,
      errors,
      missing: Object.values(store.papers || {}).filter((p) => p.status === 'missing').length,
    };
  }

  /** @deprecated 仅存量测试/脚本兼容：等价 rebind（不做文件操作的老语义已废除） */
  async function changePapersDir(id, newDir) {
    return applyPapersDirChange(id, newDir, 'rebind');
  }

  return {
    // 生命周期
    ensureRegistry,
    // 读取
    listSpaces,
    getSpace,
    getActiveSpaceId,
    getActiveSpace,
    getSpaceStore,
    resolveSpacePapersDir,
    spacesView,
    scheduledSpaces,
    minScheduledIntervalMs,
    // 写入
    createSpace,
    renameSpace,
    deleteSpace,
    setActiveSpace,
    setScanInterval,
    markScanned,
    // papersDir 改绑
    previewPapersDirChange,
    applyPapersDirChange,
    changePapersDir,
    // 全局 AI 渠道（v3.19，跨空间共享；见 ensureGlobalAi 注释的优先级阶梯）
    ensureGlobalAi,
    getGlobalAi,
    saveGlobalAi,
    // store / 全文
    saveSpaceStore,
    saveStoreBinder,
    textStoreBinder,
    searchFulltext: (id, q, opts) => {
      mustSpace(id);
      return repo.searchFulltext(id, q, opts);
    },
    // 测试/脚本
    _papersRoot: papersRoot,
    _reloadFromDisk: async () => {
      registry = null;
      storeCache.clear();
      storeLoads.clear();
      globalAiCache = undefined;
      await ensureRegistry();
    },
  };
}

module.exports = {
  createSpaceManager,
  resolvePapersDir,
  DEFAULT_SPACE_ID,
};
