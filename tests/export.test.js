'use strict';

// 论文导出（src/core/export.js）+ 导出路由（/api/papers.bib|csv）单测。
// 纯函数层毫秒级；路由用内存 stub ctx + pg-mem 之外的轻量 fake store，无需 PG。

const { test } = require('node:test');
const assert = require('node:assert');
const { papersToBibtex, papersToCsv, bibtexKey } = require('../src/core/export');
const { createRouteTable } = require('../src/api/route-table');

// ==================== BibTeX ====================

test('bibtexKey：第一作者姓 + 年份 + 标题首实词；撞 key 加字母后缀', () => {
  const used = new Set();
  const k1 = bibtexKey({ title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: '2017' }, used);
  assert.strictEqual(k1, 'vaswani2017attention');
  const k2 = bibtexKey({ title: 'attention again', authors: ['Ashish Vaswani'], year: '2017' }, used);
  assert.strictEqual(k2, 'vaswani2017attentiona', '撞 key 应加后缀 a');
  // "Last, First" 形式取逗号前
  assert.strictEqual(bibtexKey({ title: 'X', authors: ['Zhang, San'], year: '2024' }, new Set()).startsWith('zhang2024'), true);
  // 缺作者/年份/标题的兜底
  assert.strictEqual(bibtexKey({}, new Set()), 'papernduntitled');
});

test('papersToBibtex：arXiv 论文用 @article + eprint/archivePrefix，花括号被剥除', () => {
  const bib = papersToBibtex([
    {
      title: 'Some {Weird} Title',
      authors: ['Zhang, San', 'Li Si'],
      year: '2024',
      arxivId: '2401.00001',
      primaryCategory: 'cs.CL',
      abstract: 'abs with {braces}',
    },
  ]);
  assert.match(bib, /@article\{zhang2024some,/);
  assert.match(bib, /eprint = \{2401\.00001\}/);
  assert.match(bib, /archivePrefix = \{arXiv\}/);
  assert.match(bib, /primaryClass = \{cs\.CL\}/);
  assert.match(bib, /author = \{Zhang, San and Li Si\}/);
  assert.ok(!/\{Weird\}/.test(bib), '标题内花括号应被剥除');
  assert.match(bib, /title = \{\{Some Weird Title\}\}/);
});

test('papersToBibtex：无 arXiv 的条目退化为 @misc；空列表输出空串', () => {
  const bib = papersToBibtex([{ title: 'Local Only', authors: ['A B'], year: '2023' }]);
  assert.match(bib, /@misc\{b2023local,/);
  assert.ok(!bib.includes('eprint'));
  assert.strictEqual(papersToBibtex([]), '');
  assert.strictEqual(papersToBibtex(null), '');
});

// ==================== CSV ====================

test('papersToCsv：BOM + CRLF + 双引号转义（RFC 4180）', () => {
  const csv = papersToCsv([
    { id: 'a1', title: '含"引号"的标题', authors: ['张三', 'Li Si'], tags: ['llm', 'rag'], topics: ['大模型'], addedAt: 1754000000000 },
    { id: 'b2', title: 'plain', arxivId: '2401.00002' },
  ]);
  assert.strictEqual(csv.charCodeAt(0), 0xfeff, '首字符必须是 UTF-8 BOM（Excel 中文不乱码）');
  assert.ok(csv.includes('\r\n'), 'CRLF 行尾');
  assert.ok(csv.includes('"含""引号""的标题"'), '内部双引号翻倍');
  assert.ok(csv.includes('"张三; Li Si"'), '多作者分号连接');
  assert.ok(csv.includes('"llm; rag"'));
  // arxiv_url 兜底合成
  assert.ok(csv.includes('https://arxiv.org/abs/2401.00002'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.strictEqual(lines.length, 3, '表头 + 两行数据');
});

// ==================== 路由 ====================

test('导出路由：/api/papers.bib|csv 不被 /api/papers/:id 吃掉；ids 子集过滤', async () => {
  const { register } = require('../src/api/routes/papers');
  const t = createRouteTable();
  const store = {
    papers: {
      a1: { id: 'a1', title: 'Paper One', authors: ['A B'], year: '2023', arxivId: '2301.00001' },
      b2: { id: 'b2', title: 'Paper Two', authors: ['C D'], year: '2024' },
    },
    tags: [], topics: [], folders: [], concepts: [], settings: {},
  };
  const ctx = {
    ok: (res, body) => res._json(body),
    fail: (res, code, error) => res._fail(code, error),
    config: {},
    manager: {},
    scanner: {},
    isProd: false,
  };
  register(t, ctx);

  const mkRes = () => {
    const res = {
      _head: null,
      _body: null,
      writeHead(code, headers) { this._head = { code, headers }; },
      end(body) { this._body = body; },
      _json(body) { this._head = { code: 200, headers: {} }; this._body = JSON.stringify(body); },
      _fail(code, error) { this._head = { code, headers: {} }; this._body = error; },
    };
    return res;
  };
  const urlOf = (p) => new URL('http://x' + p);

  // 静态段优先：/api/papers.bib 命中导出而非 :id 详情
  const m1 = t.match('GET', '/api/papers.bib');
  assert.ok(m1, 'papers.bib 必须能匹配');
  assert.deepStrictEqual(m1.params, {}, '不应被解析成 :id 参数');
  const res1 = mkRes();
  await m1.handler({ res: res1, url: urlOf('/api/papers.bib'), q: {}, params: m1.params, store });
  assert.match(res1._head.headers['Content-Type'], /bibtex/);
  assert.match(res1._head.headers['Content-Disposition'], /attachment/);
  assert.ok(res1._body.includes('Paper One') && res1._body.includes('Paper Two'), '无 ids 导出全库');

  // ids 子集
  const m2 = t.match('GET', '/api/papers.csv');
  const res2 = mkRes();
  await m2.handler({ res: res2, url: urlOf('/api/papers.csv?ids=b2'), q: { ids: 'b2' }, params: m2.params, store });
  assert.match(res2._head.headers['Content-Type'], /text\/csv/);
  assert.ok(res2._body.includes('Paper Two'));
  assert.ok(!res2._body.includes('Paper One'), 'ids 子集过滤生效');

  // :id 详情路由不受影响
  const m3 = t.match('GET', '/api/papers/a1');
  assert.deepStrictEqual(m3.params, { id: 'a1' });
});
