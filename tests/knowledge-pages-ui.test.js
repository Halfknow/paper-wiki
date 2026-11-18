// 知识页联动 UI 测试（v3.28）：概念/公式页侧栏新分面（热度/主题/质量）+ 概念详情抽屉 +
// 公式卡相关概念/出处明细/复制按钮。jsdom 驱动真实 index.html + app.js + 假后端。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('knowledge-pages-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = [
  {
    id: 'p1',
    filename: 'a.pdf',
    title: 'Attention Is All You Need',
    authors: ['V'],
    year: '2017',
    abstract: '',
    arxivId: null,
    arxivUrl: null,
    primaryCategory: null,
    metaSource: null,
    metaConfidence: 0,
    fulltextChars: 100,
    summaryExcerpt: '',
    status: 'ready',
    error: null,
    tags: [],
    topics: ['推理'],
    folders: [],
    rating: 0,
    starred: false,
    readStatus: 'unread',
    readProgress: null,
    addedAt: 1,
    updatedAt: 1,
    hasSummary: true,
    hasNotes: false,
    conceptCount: 2,
    formulaCount: 2,
  },
  {
    id: 'p2',
    filename: 'b.pdf',
    title: 'Auto-Encoding Variational Bayes',
    authors: ['K'],
    year: '2014',
    abstract: '',
    arxivId: null,
    arxivUrl: null,
    primaryCategory: null,
    metaSource: null,
    metaConfidence: 0,
    fulltextChars: 50,
    summaryExcerpt: '',
    status: 'ready',
    error: null,
    tags: [],
    topics: ['生成'],
    folders: [],
    rating: 0,
    starred: false,
    readStatus: 'unread',
    readProgress: null,
    addedAt: 2,
    updatedAt: 2,
    hasSummary: true,
    hasNotes: false,
    conceptCount: 1,
    formulaCount: 1,
  },
];

const CONCEPTS = [
  {
    id: 'c_att',
    term: 'Scaled Dot-Product Attention',
    definition: '缩放点积注意力。',
    category: 'attention',
    context: '3.2 节，式(1)',
    importance: 'core',
    source: 'ai',
    paperIds: ['p1', 'p2'],
    createdAt: 100,
    updatedAt: 100,
  },
  {
    id: 'c_att2',
    term: 'Scaled Dot Product Attention',
    definition: '命名漂移产生的重复条目。',
    category: 'attention',
    context: '',
    importance: '',
    source: 'ai',
    paperIds: ['p2'],
    contexts: [],
    createdAt: 50,
    updatedAt: 50,
  },
  {
    id: 'c_lora',
    term: 'LoRA',
    definition: '',
    category: 'training',
    context: '',
    importance: '',
    source: 'ai',
    paperIds: ['p1'],
    createdAt: Date.now() - 86400e3,
    updatedAt: 100, // 1 天前（落在 7d 窗口）
  },
  {
    id: 'c_vae',
    term: 'Variational Autoencoder',
    definition: '变分自编码器。',
    category: 'generative',
    context: '',
    importance: '',
    source: 'ai',
    paperIds: ['p2'],
    createdAt: 1,
    updatedAt: 100, // 远古（不在 7d/30d 窗口）
  },
];

const FORMULAS = [
  {
    id: 'fm_att',
    canonicalName: 'scaled-dot-product-attention',
    name: '缩放点积注意力',
    latex: '\\mathrm{Attention}(Q,K,V)=V',
    description: '做什么：加权聚合。',
    category: 'attention',
    variables: [],
    plottable: true,
    plotHint: { variable: 'x', range: [-6, 6], params: {}, plotExpr: '1/(1+exp(-x))' },
    occurrences: [{ paperId: 'p1', rawLatex: 'QK^T', context: '式(1)', symbolMap: { d_k: 'd' } }],
    paperIds: ['p1'],
    source: 'ai',
    conceptTerms: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'fm_kl',
    canonicalName: 'kl-divergence',
    name: 'KL 散度',
    latex: 'D_{KL}(P\\|Q)',
    description: '',
    category: 'information-theory',
    variables: [],
    plottable: false,
    plotHint: null,
    occurrences: [
      { paperId: 'p1', rawLatex: 'KL[q\\|p]', context: '式(3)', symbolMap: { P: 'q' } },
      { paperId: 'p2', rawLatex: '', context: '', symbolMap: {} },
    ],
    paperIds: ['p1', 'p2'],
    source: 'ai',
    conceptTerms: ['Scaled Dot-Product Attention'],
    createdAt: 2,
    updatedAt: 2,
  },
];

const jsonRes = (data) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ ok: true, data }),
});

let posts; // 记录 POST/PATCH 调用（断言用）

before(async () => {
  posts = [];
  ui = await bootUi({
    listItems: LIST,
    details: {},
    routes: {
      '/api/concepts': ({ method, body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        if (method === 'POST') {
          posts.push({ url: 'POST /api/concepts', op });
          const hit = CONCEPTS.find((c) => c.term.toLowerCase() === String(op.term || '').toLowerCase());
          if (hit) {
            for (const pid of op.paperIds || []) if (!hit.paperIds.includes(pid)) hit.paperIds.push(pid);
            return jsonRes({ concept: hit, merged: true });
          }
          const c = {
            id:
              'c_' +
              String(op.term || '')
                .replace(/\W+/g, '')
                .slice(0, 8),
            term: op.term,
            definition: op.definition || '',
            category: op.category || 'other',
            context: '',
            importance: op.importance || '',
            source: 'manual',
            paperIds: op.paperIds || [],
            contexts: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          CONCEPTS.push(c);
          return jsonRes({ concept: c, merged: false });
        }
        return jsonRes(CONCEPTS);
      },
      '/api/concepts/bulk': ({ body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        posts.push({ url: 'POST /api/concepts/bulk', op });
        const ids = new Set(op.ids || []);
        if (op.delete) {
          for (let i = CONCEPTS.length - 1; i >= 0; i--) if (ids.has(CONCEPTS[i].id)) CONCEPTS.splice(i, 1);
        } else if (typeof op.category === 'string') {
          for (const c of CONCEPTS) if (ids.has(c.id)) c.category = op.category;
        }
        return jsonRes({ updated: ids.size });
      },
      '/api/formulas': ({ method, body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        if (method === 'POST') {
          posts.push({ url: 'POST /api/formulas', op });
          return jsonRes({ formula: { ...FORMULAS[0], id: 'fm_new' }, merged: false });
        }
        return jsonRes(FORMULAS);
      },
      '/api/formulas/bulk': ({ body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        posts.push({ url: 'POST /api/formulas/bulk', op });
        const ids = new Set(op.ids || []);
        if (op.delete) {
          for (let i = FORMULAS.length - 1; i >= 0; i--) if (ids.has(FORMULAS[i].id)) FORMULAS.splice(i, 1);
        } else if (typeof op.category === 'string') {
          for (const f of FORMULAS) if (ids.has(f.id)) f.category = op.category;
        }
        return jsonRes({ updated: ids.size });
      },
      '/api/formulas/fm_kl': ({ body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        posts.push({ url: 'PATCH /api/formulas/fm_kl', op });
        Object.assign(FORMULAS[1], op);
        return jsonRes(FORMULAS[1]);
      },
      '/api/concepts/c_att': ({ body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        Object.assign(CONCEPTS[0], op);
        return jsonRes(CONCEPTS[0]);
      },
      '/api/concepts/merge': ({ body }) => {
        const op = typeof body === 'string' ? JSON.parse(body || '{}') : body || {};
        posts.push({ url: 'POST /api/concepts/merge', op });
        const srcC = CONCEPTS.find((c) => c.id === op.sourceId);
        const tgt = CONCEPTS.find((c) => c.id === op.targetId);
        if (srcC && tgt) {
          tgt.paperIds = [...new Set([...tgt.paperIds, ...srcC.paperIds])];
          tgt.contexts = [...(tgt.contexts || [])];
          for (const x of srcC.contexts || [])
            if (!tgt.contexts.some((y) => y.paperId === x.paperId)) tgt.contexts.push(x);
          const i = CONCEPTS.indexOf(srcC);
          if (i >= 0) CONCEPTS.splice(i, 1);
        }
        return jsonRes({ concept: tgt });
      },
      '/api/settings': () => jsonRes({}),
    },
  });
  assert.ok(ui.document.querySelector('.paper-item'), 'boot 成功');
});

async function openConcepts() {
  ui.document.querySelector('#view-nav [data-view="concepts"]').click();
  await sleep(80);
}

async function openFormulas() {
  ui.document.querySelector('#view-nav [data-view="formulas"]').click();
  await sleep(80);
}

const cards = () => [...ui.document.querySelectorAll('#concepts-grid .concept-card')];
const conceptCardByTerm = (term) =>
  cards().find((c) => c.querySelector('h3') && c.querySelector('h3').textContent === term);

// ---------------------------------------------------------------- 概念页侧栏分面

test('概念页侧栏（v3.28）：热度/主题/质量分面渲染且带计数', async () => {
  await openConcepts();
  const side = () => ui.document.querySelector('#side-concepts');
  const solo = side().querySelector('.side-item[data-freq="solo"]');
  assert.ok(solo, '热度分面有「仅单篇」');
  assert.match(solo.textContent, /3/, '仅单篇计数 = 3（LoRA + VAE + 漂移重复条目）');
  const hot = side().querySelector('.side-item[data-freq="hot"]');
  assert.match(hot.textContent, /0|/, '高频 0 时不显示计数（空串）');
  const topic = side().querySelector('.side-item[data-topic="推理"]');
  assert.ok(topic, '主题分面来自论文 topics');
  assert.match(topic.textContent, /2/, '「推理」主题下 2 个概念（SDPA + LoRA，均出现于 p1）');
  const core = side().querySelector('.side-item[data-quality="core"]');
  assert.match(core.textContent, /1/, '核心创新 = 1（SDPA）');
  const nodef = side().querySelector('.side-item[data-quality="nodef"]');
  assert.match(nodef.textContent, /1/, '缺解释 = 1（LoRA）');
});

test('热度「仅单篇」点击即过滤（写 DSL freq:solo），再点取消', async () => {
  await openConcepts();
  ui.document.querySelector('#side-concepts .side-item[data-freq="solo"]').click();
  await sleep(40);
  assert.match($('search').value, /freq:solo/, '分面写进搜索框 DSL（单一事实源）');
  assert.equal(cards().length, 3, '只剩单篇概念');
  ui.document.querySelector('#side-concepts .side-item[data-freq="solo"]').click();
  await sleep(40);
  assert.equal(cards().length, 4, '再点取消恢复全部（v3.30 fixture 后共 4 条）');
});

test('主题分面点击过滤（topic: 关联论文主题，ANY 命中）', async () => {
  await openConcepts();
  ui.document.querySelector('#side-concepts .side-item[data-topic="生成"]').click();
  await sleep(40);
  assert.match($('search').value, /topic:生成/);
  const terms = cards().map((c) => c.querySelector('h3').textContent);
  assert.ok(
    terms.includes('Variational Autoencoder') && terms.includes('Scaled Dot-Product Attention'),
    'p2 论文的概念命中',
  );
  assert.ok(!terms.includes('LoRA'), 'p1 独有概念被滤掉');
});

test('概念卡（v3.28）：核心徽章 + 章节出处徽章上卡', async () => {
  await openConcepts();
  const att = conceptCardByTerm('Scaled Dot-Product Attention');
  assert.ok(att.querySelector('.imp-badge'), 'importance=core 显示「核心」徽章');
  assert.ok(att.querySelector('.ctx-badge'), 'context 显示出处徽章（map-pin 图标）');
  assert.match(att.querySelector('.ctx-badge').textContent, /3\.2/);
});

// ---------------------------------------------------------------- 概念详情抽屉

test('点击概念卡打开详情抽屉：出现论文 / 共现概念 / 相关公式，Esc 关闭', async () => {
  await openConcepts();
  const att = conceptCardByTerm('Scaled Dot-Product Attention');
  att.click(); // 卡片本体点击（非按钮区）
  await sleep(30);
  const ov = ui.document.querySelector('#concept-detail-overlay');
  assert.ok(ov && ov.classList.contains('open'), '抽屉打开');
  assert.equal(ov.querySelectorAll('.cd-paper').length, 2, '出现论文 2 行');
  assert.ok(ov.querySelector('.cd-paper .cd-topic'), '论文行带主题 chip');
  const coocs = [...ov.querySelectorAll('.cd-cooc-chip')].map((c) => c.textContent);
  assert.ok(
    coocs.some((t) => t.includes('LoRA')),
    '共现概念含 LoRA（p1 同篇）',
  );
  assert.ok(
    coocs.some((t) => t.includes('Variational Autoencoder')),
    '共现概念含 VAE（p2 同篇）',
  );
  const formulas = [...ov.querySelectorAll('.cd-formula-name')].map((c) => c.textContent);
  assert.ok(formulas.includes('KL 散度'), '相关公式：conceptTerms 显式关联命中');
  assert.ok(formulas.includes('缩放点积注意力'), '相关公式：canonicalName 名称匹配兜底命中');
  // 共现概念 chip 点击 → 抽屉内切换概念
  ov.querySelector('.cd-cooc-chip').click();
  await sleep(30);
  assert.match(ov.querySelector('.cd-term').textContent, /LoRA|Variational/);
  // Esc 关闭
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(!ov.classList.contains('open'), 'Esc 关闭抽屉');
});

// ---------------------------------------------------------------- 公式页联动

test('公式卡（v3.52）：复制按钮 + 论文标签 + 相关概念 chips；明细在预览浮窗', async () => {
  await openFormulas();
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  assert.ok(kl.querySelector('[data-copy="fm_kl"]'), '复制 LaTeX 按钮');
  assert.ok(kl.querySelector('.fc-papers .paper-chip'), '卡上有出现于论文标签（v3.52）');
  const chips = [...kl.querySelectorAll('.concept-chip')];
  assert.equal(chips.length, 2, '相关概念：conceptTerms 命中（含 v3.30 fixture 的漂移重复条目）');
  assert.match(chips[0].textContent, /Scaled Dot-Product Attention/);
  // 相关概念 chip 点击 → 概念详情抽屉（跨页联动）
  chips[0].click();
  await sleep(30);
  const ov = ui.document.querySelector('#concept-detail-overlay');
  assert.ok(ov && ov.classList.contains('open'), '从公式页直开概念抽屉');
  assert.match(ov.querySelector('.cd-term').textContent, /Scaled Dot-Product Attention/);
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('公式页名称匹配兜底：fm_att 的 canonicalName 与概念 term 归一化相等 → 相关概念', async () => {
  await openFormulas();
  const fmAtt = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === '缩放点积注意力',
  );
  const chips = [...fmAtt.querySelectorAll('.concept-chip')];
  assert.equal(chips.length, 2, '无 conceptTerms 时靠 canonicalName 匹配（同 termKey 的漂移条目也命中）');
  assert.match(chips[0].textContent, /Scaled Dot-Product Attention/);
});

test('两页排序新增「最新」：概念页按 createdAt 倒序', async () => {
  await openConcepts();
  const recent = ui.document.querySelector('#concept-sort [data-sort="recent"]');
  assert.ok(recent, '最新排序按钮存在');
  recent.click();
  await sleep(40);
  const terms = cards().map((c) => c.querySelector('h3').textContent);
  assert.equal(terms[0], 'LoRA', 'createdAt 最新（1 天前）排第一');
});

// ---------------------------------------------------------------- v3.29：新增 / 批量 / 绘图 / 编辑抽屉

test('v3.29 手动新增概念：表单对话框 → POST → 卡片出现（人工徽章）', async () => {
  await openConcepts();
  const before = cards().length;
  ui.document.getElementById('btn-concept-add').click();
  await sleep(30);
  const dlg = ui.document.querySelector('.pfdlg');
  assert.ok(dlg, '表单对话框打开');
  const termInput = dlg.querySelector('.pfd-row input[type="text"]');
  termInput.value = 'Flow Matching';
  termInput.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  // 点保存（.pwdlg-actions 里主按钮）
  dlg.querySelector('.pwdlg-actions .btn:not(.secondary)').click();
  await sleep(60);
  const sent = posts.find((p) => p.url === 'POST /api/concepts');
  assert.ok(sent, 'POST 已发出');
  assert.equal(sent.op.term, 'Flow Matching');
  assert.equal(cards().length, before + 1, '卡片就地新增');
  const added = cards().find((c) => c.querySelector('h3').textContent === 'Flow Matching');
  assert.ok(added.querySelector('.src-badge'), 'manual 来源显示「人工」徽章');
});

test('v3.29 概念多选：pick 模式点击选中 → 批量删除走 bulk 端点', async () => {
  await openConcepts();
  ui.document.getElementById('btn-concept-pick').click();
  await sleep(40);
  const pickCards = ui.document.querySelectorAll('#concepts-grid .concept-card.pickable');
  assert.ok(pickCards.length >= 2, '卡片进入多选态');
  pickCards[0].click(); // 点卡片 = 切换选中（不开抽屉）
  await sleep(30);
  assert.ok(pickCards[0].classList.contains('picked'), '选中态类');
  const bar = ui.document.querySelector('.kpick-bar.open');
  assert.ok(bar, '批量底栏出现');
  assert.match(bar.querySelector('.kpick-count').textContent, /已选 1/);
  // 批量删除：确认对话框 → bulk POST → 卡片消失、退出多选
  const before = cards().length;
  bar.querySelector('.kpick-del').click();
  // 注意：jsdom 测试环境里 PWDialog 是自动确认桩（helpers/ui.js，confirm 默认 true），
  // 不会渲染真实对话框——这里点击后删除直接执行
  await sleep(80);
  const sent = posts.find((p) => p.url === 'POST /api/concepts/bulk' && p.op.delete);
  assert.ok(sent, 'bulk delete 已发出');
  assert.equal(sent.op.ids.length, 1);
  assert.equal(cards().length, before - 1, '卡片删除');
  assert.ok(!ui.document.querySelector('#concepts-grid .concept-card.pickable'), '退出多选态');
});

test('v3.29 公式绘图：plottable + plotExpr → 卡片渲染 SVG 曲线', async () => {
  await openFormulas();
  const fmAtt = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === '缩放点积注意力',
  );
  const plot = fmAtt.querySelector('.fc-plot');
  assert.ok(plot, '绘图容器存在');
  const svg = plot.querySelector('svg.fc-plot-svg');
  assert.ok(svg, 'SVG 曲线');
  assert.ok(svg.querySelector('path'), '曲线 path');
  // KL（非 plottable）无绘图区
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  assert.strictEqual(kl.querySelector('.fc-plot'), null);
});

test('v3.29 公式编辑抽屉：全字段打开 + plotExpr 实时预览 + 保存 PATCH', async () => {
  await openFormulas();
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  kl.querySelector('[data-edit="fm_kl"]').click();
  await sleep(40);
  const ov = ui.document.querySelector('#formula-editor-overlay');
  assert.ok(ov && ov.classList.contains('open'), '编辑抽屉打开');
  const panel = ov.querySelector('#formula-editor-panel');
  assert.ok(panel.querySelector('.fe-readonly').textContent.includes('kl-divergence'), 'canonicalName 只读展示');
  assert.ok(panel.querySelector('.fe-katex-preview'), 'KaTeX 预览区');
  assert.ok(panel.querySelector('.fe-vars'), '符号表编辑区');
  // 打开 plottable + 填 plotExpr → 曲线预览出现
  const cb = [...panel.querySelectorAll('input[type="checkbox"]')][0];
  cb.checked = true;
  cb.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await sleep(30);
  const expr = [...panel.querySelectorAll('input.mono')].pop();
  expr.value = 'exp(-x)';
  expr.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await sleep(30);
  assert.ok(panel.querySelector('.fe-plot-preview svg'), 'plotExpr 预览出曲线');
  // 保存 → PATCH
  panel.querySelector('.fe-save').click();
  await sleep(60);
  const sent = posts.find((p) => p.url === 'PATCH /api/formulas/fm_kl');
  assert.ok(sent, 'PATCH 已发出');
  assert.equal(sent.op.plottable, true);
  assert.equal(sent.op.plotHint.plotExpr, 'exp(-x)');
  assert.ok(!ov.classList.contains('open'), '保存后抽屉关闭');
});

test('v3.29 公式多选批量改分类：pick → 改分类对话框 → bulk', async () => {
  await openFormulas();
  ui.document.getElementById('btn-formula-pick').click();
  await sleep(40);
  const pickCards = ui.document.querySelectorAll('#formulas-grid .formula-card.pickable');
  pickCards[0].click();
  await sleep(30);
  const bar = ui.document.querySelector('.kpick-bar.open');
  bar.querySelector('.kpick-cat').click();
  await sleep(40);
  const dlg = ui.document.querySelector('.pfdlg');
  assert.ok(dlg, '改分类对话框（自由文本，公式无枚举）');
  const inp = dlg.querySelector('.pfd-row input[type="text"]');
  inp.value = 'information-theory-x';
  dlg.querySelector('.pwdlg-actions .btn:not(.secondary)').click();
  await sleep(80);
  const sent = posts.find((p) => p.url === 'POST /api/formulas/bulk' && p.op.category);
  assert.ok(sent, 'bulk 分类已发出');
  assert.equal(sent.op.category, 'information-theory-x');
  assert.ok(!ui.document.querySelector('#formulas-grid .formula-card.pickable'), '退出多选');
});

// ---------------------------------------------------------------- v3.30：星标 / 合并 / 时间线 / AI 解读

test('v3.30 概念卡星标：点击 → PATCH starred + 侧栏「重点」计数联动', async () => {
  await openConcepts();
  const att = conceptCardByTerm('Scaled Dot-Product Attention');
  const star = att.querySelector('[data-star="c_att"]');
  assert.ok(star, '卡片有星标按钮');
  star.click();
  await sleep(60);
  assert.ok(star.classList.contains('is-starred'), '翻转成点亮态（.is-starred）');
  assert.ok(star.querySelector('svg'), '星标为 SVG 图形');
  const sideStar = ui.document.querySelector('#side-concepts .side-item[data-quality="star"]');
  assert.match(sideStar.textContent, /1/, '侧栏「重点」计数 = 1');
  // 侧栏点击过滤（写 DSL star:1）
  sideStar.click();
  await sleep(40);
  assert.match($('search').value, /star:1/, '分面写进 DSL');
  assert.ok(
    cards().every((c) => c.querySelector('[data-star].is-starred')),
    '只剩星标概念',
  );
  sideStar.click(); // 取消
  await sleep(40);
});

test('v3.30 概念抽屉：出现论文按年份时间线排列', async () => {
  await openConcepts();
  const att = conceptCardByTerm('Scaled Dot-Product Attention');
  att.click();
  await sleep(40);
  const ov = ui.document.querySelector('#concept-detail-overlay');
  const years = [...ov.querySelectorAll('.cd-year')].map((y) => y.textContent);
  assert.deepEqual(years, ['2014', '2017'], '年份升序（VAE 2014 在 Attention 2017 之前）');
  assert.ok(ov.querySelector('.cd-timeline'), '时间线容器');
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('v3.30 概念合并：抽屉「合并到…」→ 疑似重复置顶 → POST merge → 卡片收敛', async () => {
  await openConcepts();
  const before = cards().length;
  const dup = conceptCardByTerm('Scaled Dot Product Attention');
  dup.click();
  await sleep(40);
  const ov = ui.document.querySelector('#concept-detail-overlay');
  ov.querySelector('[data-cd-merge]').click();
  await sleep(40);
  const dlg = ui.document.querySelector('.pfd-merge-list');
  assert.ok(dlg, '合并对话框打开');
  const first = dlg.querySelector('.pfd-merge-item');
  assert.ok(first.classList.contains('suspect'), '疑似重复候选置顶');
  assert.match(first.textContent, /Scaled Dot-Product Attention/);
  first.click(); // 选中
  ui.document.querySelector('.pfdlg .pwdlg-actions .btn:not(.secondary)').click(); // 合并
  await sleep(80);
  const sent = posts.find((p) => p.url === 'POST /api/concepts/merge');
  assert.ok(sent, 'merge 已发出');
  assert.equal(sent.op.sourceId, 'c_att2');
  assert.equal(sent.op.targetId, 'c_att');
  assert.equal(cards().length, before - 1, '重复条目消失');
  // 抽屉跳到合并后的目标概念
  assert.match(ov.querySelector('.cd-term').textContent, /Scaled Dot-Product Attention/);
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('v3.30 概念抽屉 AI 综合解读：按钮与区块存在（流式协议由 api-knowledge 覆盖）', async () => {
  await openConcepts();
  const att = conceptCardByTerm('Scaled Dot-Product Attention');
  att.click();
  await sleep(40);
  const ov = ui.document.querySelector('#concept-detail-overlay');
  const btn = ov.querySelector('[data-cd-explain]');
  assert.ok(btn, '生成按钮存在');
  assert.ok(ov.querySelector('.cd-explain-body'), '解读展示区存在');
  ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

test('v3.30 公式卡星标 + 侧栏「重点」分面', async () => {
  await openFormulas();
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  const star = kl.querySelector('[data-star="fm_kl"]');
  assert.ok(star, '公式卡星标按钮');
  star.click();
  await sleep(50);
  assert.ok(star.classList.contains('is-starred'), '公式星标点亮');
  const sideStar = ui.document.querySelector('#side-formulas .side-item[data-trait="star"]');
  assert.ok(sideStar, '公式侧栏「重点」分面');
  assert.match(sideStar.textContent, /1/);
});
