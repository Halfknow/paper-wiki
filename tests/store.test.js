const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadStore, saveStore, upsertPaper, patchPaper, mergeTags } = require('../lib/store');

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
  return path.join(dir, 'papers.json');
}

test('loadStore 文件不存在时返回空 store', async () => {
  const store = await loadStore(tmpStorePath());
  assert.deepStrictEqual(store.papers, {});
  assert.deepStrictEqual(store.tags, []);
});

test('saveStore 原子写并可重新 load', async () => {
  const p = tmpStorePath();
  const store = { version: 1, tags: [], papers: {} };
  upsertPaper(store, { id: 'x1', title: 'T', status: 'ready' });
  await saveStore(p, store);
  const again = await loadStore(p);
  assert.ok(again.papers.x1);
  assert.strictEqual(again.papers.x1.title, 'T');
});

test('patchPaper 仅更新给定字段并刷新 updatedAt', async () => {
  const store = { version: 1, tags: [], papers: {} };
  upsertPaper(store, { id: 'x1', notes: '', status: 'ready' });
  const before = store.papers.x1.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  patchPaper(store, 'x1', { notes: 'hi', starred: true });
  assert.strictEqual(store.papers.x1.notes, 'hi');
  assert.strictEqual(store.papers.x1.starred, true);
  assert.strictEqual(store.papers.x1.status, 'ready');
  assert.ok(store.papers.x1.updatedAt > before);
});

test('mergeTags 大小写不敏感去重，保留首次大小写', () => {
  const store = { version: 1, tags: ['RLHF'], papers: {} };
  mergeTags(store, ['rlhf', 'Data-Selection', 'fine-tuning']);
  assert.deepStrictEqual(store.tags.sort(), ['Data-Selection', 'RLHF', 'fine-tuning'].sort());
});

test('saveStore 串行化并发写不交错', async () => {
  const p = tmpStorePath();
  const store = { version: 1, tags: [], papers: {} };
  await Promise.all([
    saveStore(p, { ...store, tags: ['a'] }),
    saveStore(p, { ...store, tags: ['b'] }),
    saveStore(p, { ...store, tags: ['c'] }),
  ]);
  const final = await loadStore(p);
  assert.strictEqual(final.tags.length, 1);
});
