const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 进程内串行写锁：单 pm2 实例下足够保证 papers.json 不交错
let writeChain = Promise.resolve();

function ensureDataDir(storePath) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'text'), { recursive: true });
}

function emptyStore() {
  return { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
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
  // 必须是对象：损坏内容（或被写成纯字符串/数字）时备份后回到空 store
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const bak = storePath + '.corrupt-' + Date.now();
    try {
      await fsp.rename(storePath, bak);
      console.error('[store] papers.json 无效（非 JSON 对象），已备份到', bak);
    } catch (e) {
      console.error('[store] 备份失败', e && e.message);
    }
    return emptyStore();
  }
  data.papers = data.papers || {};
  data.tags = data.tags || [];
  migrateStore(data);
  return data;
}

async function saveStore(storePath, store) {
  const run = writeChain.then(async () => {
    ensureDataDir(storePath);
    const tmp = storePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
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
    console.error('[store] backup failed', e && e.message);
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

/** 生成稳定的概念 id（基于归一化 term 的短 hash），保证跨论文可归并 */
function conceptIdFor(term) {
  const key = normalizeTerm(term);
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return 'c_' + Math.abs(h).toString(36).padStart(6, '0').slice(0, 8);
}

/**
 * 把若干 {term, definition} 归并入概念清单：
 * - 已存在（按归一化 term）则补全 definition / 追加 paperId；
 * - 否则新建。
 * 返回本次新增（首次出现）的概念 id 列表。
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
      if (paperId && !c.paperIds.includes(paperId)) c.paperIds.push(paperId);
      c.updatedAt = Date.now();
    } else {
      c = {
        id,
        term,
        definition: String((raw && raw.definition) || '').trim(),
        source: 'ai',
        paperIds: paperId ? [paperId] : [],
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

/** 把概念清单渲染为分类 Markdown 文档，便于导出/外部查看 */
function conceptsToMarkdown(store) {
  const items = store.concepts || [];
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
      lines.push(`### ${c.term}`);
      if (c.definition) lines.push('', c.definition);
      if (c.paperIds && c.paperIds.length) {
        const names = c.paperIds.map((id) => {
          const p = store.papers && store.papers[id];
          return p ? p.title || p.filename || id : id;
        });
        lines.push(
          '',
          `_出现于 ${c.paperIds.length} 篇：${names.slice(0, 3).join(' / ')}${names.length > 3 ? ' 等' : ''}_`,
        );
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
  getPaper,
  upsertPaper,
  patchPaper,
  mergeTags,
  mergeTopics,
  normalizeTopic,
  normalizeTerm,
  conceptIdFor,
  mergeConcepts,
  deleteConcept,
  conceptsToMarkdown,
  addFolder,
  deleteFolder,
};
