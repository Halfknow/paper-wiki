// NotesPanel 笔记卡片 UI 测试（jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）。
// 覆盖：卡片渲染/添加（线上「点击没反应」bug 的回归）/编辑/取消/删除/排序/复制/锚点跳转/
//       旧 notes 自动迁移/AI 骨架生成/编辑中切 tab 自动提交/双面板同步。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('notes-panel')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = [
  {
    id: 'p1', filename: 'a.pdf', title: '论文甲', authors: ['A'], year: '2024', abstract: '',
    arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 100, summaryExcerpt: '', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false, conceptCount: 0,
  },
];

function detailWith(noteCards, notes) {
  return {
    ...LIST[0],
    summary: '## TL;DR\nx', notes: notes || '', noteCards: noteCards || [], abstract: '', fulltextChars: 100,
    conceptIds: [], annotations: null, chat: [],
  };
}

let details;
function reset(noteCards, notes) {
  details.p1 = detailWith(noteCards, notes);
}

function card(id, over = {}) {
  return { id, type: 'manual', title: '卡片' + id, body: '正文' + id, createdAt: 1, updatedAt: 1, ...over };
}

before(async () => {
  details = { p1: detailWith([]) };
  ui = await bootUi({
    listItems: LIST,
    details,
    routes: {
      '/api/papers/p1/notes/generate': () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          data: {
            cards: [
              { id: 'nc-g1', type: 'skeleton', title: '🎯 研究问题', body: '骨架正文', createdAt: 50, updatedAt: 50 },
            ],
          },
        }),
      }),
    },
  });
  assert.ok(ui.document.querySelector('.paper-item'), 'boot 成功');
});

async function openNotesTab() {
  ui.document.querySelector('.paper-item').click();
  await sleep(40);
  ui.document.querySelector('.tab[data-tab="notes"]').click();
  await sleep(60); // panel.load 是 async（jget + 可能的旧笔记迁移 PATCH）
}
const host = () => $('notes-panel-host');
const cardEls = () => [...host().querySelectorAll('.note-card')];
const titles = () => cardEls().map((el) => el.querySelector('.nc-title').textContent);
const lastPatch = () => ui.backend.patches[ui.backend.patches.length - 1];
/** 轮询等待条件成立（DOM 状态先于 fetch 完成信号变化，避免 PATCH 收到但 app render 未跑的竞态） */
async function waitFor(cond, what = 'condition') {
  for (let i = 0; i < 60; i++) {
    try {
      if (cond()) return;
    } catch { /* 中间态 DOM 不完整时重试 */ }
    await sleep(20);
  }
  assert.fail('等待超时: ' + what);
}
const act = (name, nc) => {
  const sel = nc ? `[data-nact="${name}"][data-nc="${nc}"]` : `[data-nact="${name}"]`;
  const btn = host().querySelector(sel);
  assert.ok(btn, `按钮存在: ${sel}`);
  btn.click();
};

test('空笔记：空态提示 + 工具条（生成骨架/添加卡片）', async () => {
  reset([]);
  await openNotesTab();
  assert.ok(host().querySelector('.notes-empty'), '空态提示');
  assert.ok(host().querySelector('[data-nact="generate"]'), 'AI 生成骨架按钮');
  assert.ok(host().querySelector('[data-nact="add"]'), '添加卡片按钮');
});

test('卡片渲染：类型图标 + 标题 + Markdown 正文（含 CJK 加粗修复）', async () => {
  reset([card('c1', { type: 'qa', title: 'Q: 为什么', body: '这是**“重点”**内容' })]);
  await openNotesTab();
  const el = cardEls()[0];
  assert.ok(el.className.includes('nc-qa'), 'qa 类型 class');
  assert.strictEqual(el.querySelector('.nc-title').textContent, 'Q: 为什么');
  assert.ok(el.querySelector('.nc-body').innerHTML.includes('<strong>“重点”</strong>'), 'CJK 引号加粗渲染');
});

test('添加卡片：点击出现编辑器（线上 bug 回归）→ 填入 → 落盘上屏', async () => {
  reset([card('c1')]);
  await openNotesTab();
  ui.backend.patches.length = 0;
  act('add');
  const editHost = host().querySelector('.note-card.nc-editing');
  assert.ok(editHost, '点击添加后出现编辑卡');
  editHost.querySelector('.nc-edit-title').value = '新想法';
  editHost.querySelector('.nc-edit-body').value = '正文内容';
  act('save-edit', '__new__');
  await waitFor(() => ui.backend.patches.length > 0, 'PATCH 落盘');
  await waitFor(() => !host().querySelector('.nc-editing') && titles().length === 2, '编辑器关闭且 2 张卡');
  const p = lastPatch();
  assert.strictEqual(p.body.noteCards.length, 2, '新卡插入开头');
  assert.strictEqual(p.body.noteCards[0].title, '新想法');
  assert.strictEqual(p.body.noteCards[0].type, 'manual');
  assert.strictEqual(titles()[0], '新想法', 'DOM 同步上屏');
});

test('添加空内容卡片：拒绝落盘', async () => {
  reset([]);
  await openNotesTab();
  ui.backend.patches.length = 0;
  act('add');
  act('save-edit', '__new__');
  await sleep(50);
  assert.strictEqual(ui.backend.patches.length, 0, '空标题空正文不 PATCH');
  assert.ok(host().querySelector('.note-card.nc-editing'), '编辑器保留（不丢输入）');
});

test('编辑卡片：回填原内容 → 修改保存 → PATCH 更新', async () => {
  reset([card('c1', { title: '原标题', body: '原正文' })]);
  await openNotesTab();
  act('edit', 'c1');
  const editHost = host().querySelector('.note-card.nc-editing');
  assert.strictEqual(editHost.querySelector('.nc-edit-title').value, '原标题', '标题回填');
  assert.strictEqual(editHost.querySelector('.nc-edit-body').value, '原正文', '正文回填');
  editHost.querySelector('.nc-edit-body').value = '改后正文';
  ui.backend.patches.length = 0;
  act('save-edit', 'c1');
  await waitFor(() => ui.backend.patches.length > 0, 'PATCH 落盘');
  assert.strictEqual(lastPatch().body.noteCards[0].body, '改后正文');
});

test('取消编辑：不 PATCH，内容还原', async () => {
  reset([card('c1', { body: '别动我' })]);
  await openNotesTab();
  act('edit', 'c1');
  host().querySelector('.nc-edit-body').value = '被改过';
  ui.backend.patches.length = 0;
  host().querySelector('[data-nact="cancel-edit"]').click();
  await sleep(30);
  assert.strictEqual(ui.backend.patches.length, 0, '取消不落盘');
  assert.ok(cardEls()[0].querySelector('.nc-body').textContent.includes('别动我'), '内容还原');
});

test('删除卡片：confirm 后 PATCH 移除', async () => {
  reset([card('c1'), card('c2')]);
  await openNotesTab();
  ui.backend.patches.length = 0;
  act('delete', 'c1');
  await waitFor(() => ui.backend.patches.length > 0, 'PATCH 落盘');
  await waitFor(() => titles().length === 1, 'DOM 剩 1 张卡');
  assert.strictEqual(lastPatch().body.noteCards.length, 1);
  assert.deepStrictEqual(titles(), ['卡片c2']);
});

test('上移/下移：顺序交换并落盘', async () => {
  reset([card('c1'), card('c2')]);
  await openNotesTab();
  ui.backend.patches.length = 0;
  act('down', 'c1');
  await waitFor(() => ui.backend.patches.length > 0, 'PATCH 落盘');
  assert.deepStrictEqual(lastPatch().body.noteCards.map((c) => c.id), ['c2', 'c1']);
  act('up', 'c1');
  await waitFor(() => ui.backend.patches.length > 1, '第二次 PATCH');
  assert.deepStrictEqual(lastPatch().body.noteCards.map((c) => c.id), ['c1', 'c2']);
});

test('复制卡片：剪贴板得到 ## 标题 + 正文', async () => {
  reset([card('c1', { title: '标题X', body: '正文X' })]);
  await openNotesTab();
  ui.backend.clipWrites.length = 0;
  act('copy', 'c1');
  await sleep(30);
  assert.deepStrictEqual(ui.backend.clipWrites, ['## 标题X\n\n正文X']);
});

test('≥4 张卡显示锚点 chips，点击触发滚动定位', async () => {
  reset([card('c1'), card('c2'), card('c3'), card('c4')]);
  await openNotesTab();
  const anchors = [...host().querySelectorAll('.notes-anchor')];
  assert.strictEqual(anchors.length, 4, '4 个锚点');
  ui.backend.scrollIntoViewCalls = [];
  anchors[2].click();
  await sleep(20);
  assert.strictEqual(ui.backend.scrollIntoViewCalls.length, 1, '点击锚点触发 scrollIntoView');
});

test('旧 notes 自动迁移：按 ## 拆成 manual 卡并落盘 + toast', async () => {
  reset([], '导语段\n\n## 章节一\n内容一\n## 章节二\n内容二');
  ui.backend.patches.length = 0;
  await openNotesTab();
  await waitFor(() => ui.backend.patches.length > 0, '迁移 PATCH');
  await waitFor(() => cardEls().length === 2, '卡片上屏');
  const p = lastPatch();
  assert.strictEqual(p.body.noteCards.length, 2, '拆成 2 张卡');
  assert.strictEqual(p.body.noteCards[0].title, '章节一');
  assert.ok(p.body.noteCards[0].body.includes('导语段'), '导语并入首卡');
  assert.strictEqual(p.body.noteCards[0].type, 'manual');
  assert.strictEqual(cardEls().length, 2, '卡片上屏');
});

test('AI 生成骨架：confirm 后 POST → 骨架卡插到开头并落盘', async () => {
  reset([card('c1')]);
  await openNotesTab();
  ui.backend.patches.length = 0;
  act('generate');
  await waitFor(() => ui.backend.patches.length > 0, '骨架 PATCH');
  await waitFor(() => cardEls().length === 2 && cardEls()[0].className.includes('nc-skeleton'), '骨架卡上屏');
  const p = lastPatch();
  assert.strictEqual(p.body.noteCards[0].type, 'skeleton', '骨架卡在最前');
  assert.strictEqual(p.body.noteCards[0].title, '🎯 研究问题');
  assert.strictEqual(p.body.noteCards.length, 2, '原有卡保留');
});

test('编辑中切 tab：flushPendingNotes 自动提交编辑内容', async () => {
  reset([card('c1', { body: '旧' })]);
  await openNotesTab();
  act('edit', 'c1');
  host().querySelector('.nc-edit-body').value = '切 tab 前未保存的字';
  ui.backend.patches.length = 0;
  ui.document.querySelector('.tab[data-tab="summary"]').click();
  await waitFor(() => ui.backend.patches.length > 0, '切 tab 自动提交 PATCH');
  assert.strictEqual(lastPatch().body.noteCards[0].body, '切 tab 前未保存的字', '离开笔记 tab 自动提交');
});

test('双面板同步：详情 tab 保存后，阅读器侧栏面板同步更新', async () => {
  reset([card('c1')]);
  await openNotesTab();
  // 模拟阅读器侧栏：第二个 NotesPanel 实例挂在独立容器 + window._readerNotesPanel
  const host2 = ui.document.createElement('div');
  ui.document.body.appendChild(host2);
  const panel2 = new ui.window.NotesPanel(host2, { showGenerate: false });
  ui.window._readerNotesPanel = panel2;
  await panel2.load('p1');
  assert.strictEqual(host2.querySelectorAll('.note-card').length, 1, '侧栏初始 1 张卡');
  // 在详情 tab 面板里新增一张卡
  act('add');
  const editHost = host().querySelector('.note-card.nc-editing');
  editHost.querySelector('.nc-edit-title').value = '同步卡';
  editHost.querySelector('.nc-edit-body').value = 'x';
  act('save-edit', '__new__');
  for (let i = 0; i < 50 && host2.querySelectorAll('.note-card').length < 2; i++) await sleep(20);
  assert.strictEqual(host2.querySelectorAll('.note-card').length, 2, '侧栏面板同步为 2 张卡');
  assert.ok(host2.textContent.includes('同步卡'));
  delete ui.window._readerNotesPanel;
});
