'use strict';

// UI 测试共享启动器：jsdom 加载真实 public/index.html + 真实 public/app.js，
// 用可控假后端（fetch/EventSource stub）驱动全 app。chat-ui / notes-panel 等 UI 测试共用。
//
// 用法：
//   const { bootUi } = require('./helpers/ui');
//   const ui = await bootUi({ listItems: [...], details: { p1: {...} }, routes: {...} });
//   ui.document.querySelector('.paper-item').click(); ...

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonRes(data, ok = true) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok, data }) };
}
function errRes(status) {
  return { ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: 'err ' + status }) };
}

/** 假 EventSource：构造时按 URL 参数推进指定论文的 chat，异步发 token + done。
 *  regen=1 时先弹末尾轮（模拟服务端 regenerate 语义）。 */
function makeFakeEventSource(backend) {
  return class FakeEventSource {
    constructor(url) {
      const u = new URL(url, 'http://localhost');
      backend.esUrls.push(u.pathname + u.search);
      const m = /^\/api\/papers\/([\w.-]+)\/chat$/.exec(u.pathname);
      const message = u.searchParams.get('message');
      const regen = u.searchParams.get('regenerate');
      if (m && backend.details[m[1]]) {
        const chat = backend.details[m[1]].chat;
        if (regen) backend.details[m[1]].chat = chat.slice(0, -2);
        if (message || regen) {
          backend.details[m[1]].chat.push({ role: 'user', content: message || '旧问题', ts: 10 });
          backend.details[m[1]].chat.push({ role: 'assistant', content: backend.chatReply, ts: 11 });
        }
      }
      this._ls = {};
      this.onerror = null;
      setTimeout(() => {
        const chat = m && backend.details[m[1]] ? backend.details[m[1]].chat : [];
        this._fire('token', { t: backend.chatReply, kind: 'content' });
        this._fire('done', { reply: backend.chatReply, chat });
      }, 0);
    }
    addEventListener(type, fn) {
      (this._ls[type] = this._ls[type] || []).push(fn);
    }
    _fire(type, obj) {
      (this._ls[type] || []).forEach((f) => f({ data: JSON.stringify(obj) }));
    }
    close() {}
  };
}

/** 默认假后端。listItems：列表视图数组；details：{ id: detailView 对象 }（可变引用，测试可重置）。 */
function makeBackend({ listItems, details, routes = {}, chatReply = '这是 AI 的完整回答。' }) {
  const backend = {
    listItems,
    details,
    patches: [], // [{id, body}]
    posts: [],   // [{path, body?}]
    esUrls: [],
    clipWrites: [],
    chatReply,
  };
  backend.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method !== 'GET') backend.posts.push({ path: p + u.search, body });
    // 自定义路由优先（测试专项端点，如 notes/generate）
    if (routes[p]) return routes[p]({ method, body, url: u, backend });
    if (p === '/api/spaces') {
      return jsonRes({
        activeSpaceId: 'default',
        spaces: [{ id: 'default', name: 'LLM', papersDir: 'LLM', createdAt: 1, scanIntervalMinutes: 5, lastScanAt: 0, paperCount: listItems.length }],
      });
    }
    if (p === '/api/papers' && method === 'GET') return jsonRes(listItems);
    const pm = /^\/api\/papers\/([\w.-]+)$/.exec(p);
    if (pm && method === 'GET') return details[pm[1]] ? jsonRes(details[pm[1]]) : errRes(404);
    if (pm && method === 'PATCH') {
      const d = details[pm[1]];
      if (!d) return errRes(404);
      backend.patches.push({ id: pm[1], body });
      for (const k of Object.keys(body)) d[k] = body[k];
      // 模拟服务端 noteCards 归一化（补 id/时间戳）
      if ('noteCards' in body) {
        d.noteCards = (Array.isArray(body.noteCards) ? body.noteCards : []).map((c, i) => ({
          id: c.id || 'nc-srv' + i,
          type: ['qa', 'skeleton', 'manual'].includes(c.type) ? c.type : 'manual',
          title: String(c.title || ''), body: String(c.body || ''),
          ...(c.meta && typeof c.meta === 'object' ? { meta: c.meta } : {}),
          createdAt: c.createdAt || 100, updatedAt: c.updatedAt || 100,
        }));
      }
      return jsonRes(d);
    }
    if (p === '/api/tags') return jsonRes(['llm']);
    if (p === '/api/topics') return jsonRes(['NLP']);
    if (p === '/api/folders') return jsonRes([]);
    if (p === '/api/stats') return jsonRes({ ready: 1, total: 1, processing: 0, error: 0, concepts: 0, starred: 0, unread: 1 });
    if (p === '/api/ai/models') return jsonRes({ models: [{ id: 'm' }], default: 'm', source: 'config' });
    return errRes(404);
  };
  backend.FakeEventSource = makeFakeEventSource(backend);
  return backend;
}

/** 启动 app：返回 { dom, window, document, backend, $, sleep, intervalFns }。
 *  intervalFns：app 的 setInterval 回调捕获（unref 不挂进程），供测试手动触发轮询。 */
async function bootUi({ listItems, details, routes, chatReply } = {}) {
  const backend = makeBackend({ listItems: listItems || [], details: details || {}, routes, chatReply });
  const html = fs
    .readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, ''); // 剥离 vendor script，手动 import app.js
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.localStorage = w.localStorage;
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
  globalThis.EventSource = backend.FakeEventSource;
  w.EventSource = backend.FakeEventSource;
  globalThis.fetch = backend.fetch;
  w.fetch = backend.fetch;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.confirm = w.confirm = () => true;
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { writeText: async (t) => { backend.clipWrites.push(t); } },
    configurable: true,
  });
  w.Element.prototype.scrollIntoView = function () {
    (backend.scrollIntoViewCalls = backend.scrollIntoViewCalls || []).push(this);
  };
  // vendor 全局（index.html 里由 <script> 注入，这里手动装）：marked / DOMPurify / katex
  globalThis.marked = require('marked').marked;
  globalThis.DOMPurify = require('dompurify')(w);
  globalThis.katex = require('katex');
  // app 的 setInterval（10s 轮询）：unref 不挂测试进程 + 捕获回调供手动触发
  const intervalFns = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    intervalFns.push(fn);
    const t = origSetInterval(fn, ms, ...args);
    if (t && t.unref) t.unref();
    return t;
  };
  await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'app.js')).href);
  // 等 boot（loadSpaces + refresh）渲染列表
  for (let i = 0; i < 100 && !w.document.querySelector('.paper-item'); i++) await sleep(20);
  return {
    dom,
    window: w,
    document: w.document,
    backend,
    intervalFns,
    sleep,
    $: (id) => w.document.getElementById(id),
  };
}

module.exports = { bootUi, sleep };
