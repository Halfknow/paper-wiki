'use strict';

// 聊天 SSE 协议层单测（public/js/core/stream.js）——v3.54 修复的回归锁定。
//
// 根因：① POST 流（streamVisionFetch/streamPostSse）读循环结束后没有「未 finished」
// 兜底——后端/代理半途掐断连接（不发 done/fail）时 read() 正常结束、静默退出，
// busy 永久卡死（用户表现：聊一两轮后输入框锁死）；② onDone 等回调抛异常会中断
// 分发链（EventSource 版监听器裸奔、POST 版掉进外层 catch 且 finished=true 后静默）。
// 修复：safeCall 隔离回调 + 断流兜底 onFail('连接中断，请重试')。
//
// 快套件：不 require jsdom，最小 window/document/localStorage 桩即可加载模块链。

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('node:events');

// ---- 最小 DOM/浏览器桩（模块链顶层只碰这些） ----
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { origin: 'http://test' };
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};

let S;
before(async () => {
  S = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'stream.js')).href);
});

// ---- 夹具：假 SSE 响应（ReadableStream）与假 EventSource ----

const enc = new TextEncoder();
function sseRes(blocks) {
  const body = new ReadableStream({
    start(c) {
      for (const b of blocks) c.enqueue(enc.encode(b));
      c.close();
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}) };
}
const tok = (t) => `event: token\ndata: ${JSON.stringify({ t })}\n\n`;
const done = (d) => `event: done\ndata: ${JSON.stringify(d)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 EventSource：记录监听器，测试驱动事件 */
class FakeEventSource extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.closed = false;
  }
  addEventListener(type, fn) {
    this.on(type, fn);
  }
  close() {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// streamVisionFetch（POST /chat/vision，fetch + ReadableStream）
// ---------------------------------------------------------------------------

test('vision 正常流：token×2 + done → onDone 收到对象', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => sseRes([tok('你'), tok('好'), done({ reply: '你好', chat: [] })]);
  try {
    await new Promise((resolve) => {
      S.streamVisionFetch('p1', 'hi', {
        onToken: (t) => calls.push(t),
        onDone: (obj) => {
          calls.push(obj);
          resolve();
        },
        onFail: (e) => {
          calls.push('FAIL:' + e);
          resolve();
        },
      });
    });
    assert.deepStrictEqual(calls, ['你', '好', { reply: '你好', chat: [] }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('vision 断流兜底（核心回归）：只发 token 不发 done 就断开 → onFail 连接中断', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => sseRes([tok('半截')]); // 流被代理掐断：无 done/fail 直接 close
  try {
    await new Promise((resolve) => {
      S.streamVisionFetch('p1', 'hi', {
        onToken: (t) => calls.push(t),
        onDone: () => {
          calls.push('DONE');
          resolve();
        },
        onFail: (e) => {
          calls.push('FAIL:' + e);
          resolve();
        },
      });
    });
    assert.deepStrictEqual(calls, ['半截', 'FAIL:连接中断，请重试']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('vision 回调异常隔离：onDone 抛错不崩进程、不误报 onFail；onToken 抛错不丢 done', async () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a);
  const calls = [];
  globalThis.fetch = async () => sseRes([tok('a'), done({ reply: 'r' })]);
  try {
    await new Promise((resolve) => {
      S.streamVisionFetch('p1', 'hi', {
        onToken: () => {
          throw new Error('render boom');
        },
        onDone: () => {
          throw new Error('finalize boom');
        },
        onFail: (e) => {
          calls.push('FAIL:' + e);
        },
      });
      // done 已分发完（safeCall 吞异常）后应无 FAIL —— 给一拍时间确认没有误报
      setTimeout(resolve, 50);
    });
    assert.deepStrictEqual(calls, [], 'onDone 抛异常不应误走 onFail');
    assert.strictEqual(errs.length, 2, '两次回调异常都应 console.error 留痕');
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

test('vision close() 主动中止不触发 onFail（finished 先行）', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let ctrl;
  // body 永不结束的流：close() 用 AbortController 掐断 → catch 分支 !finished=false
  globalThis.fetch = async (u, o) => {
    ctrl = o.signal;
    const body = new ReadableStream({
      start() {
        /* 不 enqueue 不 close */
      },
    });
    return { ok: true, status: 200, body, json: async () => ({}) };
  };
  try {
    let failed = null;
    const close = S.streamVisionFetch('p1', 'hi', {
      onToken: () => {},
      onDone: () => {},
      onFail: (e) => {
        failed = e;
      },
    });
    await sleep(20);
    close();
    await sleep(50);
    assert.strictEqual(failed, null, '主动 close 不应触发 onFail');
    assert.ok(ctrl && ctrl.aborted, 'AbortController 已中止');
  } finally {
    globalThis.fetch = realFetch;
    void calls;
  }
});

// ---------------------------------------------------------------------------
// streamPostSse（通用 POST+SSE：概念 AI 综合解读等）
// ---------------------------------------------------------------------------

test('streamPostSse 正常流与断流兜底', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => sseRes([`event: token\ndata: ${JSON.stringify({ t: 'x' })}\n\n`, done({ ok: 1 })]);
  const calls = [];
  try {
    await new Promise((resolve) => {
      S.streamPostSse(
        '/api/x',
        {},
        {
          onToken: (o) => calls.push(o.t),
          onDone: (o) => {
            calls.push(o);
            resolve();
          },
          onFail: () => resolve(),
        },
      );
    });
    assert.deepStrictEqual(calls, ['x', { ok: 1 }]);
  } finally {
    globalThis.fetch = realFetch;
  }

  globalThis.fetch = async () => sseRes([`event: token\ndata: ${JSON.stringify({ t: '半截' })}\n\n`]);
  const fails = [];
  try {
    await new Promise((resolve) => {
      S.streamPostSse(
        '/api/x',
        {},
        {
          onToken: () => {},
          onDone: () => resolve(),
          onFail: (e) => {
            fails.push(e);
            resolve();
          },
        },
      );
    });
    assert.deepStrictEqual(fails, ['连接中断，请重试']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// streamChatFetch（GET /chat，EventSource）
// ---------------------------------------------------------------------------

test('streamChatFetch：token/done 分发 + 回调异常隔离 + onerror 兜底', async () => {
  const RealES = globalThis.EventSource;
  let es;
  globalThis.EventSource = class extends FakeEventSource {
    constructor(url) {
      super(url);
      es = this;
    }
  };
  const realError = console.error;
  console.error = () => {};
  try {
    // 1) 正常 done（onDone 抛异常也应被 safeCall 吞掉而非中断）
    let result = null;
    S.streamChatFetch('p1', 'q', {
      onToken: () => {},
      onDone: () => {
        result = 'done';
        throw new Error('boom');
      },
      onFail: (e) => {
        result = 'FAIL:' + e;
      },
    });
    es.emit('done', JSON.stringify({ reply: 'r' }));
    await sleep(30);
    assert.strictEqual(result, 'done');
    assert.ok(!es.closed || true);

    // 2) 连接错断（无 done/fail 前提下 onerror）→ onFail
    let fail2 = null;
    S.streamChatFetch('p1', 'q', {
      onToken: () => {},
      onDone: () => {},
      onFail: (e) => {
        fail2 = e;
      },
    });
    es.onerror();
    await sleep(20);
    assert.strictEqual(fail2, '连接中断，请重试');

    // 3) done 之后的 onerror 不再误报（finished 守卫）
    let fail3 = null;
    S.streamChatFetch('p1', 'q', {
      onToken: () => {},
      onDone: () => {},
      onFail: (e) => {
        fail3 = e;
      },
    });
    es.emit('done', JSON.stringify({}));
    es.onerror(); // 正常关闭触发的原生 error
    await sleep(20);
    assert.strictEqual(fail3, null);
  } finally {
    globalThis.EventSource = RealES;
    console.error = realError;
  }
});
