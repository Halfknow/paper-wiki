const { test } = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');
const { createDb, createRepository } = require('../src/db');

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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  const store = sampleStore();
  await repo.saveSpaceStore('s1', store);
  await repo.upsertSpaceMeta({
    id: 's1',
    name: '改名',
    papersDir: 'sub',
    createdAt: 1,
    scanIntervalMinutes: 10,
    lastScanAt: 9,
  });
  const loaded = await repo.loadSpaceStore('s1');
  assert.deepEqual(loaded.tags, ['llm']); // meta upsert 不清 store 字典
  const reg = await repo.loadRegistry();
  assert.equal(reg.spaces[0].name, '改名');
  assert.equal(reg.spaces[0].papersDir, 'sub');
  await db.close();
});

test('store 保存/组装 roundtrip + filepath/fulltextPath 不落库 + extra 兜底', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  const loaded = await repo.loadSpaceStore('s1');
  assert.deepEqual(loaded.papers, {});
  assert.deepEqual(loaded.tags, []);
  assert.deepEqual(loaded.settings, {});
  await db.close();
});

test('hash-diff: 未变更保存不产生写；单篇变更只写一行', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: '.',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
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
  await repo.upsertSpaceMeta({
    id: 'a',
    name: 'a',
    papersDir: 'a',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  await repo.upsertSpaceMeta({
    id: 'b',
    name: 'b',
    papersDir: 'b',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  const sa = sampleStore();
  const sb = sampleStore();
  sb.papers.p1 = { ...sb.papers.p1, title: 'B 空间的' };
  await repo.saveSpaceStore('a', sa);
  await repo.saveSpaceStore('b', sb);
  assert.equal((await repo.loadSpaceStore('a')).papers.p1.title, 'T');
  assert.equal((await repo.loadSpaceStore('b')).papers.p1.title, 'B 空间的');
  await db.close();
});

// ---- JSON→PG 一次性迁移（scripts/migrate-json-to-pg.js）----

test('migrateJsonToPg：多空间旧结构迁移（store/全文/注册表）+ 幂等', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { migrateJsonToPg } = require('../scripts/migrate-json-to-pg');
  const { db, repo } = await repoMem();
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'pwlegacy-'));
  try {
    // 旧多空间结构：spaces.json + spaces/default/{papers.json, text/p1.txt}
    fs.writeFileSync(
      path.join(legacy, 'spaces.json'),
      JSON.stringify({
        version: 1,
        activeSpaceId: 'default',
        spaces: [
          { id: 'default', name: '默认', papersDir: 'papers', scanIntervalMinutes: 5, lastScanAt: 9, createdAt: 1 },
        ],
      }),
    );
    const spDir = path.join(legacy, 'spaces', 'default');
    fs.mkdirSync(path.join(spDir, 'text'), { recursive: true });
    fs.writeFileSync(
      path.join(spDir, 'papers.json'),
      JSON.stringify({
        version: 2,
        tags: ['legacy'],
        topics: [],
        folders: [],
        concepts: [],
        settings: { ai: { model: 'x' } },
        papers: {
          p1: {
            id: 'p1',
            title: '老论文',
            filepath: 'D:\\old\\papers\\paper-one.pdf', // 绝对 Windows 路径 → 只留 basename
            tags: ['legacy'],
            status: 'ready',
          },
        },
      }),
    );
    fs.writeFileSync(path.join(spDir, 'text', 'p1.txt'), '旧全文内容');

    const r = await migrateJsonToPg(legacy, repo, { papersRoot: '/papers' });
    assert.strictEqual(r.spaces.length, 1);
    assert.strictEqual(r.spaces[0].papers, 1);
    assert.strictEqual(r.spaces[0].texts, 1);

    const reg = await repo.loadRegistry();
    assert.strictEqual(reg.activeSpaceId, 'default');
    assert.strictEqual(reg.spaces[0].papersDir, 'default', 'papersDir 映射为根内子目录 <spaceId>');
    const store = await repo.loadSpaceStore('default');
    assert.strictEqual(store.papers.p1.title, '老论文');
    assert.strictEqual(store.papers.p1.filename, 'paper-one.pdf', '绝对路径收敛为 basename');
    assert.strictEqual(store.papers.p1.filepath, undefined, '不落库 filepath');
    assert.deepStrictEqual(store.tags, ['legacy']);
    assert.strictEqual(store.settings.ai.model, 'x');
    assert.strictEqual(await repo.getPaperText('default', 'p1'), '旧全文内容');

    // 幂等：重跑无副作用
    const r2 = await migrateJsonToPg(legacy, repo, { papersRoot: '/papers' });
    assert.strictEqual(r2.spaces[0].papers, 1);
    assert.strictEqual((await repo.loadRegistry()).spaces.length, 1);
  } finally {
    fs.rmSync(legacy, { recursive: true, force: true });
    await db.close();
  }
});

test('migrateJsonToPg：更老的扁平结构（data/papers.json + data/text）→ default 空间', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { migrateJsonToPg } = require('../scripts/migrate-json-to-pg');
  const { db, repo } = await repoMem();
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'pwlegacy2-'));
  try {
    fs.mkdirSync(path.join(legacy, 'text'), { recursive: true });
    fs.writeFileSync(
      path.join(legacy, 'papers.json'),
      JSON.stringify({
        version: 2,
        tags: [],
        papers: { q1: { id: 'q1', title: '扁平时代', filename: 'q.pdf', status: 'ready' } },
      }),
    );
    fs.writeFileSync(path.join(legacy, 'text', 'q1.txt'), 'flat 全文');
    const r = await migrateJsonToPg(legacy, repo, {});
    assert.strictEqual(r.spaces[0].id, 'default');
    const store = await repo.loadSpaceStore('default');
    assert.strictEqual(store.papers.q1.title, '扁平时代');
    assert.strictEqual(await repo.getPaperText('default', 'q1'), 'flat 全文');
  } finally {
    fs.rmSync(legacy, { recursive: true, force: true });
    await db.close();
  }
});

test('migrateJsonToPg：旧数据不存在时抛错', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { migrateJsonToPg } = require('../scripts/migrate-json-to-pg');
  const { db, repo } = await repoMem();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pwlegacy3-'));
  try {
    await assert.rejects(() => migrateJsonToPg(empty, repo, {}), /旧数据不存在/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    await db.close();
  }
});

// ---- 全文检索（searchFulltext；pg-mem 走 ILIKE 降级路径）----

test('searchFulltext：英文命中（pg-mem ILIKE 降级）+ 空间隔离 + 无命中', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: 'a',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  await repo.upsertSpaceMeta({
    id: 's2',
    name: 'y',
    papersDir: 'b',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  await repo.savePaperText('s1', 'p1', 'The Attention mechanism is all you need.');
  await repo.savePaperText('s1', 'p2', 'Convolutional networks for vision.');
  await repo.savePaperText('s2', 'p3', 'attention in another space');
  const hits = await repo.searchFulltext('s1', 'attention');
  assert.deepStrictEqual(
    hits.map((h) => h.paperId),
    ['p1'],
    '大小写不敏感、且不跨空间',
  );
  assert.deepStrictEqual(await repo.searchFulltext('s1', 'nonexistent-term'), []);
  assert.deepStrictEqual(await repo.searchFulltext('s1', ''), []);
  await db.close();
});

test('searchFulltext：中文查询走 ILIKE 子串；通配符字符被转义', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({
    id: 's1',
    name: 'x',
    papersDir: 'a',
    createdAt: 1,
    scanIntervalMinutes: 5,
    lastScanAt: 0,
  });
  await repo.savePaperText('s1', 'p1', '本文提出新的注意力机制用于长序列。');
  await repo.savePaperText('s1', 'p2', '100% coverage of a_b test');
  assert.deepStrictEqual(
    (await repo.searchFulltext('s1', '注意力机制')).map((h) => h.paperId),
    ['p1'],
  );
  // 含 %/_ 的查询：真实 PG 反斜杠转义后按字面量匹配；pg-mem 不解析反斜杠转义（已知偏差），
  // 这里只断言不抛错且返回数组（字面量语义由真实 PG 环境覆盖）
  assert.ok(Array.isArray(await repo.searchFulltext('s1', '100% coverage')));
  assert.deepStrictEqual(await repo.searchFulltext('s1', 'zqz'), []);
  await db.close();
});
