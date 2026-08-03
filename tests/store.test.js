const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadStore,
  saveStore,
  upsertPaper,
  patchPaper,
  mergeTags,
  mergeTopics,
  mergeConcepts,
  deleteConcept,
  addFolder,
  deleteFolder,
  conceptIdFor,
  conceptsToMarkdown,
  migrateStore,
} = require('../src/core/store');

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

test('saveStore 拒绝写入非法 store（字符串/无 papers 段），防污染 papers.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-saveguard-'));
  const p = path.join(dir, 'papers.json');
  // 先写一份有效数据
  const good = {
    version: 2,
    tags: ['t'],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { a: { id: 'a' } },
  };
  await saveStore(p, good);
  // 尝试用各种非法值覆盖（历史 bug：storePath 字符串被当 store 传入）
  for (const bad of [p, 'somestring', null, 42, [], { tags: ['x'] }]) {
    await assert.rejects(() => saveStore(p, bad), /拒绝写入|papers 段/);
  }
  // 验证：原有效数据未被破坏
  const final = await loadStore(p);
  assert.ok(final.papers && final.papers.a, '有效数据应未被非法写入破坏');
});

test('loadStore 遇到损坏的 JSON 时备份（copyFile 保留原件）并返回空 store，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-corrupt-'));
  const p = path.join(dir, 'papers.json');
  fs.writeFileSync(p, 'this is not json {{', 'utf8');
  const store = await loadStore(p); // 不应抛错
  assert.deepStrictEqual(store.papers, {});
  assert.deepStrictEqual(store.tags, []);
  // 新行为：copyFile 备份（保留原文件以便排查），原文件仍在
  assert.ok(fs.existsSync(p), '原损坏文件应保留（copyFile 备份）');
  const bak = fs.readdirSync(dir).find((f) => f.startsWith('papers.json.corrupt-'));
  assert.ok(bak, '应有 .corrupt- 备份');
});

test('loadStore 损坏时优先从备份恢复，而非静默回空（防数据丢失）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-recover-'));
  const p = path.join(dir, 'papers.json');
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  // 先放一份有效的每日备份（含真实数据）
  const goodData = {
    version: 2,
    tags: ['saved'],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { x: { id: 'x', title: 'Recovered', tags: ['saved'], topics: [], status: 'ready', summary: 'OK' } },
  };
  fs.writeFileSync(path.join(backupDir, 'papers-2026-01-01.json'), JSON.stringify(goodData), 'utf8');
  // 再把主文件搞坏
  fs.writeFileSync(p, 'CORRUPT', 'utf8');
  const store = await loadStore(p);
  // 应回空——但优先从备份恢复（不静默丢数据）
  assert.ok(store.papers && store.papers.x, '应从备份恢复论文 x，而非回空');
  assert.strictEqual(store.papers.x.title, 'Recovered');
});

test('loadStore 遇到「合法 JSON 但非对象」（如被写成路径字符串）时同样恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-str-'));
  const p = path.join(dir, 'papers.json');
  // 复现真实事故：文件内容是一个 JSON 字符串字面量（合法 JSON，但不是对象）
  fs.writeFileSync(p, JSON.stringify(p), 'utf8');
  const store = await loadStore(p);
  assert.deepStrictEqual(store.papers, {}); // 无备份 → 回空
  assert.strictEqual(store.version, 2);
});

test('migrateStore 把 v1 数据补齐为 v2（topics/folders/concepts + 论文字段）', () => {
  const v1 = { version: 1, tags: ['x'], papers: { a: { id: 'a', title: 'T', tags: ['x'], status: 'ready' } } };
  const m = migrateStore(v1);
  assert.strictEqual(m.version, 2);
  assert.deepStrictEqual(m.topics, []);
  assert.deepStrictEqual(m.folders, []);
  assert.deepStrictEqual(m.concepts, []);
  assert.deepStrictEqual(m.papers.a.topics, []);
  assert.deepStrictEqual(m.papers.a.folders, []);
  assert.strictEqual(m.papers.a.readProgress, null);
  assert.deepStrictEqual(m.papers.a.conceptIds, []);
});

test('mergeTopics 大小写不敏感去重并保留首次写法', () => {
  const store = { version: 2, topics: ['强化学习'] };
  mergeTopics(store, ['强化学习', '推理', '数据选择']);
  assert.deepStrictEqual(store.topics.sort(), ['强化学习', '推理', '数据选择'].sort());
});

test('conceptIdFor 对同一归一化 term 返回稳定 id', () => {
  assert.strictEqual(conceptIdFor('RLHF'), conceptIdFor('rlhf'));
  assert.strictEqual(conceptIdFor('Attention'), conceptIdFor('attention '));
  assert.ok(conceptIdFor('foo').startsWith('c_'));
});

// 概念 id 已落库（PG concepts.id），hash 算法一旦变动全库概念即失联。
// v3.9 把内联 hash 抽成 stableShortHash 供公式复用，这里钉住已知映射防回归。
test('conceptIdFor 输出逐字节不可变（防 stableShortHash 重构回归）', () => {
  assert.strictEqual(conceptIdFor('RLHF'), 'c_02335k');
  assert.strictEqual(conceptIdFor('attention'), 'c_5uqeoy');
  assert.strictEqual(conceptIdFor('MoE'), 'c_002bk3');
  assert.strictEqual(conceptIdFor('in-context learning'), 'c_ifasix');
  assert.strictEqual(conceptIdFor('Transformer'), 'c_x2ha07');
  assert.strictEqual(conceptIdFor('混合专家'), 'c_e7zzck');
  assert.strictEqual(conceptIdFor(''), 'c_000000');
});

test('stableShortHash 与 formulaIdFor 共用同一算法但命名空间隔离', () => {
  const { stableShortHash } = require('../src/core/store');
  const { formulaIdFor } = require('../src/core/formulas');
  assert.strictEqual('c_' + stableShortHash('rlhf'), conceptIdFor('RLHF'));
  assert.strictEqual('fm_' + stableShortHash('rlhf'), formulaIdFor('RLHF'));
  assert.notStrictEqual(conceptIdFor('RLHF'), formulaIdFor('RLHF'));
});

test('mergeConcepts 首次写入新增，重复 term 仅追加 paperId', () => {
  const store = { version: 2, concepts: [], papers: { p1: { id: 'p1', title: 'A' } } };
  const new1 = mergeConcepts(store, [{ term: 'RLHF', definition: '人类反馈强化学习' }], 'p1');
  assert.strictEqual(new1.length, 1);
  assert.strictEqual(store.concepts.length, 1);
  assert.strictEqual(store.concepts[0].paperIds.length, 1);
  // 第二篇带相同 term：不应新增，但 paperIds 应合并、definition 不被空值覆盖
  const new2 = mergeConcepts(store, [{ term: 'rlhf', definition: '' }], 'p2');
  assert.strictEqual(new2.length, 0);
  assert.strictEqual(store.concepts.length, 1);
  assert.strictEqual(store.concepts[0].paperIds.length, 2);
  assert.strictEqual(store.concepts[0].definition, '人类反馈强化学习');
});

test('deleteConcept 从清单移除并清理 paper.conceptIds', () => {
  const store = { version: 2, concepts: [], papers: { p1: { id: 'p1', title: 'A', conceptIds: [] } } };
  const [id] = mergeConcepts(store, [{ term: 'PPO', definition: 'd' }], 'p1');
  store.papers.p1.conceptIds = [id];
  assert.ok(deleteConcept(store, id));
  assert.strictEqual(store.concepts.length, 0);
  assert.deepStrictEqual(store.papers.p1.conceptIds, []);
  assert.strictEqual(deleteConcept(store, id), false); // 已删除
});

test('addFolder / deleteFolder 管理收藏夹并解绑论文', () => {
  const store = { version: 2, folders: [], papers: { p1: { id: 'p1', folders: [] } } };
  const f = addFolder(store, '精读', '#2563eb');
  assert.strictEqual(store.folders.length, 1);
  store.papers.p1.folders = [f.id];
  deleteFolder(store, f.id);
  assert.strictEqual(store.folders.length, 0);
  assert.deepStrictEqual(store.papers.p1.folders, []);
});

test('conceptsToMarkdown 按首字母分组且空清单有提示', () => {
  const empty = conceptsToMarkdown({ version: 2, concepts: [], papers: {} });
  assert.ok(empty.includes('暂无概念'));
  const md = conceptsToMarkdown({
    version: 2,
    concepts: [{ term: 'Attention', definition: '注意力机制', paperIds: ['p1'] }],
    papers: { p1: { id: 'p1', title: 'A 论文' } },
  });
  assert.ok(md.includes('# 概念清单'));
  assert.ok(md.includes('### Attention'));
  assert.ok(md.includes('注意力机制'));
  assert.ok(md.includes('A 论文'));
});

test('migrateStore 补星级 rating（starred:true→5、缺省→0、clamp 0-5，starred 与 rating>0 互为镜像）', () => {
  const data = {
    version: 1,
    papers: {
      a: { id: 'a', starred: true },
      b: { id: 'b' },
      c: { id: 'c', rating: 9 },
      d: { id: 'd', rating: 3 },
      e: { id: 'e', rating: 0, starred: true },
    },
  };
  migrateStore(data);
  assert.strictEqual(data.papers.a.rating, 5, 'starred:true → 5 星');
  assert.strictEqual(data.papers.a.starred, true);
  assert.strictEqual(data.papers.b.rating, 0, '缺省 → 0');
  assert.strictEqual(data.papers.b.starred, false);
  assert.strictEqual(data.papers.c.rating, 5, '超界 clamp 到 5');
  assert.strictEqual(data.papers.d.rating, 3);
  assert.strictEqual(data.papers.d.starred, true, 'rating>0 → starred true');
  assert.strictEqual(data.papers.e.rating, 0, 'rating 为准：rating:0 即 0 星');
  assert.strictEqual(data.papers.e.starred, false);
});

test('backupStoreObject：写 JSON 快照、同日幂等、保留 7 份', async () => {
  const os = require('node:os');
  const { backupStoreObject } = require('../src/core/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-'));
  try {
    // 预置 8 份旧备份（触发裁剪）
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(
        path.join(dir, `papers-2020-01-0${i > 7 ? 8 : i}.json`.replace('08', String(i).padStart(2, '0'))),
        '{}',
      );
    }
    const store = {
      version: 2,
      tags: [],
      topics: [],
      folders: [],
      concepts: [],
      settings: {},
      papers: { p1: { id: 'p1' } },
    };
    await backupStoreObject(dir, store);
    const files = fs.readdirSync(dir).filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    assert.strictEqual(files.length, 7, '超额备份应被裁剪到 7 份');
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `papers-${today}.json`);
    assert.ok(fs.existsSync(dest), '今日快照应存在');
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.ok(loaded.papers.p1, '快照内容为 store 序列化');
    // 同日幂等：改 store 再备份，不覆盖当日已有快照
    store.papers.p2 = { id: 'p2' };
    await backupStoreObject(dir, store);
    const again = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.ok(!again.papers.p2, '同日不重复写');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 追加：backupStore / 备份回退 / 循环引用 / 归一化边界 ====================

test('backupStore（legacy 文件备份）：生成当日起始的 papers-YYYY-MM-DD.json 备份', async () => {
  const { backupStore } = require('../src/core/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwlbak-'));
  try {
    const p = path.join(dir, 'papers.json');
    fs.writeFileSync(p, JSON.stringify({ version: 2, tags: [], papers: { a: { id: 'a' } } }), 'utf8');
    await backupStore(p);
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, 'backups', `papers-${today}.json`);
    assert.ok(fs.existsSync(dest), '应在 data/backups/ 生成当日备份文件');
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.ok(loaded.papers.a, '备份内容为 papers.json 拷贝');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLatestBackup 回退：最新备份损坏/空 papers 时落到较旧的有效备份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwfb-'));
  try {
    const p = path.join(dir, 'papers.json');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const valid = {
      version: 2,
      tags: ['old'],
      topics: [],
      folders: [],
      concepts: [],
      settings: {},
      papers: { old1: { id: 'old1', title: 'OldValid', status: 'ready' } },
    };
    // 三份备份：最新是损坏 JSON，次新是合法 JSON 但 papers 为空，最旧是有效数据
    const fOld = path.join(backupDir, 'papers-2020-01-01.json');
    const fEmpty = path.join(backupDir, 'papers-2020-01-02.json');
    const fCorrupt = path.join(backupDir, 'papers-2020-01-03.json');
    fs.writeFileSync(fOld, JSON.stringify(valid), 'utf8');
    fs.writeFileSync(fEmpty, JSON.stringify({ version: 2, papers: {} }), 'utf8');
    fs.writeFileSync(fCorrupt, 'not json {{', 'utf8');
    // mtime 降序排列：corrupt 最新，valid 最旧
    fs.utimesSync(fOld, new Date('2020-01-01'), new Date('2020-01-01'));
    fs.utimesSync(fEmpty, new Date('2020-01-02'), new Date('2020-01-02'));
    fs.utimesSync(fCorrupt, new Date('2020-01-03'), new Date('2020-01-03'));
    // 主文件也损坏 → 触发自愈恢复路径
    fs.writeFileSync(p, 'CORRUPT', 'utf8');
    const store = await loadStore(p);
    assert.ok(store.papers && store.papers.old1, '应跳过损坏/空备份，回退到最旧有效备份');
    assert.strictEqual(store.papers.old1.title, 'OldValid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveStore：循环引用 store 拒绝写入且不破坏原文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwcirc-'));
  try {
    const p = path.join(dir, 'papers.json');
    const good = { version: 2, tags: ['ok'], topics: [], folders: [], concepts: [], settings: {}, papers: { a: { id: 'a' } } };
    await saveStore(p, good);
    const circular = { version: 2, papers: {} };
    circular.self = circular; // 循环引用 → JSON.stringify 抛 TypeError
    await assert.rejects(() => saveStore(p, circular), /circular|JSON/i);
    const final = await loadStore(p);
    assert.ok(final.papers && final.papers.a, '原文件未被破坏');
    // 写锁不被失败卡死：后续合法保存仍可成功
    good.tags = ['ok', 'after'];
    await saveStore(p, good);
    const again = await loadStore(p);
    assert.deepStrictEqual(again.tags.sort(), ['after', 'ok']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizePaper（经 upsertPaper）：chat 非数组→[]、rating 字符串强转、未知字段保留', () => {
  const store = { version: 2, tags: [], papers: {} };
  const saved = upsertPaper(store, {
    id: 'n1',
    title: 'T',
    status: 'ready',
    chat: 'not-an-array',
    rating: '4',
    customField: { a: 1 },
  });
  assert.deepStrictEqual(saved.chat, [], 'chat 非数组 → []');
  assert.strictEqual(saved.rating, 4, 'rating 字符串被数值化');
  assert.strictEqual(saved.starred, true, 'rating>0 → starred 镜像');
  assert.deepStrictEqual(saved.customField, { a: 1 }, '未知字段经展开保留');
  // rating 非法字符串：Math.round('abc')=NaN，经 min/max 后仍 NaN（记录实际行为）
  const saved2 = upsertPaper(store, { id: 'n2', title: 'U', status: 'ready', rating: 'abc' });
  assert.ok(Number.isNaN(saved2.rating), 'rating 非法字符串 → NaN（min/max 不拦截 NaN）');
});

test('normalizeTopic / normalizeTerm：标点、大小写折叠、空白折叠', () => {
  const { normalizeTopic, normalizeTerm } = require('../src/core/store');
  // normalizeTopic：小写 + 去标点（非字母数字→空格）+ 折叠空白
  assert.strictEqual(normalizeTopic('  Mixture-of-Experts! 2024 '), 'mixture of experts 2024');
  assert.strictEqual(normalizeTopic('强化  学习'), '强化 学习');
  assert.strictEqual(normalizeTopic(null), '');
  // normalizeTerm：小写 + 折叠空白 + trim，但保留连字符等标点
  assert.strictEqual(normalizeTerm('  Mixture-of-Experts  '), 'mixture-of-experts');
  assert.strictEqual(normalizeTerm('A   B'), 'a b');
  assert.strictEqual(normalizeTerm('  '), '');
});

test('mergeConcepts：已有概念无 definition 时回填；空 term 跳过', () => {
  const store = { version: 2, concepts: [], papers: {} };
  const ids1 = mergeConcepts(store, [{ term: 'MoE' }], 'p1');
  assert.strictEqual(ids1.length, 1);
  assert.strictEqual(store.concepts[0].definition, '', '首次无 definition → 空串');
  // 同 term（大小写不同）带 definition → 不新增，但回填 definition、合并 paperId
  const ids2 = mergeConcepts(store, [{ term: 'moe', definition: '混合专家' }], 'p2');
  assert.deepStrictEqual(ids2, []);
  assert.strictEqual(store.concepts.length, 1);
  assert.strictEqual(store.concepts[0].definition, '混合专家', 'definition 应被回填');
  assert.deepStrictEqual(store.concepts[0].paperIds, ['p1', 'p2']);
  // 已有 definition 不被新值覆盖
  mergeConcepts(store, [{ term: 'MOE', definition: '别的定义' }], 'p3');
  assert.strictEqual(store.concepts[0].definition, '混合专家', '已有 definition 不被覆盖');
  // 空 term / 全空白 term 跳过
  const ids3 = mergeConcepts(store, [{ term: '' }, { term: '   ' }, {}], 'p1');
  assert.deepStrictEqual(ids3, []);
  assert.strictEqual(store.concepts.length, 1);
});
