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

test('noteCards（jsonb 列）roundtrip：数组形状保真 + meta 不丢 + 参与 hash-diff', async () => {
  const { repo } = await repoMem();
  const store = sampleStore();
  store.papers.p1.noteCards = [
    { id: 'nc-1', type: 'qa', title: 'Q: t', body: 'b', meta: { question: 't', mi: 3 }, createdAt: 1, updatedAt: 1 },
  ];
  await repo.saveSpaceStore('default', store);
  const loaded = await repo.loadSpaceStore('default');
  // jsonb 保真：仍是 JS 数组（未被 node-pg 序列化成 PG 数组字面量 {a,b}）
  assert.ok(Array.isArray(loaded.papers.p1.noteCards));
  assert.strictEqual(loaded.papers.p1.noteCards.length, 1);
  assert.strictEqual(loaded.papers.p1.noteCards[0].type, 'qa');
  assert.deepStrictEqual(loaded.papers.p1.noteCards[0].meta, { question: 't', mi: 3 });
  // 未写字段时 roundtrip 为 null（不炸）
  assert.strictEqual(loaded.papers.p1.customFutureField, 42); // extra 兜底不受影响
  // 改 noteCards → hash-diff 应检出变更并写库（二次保存后可见）
  loaded.papers.p1.noteCards.push({ id: 'nc-2', type: 'manual', title: 'm', body: 'x', createdAt: 2, updatedAt: 2 });
  await repo.saveSpaceStore('default', loaded);
  const loaded2 = await repo.loadSpaceStore('default');
  assert.strictEqual(loaded2.papers.p1.noteCards.length, 2);
  assert.strictEqual(loaded2.papers.p1.noteCards[1].type, 'manual');
});

test('noteCards 未设置时 roundtrip 为 null（undefined → null 稳定 hash）', async () => {
  const { repo } = await repoMem();
  await repo.saveSpaceStore('default', sampleStore());
  const loaded = await repo.loadSpaceStore('default');
  assert.strictEqual(loaded.papers.p1.noteCards, null);
});

// ---- v3.2 searchFulltext opts.ids 子集 / limit 钳制 / NUL 剥离 / 列映射直测 ----

test('searchFulltext：opts.ids 子集限定搜索范围；空 ids 数组立即返回空', async () => {
  const { db, repo } = await repoMem();
  await repo.savePaperText('s1', 'p1', '本文提出新的注意力机制。');
  await repo.savePaperText('s1', 'p2', '另一篇也讨论注意力问题。');
  // ids 子集：两篇都含关键词，但只搜 p1
  const sub = await repo.searchFulltext('s1', '注意力', { ids: ['p1'] });
  assert.deepStrictEqual(
    sub.map((h) => h.paperId),
    ['p1'],
    '只命中 ids 子集内的论文',
  );
  // ids 含不存在的 id：照常只返回真实命中的
  const sub2 = await repo.searchFulltext('s1', '注意力', { ids: ['p2', 'p9'] });
  assert.deepStrictEqual(sub2.map((h) => h.paperId), ['p2']);
  // 空 ids 数组 = 无候选 → 直接返回 []
  assert.deepStrictEqual(await repo.searchFulltext('s1', '注意力', { ids: [] }), []);
  await db.close();
});

test('searchFulltext：limit 钳制（0→默认 30、负数→1、>100→100）', async () => {
  const { db, repo } = await repoMem();
  await repo.savePaperText('s1', 'p1', '注意力机制 A。');
  await repo.savePaperText('s1', 'p2', '注意力机制 B。');
  // limit 0：Number(0) || 30 → 默认 30 → 两篇全回
  assert.strictEqual((await repo.searchFulltext('s1', '注意力', { limit: 0 })).length, 2);
  // 负数：Math.max(1, -5) → 1
  assert.strictEqual((await repo.searchFulltext('s1', '注意力', { limit: -5 })).length, 1);
  // 超过 100：钳到 100（库内仅 2 篇，全回且不报错）
  assert.strictEqual((await repo.searchFulltext('s1', '注意力', { limit: 1000 })).length, 2);
  // 正常 limit=1 只回 1 篇
  assert.strictEqual((await repo.searchFulltext('s1', '注意力', { limit: 1 })).length, 1);
  await db.close();
});

test('savePaperText：写入前剥离 NUL 字节（PG TEXT 拒绝 0x00）', async () => {
  const { db, repo } = await repoMem();
  await repo.savePaperText('s1', 'p1', 'abc\u0000def\u0000ghi');
  assert.strictEqual(await repo.getPaperText('s1', 'p1'), 'abcdefghi');
  // null/undefined 归一为空串，不抛错
  await repo.savePaperText('s1', 'p2', null);
  assert.strictEqual(await repo.getPaperText('s1', 'p2'), '');
  await db.close();
});

test('paperToRow：未设字段→null、jsonb 列 undefined→null、未知键只进 extra、派生键忽略', () => {
  const { paperToRow } = require('../src/db');
  const row = paperToRow({ id: 'x', futureField: 1, filepath: '/a/x.pdf', fulltextPath: '/t/x.txt' });
  assert.strictEqual(row.id, 'x');
  assert.strictEqual(row.title, null, '未设普通字段 → null');
  assert.strictEqual(row.authors, null, 'jsonb 列 undefined → null');
  assert.strictEqual(row.note_cards, null);
  assert.deepStrictEqual(row.extra, { futureField: 1 }, '未知键只进 extra');
  assert.ok(!('filepath' in row), '派生字段 filepath 不落行');
  assert.ok(!('fulltextPath' in row.extra), '废弃字段不进 extra');
  // 无未知键时 extra 为 null（保证 hash 稳定）
  const row2 = paperToRow({ id: 'y', title: 'T' });
  assert.strictEqual(row2.extra, null);
});

test('paperToRow/rowToPaper：完整 paper roundtrip 字段保真', () => {
  const { paperToRow, rowToPaper } = require('../src/db');
  const paper = {
    id: 'p1',
    filename: 'a.pdf',
    fileMtime: 100,
    fileSize: 200,
    addedAt: 300,
    updatedAt: 400,
    title: 'T',
    year: 2024,
    abstract: 'abs',
    arxivId: '2401.00001',
    arxivUrl: 'https://arxiv.org/abs/2401.00001',
    primaryCategory: 'cs.CL',
    metaSource: 'arxiv',
    metaConfidence: 0.9,
    fulltextChars: 1234,
    summary: 's',
    summaryModel: 'm',
    summaryAt: 500,
    notes: 'n',
    noteCards: [{ id: 'nc', type: 'qa', title: 'q', body: 'b' }],
    rating: 4,
    starred: true,
    readStatus: 'reading',
    status: 'ready',
    error: null,
    authors: ['Alice', 'Bob'],
    tags: ['llm'],
    topics: ['推理'],
    conceptIds: ['c1'],
    folders: ['f1'],
    readProgress: { page: 3 },
    annotations: [{ page: 1, text: 'hi' }],
    chat: [{ role: 'user', content: 'q' }],
    futureField: { z: 9 },
  };
  const back = rowToPaper(paperToRow(paper));
  for (const k of Object.keys(paper)) {
    assert.deepStrictEqual(back[k], paper[k], `字段 ${k} roundtrip 应保真`);
  }
  assert.strictEqual(back.fulltextPath, null, '废弃字段固定 null');
  assert.strictEqual(back.filepath, undefined, '派生字段不回填');
});

test('hash-diff：改 concepts 只写概念行；删 folder 行消失；settings 变更经 dict 路径持久化', async () => {
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
  let w = repo._stats().rowsWritten;
  // 只改 concepts（新增一条）→ 只写 1 行
  store.concepts.push({ id: 'c2', term: 'RLHF', definition: 'd2', paperIds: [], createdAt: 2, updatedAt: 2 });
  await repo.saveSpaceStore('s1', store);
  assert.strictEqual(repo._stats().rowsWritten, w + 1, 'concepts 变更只写概念行');
  let loaded = await repo.loadSpaceStore('s1');
  assert.strictEqual(loaded.concepts.length, 2);
  // 删除 folder f1 → 库中 folders 表行消失
  w = repo._stats().rowsWritten;
  store.folders = [];
  await repo.saveSpaceStore('s1', store);
  assert.strictEqual(repo._stats().rowsWritten, w + 1, 'folder 删除只写 1 行');
  const fr = await db.query("SELECT * FROM folders WHERE space_id='s1'");
  assert.strictEqual(fr.rows.length, 0, 'folder 行已删除');
  loaded = await repo.loadSpaceStore('s1');
  assert.strictEqual(loaded.folders.length, 0);
  // settings 变更 → dictChanged 路径 UPDATE spaces，重载可见
  w = repo._stats().rowsWritten;
  store.settings = { summaryPrompt: 'y' };
  await repo.saveSpaceStore('s1', store);
  assert.strictEqual(repo._stats().rowsWritten, w + 1, 'settings 变更写 spaces 行');
  loaded = await repo.loadSpaceStore('s1');
  assert.strictEqual(loaded.settings.summaryPrompt, 'y');
  await db.close();
});

test('upsertSpaceMeta：缺省 scanIntervalMinutes/lastScanAt 落库为 0', async () => {
  const { db, repo } = await repoMem();
  await repo.upsertSpaceMeta({ id: 's1', name: 'x', papersDir: '.' });
  const reg = await repo.loadRegistry();
  assert.strictEqual(reg.spaces[0].scanIntervalMinutes, 0, '缺省扫描间隔 → 0');
  assert.strictEqual(reg.spaces[0].lastScanAt, 0, '缺省 lastScanAt → 0');
  assert.strictEqual(reg.spaces[0].createdAt, 0, '缺省 createdAt → 0');
  await db.close();
});
