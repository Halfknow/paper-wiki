const { test } = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');
const { createDb, createRepository } = require('../lib/db');

/** pg-mem 内存库：无需真实 PostgreSQL 即可测 repository 全逻辑 */
function memDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  return createDb({ createPool: () => new Pool() });
}

async function repoMem() {
  const db = memDb();
  await db.migrate();
  return { db, repo: createRepository(db) };
}

function sampleStore() {
  return {
    version: 2,
    tags: ['llm'],
    topics: ['大模型'],
    folders: [{ id: 'f1', name: 'A', color: '#fff', createdAt: 1 }],
    concepts: [{ id: 'c1', term: 'MoE', definition: 'd', paperIds: ['p1'], createdAt: 1, updatedAt: 1 }],
    settings: { summaryPrompt: 'x' },
    papers: {
      p1: {
        id: 'p1',
        filename: 'a.pdf',
        filepath: '/papers/a.pdf',
        fulltextPath: '/old/text/p1.txt',
        title: 'T',
        year: 2024,
        authors: ['Alice', 'Bob'],
        tags: ['llm'],
        topics: [],
        folders: [],
        conceptIds: ['c1'],
        readProgress: null,
        annotations: null,
        rating: 0,
        starred: false,
        readStatus: 'unread',
        status: 'ready',
        error: null,
        notes: '',
        chat: [],
        customFutureField: 42,
      },
    },
  };
}

test('migrate 幂等建表', async () => {
  const db = memDb();
  await db.migrate();
  await db.migrate(); // 第二次不报错
  const r = await db.query('SELECT key FROM app_state');
  assert.ok(Array.isArray(r.rows));
  await db.close();
});

test('registry: 空库返回 null，upsert 后可读', async () => {
  const { db, repo } = await repoMem();
  assert.equal(await repo.loadRegistry(), null);
  await repo.upsertSpaceMeta({
    id: 'default',
    name: '默认',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  await repo.setActiveSpaceId('default');
  const reg = await repo.loadRegistry();
  assert.equal(reg.activeSpaceId, 'default');
  assert.equal(reg.spaces.length, 1);
  assert.equal(reg.spaces[0].papersDir, '.');
  assert.equal(reg.spaces[0].scanIntervalMinutes, 5);
  await db.close();
});

test('upsertSpaceMeta 不覆盖 store 字段（tags/topics/settings）', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = sampleStore();
  await repo.saveSpaceStore('s1', store);
  await repo.upsertSpaceMeta({ id: 's1', name: '改名', papersDir: 'sub', createdAt: 1, scanIntervalMinutes: 10, lastScanAt: 9 });
  const loaded = await repo.loadSpaceStore('s1');
  assert.deepEqual(loaded.tags, ['llm']); // meta upsert 不清 store 字典
  const reg = await repo.loadRegistry();
  assert.equal(reg.spaces[0].name, '改名');
  assert.equal(reg.spaces[0].papersDir, 'sub');
  await db.close();
});

test('store 保存/组装 roundtrip + filepath/fulltextPath 不落库 + extra 兜底', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  await repo.saveSpaceStore('s1', sampleStore());
  const loaded = await repo.loadSpaceStore('s1');
  const p = loaded.papers.p1;
  assert.equal(p.filename, 'a.pdf');
  assert.equal(p.filepath, undefined); // 派生字段不落库
  assert.equal(p.fulltextPath, null); // 废弃字段固定 null
  assert.equal(p.customFutureField, 42); // 未知字段经 extra 兜底
  assert.equal(p.title, 'T');
  assert.equal(p.year, 2024);
  assert.deepEqual(p.authors, ['Alice', 'Bob']);
  assert.deepEqual(p.conceptIds, ['c1']);
  assert.deepEqual(loaded.tags, ['llm']);
  assert.deepEqual(loaded.topics, ['大模型']);
  assert.equal(loaded.folders.length, 1);
  assert.equal(loaded.concepts[0].term, 'MoE');
  assert.equal(loaded.settings.summaryPrompt, 'x');
  assert.equal(loaded.version, 2);
  await db.close();
});

test('loadSpaceStore: 不存在的空间返回空 store 形状', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const loaded = await repo.loadSpaceStore('s1');
  assert.deepEqual(loaded.papers, {});
  assert.deepEqual(loaded.tags, []);
  assert.deepEqual(loaded.settings, {});
  await db.close();
});

test('hash-diff: 未变更保存不产生写；单篇变更只写一行', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = sampleStore();
  await repo.saveSpaceStore('s1', store);
  const w1 = repo._stats().rowsWritten;
  await repo.saveSpaceStore('s1', store);
  assert.equal(repo._stats().rowsWritten, w1); // 无变更 → 零写

  store.papers.p1.notes = '改了';
  await repo.saveSpaceStore('s1', store);
  assert.equal(repo._stats().rowsWritten, w1 + 1); // 只写 p1 一行
  const loaded = await repo.loadSpaceStore('s1');
  assert.equal(loaded.papers.p1.notes, '改了');
  await db.close();
});

test('filepath 变化不触发写（派生字段不参与 diff）', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = sampleStore();
  await repo.saveSpaceStore('s1', store);
  const w1 = repo._stats().rowsWritten;
  store.papers.p1.filepath = '/elsewhere/a.pdf';
  await repo.saveSpaceStore('s1', store);
  assert.equal(repo._stats().rowsWritten, w1);
  await db.close();
});

test('删除的论文行与全文一起消失', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const store = sampleStore();
  await repo.saveSpaceStore('s1', store);
  await repo.savePaperText('s1', 'p1', 'fulltext here');
  delete store.papers.p1;
  await repo.saveSpaceStore('s1', store);
  const loaded = await repo.loadSpaceStore('s1');
  assert.equal(loaded.papers.p1, undefined);
  assert.equal(await repo.getPaperText('s1', 'p1'), null);
  await db.close();
});

test('texts: save/get/remove roundtrip', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  assert.equal(await repo.getPaperText('s1', 'p9'), null);
  await repo.savePaperText('s1', 'p9', '你好全文');
  assert.equal(await repo.getPaperText('s1', 'p9'), '你好全文');
  await repo.savePaperText('s1', 'p9', '更新后');
  assert.equal(await repo.getPaperText('s1', 'p9'), '更新后');
  await repo.removePaperText('s1', 'p9');
  assert.equal(await repo.getPaperText('s1', 'p9'), null);
  await db.close();
});

test('deleteSpaceRow 级联清空五表', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  await repo.saveSpaceStore('s1', sampleStore());
  await repo.savePaperText('s1', 'p1', 't');
  await repo.deleteSpaceRow('s1');
  assert.equal(await repo.loadRegistry(), null);
  assert.equal(await repo.getPaperText('s1', 'p1'), null);
  const r = await db.query("SELECT * FROM papers WHERE space_id='s1'");
  assert.equal(r.rows.length, 0);
  await db.close();
});

test('多空间隔离：同 paper id 各自独立', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 'a', name: 'a', papersDir: 'a', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  await repo.upsertSpaceMeta({ id: 'b', name: 'b', papersDir: 'b', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0 });
  const sa = sampleStore();
  const sb = sampleStore();
  sb.papers.p1 = { ...sb.papers.p1, title: 'B 空间的' };
  await repo.saveSpaceStore('a', sa);
  await repo.saveSpaceStore('b', sb);
  assert.equal((await repo.loadSpaceStore('a')).papers.p1.title, 'T');
  assert.equal((await repo.loadSpaceStore('b')).papers.p1.title, 'B 空间的');
  await db.close();
});
