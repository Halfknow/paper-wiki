'use strict';

// SPA fallback 判定（src/server.js 的 isAppRoute）单测——纯函数，毫秒级。
//
// 前端改用 History API 干净 URL（/paper/:id、/settings/ai）后，直接刷新或分享深链会打到服务端，
// 而磁盘上并不存在这些路径的文件。isAppRoute 决定「哪些路径回 index.html 交给前端路由器」。
//
// 判定要点（顺序即优先级）：
//  1. 保留前缀 /api/ /papers/ /vendor/ 一律不接管（分别是 API、PDF 原文、node_modules 映射）
//  2. 末段带扩展名的一律不接管（/app.js、/styles.css、/js/core/router.js —— 真实静态文件）
//  3. 其余无扩展名路径接管（/、/library、/paper/abc、/settings/ai）

const { test } = require('node:test');
const assert = require('node:assert');
const { isAppRoute } = require('../src/server');

test('isAppRoute：前端路由路径接管', () => {
  for (const p of [
    '/',
    '/library',
    '/paper/9f2a1b3c4d5e6f70',
    '/paper/9f2a1b3c4d5e6f70/chat',
    '/reader/9f2a1b3c4d5e6f70',
    '/concepts',
    '/concepts/maps',
    '/concepts/maps/cm_abc',
    '/formulas',
    '/settings',
    '/settings/ai',
    '/settings/channels',
  ]) {
    assert.strictEqual(isAppRoute(p), true, p);
  }
});

test('isAppRoute：API 路径不接管（必须继续走 router，404 也由 API 出）', () => {
  for (const p of ['/api/papers', '/api/papers/abc', '/api/settings/ai', '/api/nope']) {
    assert.strictEqual(isAppRoute(p), false, p);
  }
});

test('isAppRoute：PDF 原文与 vendor 不接管', () => {
  for (const p of [
    '/papers/attention.pdf',
    '/papers/sub/dir/x.pdf',
    '/vendor/katex.js',
    '/vendor/fonts/KaTeX_Main-Regular.woff2',
    '/vendor/images/findbarButton-next.svg',
  ]) {
    assert.strictEqual(isAppRoute(p), false, p);
  }
});

test('isAppRoute：带扩展名的静态资源不接管', () => {
  for (const p of [
    '/app.js',
    '/index.html',
    '/styles.css',
    '/reader.js',
    '/search-dsl.js',
    '/js/core/router.js',
    '/js/detail/notes-panel.js',
    '/favicon.ico',
  ]) {
    assert.strictEqual(isAppRoute(p), false, p);
  }
});

test('isAppRoute：/paper 单数与 /papers 复数不得混淆（后者是 PDF 静态服务）', () => {
  assert.strictEqual(isAppRoute('/paper/abc'), true, '/paper/:id 是前端路由');
  assert.strictEqual(isAppRoute('/papers/abc.pdf'), false, '/papers/* 是 PDF 原文');
  // /papers 自身（无斜杠）不属于 PDF 静态前缀，按无扩展名路径接管——前端路由会回退到 /library
  assert.strictEqual(isAppRoute('/papers'), true);
});

test('isAppRoute：非字符串 / 异常输入安全返回 false', () => {
  for (const p of [null, undefined, '', 'library', 42, {}]) {
    assert.strictEqual(isAppRoute(p), false, String(p));
  }
});

test('isAppRoute：路径中含点但末段无扩展名仍接管', () => {
  // 论文 id 是 sha1 前 16 位（纯 hex），但概念/制品 id 可能带点号
  assert.strictEqual(isAppRoute('/concepts/maps/cm_1.2'), false, '末段 .2 被视作扩展名 → 交静态');
  assert.strictEqual(isAppRoute('/paper/v1.2/chat'), true, '中间段带点、末段无扩展名 → 接管');
});
