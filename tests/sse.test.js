const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const pathm = require('node:path');
const { createApiRouter } = require('../src/api/router');

// ---- 测试夹具（从 tests/api.test.js 复制，保持本文件自包含）----

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try {
        await handler(req, res, body);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 伪造最小 manager + 可变 scanner（与 tests/api.test.js 的 baseCtx 同形）。 */
function baseCtx(store, save, opts = {}) {
  const globalConfig = opts.config || { ai: {}, scanIntervalMinutes: 5 };
  const papersDir = opts.papersDir || 'papers';
  const spaceObj = { id: 'default', name: '默认', papersDir, scanIntervalMinutes: 5, lastScanAt: 0, createdAt: 0 };
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj,
    getSpace: (id) => (id === 'default' ? spaceObj : null),
    listSpaces: () => [spaceObj],
    getStorePath: () => 'papers.json',
    getSpaceStore: async () => store,
    saveStoreBinder: () => async () => {
      if (save) await save(store);
    },
    resolveSpacePapersDir: () => papersDir,
    resolveSpaceTextDir: () => pathm.join(papersDir, 'text'),
    spacesView: async () => ({ activeSpaceId: 'default', spaces: [{ ...spaceObj, paperCount: 0 }] }),
    minScheduledIntervalMs: () => 5 * 60 * 1000,
    scheduledSpaces: () => [spaceObj],
    markScanned: async () => {},
    backupAllSpaces: async () => {},
  };
  const scanner = {
    scan: async () => ({ added: 0 }),
    scanSpace: async () => ({ added: 0 }),
    enqueue: () => {},
    extractConcepts: async (spaceId, ids) => ({ processed: ids.length, added: 1 }),
    retagPapers: async (spaceId, ids) => ({ processed: ids.length }),
    chatPaper: async (spaceId, id, message) => ({ reply: '', chat: [] }),
    reschedule: async () => {},
    invalidate: () => {},
  };
  return { manager, scanner, globalConfig };
}

function chatStore() {
  return {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { p1: { id: 'p1', title: 'T', abstract: 'A', status: 'ready', chat: [] } },
  };
}

/** 流式 chatPaper stub：推两个 token 后返回完整结果，捕获 opts 供断言。 */
function stubChatPaper(ctx, captured) {
  ctx.scanner.chatPaper = async (spaceId, id, message, opts) => {
    captured.opts = opts;
    captured.message = message;
    opts.onToken('你好', 'content');
    opts.onToken('世界', 'content');
    return {
      reply: '你好世界',
      chat: [
        { role: 'user', content: message, ts: 1 },
        { role: 'assistant', content: '你好世界', ts: 2 },
      ],
    };
  };
}

/** 解析 SSE 文本为 [{event, data}] 数组（data 已 JSON.parse）。 */
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const ev = /^event: (.+)$/m.exec(block);
    const da = /^data: (.+)$/m.exec(block);
    if (ev && da) events.push({ event: ev[1], data: JSON.parse(da[1]) });
  }
  return events;
}

// ==================== GET /api/papers/:id/chat（SSE 流式） ====================

test('GET /api/papers/:id/chat SSE：token → done 事件序列 + 响应头', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat?message=` + encodeURIComponent('核心方法？'));
    assert.strictEqual(res.status, 200);
    assert.ok(
      (res.headers.get('content-type') || '').includes('text/event-stream'),
      'Content-Type 应为 text/event-stream',
    );
    const text = await res.text();
    const events = parseSse(text);
    // 事件序列：token, token, done
    assert.deepStrictEqual(
      events.map((e) => e.event),
      ['token', 'token', 'done'],
    );
    assert.deepStrictEqual(events[0].data, { t: '你好', kind: 'content' });
    assert.deepStrictEqual(events[1].data, { t: '世界', kind: 'content' });
    assert.strictEqual(events[2].data.reply, '你好世界');
    assert.deepStrictEqual(events[2].data.chat, [
      { role: 'user', content: '核心方法？', ts: 1 },
      { role: 'assistant', content: '你好世界', ts: 2 },
    ]);
    // token 必须先于 done 出现在原始字节流里
    assert.ok(text.indexOf('event: token') < text.indexOf('event: done'));
    // 无 chatParams 查询参数 → opts.chatParams 为 undefined
    assert.strictEqual(captured.opts.chatParams, undefined);
    assert.strictEqual(captured.message, '核心方法？');
  } finally {
    server.close();
  }
});

test('GET /api/papers/:id/chat chatParams 透传 + model 白名单静默回退', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {}, {
    config: { ai: { model: 'glm-4.6', extraModels: ['gpt-4o'] }, scanIntervalMinutes: 5 },
  });
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    // 合法参数全量透传 + 白名单内 model（extraModels 成员）
    const q1 =
      '?message=x&temperature=0.3&topP=0.9&maxTokens=512&thinking=disabled&model=gpt-4o';
    const r1 = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat${q1}`);
    await r1.text();
    assert.deepStrictEqual(captured.opts.chatParams, {
      thinking: { type: 'disabled' },
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 512,
      model: 'gpt-4o',
    });
    // thinking=enabled + config.ai.model 本身也在白名单
    const r2 = await fetch(
      `http://127.0.0.1:${port}/api/papers/p1/chat?message=x&thinking=enabled&model=glm-4.6`,
    );
    await r2.text();
    assert.deepStrictEqual(captured.opts.chatParams, { thinking: { type: 'enabled' }, model: 'glm-4.6' });
    // 非法 model（不在白名单）→ 静默丢弃，chatParams.model 为 undefined；其余字段不受影响
    const r3 = await fetch(
      `http://127.0.0.1:${port}/api/papers/p1/chat?message=x&model=evil-model&temperature=0.5`,
    );
    await r3.text();
    assert.strictEqual(captured.opts.chatParams.model, undefined, '非白名单 model 应被丢弃');
    assert.strictEqual(captured.opts.chatParams.temperature, 0.5);
    // 非法数值参数 → 被忽略（temperature=abc 不进 chatParams）
    const r4 = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat?message=x&temperature=abc`);
    await r4.text();
    assert.strictEqual(captured.opts.chatParams, undefined, '全部参数非法时 chatParams 整体为 undefined');
  } finally {
    server.close();
  }
});

test('GET /api/papers/:id/chat 边界：空 message 400 / 不存在 404', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const r400 = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat?message=`);
    assert.strictEqual(r400.status, 400);
    const r404 = await fetch(`http://127.0.0.1:${port}/api/papers/nope/chat?message=x`);
    assert.strictEqual(r404.status, 404);
    assert.strictEqual(captured.opts, undefined, '校验失败不应触达 scanner');
  } finally {
    server.close();
  }
});

// ==================== POST /api/papers/:id/chat/vision（SSE 流式） ====================

test('POST /api/papers/:id/chat/vision：合法 1 图 → SSE 流 + opts.images 透传', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const img = 'data:image/png;base64,iVBORw0KGgo=';
    const res = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '这张图讲了什么？', images: [img] }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    const events = parseSse(await res.text());
    assert.deepStrictEqual(
      events.map((e) => e.event),
      ['token', 'token', 'done'],
    );
    assert.strictEqual(events[2].data.reply, '你好世界');
    assert.deepStrictEqual(captured.opts.images, [img], '图片应原样透传给 scanner');
  } finally {
    server.close();
  }
});

test('POST /api/papers/:id/chat/vision：非图片 dataURL 被过滤（当前实现为静默过滤而非 400）', async () => {
  // 注意：router.js:788-790 对图片做白名单 filter + slice(0,4)，不合法图片被静默剔除，
  // 不返回 400。此测试锁定当前实际行为（若未来改为 400 需同步更新）。
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '看图',
        images: ['data:text/html;base64,PGI+', 'not-a-data-url', 'data:image/png;base64,AAAA'],
      }),
    });
    assert.strictEqual(res.status, 200);
    await res.text();
    assert.deepStrictEqual(
      captured.opts.images,
      ['data:image/png;base64,AAAA'],
      '非 data:image/* 的条目应被白名单过滤，仅保留合法图片',
    );
    // 全部非法 → images 为 undefined（空数组不透传）
    const res2 = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '看图', images: ['data:text/html;base64,PGI+'] }),
    });
    assert.strictEqual(res2.status, 200);
    await res2.text();
    assert.strictEqual(captured.opts.images, undefined, '全部图片非法时 opts.images 应为 undefined');
  } finally {
    server.close();
  }
});

test('POST /api/papers/:id/chat/vision：超过 4 张图片截断为 4（当前实现为 slice 而非 400）', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const captured = {};
  stubChatPaper(ctx, captured);
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const imgs = [1, 2, 3, 4, 5, 6].map((i) => `data:image/png;base64,${'A'.repeat(4)}${i}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '看图', images: imgs }),
    });
    assert.strictEqual(res.status, 200);
    await res.text();
    assert.deepStrictEqual(captured.opts.images, imgs.slice(0, 4), '超过 4 张应截断为前 4 张');
    // 空 message → 400
    const r400 = await fetch(`http://127.0.0.1:${port}/api/papers/p1/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '  ', images: imgs }),
    });
    assert.strictEqual(r400.status, 400);
    // 不存在论文 → 404
    const r404 = await fetch(`http://127.0.0.1:${port}/api/papers/nope/chat/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x', images: imgs }),
    });
    assert.strictEqual(r404.status, 404);
  } finally {
    server.close();
  }
});

// ==================== GET /api/discover/stream ====================

test('GET /api/discover/stream：空 topic → 400（流式发现走真实 discover 模块，仅测校验分支）', async () => {
  const store = chatStore();
  const ctx = baseCtx(store, async () => {});
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/api/discover/stream?topic=`);
    assert.strictEqual(r1.status, 400);
    const j1 = await r1.json();
    assert.strictEqual(j1.ok, false);
    // 纯空白 topic（trim 后为空）同样 400
    const r2 = await fetch(`http://127.0.0.1:${port}/api/discover/stream?topic=` + encodeURIComponent('   '));
    assert.strictEqual(r2.status, 400);
    // 不带 topic 参数 → 400
    const r3 = await fetch(`http://127.0.0.1:${port}/api/discover/stream`);
    assert.strictEqual(r3.status, 400);
  } finally {
    server.close();
  }
});
