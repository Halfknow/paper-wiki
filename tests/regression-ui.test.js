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
  // 人为打开一个底层模态
  $('import-modal').classList.add('active');
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(30);
  assert.ok(pop.hidden || pop.style.display === 'none', 'Esc 关闭了 @ 浮层');
  assert.ok($('import-modal').classList.contains('active'), '底层模态未被连带关闭（分层语义）');
  // 浮层已关：再按 Esc 才轮到关模态
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(30);
  assert.ok(!$('import-modal').classList.contains('active'), '第二次 Esc 关闭模态');
});
