const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createScanner } = require('../src/services/scanner');
const { mergeFormulas: realMergeFormulas } = require('../src/core/formulas');

/** 内存版全文存取（同 scanner.test.js 的 memTextStore） */
function memTextStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    load: async (id) => (m.has(id) ? m.get(id) : null),
    save: async (id, t) => {
      m.set(id, t);
    },
    remove: async (id) => {
      m.delete(id);
    },
  };
}

function fixture(dir) {
  fs.writeFileSync(path.join(dir, 'x.pdf'), Buffer.from('%PDF-1.4\n%x\n'));
  return {
    version: 2,
    tags: [],
    concepts: [],
    formulas: [],
    settings: {},
    papers: {
      x: {
        id: 'x',
        filename: 'x.pdf',
        filepath: path.join(dir, 'x.pdf'),
        title: 'T',
        abstract: 'A',
        authors: ['A'],
        year: 2024,
        arxivId: null,
        tags: [],
        topics: [],
        conceptIds: [],
        formulaIds: [],
        status: 'pending',
        error: null,
        updatedAt: 0,
      },
    },
  };
}

function mkDeps(over = {}) {
  return {
    parser: { extractText: async () => ({ text: '全文', charCount: 2, numPages: 1 }) },
    arxiv: { cleanFilenameToTitle: (f) => f },
    ai: {
      summarize: async () => '## TL;DR\nt',
      extractTagsTopics: async () => ({ tags: [], topics: [], metadata: {} }),
      extractConcepts: async () => [],
      buildSummaryMarkdown: (md) => md,
      applySettingsOverride: (c) => c,
      ...(over.ai || {}),
    },
    saveStore: async () => {},
    mergeTags: () => {},
    mergeTopics: () => {},
    mergeConcepts: () => [],
    mergeFormulas: realMergeFormulas,
    config: { ai: { model: 'm' }, arxiv: { enabled: false } },
    rateLimitArxiv: async () => {},
    ...(over.rest || {}),
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pwformula-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ==================== processOne 步骤 6 ====================

test('processOne 步骤 6：抽取公式并入清单，p.formulaIds 由 occurrences 反查', async () => {
  const dir = tmp();
  const store = fixture(dir);
  let sawExisting = null;
  const deps = mkDeps({
    ai: {
      extractFormulas: async ({ existingFormulas }) => {
        sawExisting = (existingFormulas || []).slice(); // 快照：store.formulas 是同一引用，随后会被 merge 填充
        return [
          { canonicalName: 'softmax', name: '归一化指数函数', latex: '\\sigma(z)', rawLatex: 'sm(z)' },
          { canonicalName: 'elbo', latex: '\\mathcal{L}' },
        ];
      },
    },
  });
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  const p = store.papers.x;
  assert.strictEqual(p.status, 'ready');
  assert.deepStrictEqual(sawExisting, [], '首次抽取时已有公式列表为空');
  assert.strictEqual(store.formulas.length, 2);
  assert.deepStrictEqual(
    p.formulaIds.slice().sort(),
    store.formulas.map((f) => f.id).sort(),
    'formulaIds 覆盖本篇涉及的全部条目',
  );
  assert.strictEqual(store.formulas.find((f) => f.canonicalName === 'softmax').occurrences[0].rawLatex, 'sm(z)');
  scanner.stop();
  rm(dir);
});

test('processOne 步骤 6：公式抽取抛错不影响入库（仍 ready）', async () => {
  const dir = tmp();
  const store = fixture(dir);
  const deps = mkDeps({
    ai: {
      extractFormulas: async () => {
        throw new Error('gateway 500');
      },
    },
  });
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(store.papers.x.status, 'ready', '公式失败不阻塞 ready');
  assert.strictEqual(store.papers.x.error, null);
  assert.deepStrictEqual(store.formulas, []);
  scanner.stop();
  rm(dir);
});

test('processOne 步骤 6：deps 未注入 mergeFormulas 时安全跳过（老装配兼容）', async () => {
  const dir = tmp();
  const store = fixture(dir);
  const deps = mkDeps({ ai: { extractFormulas: async () => [{ canonicalName: 'a', latex: 'x' }] } });
  delete deps.mergeFormulas;
  const scanner = createScanner({ store, textStore: memTextStore(), papersDir: dir, deps, scanIntervalMs: 0 });
  scanner.enqueue(['x']);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(store.papers.x.status, 'ready');
  assert.deepStrictEqual(store.formulas, []);
  scanner.stop();
  rm(dir);
});

// ==================== scanner.extractFormulas（批量重抽） ====================

test('scanner.extractFormulas：串行处理 + 单参 saveStore + 返回 {processed, added}', async () => {
  const dir = tmp();
  const store = fixture(dir);
  store.papers.y = { ...store.papers.x, id: 'y', filename: 'y.pdf' };
  const saveArgs = [];
  const order = [];
  const deps = mkDeps({
    ai: {
      extractFormulas: async ({ title }) => {
        order.push('start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('end');
        return [{ canonicalName: 'shared-formula', latex: 'x', name: title }];
      },
    },
    rest: {
      saveStore: async (...args) => {
        saveArgs.push(args);
      },
    },
  });
  const text = { load: async () => '全文', save: async () => {}, remove: async () => {} };
  const scanner = createScanner({ store, textStore: text, papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.extractFormulas(['x', 'y']);
  assert.deepStrictEqual(r, { processed: 2, added: 1 }, '两篇都处理，公式合并为一条');
  assert.deepStrictEqual(order, ['start', 'end', 'start', 'end'], '串行，不并发压垮网关');
  assert.strictEqual(saveArgs.length, 1, '最后一次性保存');
  assert.strictEqual(saveArgs[0].length, 1, 'saveStore 必须单参（陷阱 1）');
  assert.strictEqual(store.formulas.length, 1);
  assert.deepStrictEqual(store.formulas[0].paperIds, ['x', 'y']);
  assert.deepStrictEqual(store.papers.x.formulaIds, [store.formulas[0].id]);
  assert.deepStrictEqual(store.papers.y.formulaIds, [store.formulas[0].id]);
  scanner.stop();
  rm(dir);
});

test('scanner.extractFormulas：无全文 / 不存在的论文跳过，不计入 processed', async () => {
  const dir = tmp();
  const store = fixture(dir);
  let called = 0;
  const deps = mkDeps({
    ai: {
      extractFormulas: async () => {
        called++;
        return [];
      },
    },
  });
  const text = { load: async () => '', save: async () => {}, remove: async () => {} };
  const scanner = createScanner({ store, textStore: text, papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.extractFormulas(['x', 'nonexistent']);
  assert.deepStrictEqual(r, { processed: 0, added: 0 });
  assert.strictEqual(called, 0);
  scanner.stop();
  rm(dir);
});

test('scanner.extractFormulas：单篇抛错不影响其余篇（继续处理）', async () => {
  const dir = tmp();
  const store = fixture(dir);
  store.papers.y = { ...store.papers.x, id: 'y', filename: 'y.pdf' };
  const deps = mkDeps({
    ai: {
      extractFormulas: async ({ title }) => {
        if (title === 'boom') throw new Error('bad');
        return [{ canonicalName: 'ok-formula', latex: 'x' }];
      },
    },
  });
  store.papers.x.title = 'boom';
  const text = { load: async () => '全文', save: async () => {}, remove: async () => {} };
  const scanner = createScanner({ store, textStore: text, papersDir: dir, deps, scanIntervalMs: 0 });
  const r = await scanner.extractFormulas(['x', 'y']);
  assert.deepStrictEqual(r, { processed: 1, added: 1 }, 'x 失败不计 processed，y 正常');
  assert.strictEqual(store.formulas.length, 1);
  assert.deepStrictEqual(store.formulas[0].paperIds, ['y']);
  scanner.stop();
  rm(dir);
});

test('scanner.extractFormulas：公式提示词三级回退（settings > config > 内置）', async () => {
  const dir = tmp();
  const store = fixture(dir);
  const seen = [];
  const deps = mkDeps({
    ai: {
      extractFormulas: async ({ prompt }) => {
        seen.push(prompt);
        return [];
      },
    },
  });
  deps.config.formulaPrompt = 'config 级提示词';
  const text = { load: async () => '全文', save: async () => {}, remove: async () => {} };
  const scanner = createScanner({ store, textStore: text, papersDir: dir, deps, scanIntervalMs: 0 });
  await scanner.extractFormulas(['x']);
  assert.strictEqual(seen[0], 'config 级提示词');
  store.settings.formulaPrompt = 'settings 级提示词';
  await scanner.extractFormulas(['x']);
  assert.strictEqual(seen[1], 'settings 级提示词', 'settings 优先于 config');
  delete deps.config.formulaPrompt;
  store.settings.formulaPrompt = '';
  await scanner.extractFormulas(['x']);
  assert.strictEqual(seen[2], undefined, '都没有时传 undefined → ai 层用内置默认');
  scanner.stop();
  rm(dir);
});

test('scanner.extractFormulas：重复抽取幂等（occurrence 覆盖，不重复计 added）', async () => {
  const dir = tmp();
  const store = fixture(dir);
  const deps = mkDeps({
    ai: { extractFormulas: async () => [{ canonicalName: 'idem', latex: 'x', rawLatex: 'raw' }] },
  });
  const text = { load: async () => '全文', save: async () => {}, remove: async () => {} };
  const scanner = createScanner({ store, textStore: text, papersDir: dir, deps, scanIntervalMs: 0 });
  const r1 = await scanner.extractFormulas(['x']);
  const r2 = await scanner.extractFormulas(['x']);
  assert.strictEqual(r1.added, 1);
  assert.strictEqual(r2.added, 0, '第二次不新增条目');
  assert.strictEqual(store.formulas.length, 1);
  assert.strictEqual(store.formulas[0].occurrences.length, 1, 'occurrence 覆盖而非追加');
  scanner.stop();
  rm(dir);
});
