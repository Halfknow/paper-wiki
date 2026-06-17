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

function emptyStore() { return { version: 1, tags: [], papers: {} }; }

async function loadStore(storePath) {
  ensureDataDir(storePath);
  try {
    const raw = await fsp.readFile(storePath, 'utf8');
    const data = JSON.parse(raw);
    data.papers = data.papers || {};
    data.tags = data.tags || [];
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyStore();
    throw e;
  }
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

function getPaper(store, id) { return store.papers[id] || null; }

function upsertPaper(store, paper) {
  const prev = store.papers[paper.id] || {};
  store.papers[paper.id] = { ...prev, ...paper, updatedAt: Date.now() };
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
  const map = new Map(store.tags.map((t) => [t.toLowerCase(), t]));
  for (const raw of newTags || []) {
    const t = String(raw).trim();
    const key = t.toLowerCase();
    if (key && !map.has(key)) map.set(key, t);
  }
  store.tags = [...map.values()].sort();
  return store.tags;
}

module.exports = {
  ensureDataDir, emptyStore, loadStore, saveStore,
  getPaper, upsertPaper, patchPaper, mergeTags,
};
