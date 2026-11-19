// 本会话修复的回归测试（jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）：
//  1. fixCjkStrong——CJK 引号加粗在聊天/总结里渲染为 <strong>（CommonMark 侧翼规则缺陷兜底）
//  2. refresh 轮询重建保护——updatedAt 不变不重建详情（「标题/总结无法选中复制」根因修复）
//  3. @ 引用浮层 Esc 分层——Esc 只关浮层不波及底层（stopPropagation 语义锁定）

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('regression-ui')) return;

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
  {
    id: 'p2', filename: 'b.pdf', title: '论文乙', authors: ['B'], year: '2023', abstract: '',
    arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 50, summaryExcerpt: '', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 2, updatedAt: 2, hasSummary: true, hasNotes: false, conceptCount: 0,
  },
];

let details;
function resetDetail(over = {}) {
  details.p1 = {
    ...LIST[0],
    summary: '## TL;DR\nx', notes: '', noteCards: [], abstract: '', fulltextChars: 100,
    conceptIds: [], annotations: null, chat: [], ...over,
  };
}

before(async () => {
  details = { p1: null };
  resetDetail();
  ui = await bootUi({ listItems: LIST, details });
  assert.ok(ui.document.querySelector('.paper-item'), 'boot 成功');
});

async function openTab(tab) {
  ui.document.querySelector('.paper-item').click();
  await sleep(40);
  ui.document.querySelector(`.tab[data-tab="${tab}"]`).click();
  await sleep(40);
}

// 必须是本文件第一个用例：此时尚未选中过任何论文（state.detail 为空）
test('首次点论文：详情 fetch 期间立即出骨架，不停留在「从左侧选择一篇论文」空状态', async () => {
  const detailEl = $('detail');
  assert.ok(detailEl.querySelector('.empty'), '前置：启动后详情是空状态');
  // 用 p2（后续用例都以「首次打开 p1」为前提，这里不能先选中 p1）。
  // 让 /api/papers/p2 的响应挂起，观察 fetch 进行中的界面
  details.p2 = { ...LIST[1], summary: '## TL;DR\ny', notes: '', noteCards: [], conceptIds: [], annotations: null, chat: [] };
  const w = ui.window;
  const realFetch = w.fetch;
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFetch = async (url, opts) => {
    if (/\/api\/papers\/p2(\?|$)/.test(String(url))) await gate;
    return realFetch(url, opts);
  };
  globalThis.fetch = w.fetch = slowFetch;
  try {
    ui.document.querySelector('.paper-item[data-id="p2"]').click();
    await sleep(30);
    assert.ok(detailEl.querySelector('.detail-skel'), 'fetch 期间显示骨架');
    assert.ok(!detailEl.querySelector('.empty'), '不再显示空状态');
  } finally {
    release();
    globalThis.fetch = w.fetch = realFetch;
  }
  await sleep(40);
  assert.ok(!detailEl.querySelector('.detail-skel'), '数据到达后骨架被替换');
});

test('回归 fixCjkStrong：聊天历史里 的**“引用”**的 渲染为 <strong>', async () => {
  resetDetail({
    chat: [
      { role: 'user', content: 'q', ts: 1 },
      { role: 'assistant', content: '这篇论文是极佳的**“从第一性原理出发”**的示范。', ts: 2 },
    ],
  });
  await openTab('chat');
  const content = ui.document.querySelector('#chat-list .chat-msg.assistant .chat-content');
  assert.ok(content, 'assistant 消息渲染');
  assert.ok(content.innerHTML.includes('<strong>“从第一性原理出发”</strong>'), 'CJK 引号加粗已渲染');
  assert.ok(!content.textContent.includes('**'), '不残留字面 **');
});

test('回归 fixCjkStrong：总结 tab 同样生效', async () => {
  resetDetail({ summary: '## TL;DR\n这是**“核心创新”**所在。' });
  await openTab('summary');
  const md = ui.document.querySelector('#tab-body .md');
  assert.ok(md.innerHTML.includes('<strong>“核心创新”</strong>'));
});

test('回归 refresh 重建保护：updatedAt 不变轮询不重建详情，变了才重建', async () => {
  resetDetail();
  await openTab('summary');
  const poll = ui.intervalFns[ui.intervalFns.length - 1]; // app 的 10s 轮询回调
  assert.ok(poll, '捕获到轮询回调');
  const h2Before = ui.document.querySelector('#detail .title-row h2');
  assert.ok(h2Before, '详情标题存在');
  // 第一次轮询：数据未变 → 节点应保持同一个（不重建 → 不打断文本选择）。
  // poll 是 fire-and-forget（setInterval 回调不 return refresh 的 promise），给足 settle 窗口再断言。
  poll();
  await sleep(150);
  const h2After1 = ui.document.querySelector('#detail .title-row h2');
  assert.strictEqual(h2After1, h2Before, 'updatedAt 不变：DOM 节点未被重建');
  // 数据变更（模拟服务端笔记/总结更新）→ 下一轮应重建
  LIST[0].updatedAt = 999;
  poll();
  let h2After2 = h2Before;
  for (let i = 0; i < 60 && h2After2 === h2Before; i++) {
    await sleep(20);
    h2After2 = ui.document.querySelector('#detail .title-row h2');
  }
  assert.notStrictEqual(h2After2, h2Before, 'updatedAt 变化：详情重建');
  LIST[0].updatedAt = 1; // 还原
});

test('回归 Esc 分层：@ 浮层开着按 Esc 只关浮层，不波及底层模态', async () => {
  resetDetail();
  await openTab('chat');
  const input = $('chat-input');
  input.value = '@';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  await sleep(60);
  const pop = ui.document.querySelector('.chat-mention-pop');
  assert.ok(pop && !pop.hidden && pop.style.display !== 'none', '@ 浮层打开');
  // 经真实入口打开一个底层模态（v3.65 起静态模态由 PWLayers 登记，Esc 归层管理器）
  $('btn-import').click();
  assert.ok($('import-modal').classList.contains('active'), '底层模态已打开');
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(30);
  assert.ok(pop.hidden || pop.style.display === 'none', 'Esc 关闭了 @ 浮层');
  assert.ok($('import-modal').classList.contains('active'), '底层模态未被连带关闭（分层语义）');
  // 浮层已关：再按 Esc 才轮到关模态
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(30);
  assert.ok(!$('import-modal').classList.contains('active'), '第二次 Esc 关闭模态');
});

test('回归 列表文本可选：条目默认不可拖，hover 文本区保持不可拖、悬留白区才可拖（拖入收藏夹）', async () => {
  // draggable=true 会触发 Chromium UA 样式 user-select:none → 整卡文字无法选中复制。
  // 修复后：draggable 由 mouseover 分派——文本区 false（手势=选择），留白区 true（拖入收藏夹）。
  const li = ui.document.querySelector('.paper-item');
  assert.ok(li, '列表条目存在');
  assert.strictEqual(li.draggable, false, '默认 draggable=false（文本可选）');
  li.querySelector('.pt').dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  assert.strictEqual(li.draggable, false, '悬在标题区：不可拖（手势=文本选择）');
  li.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  assert.strictEqual(li.draggable, true, '悬在留白区：可拖（拖入收藏夹）');
});

test('回归 refresh 选区守卫：列表有活动选区时轮询不重建（选中文字可复制）', async () => {
  const poll = ui.intervalFns[ui.intervalFns.length - 1]; // app 的 10s 轮询回调
  assert.ok(poll, '捕获到轮询回调');
  const liBefore = ui.document.querySelector('.paper-item');
  assert.ok(liBefore, '列表条目存在');
  // 在列表标题里制造一个活动选区
  const range = ui.document.createRange();
  range.selectNodeContents(liBefore.querySelector('.pt'));
  const sel = ui.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  assert.ok(!sel.isCollapsed, '选区已建立');
  poll();
  await sleep(150);
  assert.strictEqual(ui.document.querySelector('.paper-item'), liBefore, '有选区：列表未重建');
  // 释放选区 → 下一轮恢复重建
  sel.removeAllRanges();
  poll();
  await sleep(150);
  assert.notStrictEqual(ui.document.querySelector('.paper-item'), liBefore, '选区释放后恢复重建');
});

test('回归 refresh 推迟补渲：详情有选区时推迟重建，选区释放后下一轮补上', async () => {
  resetDetail();
  await openTab('summary');
  const poll = ui.intervalFns[ui.intervalFns.length - 1];
  const h2Before = ui.document.querySelector('#detail .title-row h2');
  assert.ok(h2Before, '详情标题存在');
  // 在详情里建立选区 + 模拟服务端数据变更
  const range = ui.document.createRange();
  range.selectNodeContents(h2Before);
  const sel = ui.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  LIST[0].updatedAt = 555;
  poll();
  await sleep(150);
  assert.strictEqual(ui.document.querySelector('#detail .title-row h2'), h2Before, '有选区：推迟重建');
  // 释放选区 → 下一轮必须补渲（修复「推迟后 state 已合并、永不补渲」）
  sel.removeAllRanges();
  poll();
  let h2After = h2Before;
  for (let i = 0; i < 60 && h2After === h2Before; i++) {
    await sleep(20);
    h2After = ui.document.querySelector('#detail .title-row h2');
  }
  assert.notStrictEqual(h2After, h2Before, '选区释放：下一轮补渲');
  LIST[0].updatedAt = 1; // 还原
});

test('回归 拖选后 click 抑制：条目内有选区时点击不跳转（选区不被路由重建摧毁）', async () => {
  const li = ui.document.querySelector('.paper-item');
  assert.ok(li, '列表条目存在');
  const pathBefore = ui.window.location.pathname;
  // 模拟拖选结束瞬间：条目内选区非空 + click 跟进
  const range = ui.document.createRange();
  range.selectNodeContents(li.querySelector('.pt'));
  const sel = ui.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  li.click();
  await sleep(60);
  assert.strictEqual(ui.window.location.pathname, pathBefore, '有选区：click 被抑制，未跳转');
  assert.ok(!sel.isCollapsed, '选区仍在（可复制）');
  // 普通点击（选区已塌陷）照常跳转
  sel.removeAllRanges();
  li.click();
  await sleep(120);
  assert.ok(ui.window.location.pathname.startsWith('/paper/'), '无选区：click 正常打开论文');
});

test('回归 删除论文带知识产出选项：默认保留概念/公式（keepKnowledge=1），勾选后改为连带删除（v3.63）', async () => {
  resetDetail(); // p1 详情恢复（此前用例可能已删）
  await openTab('info');
  const btn = $('b-delete');
  assert.ok(btn, '信息 tab 有删除按钮');
  // 桩默认自动确认、checked 取 opts.checkbox.checked（默认 false → 保留知识）
  btn.click();
  await sleep(60);
  const del1 = ui.backend.posts.filter((x) => x.method !== 'GET' && x.path.startsWith('/api/papers/p1')).pop();
  assert.ok(del1, '发出删除请求');
  assert.match(del1.path, /keepKnowledge=1/, '未勾选：知识条目保留（只解除关联）');
  // 删除后详情清空，重新选回论文再测勾选分支
  resetDetail();
  ui.backend.posts.length = 0;
  const prevConfirmCheck = ui.window.PWDialog.confirmCheck;
  ui.window.PWDialog.confirmCheck = (msg, opts) =>
    Promise.resolve({ ok: (globalThis.confirm || (() => true))(msg, opts), checked: true });
  try {
    await openTab('info');
    $('b-delete').click();
    await sleep(60);
    const del2 = ui.backend.posts.filter((x) => x.method !== 'GET' && x.path.startsWith('/api/papers/p1')).pop();
    assert.ok(del2, '勾选分支也发出删除请求');
    assert.match(del2.path, /keepKnowledge=0/, '勾选：仅本篇贡献的概念/公式一并删除');
  } finally {
    ui.window.PWDialog.confirmCheck = prevConfirmCheck;
  }
});

test('v3.65 多选三页同构（论文库）：Shift 范围选 / 全选↔取消全选 / Esc 退出', async () => {
  $('btn-pick').click();
  await sleep(30);
  const bar = $('bulk-bar');
  assert.equal(bar.getAttribute('role'), 'toolbar');
  assert.equal($('btn-pick-cancel').textContent, '退出多选', '文案与概念/公式页一致');
  const items = () => [...ui.document.querySelectorAll('.paper-item')];
  items()[0].click();
  await sleep(10);
  items()[1].dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  await sleep(10);
  assert.match($('sel-count').textContent, /已选 2/, 'Shift 范围选');
  assert.equal($('btn-pick-all').textContent.trim(), '取消全选', '全部选中后按钮切成「取消全选」');
  $('btn-pick-all').click();
  assert.match($('sel-count').textContent, /已选 0/);
  ui.document.body.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  assert.ok(!bar.classList.contains('active'), 'Esc 退出多选');
  assert.ok(!$('btn-pick').classList.contains('active'));
});
