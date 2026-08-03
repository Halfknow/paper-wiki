'use strict';

// 前端路由器纯函数单测（public/js/core/router.js）——无 DOM 依赖，无需 jsdom，毫秒级。
//
// 这些函数是「URL ↔ 视图状态」的唯一真源：matchRoute 决定渲染哪个视图，
// parseQuery/stringifyQuery 决定库视图的筛选状态如何在 URL 里往返。
// 有状态的部分（popstate 绑定、链接拦截、视图切换）由 tests/routing-ui.test.js 在 jsdom 里覆盖。
//
// 注意：public/ 下是浏览器 ESM，Node 侧用动态 import 加载。

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let R;
before(async () => {
  R = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'router.js')).href);
});

// ---------------------------------------------------------------------------
// matchRoute
// ---------------------------------------------------------------------------

const ROUTES = [
  { name: 'library', pattern: '/library' },
  { name: 'paper', pattern: '/paper/:id' },
  { name: 'paper-tab', pattern: '/paper/:id/:tab' },
  { name: 'reader', pattern: '/reader/:id' },
  { name: 'concepts', pattern: '/concepts' },
  { name: 'concept-maps', pattern: '/concepts/maps' },
  { name: 'concept-map', pattern: '/concepts/maps/:id' },
  { name: 'formulas', pattern: '/formulas' },
  { name: 'settings-tab', pattern: '/settings/:tab' },
];

test('matchRoute：静态路径', () => {
  assert.strictEqual(R.matchRoute(ROUTES, '/library').route.name, 'library');
  assert.strictEqual(R.matchRoute(ROUTES, '/concepts').route.name, 'concepts');
  assert.strictEqual(R.matchRoute(ROUTES, '/formulas').route.name, 'formulas');
});

test('matchRoute：参数提取', () => {
  const a = R.matchRoute(ROUTES, '/paper/9f2a1b3c4d5e6f70');
  assert.strictEqual(a.route.name, 'paper');
  assert.deepStrictEqual(a.params, { id: '9f2a1b3c4d5e6f70' });

  const b = R.matchRoute(ROUTES, '/paper/9f2a/chat');
  assert.strictEqual(b.route.name, 'paper-tab');
  assert.deepStrictEqual(b.params, { id: '9f2a', tab: 'chat' });

  const c = R.matchRoute(ROUTES, '/settings/channels');
  assert.deepStrictEqual(c.params, { tab: 'channels' });
});

test('matchRoute：静态段优先于参数段', () => {
  // /concepts/maps 必须胜过（假想的）/concepts/:x，且不依赖数组顺序
  const shuffled = [{ name: 'concept-one', pattern: '/concepts/:name' }, ...ROUTES];
  assert.strictEqual(R.matchRoute(shuffled, '/concepts/maps').route.name, 'concept-maps');
  assert.strictEqual(R.matchRoute(shuffled, '/concepts/attention').route.name, 'concept-one');
});

test('matchRoute：段数必须相等', () => {
  assert.strictEqual(R.matchRoute(ROUTES, '/paper'), null);
  assert.strictEqual(R.matchRoute(ROUTES, '/paper/a/b/c'), null);
  assert.strictEqual(R.matchRoute(ROUTES, '/library/extra'), null);
});

test('matchRoute：尾斜杠归一化', () => {
  assert.strictEqual(R.matchRoute(ROUTES, '/library/').route.name, 'library');
  assert.strictEqual(R.matchRoute(ROUTES, '/paper/abc/').route.name, 'paper');
  assert.strictEqual(R.matchRoute(ROUTES, '/'), null, '根路径不在表内（由 createRouter 重定向到 /library）');
});

test('matchRoute：参数值做 URL 解码', () => {
  const m = R.matchRoute(ROUTES, '/settings/a%20b');
  assert.deepStrictEqual(m.params, { tab: 'a b' });
});

test('matchRoute：未匹配返回 null', () => {
  assert.strictEqual(R.matchRoute(ROUTES, '/nope'), null);
  assert.strictEqual(R.matchRoute(ROUTES, '/paper//x'), null, '空参数段不匹配');
  assert.strictEqual(R.matchRoute(ROUTES, ''), null);
});

// ---------------------------------------------------------------------------
// buildPath
// ---------------------------------------------------------------------------

test('buildPath：填参并编码', () => {
  assert.strictEqual(R.buildPath('/paper/:id', { id: 'abc' }), '/paper/abc');
  assert.strictEqual(R.buildPath('/paper/:id/:tab', { id: 'abc', tab: 'chat' }), '/paper/abc/chat');
  assert.strictEqual(R.buildPath('/library', {}), '/library');
  assert.strictEqual(R.buildPath('/settings/:tab', { tab: 'a b' }), '/settings/a%20b');
});

test('buildPath：与 matchRoute 往返一致', () => {
  const params = { id: '9f2a1b3c', tab: 'notes' };
  const p = R.buildPath('/paper/:id/:tab', params);
  assert.deepStrictEqual(R.matchRoute(ROUTES, p).params, params);
});

test('buildPath：缺参抛错（早失败好过生成 /paper/undefined）', () => {
  assert.throws(() => R.buildPath('/paper/:id', {}), /缺少路由参数/);
});

// ---------------------------------------------------------------------------
// parseQuery / stringifyQuery
// ---------------------------------------------------------------------------

test('parseQuery：基本解析', () => {
  assert.deepStrictEqual(R.parseQuery('?q=attention&sort=addedDesc'), { q: 'attention', sort: 'addedDesc' });
  assert.deepStrictEqual(R.parseQuery('q=x'), { q: 'x' }, '无问号也可');
  assert.deepStrictEqual(R.parseQuery(''), {});
  assert.deepStrictEqual(R.parseQuery('?'), {});
});

test('parseQuery：解码与 + 号', () => {
  assert.deepStrictEqual(R.parseQuery('?q=%E6%B3%A8%E6%84%8F%E5%8A%9B'), { q: '注意力' });
  assert.deepStrictEqual(R.parseQuery('?tag=a%2Cb'), { tag: 'a,b' });
});

test('stringifyQuery：省略等于默认值的键（URL 不留噪声）', () => {
  const defaults = { q: '', status: '', sort: 'addedDesc', starred: false };
  assert.strictEqual(R.stringifyQuery({ q: '', status: '', sort: 'addedDesc', starred: false }, defaults), '');
  assert.strictEqual(R.stringifyQuery({ q: 'attention', sort: 'addedDesc' }, defaults), '?q=attention');
  assert.strictEqual(R.stringifyQuery({ sort: 'yearDesc' }, defaults), '?sort=yearDesc');
});

test('stringifyQuery：布尔 true 序列化为 1，false 省略', () => {
  const defaults = { starred: false };
  assert.strictEqual(R.stringifyQuery({ starred: true }, defaults), '?starred=1');
  assert.strictEqual(R.stringifyQuery({ starred: false }, defaults), '');
});

test('stringifyQuery：数组用逗号连接，空数组省略', () => {
  const defaults = { tags: [] };
  assert.strictEqual(R.stringifyQuery({ tags: ['llm', 'rag'] }, defaults), '?tags=llm%2Crag');
  assert.strictEqual(R.stringifyQuery({ tags: [] }, defaults), '');
});

test('stringifyQuery：键按字母序输出（同一状态永远同一 URL，利于收藏/比对）', () => {
  const s = R.stringifyQuery({ sort: 'yearDesc', q: 'x', folder: 'f1' }, {});
  assert.strictEqual(s, '?folder=f1&q=x&sort=yearDesc');
});

test('parseQuery / stringifyQuery 往返', () => {
  const defaults = { q: '', tags: [], starred: false, sort: 'addedDesc' };
  const s = R.stringifyQuery({ q: '注意力', tags: ['llm'], starred: true, sort: 'yearDesc' }, defaults);
  const back = R.parseQuery(s);
  assert.strictEqual(back.q, '注意力');
  assert.strictEqual(back.tags, 'llm');
  assert.strictEqual(back.starred, '1');
  assert.strictEqual(back.sort, 'yearDesc');
});

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

test('normalizePath：去尾斜杠但保留根', () => {
  assert.strictEqual(R.normalizePath('/library/'), '/library');
  assert.strictEqual(R.normalizePath('/library'), '/library');
  assert.strictEqual(R.normalizePath('/'), '/');
  assert.strictEqual(R.normalizePath(''), '/');
  assert.strictEqual(R.normalizePath('library'), '/library', '补前导斜杠');
});
