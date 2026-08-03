'use strict';

// 后端声明式路由表（src/api/route-table.js）单测——纯函数，无需 PG / jsdom，毫秒级。
//
// 这层替代了 createApiRouter 里原先约 1800 行的 `if (pathname === X && method === Y)` 长链。
// 契约要点：
//  - 参数段字符集固定为 [\w.-]+，与被替换的旧正则 /^\/api\/papers\/([\w.-]+)$/ 逐字一致；
//    这保证「今天能匹配的仍匹配、今天 404 的仍 404」（如 %XX 编码路径继续不匹配）。
//  - 静态段优先于参数段（/api/concepts/map 胜过 /api/concepts/:name），与旧 if 链的书写顺序同义。
//  - pathname 不做 decodeURIComponent（旧实现直接拿 url.pathname 上正则，保持一致）。

const { test } = require('node:test');
const assert = require('node:assert');
const { createRouteTable } = require('../src/api/route-table');

const H = (name) => {
  const fn = async () => name;
  fn._name = name;
  return fn;
};

test('route-table：静态路径按 method 分派', () => {
  const t = createRouteTable();
  t.get('/api/papers', H('list'));
  t.post('/api/papers', H('create'));

  assert.strictEqual(t.match('GET', '/api/papers').handler._name, 'list');
  assert.strictEqual(t.match('POST', '/api/papers').handler._name, 'create');
  assert.strictEqual(t.match('DELETE', '/api/papers'), null, '未注册的 method 不匹配');
});

test('route-table：参数提取（单参 / 多参）', () => {
  const t = createRouteTable();
  t.get('/api/papers/:id', H('detail'));
  t.post('/api/papers/:id/:act', H('action'));

  const a = t.match('GET', '/api/papers/9f2a1b3c4d5e6f70');
  assert.strictEqual(a.handler._name, 'detail');
  assert.deepStrictEqual(a.params, { id: '9f2a1b3c4d5e6f70' });

  const b = t.match('POST', '/api/papers/abc/summarize');
  assert.strictEqual(b.handler._name, 'action');
  assert.deepStrictEqual(b.params, { id: 'abc', act: 'summarize' });
});

test('route-table：静态段优先于参数段', () => {
  const t = createRouteTable();
  // 故意「先注册参数路由」——静态优先不依赖注册顺序
  t.put('/api/concepts/:name', H('concept'));
  t.put('/api/concepts/map', H('map'));

  assert.strictEqual(t.match('PUT', '/api/concepts/map').handler._name, 'map');
  const c = t.match('PUT', '/api/concepts/attention');
  assert.strictEqual(c.handler._name, 'concept');
  assert.deepStrictEqual(c.params, { name: 'attention' });
});

test('route-table：段数不同不互相匹配', () => {
  const t = createRouteTable();
  t.get('/api/spaces/:id', H('one'));
  t.post('/api/spaces/:id/dir/preview', H('preview'));

  assert.strictEqual(t.match('GET', '/api/spaces/a/b'), null);
  assert.strictEqual(t.match('POST', '/api/spaces/a/dir/preview').handler._name, 'preview');
  assert.strictEqual(t.match('POST', '/api/spaces/a/dir'), null);
});

test('route-table：参数段字符集与旧正则 [\\w.-]+ 一致', () => {
  const t = createRouteTable();
  t.get('/api/papers/:id', H('detail'));

  assert.ok(t.match('GET', '/api/papers/abc-1.2_3'), '字母数字 . - _ 允许');
  assert.strictEqual(t.match('GET', '/api/papers/a%20b'), null, '百分号编码不匹配（与旧实现一致）');
  assert.strictEqual(t.match('GET', '/api/papers/a b'), null, '空格不匹配');
  assert.strictEqual(t.match('GET', '/api/papers/'), null, '空参数段不匹配');
});

test('route-table：all() 注册所有 method', () => {
  const t = createRouteTable();
  t.all('/api/concepts/map/:id', H('cmap'));

  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.strictEqual(t.match(m, '/api/concepts/map/cm_1').handler._name, 'cmap', m);
  }
  assert.deepStrictEqual(t.match('GET', '/api/concepts/map/cm_1').params, { id: 'cm_1' });
});

test('route-table：同一路径可注册多个 method，互不覆盖', () => {
  const t = createRouteTable();
  t.get('/api/settings', H('read'));
  t.put('/api/settings', H('write'));
  t.patch('/api/settings', H('patch'));

  assert.strictEqual(t.match('GET', '/api/settings').handler._name, 'read');
  assert.strictEqual(t.match('PUT', '/api/settings').handler._name, 'write');
  assert.strictEqual(t.match('PATCH', '/api/settings').handler._name, 'patch');
});

test('route-table：未注册路径返回 null', () => {
  const t = createRouteTable();
  t.get('/api/papers', H('list'));

  assert.strictEqual(t.match('GET', '/api/nope'), null);
  assert.strictEqual(t.match('GET', '/api'), null);
  assert.strictEqual(t.match('GET', '/'), null);
});

test('route-table：opts 原样透传（空间解析开关）', () => {
  const t = createRouteTable();
  t.get('/api/spaces', H('spaces'), { space: false });
  t.get('/api/papers', H('papers'));

  assert.strictEqual(t.match('GET', '/api/spaces').opts.space, false);
  assert.deepStrictEqual(t.match('GET', '/api/papers').opts, {}, '未给 opts 时为空对象');
});

test('route-table：含点号的静态路径（/api/concepts.md）正常匹配', () => {
  const t = createRouteTable();
  t.get('/api/concepts.md', H('md'));
  t.get('/api/concepts', H('list'));
  t.patch('/api/concepts/:name', H('one'));

  assert.strictEqual(t.match('GET', '/api/concepts.md').handler._name, 'md');
  assert.strictEqual(t.match('GET', '/api/concepts').handler._name, 'list');
  assert.strictEqual(t.match('PATCH', '/api/concepts/x').handler._name, 'one');
});

test('route-table：重复注册同 method+pattern 抛错（防迁移期漏改静默覆盖）', () => {
  const t = createRouteTable();
  t.get('/api/papers', H('a'));
  assert.throws(() => t.get('/api/papers', H('b')), /重复注册/);
});

test('route-table：routes() 可枚举，供启动期自检', () => {
  const t = createRouteTable();
  t.get('/api/papers', H('list'));
  t.post('/api/papers/:id/retag', H('retag'));

  const rs = t.routes();
  assert.strictEqual(rs.length, 2);
  assert.deepStrictEqual(rs.map((r) => `${r.method} ${r.pattern}`).sort(), [
    'GET /api/papers',
    'POST /api/papers/:id/retag',
  ]);
});
