const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { backupStoreObject } = require('../src/core/store');

// 本文件补充 tests/store.test.js 未覆盖的 backupStoreObject 边界：
// store.test.js 已覆盖「快照创建 / 同日幂等 / 超额裁剪到 7 份」，
// 这里补「裁剪顺序（删最旧）」「不匹配文件名忽略」「损坏备份目录 / 不可序列化 store 的容错」。
// server.js 的 backupAllSpaces 只是遍历空间调用 backupStoreObject，与 http listen 强耦合，故不重构、不测。

function mkStore(id) {
  return {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { [id]: { id } },
  };
}

function matchingFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^papers-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
}

test('backupStoreObject：超额时按文件名顺序删除最旧的备份，保留最新 7 份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-ord-'));
  try {
    // 预置 8 份旧备份（2020-01-01 ~ 2020-01-08），加今日共 9 份 → 应删最旧 2 份
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(path.join(dir, `papers-2020-01-0${i}.json`), '{}', 'utf8');
    }
    await backupStoreObject(dir, mkStore('p1'));
    const files = matchingFiles(dir);
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(files.length, 7, '9 份应裁剪到 7 份');
    assert.ok(!files.includes('papers-2020-01-01.json'), '最旧的一份应被删除');
    assert.ok(!files.includes('papers-2020-01-02.json'), '次旧的一份应被删除');
    assert.ok(files.includes('papers-2020-01-03.json'), '第 3 旧（新的第 1 名）应保留');
    assert.ok(files.includes('papers-2020-01-08.json'), '旧备份中最新的一份应保留');
    assert.strictEqual(files[files.length - 1], `papers-${today}.json`, '今日快照排在最新');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupStoreObject：不匹配命名规则的文件不参与裁剪、不被删除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-ign-'));
  try {
    // 7 份匹配备份 + 今日 = 8 份 → 裁 1 份最旧；其余杂文件应原样保留
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(dir, `papers-2020-01-0${i}.json`), '{}', 'utf8');
    }
    const junk = [
      'papers-20200101.json', // 无连字符
      'papers-2020-1-1.json', // 非两位月/日
      'papers-2020-01-01.txt', // 非 json 后缀
      'notes-2020-01-01.json', // 前缀不同
      'papers-2020-13-99.json.bak', // 后缀不对
    ];
    for (const f of junk) fs.writeFileSync(path.join(dir, f), 'junk', 'utf8');
    await backupStoreObject(dir, mkStore('p1'));
    const files = matchingFiles(dir);
    assert.strictEqual(files.length, 7, '匹配备份裁剪到 7 份');
    assert.ok(!files.includes('papers-2020-01-01.json'), '最旧的匹配备份被删除');
    for (const f of junk) {
      assert.ok(fs.existsSync(path.join(dir, f)), `杂文件 ${f} 不应被删除`);
    }
    // 目录总文件数 = 7 匹配备份 + 5 杂文件
    assert.strictEqual(fs.readdirSync(dir).length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupStoreObject：备份目录路径被普通文件占用时不抛错（只记日志）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-bad-'));
  try {
    const blocked = path.join(dir, 'blocked'); // 作为 backupDir 传入，但它是个普通文件
    fs.writeFileSync(blocked, 'i am a file', 'utf8');
    // mkdir(recursive) 会对已存在的普通文件路径抛 EEXIST/ENOTDIR → 应被内部 catch 吞掉
    await assert.doesNotReject(() => backupStoreObject(blocked, mkStore('p1')), '目录不可用不应抛错');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupStoreObject：不可序列化 store（循环引用）不抛错，且当天可重试成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-circ-'));
  try {
    const circular = mkStore('p1');
    circular.self = circular; // JSON.stringify 抛 TypeError
    await assert.doesNotReject(() => backupStoreObject(dir, circular), '序列化失败不应抛错');
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `papers-${today}.json`);
    assert.ok(!fs.existsSync(dest), '失败的备份不应留下快照文件');
    // 失败后 lastBackupDates 未记录 → 同一天用合法 store 重试应能成功写入
    await backupStoreObject(dir, mkStore('p2'));
    assert.ok(fs.existsSync(dest), '失败后同日重试应能补写快照');
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.ok(loaded.papers.p2, '重试写入的是新的合法 store');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupStoreObject：非对象 store（序列化结果不是 { 开头）视为失败、不写文件、不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-arr-'));
  try {
    // 数组 JSON.stringify 后以 '[' 开头 → 触发「序列化结果非 JSON 对象」分支
    await assert.doesNotReject(() => backupStoreObject(dir, [1, 2, 3]));
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(!fs.existsSync(path.join(dir, `papers-${today}.json`)), '数组 store 不应写入快照');
    // 未记 lastBackupDates → 同日用对象重试成功
    await backupStoreObject(dir, mkStore('p3'));
    const loaded = JSON.parse(fs.readFileSync(path.join(dir, `papers-${today}.json`), 'utf8'));
    assert.ok(loaded.papers.p3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupStoreObject：不同 backupDir 的按天去重互不影响', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pwbak-b-'));
  try {
    const today = new Date().toISOString().slice(0, 10);
    await backupStoreObject(dirA, mkStore('pa'));
    await backupStoreObject(dirB, mkStore('pb'));
    assert.ok(fs.existsSync(path.join(dirA, `papers-${today}.json`)), '空间 A 应有快照');
    assert.ok(fs.existsSync(path.join(dirB, `papers-${today}.json`)), '空间 B 同日也应有快照（按目录分别去重）');
    // A 目录同日再备 → 幂等不覆盖
    await backupStoreObject(dirA, mkStore('pa2'));
    const loaded = JSON.parse(fs.readFileSync(path.join(dirA, `papers-${today}.json`), 'utf8'));
    assert.ok(!loaded.papers.pa2, 'A 目录同日第二次不覆盖');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
