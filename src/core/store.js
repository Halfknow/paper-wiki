const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logger = require('./logger').createLogger('store');

// 进程内串行写锁：单 pm2 实例下足够保证 papers.json 不交错
let writeChain = Promise.resolve();

function ensureDataDir(storePath) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'text'), { recursive: true });
}

function emptyStore() {
  return { version: 2, tags: [], topics: [], folders: [], concepts: [], formulas: [], settings: {}, papers: {} };
}

/** 给单篇论文补齐 v2 字段的默认值（向后兼容老数据） */
function normalizePaper(p) {
  // 星级评分（0-5）：rating 为准；老数据无 rating 时按 starred 推断（true→5）。
  // starred 保留为 rating>0 的镜像，向后兼容既有读取/筛选逻辑。
  const rating = Math.max(0, Math.min(5, Math.round(p.rating != null ? p.rating : p.starred ? 5 : 0)));
  return {
    ...p,
    tags: p.tags || [],
    topics: p.topics || [],
    folders: p.folders || [],
    readProgress: p.readProgress || null,
    annotations: p.annotations || null,
    conceptIds: p.conceptIds || [],
    formulaIds: p.formulaIds || [],
    rating,
    starred: rating > 0,
    chat: Array.isArray(p.chat) ? p.chat : [],
  };
}

/** v1 store 迁移到 v2：补全字典字段并规范化每篇论文 */
function migrateStore(data) {
  data.version = 2;
  data.topics = data.topics || [];
  data.folders = data.folders || [];
  data.concepts = data.concepts || [];
  data.formulas = data.formulas || [];
  data.settings = data.settings || {};
  if (!Array.isArray(data.tags)) data.tags = [];
  const papers = data.papers || {};
  for (const id of Object.keys(papers)) papers[id] = normalizePaper(papers[id]);
  data.papers = papers;
  return data;
}

async function loadStore(storePath) {
  ensureDataDir(storePath);
  let raw;
  try {
    raw = await fsp.readFile(storePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyStore(); // 首次启动
    throw e;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }
  // papers.json 损坏自愈：历史上有把 storePath 字符串/空内容误写进去的 bug，
  // 此时绝不可静默回空 store（会导致全库数据「丢失」+ 重新扫描覆盖总结）。
  // 策略：① 把损坏文件备份为 .corrupt-<ts>；② 优先从最近的备份恢复；③ 没有备份才回空。
  // 始终打 ERROR 日志让问题可见，绝不静默继续。
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.papers !== 'object') {
    const bak = storePath + '.corrupt-' + Date.now();
    let recovered = null;
    try {
      await fsp.copyFile(storePath, bak); // 复制而非 rename：保留原文件以便排查
      logger.error('papers.json 损坏（非 JSON 对象），已备份到', { bak });
    } catch (e) {
      logger.error('损坏文件备份失败', e && e.message);
    }
    // 尝试从最近备份恢复（避免回空丢数据）
    try {
      recovered = await loadLatestBackup(storePath);
    } catch (e) {
      logger.error('从备份恢复失败', e && e.message);
    }
    if (recovered) {
      logger.error('已从备份恢复', { papers: Object.keys(recovered.papers || {}).length });
      return recovered;
    }
    logger.error('无可用备份，回空 store（数据将重新扫描）');
    return emptyStore();
  }
  data.papers = data.papers || {};
  data.tags = data.tags || [];
  migrateStore(data);
  return data;
}

/** 从 data/backups/ 加载最近一份有效的 papers-*.json（按 mtime 降序，跳过损坏）。
 *  损坏自愈时优先恢复，避免回空丢数据。 */
async function loadLatestBackup(storePath) {
  const dataDir = path.dirname(storePath);
  const backupDir = path.join(dataDir, 'backups');
  let files = [];
  try {
    files = await fsp.readdir(backupDir);
  } catch (e) {
    return null; // 无备份目录
  }
  // 只看 papers-*.json（每日备份命名），按 mtime 降序
  const candidates = [];
  for (const f of files) {
    if (!/^papers-.*\.json$/.test(f)) continue;
    try {
      const st = await fsp.stat(path.join(backupDir, f));
      candidates.push({ f, mtime: st.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    try {
      const raw = await fsp.readFile(path.join(backupDir, c.f), 'utf8');
      const j = JSON.parse(raw);
      if (
        j &&
        typeof j === 'object' &&
        !Array.isArray(j) &&
        typeof j.papers === 'object' &&
        Object.keys(j.papers).length > 0
      ) {
        migrateStore(j);
        return j;
      }
    } catch {}
  }
  return null;
}

async function saveStore(storePath, store) {
  const run = writeChain.then(async () => {
    // 防御：绝不把非对象（字符串路径/数字/null）或无 papers 的内容写进 papers.json。
    // 历史上有 saveStore(storePath, store) 误写成单参把 storePath 字符串当 store 存进去的 bug，
    // 一旦写入，下次 loadStore 会判定损坏 → 回空 → 全库数据「丢失」。这里在写入前拦截。
    if (!store || typeof store !== 'object' || Array.isArray(store) || typeof store.papers !== 'object') {
      logger.error('拒绝写入非法 store（非对象/无 papers 段），已阻止', {
        type: typeof store,
        isArray: Array.isArray(store),
      });
      throw new Error('saveStore: 拒绝写入非法 store（非对象或无 papers 段）');
    }
    ensureDataDir(storePath);
    const tmp = storePath + '.tmp';
    const content = JSON.stringify(store, null, 2);
    // 二次校验：序列化结果必须是合法 JSON 对象（防止循环引用等产生异常输出）
    if (!content || content[0] !== '{') {
      logger.error('拒绝写入：序列化结果非 JSON 对象', { firstChar: content ? content[0] : '(空)' });
      throw new Error('saveStore: 序列化结果非 JSON 对象');
    }
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, storePath); // atomic on same filesystem
  });
  writeChain = run.catch(() => {}); // 单次失败不阻塞后续
  await run;
}

// 每日备份：把 papers.json 复制到 data/backups/papers-YYYYMMDD.json，保留最近 N 份。
// 失败只记日志不抛（备份不应阻断主流程）。默认保留 7 份。
const BACKUP_RETENTION = 7;
let lastBackupDate = '';
async function backupStore(storePath) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (date === lastBackupDate) return; // 每天只备一次
  try {
    const dataDir = path.dirname(storePath);
    const backupDir = path.join(dataDir, 'backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const dest = path.join(backupDir, `papers-${date}.json`);
    if (!fs.existsSync(dest)) await fsp.copyFile(storePath, dest);
    lastBackupDate = date;
    // 清理超额备份（按文件名排序，保留最新 N 份）
    const files = (await fsp.readdir(backupDir)).filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_RETENTION))) {
      await fsp.unlink(path.join(backupDir, f)).catch(() => {});
    }
  } catch (e) {
    logger.error('backup failed', e && e.message);
  }
}

/** v3 备份：把内存 store 对象序列化为 <backupDir>/papers-YYYY-MM-DD.json（PG→JSON 快照逃生通道）。
 *  按 backupDir+日期去重（每天一次）；保留最近 BACKUP_RETENTION 份；失败只记日志不抛。 */
const lastBackupDates = new Map(); // backupDir -> YYYY-MM-DD
async function backupStoreObject(backupDir, store) {
  const date = new Date().toISOString().slice(0, 10);
  if (lastBackupDates.get(backupDir) === date) return;
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    const dest = path.join(backupDir, `papers-${date}.json`);
    if (!fs.existsSync(dest)) {
      const content = JSON.stringify(store, null, 2);
      if (!content || content[0] !== '{') throw new Error('序列化结果非 JSON 对象');
      await fsp.writeFile(dest, content, 'utf8');
    }
    lastBackupDates.set(backupDir, date);
    const files = (await fsp.readdir(backupDir)).filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_RETENTION))) {
      await fsp.unlink(path.join(backupDir, f)).catch(() => {});
    }
  } catch (e) {
    logger.error('backupStoreObject failed', e && e.message);
  }
}

function getPaper(store, id) {
  return store.papers[id] || null;
}

function upsertPaper(store, paper) {
  const prev = store.papers[paper.id] || {};
  store.papers[paper.id] = { ...normalizePaper(prev), ...normalizePaper(paper), updatedAt: Date.now() };
  return store.papers[paper.id];
}

function patchPaper(store, id, patch) {
  const p = store.papers[id];
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: Date.now() });
  return p;
}

/** 大小写不敏感地把新标签并入全局字典，保留首次出现的写法 */
function mergeTags(store, newTags) {
  const map = new Map((store.tags || []).map((t) => [t.toLowerCase(), t]));
  for (const raw of newTags || []) {
    const t = String(raw).trim();
    const key = t.toLowerCase();
    if (key && !map.has(key)) map.set(key, t);
  }
  store.tags = [...map.values()].sort();
  return store.tags;
}

/** 主题字典去重归并（大小写不敏感、中文 trim） */
function mergeTopics(store, newTopics) {
  const map = new Map((store.topics || []).map((t) => [normalizeTopic(t), t]));
  for (const raw of newTopics || []) {
    const t = String(raw).trim();
    const key = normalizeTopic(t);
    if (key && !map.has(key)) map.set(key, t);
  }
  store.topics = [...map.values()].sort();
  return store.topics;
}

/** 概念 term 归一化：小写 + 去标点 + 折叠空白，便于去重 */
function normalizeTopic(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** term 归一化用于概念去重（保留英文/中文，去掉连字符两侧空白等） */
function normalizeTerm(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化 key → 稳定短 hash（djb31 变体）。概念 / 公式共用，保证跨论文可归并。
 *  **输出格式不可变更**：已有概念 id（c_xxx）已落库，改算法会让全库概念失联。 */
function stableShortHash(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0').slice(0, 8);
}

/** 生成稳定的概念 id（基于归一化 term 的短 hash），保证跨论文可归并 */
function conceptIdFor(term) {
  return 'c_' + stableShortHash(normalizeTerm(term));
}

/** 概念核心度归一化：'core'（本篇核心创新）/ 'supporting'（支撑技术），其余（含空）→ ''（未知）。 */
function normalizeImportance(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return s === 'core' || s === 'supporting' ? s : '';
}

/** 概念「由来」归一化（v3.29）：contexts = [{paperId, context}]，按 paperId 去重（后者覆盖前者）、
 *  空 context 不入列、封顶 50 条。概念级 context 仍是「主出处」（首次定义处）。 */
function normalizeConceptContexts(raw) {
  if (!Array.isArray(raw)) return [];
  const byPaper = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const paperId = String(item.paperId || '').trim();
    const context = String(item.context || '')
      .trim()
      .slice(0, 200);
    if (!paperId || !context) continue;
    byPaper.set(paperId, context); // 同 paperId 覆盖（重复抽取幂等）
    if (byPaper.size >= 50) break;
  }
  return [...byPaper.entries()].map(([paperId, context]) => ({ paperId, context }));
}

/**
 * 把若干 {term, definition} 归并入概念清单：
 * - 已存在（按归一化 term）则补全 definition / 追加 paperId；
 * - 否则新建。
 * 返回本次新增（首次出现）的概念 id 列表。
 * raw.source（v3.29）：'ai'（默认，抽取链路）| 'manual'（手动新增）——仅新建时生效，命中不改。
 */
function mergeConcepts(store, items, paperId) {
  const existing = new Map((store.concepts || []).map((c) => [normalizeTerm(c.term), c]));
  const newIds = [];
  for (const raw of items || []) {
    const term = String((raw && raw.term) || '').trim();
    if (!term) continue;
    const key = normalizeTerm(term);
    if (!key) continue;
    const id = conceptIdFor(term);
    let c = existing.get(key);
    if (c) {
      if (raw.definition && !c.definition) c.definition = String(raw.definition).trim();
      // category 只在原概念缺分类时补（不覆盖已有）
      if (raw.category && !c.category) c.category = String(raw.category).trim().toLowerCase();
      // context（论文出处，如「3.2.1 节，式(1)」）：仅在原概念缺时补，便于回溯
      if (raw.context && !c.context) c.context = String(raw.context).trim();
      // importance 只升不降：任一篇把该概念标为核心创新（core），它就是核心——
      // 后续论文把它当背景技术（supporting）不应降级（学者找「创新点」时宁多勿漏）
      const imp = normalizeImportance(raw && raw.importance);
      if (imp === 'core') c.importance = 'core';
      else if (imp && !c.importance) c.importance = imp;
      if (paperId) {
        if (!c.paperIds.includes(paperId)) c.paperIds.push(paperId);
        // per-paper 由来（v3.29）：本篇的 context 记到该论文槽位（同篇覆盖，重复抽取幂等）
        if (raw && raw.context) {
          const ctxList = normalizeConceptContexts(c.contexts);
          const next = ctxList.filter((x) => x.paperId !== paperId);
          next.push({ paperId, context: String(raw.context).trim().slice(0, 200) });
          c.contexts = next;
        }
      }
      c.updatedAt = Date.now();
    } else {
      const src = raw && raw.source === 'manual' ? 'manual' : 'ai';
      c = {
        id,
        term,
        definition: String((raw && raw.definition) || '').trim(),
        category:
          String((raw && raw.category) || '')
            .trim()
            .toLowerCase() || 'other',
        context: String((raw && raw.context) || '').trim(),
        importance: normalizeImportance(raw && raw.importance),
        starred: !!(raw && raw.starred),
        source: src,
        paperIds: paperId ? [paperId] : [],
        contexts: paperId && raw && raw.context ? normalizeConceptContexts([{ paperId, context: raw.context }]) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      existing.set(key, c);
      store.concepts = [...existing.values()];
      newIds.push(id);
    }
  }
  store.concepts.sort((a, b) => a.term.localeCompare(b.term));
  return newIds;
}

/** 删除概念，并从所有 paper.conceptIds 里清除 */
function deleteConcept(store, id) {
  const before = (store.concepts || []).length;
  store.concepts = (store.concepts || []).filter((c) => c.id !== id);
  for (const p of Object.values(store.papers || {})) {
    if (Array.isArray(p.conceptIds)) p.conceptIds = p.conceptIds.filter((x) => x !== id);
  }
  return before !== store.concepts.length;
}
/** 把某篇论文从所有概念里移除：多论文共享的概念只删该 paperId，仅剩该篇的概念整条删除（同 removePaperFromFormulas 语义）。 */
function removePaperFromConcepts(store, paperId) {
  if (!Array.isArray(store.concepts)) return;
  for (const c of store.concepts) {
    if (Array.isArray(c.paperIds)) c.paperIds = c.paperIds.filter((x) => x !== paperId);
    if (Array.isArray(c.contexts)) c.contexts = c.contexts.filter((x) => x.paperId !== paperId);
  }
  store.concepts = store.concepts.filter((c) => (c.paperIds || []).length > 0);
}

/** 把 source 概念并入 target（v3.30 治理：命名漂移产生的重复条目收敛）。
 *  并集语义：paperIds 合并去重；contexts 按 paperId 合并（target 已有的槽位保留）；
 *  definition/category/context/importance 只在 target 缺时补（importance 遵循 core 只升不降）；
 *  starred 取或；papers[].conceptIds 里的 sourceId 全部替换为 targetId；删除 source。
 *  返回合并后的 target（概念不存在/自并时返回 null）。 */
function mergeConceptInto(store, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = (store.concepts || []).find((c) => c.id === sourceId);
  const target = (store.concepts || []).find((c) => c.id === targetId);
  if (!source || !target) return null;
  // paperIds 并集（保持 target 原有的在前）
  const ids = new Set(target.paperIds || []);
  for (const pid of source.paperIds || []) ids.add(pid);
  target.paperIds = [...ids];
  // contexts 按 paperId 并集（target 槽位优先——已有的是该篇的准确由来）
  const ctxBy = new Map((target.contexts || []).map((x) => [x.paperId, x]));
  for (const x of source.contexts || []) if (!ctxBy.has(x.paperId)) ctxBy.set(x.paperId, x);
  target.contexts = [...ctxBy.values()];
  // 空缺补齐（同 mergeConcepts 命中语义）
  if (!target.definition && source.definition) target.definition = source.definition;
  if (!target.category && source.category) target.category = source.category;
  if (!target.context && source.context) target.context = source.context;
  if (source.importance === 'core') target.importance = 'core';
  else if (!target.importance && source.importance) target.importance = source.importance;
  target.starred = !!(target.starred || source.starred);
  target.updatedAt = Date.now();
  // 删 source + papers 反向替换
  store.concepts = store.concepts.filter((c) => c.id !== sourceId);
  for (const p of Object.values(store.papers || {})) {
    if (Array.isArray(p.conceptIds)) {
      const set = new Set(p.conceptIds.map((x) => (x === sourceId ? targetId : x)));
      p.conceptIds = [...set];
    }
  }
  return target;
}

/** 创建虚拟收藏夹 */
function addFolder(store, name, color) {
  const folder = {
    id: 'f_' + Math.random().toString(36).slice(2, 10),
    name: String(name || '未命名').trim(),
    color: color || '#2563eb',
    createdAt: Date.now(),
  };
  store.folders = store.folders || [];
  store.folders.push(folder);
  return folder;
}

function deleteFolder(store, id) {
  store.folders = (store.folders || []).filter((f) => f.id !== id);
  for (const p of Object.values(store.papers || {})) {
    if (Array.isArray(p.folders)) p.folders = p.folders.filter((x) => x !== id);
  }
  return true;
}

/** 把概念清单渲染为分类 Markdown 文档，便于导出/外部查看。
 *  opts.ids（v3.30）：限定导出子集（「按当前筛选导出」，备课/综述场景）。 */
function conceptsToMarkdown(store, opts = {}) {
  const ids = Array.isArray(opts && opts.ids) && opts.ids.length ? new Set(opts.ids) : null;
  let items = store.concepts || [];
  if (ids) items = items.filter((c) => ids.has(c.id));
  if (!items.length) return '# 概念清单\n\n_（暂无概念，运行 AI 总结或在论文页「追加概念」即可生成）_\n';
  const byFirst = new Map();
  for (const c of items) {
    const ch = (c.term[0] || '#').toUpperCase();
    if (!byFirst.has(ch)) byFirst.set(ch, []);
    byFirst.get(ch).push(c);
  }
  const lines = ['# 概念清单', '', `> 共 ${items.length} 个概念，由 PaperWiki 自动整理。`, ''];
  for (const ch of [...byFirst.keys()].sort()) {
    lines.push(`## ${ch}`);
    for (const c of byFirst.get(ch)) {
      lines.push(`### ${c.starred ? '⭐ ' : ''}${c.term}`);
      const meta = [
        c.category ? `分类：${c.category}` : '',
        c.importance === 'core' ? '核心创新' : '',
        c.context ? `出处：${c.context}` : '',
      ].filter(Boolean);
      if (meta.length) lines.push('', `_${meta.join(' · ')}_`);
      if (c.definition) lines.push('', c.definition);
      if (c.paperIds && c.paperIds.length) {
        const ctxOf = new Map((c.contexts || []).map((x) => [x.paperId, x.context]));
        const names = c.paperIds.map((id) => {
          const p = store.papers && store.papers[id];
          return p ? p.title || p.filename || id : id;
        });
        lines.push(
          '',
          `_出现于 ${c.paperIds.length} 篇：${names.slice(0, 3).join(' / ')}${names.length > 3 ? ' 等' : ''}_`,
        );
        // per-paper 由来（v3.29）：每篇各自出现在哪一节哪个式号
        for (const [pid, ctx] of ctxOf.entries()) {
          const p = store.papers && store.papers[pid];
          if (p) lines.push(`- ${p.title || p.filename || pid}：${ctx}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = {
  ensureDataDir,
  emptyStore,
  migrateStore,
  loadStore,
  saveStore,
  backupStore,
  backupStoreObject,
  getPaper,
  upsertPaper,
  patchPaper,
  mergeTags,
  mergeTopics,
  normalizeTopic,
  normalizeTerm,
  normalizeImportance,
  normalizeConceptContexts,
  mergeConceptInto,
  stableShortHash,
  conceptIdFor,
  mergeConcepts,
  deleteConcept,
  removePaperFromConcepts,
  conceptsToMarkdown,
  addFolder,
  deleteFolder,
};
