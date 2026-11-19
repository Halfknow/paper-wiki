// jsdom 驱动的 AI 聊天输入框 UI 测试：加载真实 index.html + 真实 public/app.js（浏览器 ESM 模块），
// 用假后端（fetch/EventSource stub）驱动「选中论文 → 聊天 tab → 输入/发送/删除/编辑/重新生成/
// 存笔记/清空/@引用/参数浮层/草稿保护」全链路常规操作。
//
// 覆盖的是 app.js 详情 tab 聊天（reader 抽屉聊天依赖 pdf.js，不在 jsdom 范围，由 e2e 兜底）。
// 运行环境：需要 jsdom（devDependency 语义；CI 上随 npm install 安装）。

const { guardSlowFile } = require('./helpers/slow');
if (guardSlowFile('chat-ui')) return;

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 无 jsdom 环境（如精简 CI）：整文件跳过而不是报错
  test.skip('chat-ui: jsdom 不可用，跳过', () => {});
  return;
}

// ---------------------------------------------------------------------------
// 假后端：内存论文 + fetch/EventSource stub
// ---------------------------------------------------------------------------

const backend = {
  listItem: {
    id: 'p1', filename: 'a.pdf', title: '测试论文 Alpha', authors: ['Alice'], year: '2024',
    abstract: '', arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 100, summaryExcerpt: 'TL;DR', status: 'ready', error: null,
    tags: ['llm'], topics: ['NLP'], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false, conceptCount: 0,
  },
  listItem2: {
    id: 'p2', filename: 'b.pdf', title: '候选论文 Beta', authors: ['Bob'], year: '2023',
    abstract: '', arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 50, summaryExcerpt: 'TL;DR2', status: 'ready', error: null,
    tags: [], topics: [], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 2, updatedAt: 2, hasSummary: true, hasNotes: false, conceptCount: 0,
  },
  detail: null, // GET /api/papers/p1 返回的可变详情对象（每个用例可重置）
  patches: [],  // PATCH 捕获 [{body}]
  esUrls: [],   // EventSource 捕获
  chatReply: '这是 AI 的完整回答。',
};

function resetDetail(chat) {
  backend.detail = {
    ...backend.listItem,
    summary: '## TL;DR\n总结', notes: '', noteCards: [], abstract: '摘要', fulltextChars: 100,
    conceptIds: [], annotations: null,
    chat: chat || [
      { role: 'user', content: '旧问题一', ts: 1 },
      { role: 'assistant', content: '旧回答一', ts: 2 },
    ],
  };
}

function jsonRes(data, ok = true) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok, data }) };
}
function errRes(status) {
  return { ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: 'err ' + status }) };
}

function makeFetch() {
  return async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    if (p === '/api/spaces') {
      return jsonRes({
        activeSpaceId: 'default',
        spaces: [{ id: 'default', name: 'LLM', papersDir: 'LLM', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0, paperCount: 1 }],
      });
    }
    if (p === '/api/papers' && method === 'GET') return jsonRes([backend.listItem, backend.listItem2]);
    if (p === '/api/papers/p1' && method === 'GET') return jsonRes(backend.detail);
    if (p === '/api/papers/p2' && method === 'GET') return jsonRes({ ...backend.listItem2, summary: '', notes: '', noteCards: [], abstract: '', fulltextChars: 50, conceptIds: [], annotations: null, chat: [] });
    if (p === '/api/papers/p1' && method === 'PATCH') {
      const body = JSON.parse(opts.body || '{}');
      backend.patches.push(body);
      if ('chat' in body) backend.detail.chat = body.chat;
      if ('noteCards' in body) {
        // 模拟服务端归一化：补 id/时间戳
        backend.detail.noteCards = (Array.isArray(body.noteCards) ? body.noteCards : []).map((c, i) => ({
          id: c.id || 'nc-srv' + i, type: c.type || 'manual', title: c.title || '', body: c.body || '',
          ...(c.meta ? { meta: c.meta } : {}), createdAt: c.createdAt || 100, updatedAt: c.updatedAt || 100,
        }));
      }
      return jsonRes(backend.detail);
    }
    if (p === '/api/tags') return jsonRes(['llm']);
    if (p === '/api/topics') return jsonRes(['NLP']);
    if (p === '/api/folders') return jsonRes([]);
    if (p === '/api/stats') return jsonRes({ ready: 1, total: 1, processing: 0, error: 0, concepts: 0, starred: 0, unread: 1 });
    if (p === '/api/ai/models') return jsonRes({ models: [{ id: 'm' }], default: 'm', source: 'config' });
    return errRes(404);
  };
}

/** 假 EventSource：构造时按 URL 参数推进后端聊天状态，异步发 token + done。 */
class FakeEventSource {
  constructor(url) {
    const u = new URL(url, 'http://localhost');
    backend.esUrls.push(u.pathname + u.search);
    const message = u.searchParams.get('message');
    const regen = u.searchParams.get('regenerate');
    if (regen) backend.detail.chat = backend.detail.chat.slice(0, -2); // 服务端弹末尾轮
    if (message || regen) {
      backend.detail.chat.push({ role: 'user', content: message || '旧问题一', ts: 10 });
      backend.detail.chat.push({ role: 'assistant', content: backend.chatReply, ts: 11 });
    }
    this._ls = {};
    this.onerror = null;
    setTimeout(() => {
      this._fire('token', { t: backend.chatReply, kind: 'content' });
      this._fire('done', { reply: backend.chatReply, chat: backend.detail.chat });
    }, 0);
  }
  addEventListener(type, fn) {
    (this._ls[type] = this._ls[type] || []).push(fn);
  }
  _fire(type, obj) {
    (this._ls[type] || []).forEach((f) => f({ data: JSON.stringify(obj) }));
  }
  close() {}
}

// ---------------------------------------------------------------------------
// DOM 启动：真实 index.html + 真实 app.js
// ---------------------------------------------------------------------------

let dom;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => dom.window.document.getElementById(id);

before(async () => {
  resetDetail();
  // 注册 boot-loader resolve 钩子（把 /vendor/* 绝对路径映射到空 stub，
  // 让 reader-host→reader.js 的 pdfjs 副作用 import 在 jsdom 不崩）。
  // 此文件自包含 bootUi（不依赖 helpers/ui.js），需自行注册。
  try {
    require('node:module').register(pathToFileURL(path.join(__dirname, 'helpers', 'boot-loader.mjs')).href);
  } catch { /* 重复注册或 Node < 20.6 忽略 */ }
  const html = fs
    .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, ''); // 剥离 vendor script，手动 import app.js
  dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  // 浏览器全局 → node 全局（app.js 以裸标识符访问 document/localStorage/fetch 等）
  globalThis.window = w;
  globalThis.document = w.document;
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.localStorage = w.localStorage;
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
  globalThis.EventSource = FakeEventSource;
  w.EventSource = FakeEventSource;
  globalThis.fetch = makeFetch();
  w.fetch = globalThis.fetch;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.confirm = w.confirm = () => true;
  // PWDialog 桩：app 已改用自定义弹窗（public/dialog.js，jsdom 剥离 <script> 后不加载），
  // 委托到上面的 confirm 桩（固定确认）。
  globalThis.PWDialog = w.PWDialog = {
    confirm: (msg, opts) => Promise.resolve(globalThis.confirm(msg, opts)),
    prompt: () => Promise.resolve(null),
    alert: () => Promise.resolve(true),
  };
  // layers.js（classic script，挂 window.PWLayers，v3.65 P2）：与 helpers/ui.js 同法手动执行；
  // 缺席时 app 启动即抛「PWLayers 未加载」。
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'layers.js'), 'utf8'), { window: w });
  const clipWrites = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { clipWrites.push(t); } }, configurable: true });
  backend.clipWrites = clipWrites;
  w.Element.prototype.scrollIntoView = function () {};
  // vendor 全局（index.html 里由 <script> 注入，这里手动装）：marked / DOMPurify / katex
  globalThis.marked = require('marked').marked;
  globalThis.DOMPurify = require('dompurify')(w);
  globalThis.katex = require('katex');
  // app.js 的 10s 轮询 interval 不挂住测试进程
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    const t = origSetInterval(fn, ms, ...args);
    if (t && t.unref) t.unref();
    return t;
  };
  await import(pathToFileURL(path.join(__dirname, '..', 'public', 'app.js')).href);
  // 等 boot（loadSpaces + refresh）渲染列表
  for (let i = 0; i < 100 && !w.document.querySelector('.paper-item'); i++) await sleep(20);
  assert.ok(w.document.querySelector('.paper-item'), 'boot 后论文列表应渲染');
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function openChatTab() {
  const doc = dom.window.document;
  doc.querySelector('.paper-item').click();
  for (let i = 0; i < 50 && !$('tab-body'); i++) await sleep(20);
  await sleep(30);
  doc.querySelector('.tab[data-tab="chat"]').click();
  await sleep(30);
}
function typeInto(el, text) {
  el.value = text;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
function pressKey(el, key, opts = {}) {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}
const chatTexts = () => [...dom.window.document.querySelectorAll('#chat-list .chat-msg')].map((m) => m.className.includes('user') ? 'user' : 'assistant');
const lastPatch = () => backend.patches[backend.patches.length - 1];

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('聊天 tab：composer 渲染 + 历史消息回显', async () => {
  resetDetail();
  await openChatTab();
  assert.ok($('chat-input'), '输入框存在');
  assert.ok($('chat-send'), '发送键存在');
  assert.deepStrictEqual(chatTexts(), ['user', 'assistant'], '历史两轮回显');
});

test('发送键空输入禁用，输入后启用', async () => {
  await openChatTab();
  const input = $('chat-input'), send = $('chat-send');
  typeInto(input, '');
  assert.strictEqual(send.disabled, true, '空输入禁用');
  typeInto(input, '这篇论文的核心方法是什么？');
  assert.strictEqual(send.disabled, false, '有输入启用');
});

test('Enter 发送：EventSource 带 message → 用户消息上屏 → done 后 AI 定型 + 输入框清空', async () => {
  resetDetail();
  await openChatTab();
  const before2 = backend.esUrls.length;
  const input = $('chat-input');
  typeInto(input, '核心贡献是什么？');
  pressKey(input, 'Enter');
  await sleep(10);
  // EventSource 收到正确 message 参数
  const url = backend.esUrls[backend.esUrls.length - 1];
  assert.ok(backend.esUrls.length > before2, '发起了流式请求');
  assert.ok(url.includes('message=' + encodeURIComponent('核心贡献是什么？')), 'URL 带 message');
  // done 后：服务端权威 chat 回写，最后一条 assistant 带操作按钮（重新生成）
  for (let i = 0; i < 50 && !dom.window.document.querySelector('#chat-list .chat-act[data-act="regen"]'); i++) await sleep(20);
  assert.deepStrictEqual(chatTexts(), ['user', 'assistant', 'user', 'assistant'], '新旧两轮齐全');
  const last = [...dom.window.document.querySelectorAll('#chat-list .chat-msg')].pop();
  assert.ok(last.textContent.includes('这是 AI 的完整回答'), '回答定型上屏');
  assert.strictEqual(input.value, '', '输入框已清空');
  assert.strictEqual(input.disabled, false, '不再 busy（输入解锁）');
});

test('删除 assistant 消息：PATCH 只删该条', async () => {
  resetDetail(); // [旧问题一, 旧回答一]
  await openChatTab();
  backend.patches.length = 0;
  const btn = dom.window.document.querySelector('#chat-list .chat-msg.assistant .chat-act[data-act="delete"]');
  btn.click();
  await sleep(30);
  assert.deepStrictEqual(lastPatch(), { chat: [{ role: 'user', content: '旧问题一', ts: 1 }] }, 'PATCH 体只剩 user 消息');
  assert.deepStrictEqual(chatTexts(), ['user'], 'DOM 同步删除');
});

test('删除 user 消息：连同其回答一起删', async () => {
  resetDetail();
  await openChatTab();
  backend.patches.length = 0;
  const btn = dom.window.document.querySelector('#chat-list .chat-msg.user .chat-act[data-act="delete"]');
  btn.click();
  await sleep(30);
  assert.deepStrictEqual(lastPatch(), { chat: [] }, 'user + 紧随 assistant 一起删');
});

test('编辑 user 消息：内容回填输入框', async () => {
  resetDetail();
  await openChatTab();
  dom.window.document.querySelector('#chat-list .chat-act[data-act="edit"]').click();
  await sleep(20);
  assert.strictEqual($('chat-input').value, '旧问题一', '编辑回填到输入框');
});

test('重新生成：EventSource 带 regenerate=1，服务端弹旧轮后重新回答', async () => {
  resetDetail();
  await openChatTab();
  backend.esUrls.length = 0;
  dom.window.document.querySelector('#chat-list .chat-act[data-act="regen"]').click();
  for (let i = 0; i < 50 && !backend.esUrls.length; i++) await sleep(20);
  assert.ok(backend.esUrls[0].includes('regenerate=1'), 'URL 带 regenerate=1');
  for (let i = 0; i < 50 && !dom.window.document.querySelector('#chat-list .chat-act[data-act="regen"]'); i++) await sleep(20);
  const msgs = [...dom.window.document.querySelectorAll('#chat-list .chat-msg')];
  assert.strictEqual(msgs.length, 2, '旧轮被替换而非追加');
  assert.ok(msgs[1].textContent.includes('这是 AI 的完整回答'));
});

test('存入笔记：该回答 + 前溯 user 问题 → PATCH noteCards 问答卡', async () => {
  resetDetail();
  await openChatTab();
  backend.patches.length = 0;
  dom.window.document.querySelector('#chat-list .chat-act[data-act="note"]').click();
  for (let i = 0; i < 50 && !backend.patches.length; i++) await sleep(20);
  const p = lastPatch();
  assert.ok(Array.isArray(p.noteCards) && p.noteCards.length === 1, 'PATCH 了一张卡');
  const c = p.noteCards[0];
  assert.strictEqual(c.type, 'qa');
  assert.strictEqual(c.title, 'Q: 旧问题一');
  assert.strictEqual(c.body, '旧回答一');
  assert.deepStrictEqual(c.meta, { question: '旧问题一', mi: 1 });
});

test('复制回答：写入剪贴板', async () => {
  resetDetail();
  await openChatTab();
  backend.clipWrites.length = 0;
  dom.window.document.querySelector('#chat-list .chat-act[data-act="copy"]').click();
  await sleep(30);
  assert.deepStrictEqual(backend.clipWrites, ['旧回答一']);
});

test('清空聊天：PATCH chat 为空数组', async () => {
  resetDetail();
  await openChatTab();
  backend.patches.length = 0;
  dom.window.document.querySelector('#chat-clear').click();
  await sleep(30);
  assert.deepStrictEqual(lastPatch(), { chat: [] });
});

test('空聊天时建议卡片：点击即填入并发送', async () => {
  resetDetail([]); // 空聊天 → 空状态建议卡片
  await openChatTab();
  const sug = dom.window.document.querySelector('#chat-list .chat-suggest');
  assert.ok(sug, '空状态渲染建议卡片');
  backend.esUrls.length = 0;
  sug.click();
  for (let i = 0; i < 50 && !backend.esUrls.length; i++) await sleep(20);
  assert.ok(backend.esUrls[0].includes('message='), '建议卡片触发发送');
});

test('@ 触发引用浮层：输入 @ 显示候选论文', async () => {
  resetDetail();
  await openChatTab();
  const input = $('chat-input');
  typeInto(input, '@');
  await sleep(50);
  const pop = dom.window.document.querySelector('.chat-mention-pop');
  assert.ok(pop && !pop.hidden && pop.style.display !== 'none', '@ 浮层打开');
  assert.ok(pop.textContent.includes('候选论文 Beta'), '候选含库内其它论文（当前论文被排除）');
});

test('参数浮层：勾选 temperature 写入 localStorage chatParams', async () => {
  resetDetail();
  await openChatTab();
  dom.window.localStorage.removeItem('chatParams');
  $('chat-params-btn').click();
  await sleep(20);
  const pop = $('chat-params-pop');
  assert.strictEqual(pop.hidden, false, '参数浮层打开');
  const sw = pop.querySelector('[data-key="temperature"] .pp-switch');
  sw.checked = true;
  sw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(20);
  const saved = JSON.parse(dom.window.localStorage.getItem('chatParams') || '{}');
  assert.strictEqual(saved.temperature && saved.temperature.enabled, true, 'temperature 启用已持久化');
});

test('草稿保护：输入后切走再切回聊天 tab，草稿回填', async () => {
  resetDetail();
  await openChatTab();
  typeInto($('chat-input'), '还没打完的草稿');
  dom.window.document.querySelector('.tab[data-tab="summary"]').click();
  await sleep(30);
  dom.window.document.querySelector('.tab[data-tab="chat"]').click();
  await sleep(30);
  assert.strictEqual($('chat-input').value, '还没打完的草稿', 'renderDetail 重建后草稿从 chatState 回填');
});

test('流式选区保护：选中流式气泡时 token 重渲跳过、done 定型推迟到选区释放', async () => {
  resetDetail();
  await openChatTab();
  // 手动驱动的 EventSource（真实流式时序：token 逐个到达，done 最后）
  let es = null;
  class ManualES {
    constructor(url) { es = this; this._ls = {}; this.onerror = null; backend.esUrls.push(new URL(url, 'http://localhost').pathname); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    fire(t, obj) { (this._ls[t] || []).forEach((f) => f({ data: JSON.stringify(obj) })); }
    close() {}
  }
  const OrigES = globalThis.EventSource;
  globalThis.EventSource = ManualES;
  dom.window.EventSource = ManualES;
  const doc = dom.window.document;
  try {
    typeInto($('chat-input'), '流式选区测试');
    pressKey($('chat-input'), 'Enter');
    await sleep(10);
    assert.ok(es, '流式请求已发起');
    es.fire('token', { t: '第一段内容。', kind: 'content' });
    await sleep(10);
    const content = doc.querySelector('#chat-list .chat-msg.assistant[data-streaming="1"] .chat-content');
    assert.ok(content && content.textContent.includes('第一段'), '首段上屏');
    // 在流式气泡内建立选区
    const range = doc.createRange();
    range.selectNodeContents(content);
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    assert.ok(!sel.isCollapsed, '选区已建立');
    // 后续 token：渲染被守卫跳过（DOM 不重建），选区存活
    es.fire('token', { t: '第二段内容。', kind: 'content' });
    await sleep(10);
    assert.ok(!content.textContent.includes('第二段'), '有选区：token 渲染跳过（未重建 DOM）');
    assert.ok(!sel.isCollapsed && sel.toString().includes('第一段'), '选区未被摧毁');
    // done：定型 replaceWith 推迟——占位节点仍在、操作按钮未出
    backend.detail.chat.push({ role: 'user', content: '流式选区测试', ts: 10 }, { role: 'assistant', content: '第一段内容。第二段内容。', ts: 11 });
    es.fire('done', { reply: '第一段内容。第二段内容。', chat: backend.detail.chat });
    await sleep(10);
    assert.ok(!sel.isCollapsed, 'done 后选区仍在（定型推迟）');
    assert.ok(doc.querySelector('#chat-list .chat-msg.assistant[data-streaming="1"]'), '流式占位未被替换（推迟中）');
    // 释放选区 → 补渲定型结构（占位消失，末条出现操作按钮）
    sel.removeAllRanges();
    doc.dispatchEvent(new dom.window.Event('selectionchange'));
    await sleep(10);
    assert.ok(!doc.querySelector('#chat-list .chat-msg.assistant[data-streaming="1"]'), '选区释放后定型补渲');
    const lastMsg = [...doc.querySelectorAll('#chat-list .chat-msg')].pop();
    assert.ok(lastMsg.querySelector('.chat-act[data-act="regen"]'), '末条消息已定型（含操作按钮）');
  } finally {
    globalThis.EventSource = OrigES;
    dom.window.EventSource = OrigES;
  }
});
