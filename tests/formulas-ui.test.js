// 公式清单页 UI 测试（v3.9）：jsdom 驱动真实 public/app.js + 真实 index.html。
// 覆盖：视图切换 / KaTeX 渲染 / 符号表 / 论文胶囊跳转 / 搜索 / 排序 / 布局 / 编辑 / 删除 / 批量抽取。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('formulas-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = [
  {
    id: 'p1', filename: 'a.pdf', title: 'Attention Is All You Need', authors: ['V'], year: '2017',
    abstract: '', arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 100, summaryExcerpt: '', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false,
    conceptCount: 0, formulaCount: 2,
  },
  {
    id: 'p2', filename: 'b.pdf', title: 'Auto-Encoding Variational Bayes', authors: ['K'], year: '2014',
    abstract: '', arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 50, summaryExcerpt: '', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 2, updatedAt: 2, hasSummary: true, hasNotes: false,
    conceptCount: 0, formulaCount: 1,
  },
];

/** 后端公式清单（可变，测试可增删以模拟服务端状态）。 */
let FORMULAS;
function resetFormulas() {
  FORMULAS = [
    {
      id: 'fm_att', canonicalName: 'scaled-dot-product-attention', name: '缩放点积注意力',
      latex: '\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V',
      description: '缩放因子 $\\sqrt{d_k}$ 抑制点积方差。',
      category: 'attention',
      variables: [
        { symbol: 'Q', meaning: '查询矩阵', role: 'input' },
        { symbol: 'd_k', meaning: '键向量维度', role: 'param' },
      ],
      plottable: false, plotHint: null,
      occurrences: [{ paperId: 'p1', rawLatex: 'QK^T', context: '式(1)', symbolMap: { d_k: 'd' } }],
      paperIds: ['p1'], source: 'ai', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'fm_kl', canonicalName: 'kl-divergence', name: 'KL 散度',
      latex: 'D_{\\mathrm{KL}}(P\\,\\|\\,Q)=\\sum_x P(x)\\log\\frac{P(x)}{Q(x)}',
      description: '衡量分布差异。', category: 'information-theory',
      variables: [], plottable: false, plotHint: null,
      occurrences: [
        { paperId: 'p1', rawLatex: '', context: '附录', symbolMap: {} },
        { paperId: 'p2', rawLatex: 'KL[q\\|p]', context: '式(3)', symbolMap: { P: 'q' } },
      ],
      paperIds: ['p1', 'p2'], source: 'vision', createdAt: 2, updatedAt: 2,
    },
    {
      id: 'fm_elbo', canonicalName: 'elbo', name: '证据下界',
      latex: '\\mathcal{L}=\\mathbb{E}[\\log p]-D_{\\mathrm{KL}}', description: '',
      category: 'variational-inference', variables: [], plottable: false, plotHint: null,
      occurrences: [{ paperId: 'p2', rawLatex: '', context: '', symbolMap: {} }],
      paperIds: ['p2'], source: 'ai', createdAt: 3, updatedAt: 3,
    },
  ];
}

const jsonRes = (data) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data }) });

let details;

before(async () => {
  resetFormulas();
  details = {
    p1: { ...LIST[0], summary: '## TL;DR\nx', notes: '', noteCards: [], conceptIds: [], formulaIds: ['fm_att', 'fm_kl'], annotations: null, chat: [] },
    p2: { ...LIST[1], summary: '## TL;DR\ny', notes: '', noteCards: [], conceptIds: [], formulaIds: ['fm_kl', 'fm_elbo'], annotations: null, chat: [] },
  };
  ui = await bootUi({
    listItems: LIST,
    details,
    routes: {
      '/api/formulas': () => jsonRes(FORMULAS),
      '/api/papers/formulas': ({ body }) => jsonRes({ processed: (body.ids || []).length, added: 2 }),
    },
  });
  assert.ok(ui.document.querySelector('.paper-item'), 'boot 成功');
});

async function openFormulas() {
  ui.document.querySelector('#view-nav [data-view="formulas"]').click();
  await sleep(60);
}

// ---------------------------------------------------------------- 视图切换

const hidden = (id) => $(id).classList.contains('view-hidden');

test('顶栏「公式」导航段切到公式视图，其余视图隐藏', async () => {
  await openFormulas();
  assert.ok(!hidden('formulas-view'));
  assert.ok(hidden('library-view'));
  assert.ok(hidden('concepts-view'));
  assert.ok(hidden('settings-view'));
  assert.ok(ui.document.querySelector('#view-nav [data-view="formulas"]').classList.contains('active'));
  assert.strictEqual(ui.document.body.dataset.view, 'formulas');
  assert.strictEqual($('formulas-count').textContent, '3');
});

test('点「论文」导航段回到论文库', async () => {
  await openFormulas();
  ui.document.querySelector('#view-nav [data-view="library"]').click();
  await sleep(30);
  assert.ok(!hidden('library-view'));
  assert.ok(hidden('formulas-view'));
});

// ---------------------------------------------------------------- 卡片渲染

test('卡片渲染：KaTeX display 公式 + 规范名 + 频次徽章 + 来源标记', async () => {
  await openFormulas();
  const cards = ui.document.querySelectorAll('#formulas-grid .formula-card');
  assert.strictEqual(cards.length, 3);
  // 默认按频次排序 → KL（2 篇）在最前
  assert.strictEqual(cards[0].querySelector('h3').textContent, 'KL 散度');
  assert.strictEqual(cards[0].querySelector('.freq-badge').textContent, '2 篇');
  // KaTeX 真的渲染成了 DOM（注意：KaTeX 会把源码嵌进 MathML annotation，
  // 所以不能用 textContent 不含 LaTeX 命令来判断，要看结构）
  const latexBox = cards[0].querySelector('.fc-latex');
  assert.ok(latexBox.querySelector('.katex'), '公式经 KaTeX 渲染');
  assert.ok(latexBox.querySelector('.katex-display'), 'display 模式（非行内）');
  assert.strictEqual(latexBox.querySelector('.katex-error'), null, 'KaTeX 未报错');
  // 规范名 + 分类 + 来源
  assert.strictEqual(cards[0].querySelector('.fc-canon code').textContent, 'kl-divergence');
  assert.strictEqual(cards[0].querySelector('.fc-cat').textContent, 'information-theory');
  assert.strictEqual(cards[0].querySelector('.fc-src').textContent, '框选', 'source=vision 标记');
});

test('卡片渲染：解读走 renderMd（行内 $...$ 也经 KaTeX）；无解读显示占位', async () => {
  await openFormulas();
  const cards = [...ui.document.querySelectorAll('#formulas-grid .formula-card')];
  const att = cards.find((c) => c.querySelector('h3').textContent === '缩放点积注意力');
  assert.ok(att.querySelector('.fc-desc .katex'), '解读里的 $\\sqrt{d_k}$ 被渲染');
  const elbo = cards.find((c) => c.querySelector('h3').textContent === '证据下界');
  assert.ok(elbo.querySelector('.fc-desc').classList.contains('muted'));
  assert.strictEqual(elbo.querySelector('.fc-desc').textContent, '（无解读）');
});

test('卡片渲染：符号表折叠区列出符号/含义/角色（中文角色名）', async () => {
  await openFormulas();
  const att = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === '缩放点积注意力',
  );
  const rows = att.querySelectorAll('.fc-vars tr');
  assert.strictEqual(rows.length, 2);
  assert.ok(att.querySelector('.fc-vars summary').textContent.includes('2'));
  assert.strictEqual(rows[0].querySelectorAll('td')[1].textContent, '查询矩阵');
  assert.strictEqual(rows[0].querySelectorAll('td')[2].textContent, '输入');
  assert.strictEqual(rows[1].querySelectorAll('td')[2].textContent, '参数');
  assert.ok(rows[0].querySelector('td.vs .katex'), '符号本身也走 KaTeX');
  // 无 variables 的条目不渲染符号表
  const elbo = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === '证据下界',
  );
  assert.strictEqual(elbo.querySelector('.fc-vars'), null);
});

test('论文胶囊：每个 occurrence 一个，tooltip 含章节与符号对照', async () => {
  await openFormulas();
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  const chips = kl.querySelectorAll('.paper-chip');
  assert.strictEqual(chips.length, 2);
  assert.strictEqual(chips[0].textContent, 'Attention Is All You Need');
  assert.strictEqual(chips[1].textContent, 'Auto-Encoding Variational Bayes');
  assert.ok(chips[1].title.includes('式(3)'), 'tooltip 含章节出处');
  assert.ok(chips[1].title.includes('P→q'), 'tooltip 含符号对照（归一化落点）');
});

// ---------------------------------------------------------------- 交互

test('点击论文胶囊：回论文库 + 选中该论文', async () => {
  await openFormulas();
  const kl = [...ui.document.querySelectorAll('.formula-card')].find(
    (c) => c.querySelector('h3').textContent === 'KL 散度',
  );
  kl.querySelectorAll('.paper-chip')[1].click();
  await sleep(80);
  assert.ok(!hidden('library-view'), '回到论文库视图');
  assert.ok(hidden('formulas-view'));
  const active = ui.document.querySelector('.paper-item.active');
  assert.ok(active, '有选中项');
  assert.strictEqual(active.dataset.id, 'p2');
});

test('顶栏搜索框（公式页 scope）：匹配名称 / 规范名 / LaTeX / 解读 / 分类', async () => {
  await openFormulas();
  const q = $('search'); // v3.17：页内 #formula-q 退役，统一走顶栏上下文搜索框（250ms 防抖）
  const type = async (v) => {
    q.value = v;
    q.dispatchEvent(new ui.window.Event('input'));
    await sleep(320);
  };
  await type('散度');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 1);
  await type('elbo');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 1);
  await type('mathrm{Attention}');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 1);
  await type('variational');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 1, '按分类命中');
  await type('不存在的公式');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 0);
  assert.ok(ui.document.querySelector('#formulas-grid .empty-state'));
  await type('');
  assert.strictEqual(ui.document.querySelectorAll('.formula-card').length, 3);
});

test('排序切换：频次 / 名称 / 分类，选择持久化到 localStorage', async () => {
  await openFormulas();
  const names = () => [...ui.document.querySelectorAll('.formula-card h3')].map((h) => h.textContent);
  const clickSort = async (s) => {
    ui.document.querySelector(`#formula-sort button[data-sort="${s}"]`).click();
    await sleep(30);
  };
  await clickSort('alpha');
  assert.strictEqual(ui.window.localStorage.getItem('pw-formula-sort'), 'alpha');
  assert.ok(ui.document.querySelector('#formula-sort button[data-sort="alpha"]').classList.contains('active'));
  // zh-Hans-CN-u-co-pinyin 下汉字在前、拉丁字母在后（与概念页同一 collation）
  assert.deepStrictEqual(names(), ['缩放点积注意力', '证据下界', 'KL 散度'], '按拼音/字母');
  await clickSort('category');
  assert.deepStrictEqual(names()[0], '缩放点积注意力', 'attention 分类排最前');
  await clickSort('freq');
  assert.strictEqual(names()[0], 'KL 散度', '2 篇的排最前');
});

test('布局切换：清单视图单行紧凑（隐藏公式块，展示行内公式）', async () => {
  await openFormulas();
  ui.document.querySelector('#formula-layout button[data-layout="list"]').click();
  await sleep(30);
  assert.ok($('formulas-grid').classList.contains('list-view'));
  assert.strictEqual(ui.window.localStorage.getItem('pw-formula-layout'), 'list');
  const card = ui.document.querySelector('.formula-card');
  assert.ok(card.querySelector('.lc-term'), '有名称列');
  assert.ok(card.querySelector('.lc-formula .katex'), '行内公式经 KaTeX');
  assert.strictEqual(card.querySelector('.fc-latex'), null, '清单视图不渲染 display 公式块');
  // 切回瀑布流
  ui.document.querySelector('#formula-layout button[data-layout="masonry"]').click();
  await sleep(30);
  assert.ok($('formulas-grid').classList.contains('masonry-view'));
});

// ---------------------------------------------------------------- 编辑 / 删除

test('编辑：两步 prompt（LaTeX → 解读）后 PATCH，中途取消不发请求', async () => {
  await openFormulas();
  const before = ui.backend.posts.length;
  // 第一步取消 → 不应发请求
  globalThis.prompt = () => null;
  ui.document.querySelector('.formula-card [data-edit="fm_kl"]').click();
  await sleep(50);
  assert.strictEqual(ui.backend.posts.length, before, '取消不发 PATCH');

  // 两步都填 → PATCH latex + description
  const answers = ['新的 LaTeX', '新的解读'];
  let i = 0;
  globalThis.prompt = () => answers[i++];
  ui.document.querySelector('.formula-card [data-edit="fm_kl"]').click();
  await sleep(80);
  // 路径带 sp() 注入的 ?space=default，故用 startsWith
  const patch = ui.backend.posts.find((x) => x.path.startsWith('/api/formulas/fm_kl'));
  assert.ok(patch, '发出 PATCH /api/formulas/fm_kl');
  assert.deepStrictEqual(patch.body, { latex: '新的 LaTeX', description: '新的解读' });
  globalThis.prompt = undefined;
});

test('删除：确认后 DELETE，取消则不发请求', async () => {
  await openFormulas();
  globalThis.confirm = () => false;
  const before = ui.backend.posts.length;
  ui.document.querySelector('.formula-card [data-del="fm_kl"]').click();
  await sleep(50);
  assert.strictEqual(ui.backend.posts.length, before, '取消不发 DELETE');

  globalThis.confirm = () => true;
  ui.document.querySelector('.formula-card [data-del="fm_kl"]').click();
  await sleep(80);
  const del = ui.backend.posts.find((x) => x.path.startsWith('/api/formulas/fm_kl'));
  assert.ok(del, '发出 DELETE /api/formulas/fm_kl');
});

// ---------------------------------------------------------------- 论文侧入口

test('详情「信息」tab：显示公式贡献数 + 「重新抽取并追加」调 POST /api/papers/formulas', async () => {
  ui.document.querySelector('#view-nav [data-view="library"]').click();
  await sleep(20);
  ui.document.querySelector('.paper-item[data-id="p1"]').click();
  await sleep(60);
  ui.document.querySelector('.tab[data-tab="info"]').click();
  await sleep(60);
  const btn = $('b-formulas-this');
  assert.ok(btn, '信息 tab 有「重新抽取并追加」按钮');
  const field = btn.closest('.field');
  assert.ok(field.textContent.includes('本篇涉及 2 个公式'), '显示公式贡献数');
  btn.click();
  await sleep(80);
  const post = ui.backend.posts.find((x) => x.path.startsWith('/api/papers/formulas'));
  assert.ok(post, '发出 POST /api/papers/formulas');
  assert.deepStrictEqual(post.body, { ids: ['p1'] });
});

test('多选工具栏：「抽取并追加公式」对已选论文逐篇调用（拿真实进度）', async () => {
  ui.document.querySelector('#btn-pick').click();
  await sleep(40);
  $('btn-pick-all').click(); // 全选（比逐个点复选框稳，不依赖 pick-box 的具体标记）
  await sleep(40);
  const before = ui.backend.posts.filter((x) => x.path.startsWith('/api/papers/formulas')).length;
  $('btn-pick-formulas').click();
  await sleep(160);
  const posts = ui.backend.posts.filter((x) => x.path.startsWith('/api/papers/formulas'));
  // 逐篇循环：每篇 1 次请求、body.ids.length===1，共 2 篇 → 2 次请求（前端拿真实百分比进度）
  assert.strictEqual(posts.length, before + 2);
  assert.strictEqual(posts[posts.length - 1].body.ids.length, 1, '逐篇传单 id 给后端');
});
