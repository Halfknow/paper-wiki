const test = require('node:test');
const assert = require('node:assert');
const {
  CARD_TYPES,
  newCardId,
  normalizeNoteCards,
  splitMarkdownToCards,
} = require('../src/core/notes');
const { parseSearchQuery } = require('../src/core/search-query');
const { normalizeAnnotations } = require('../src/core/annotations');
const { splitTerms, buildSnippets } = require('../src/core/search');

// ---- 确定性随机源：固定种子的 LCG（不用 Math.random 生成输入） ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function randInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** 卡片数组不变量：normalizeNoteCards 输出必须满足的形状约束。 */
function assertCardInvariants(cards) {
  assert.ok(Array.isArray(cards), '输出必须是数组');
  const ids = new Set();
  for (const c of cards) {
    assert.ok(c && typeof c === 'object' && !Array.isArray(c), '卡片必须是对象');
    assert.ok(typeof c.id === 'string' && c.id.length > 0, '卡片必须有非空 id');
    assert.ok(!ids.has(c.id), '卡片 id 不应重复');
    ids.add(c.id);
    assert.ok(CARD_TYPES.has(c.type), `type 必须在白名单内，得到 ${c.type}`);
    assert.strictEqual(typeof c.title, 'string');
    assert.strictEqual(typeof c.body, 'string');
    assert.ok(c.title.length > 0 || c.body.trim().length > 0, '标题与正文不应同时为空');
    assert.ok(Number.isFinite(c.createdAt) && c.createdAt > 0, 'createdAt 必须为正数时间戳');
    assert.ok(Number.isFinite(c.updatedAt) && c.updatedAt > 0, 'updatedAt 必须为正数时间戳');
  }
}

// ==================== 1. normalizeNoteCards 幂等性 ====================

test('normalizeNoteCards 幂等：二次归一化（同 now）与一次深相等（含自生成 id 的卡片）', () => {
  const now = 1700000000000;
  const inputs = [
    // 混合脏数据：null / 非对象 / 缺字段 / 非法 type / 数组 / 重复 id / 无 id（触发生成）
    [
      null,
      42,
      'str',
      [],
      {},
      { id: 'nc-fixed1', type: 'qa', title: '问题', body: '回答', createdAt: 5, updatedAt: 6 },
      { type: 'skeleton', title: '骨架', body: '内容' }, // 无 id → 第一遍生成，第二遍必须保留
      { type: 'skeleton', title: '骨架2', body: '内容2' }, // 同上
      { id: 'nc-fixed1', type: 'manual', title: '撞id', body: 'x' }, // id 撞车 → 第一遍重发
      { id: '', type: 'weird', title: '', body: '只有正文' }, // 空 id + 非法 type
      { type: 'manual', title: '只有标题', body: '' },
      { type: 'manual', title: '   ', body: '  ' }, // 全空 → 被丢弃
      { id: 'nc-meta', type: 'qa', title: 't', body: 'b', meta: { question: 'q', mi: 1 } },
      { id: 'nc-badmeta', type: 'qa', title: 't', body: 'b', meta: [1, 2] }, // 非法 meta 被剥
    ],
    [], // 空数组
    [{ type: 'manual', title: '唯一卡', body: 'b', createdAt: -1, updatedAt: NaN }], // 非法时间戳
  ];
  for (const input of inputs) {
    const once = normalizeNoteCards(input, now);
    const twice = normalizeNoteCards(once, now);
    assert.deepStrictEqual(twice, once, '二次归一化不应再改变任何字段（含第一遍生成的 id）');
    assertCardInvariants(once);
  }
  // 第一遍生成 id 的卡片，把输出再喂回去：id 必须逐张保留（不重新随机）
  const gen = normalizeNoteCards([{ type: 'qa', title: 'A', body: 'B' }], now);
  assert.ok(/^nc-/.test(gen[0].id));
  const again = normalizeNoteCards(gen, now);
  assert.strictEqual(again[0].id, gen[0].id, '已生成的合法 id 必须被保留');
});

test('normalizeNoteCards 非数组输入一律回 []', () => {
  for (const bad of [null, undefined, 0, 'x', {}, true]) {
    assert.deepStrictEqual(normalizeNoteCards(bad, 1), []);
  }
});

// ==================== 2. splitMarkdownToCards 健壮性（50+ 生成输入） ====================

test('splitMarkdownToCards：60 组随机 Markdown 输入不抛异常且输出满足卡片不变量', () => {
  const rand = lcg(0xC0FFEE);
  const fragments = [
    '# 一级标题',
    '## 二级标题',
    '### 三级标题',
    '####### 超多井号',
    '##',
    '##   ',
    '正文一行',
    '',
    '   ',
    '中文 unicode 内容：论文《注意力机制》🎉',
    '很长的行' + 'x'.repeat(5000),
    '- 列表项\n- 列表项2',
    '```\ncode block\n## 代码里的假标题\n```',
    '## 标题带 emoji 🚀',
    '\t制表符开头',
    '## 重复标题\n内容\n## 重复标题\n内容2',
    '> 引用块',
    '## 标题\n\n\n\n多空行正文',
    'a'.repeat(60000), // 超过 MAX_BODY_CHARS 的超长正文
    '## CJK 标题　全角空格',
    '| 表格 | 列 |\n|---|---|',
  ];
  const types = ['manual', 'skeleton', 'qa', 'invalid-type', undefined];
  for (let i = 0; i < 60; i++) {
    const n = randInt(rand, 1, 12);
    const parts = [];
    for (let j = 0; j < n; j++) parts.push(pick(rand, fragments));
    const md = parts.join('\n');
    const type = pick(rand, types);
    const now = 1700000000000 + i;
    let cards;
    assert.doesNotThrow(() => {
      cards = splitMarkdownToCards(md, type, now, '回退标题');
    }, `第 ${i} 组输入不应抛异常`);
    assertCardInvariants(cards);
    // 幂等：输出再过一遍 normalizeNoteCards 不变
    assert.deepStrictEqual(normalizeNoteCards(cards, now), cards);
  }
  // 空输入 / 非字符串输入
  assert.deepStrictEqual(splitMarkdownToCards('', 'manual', 1), []);
  assert.deepStrictEqual(splitMarkdownToCards(null, 'manual', 1), []);
  assert.deepStrictEqual(splitMarkdownToCards('   \n  ', 'manual', 1), []);
});

// ==================== 3. parseSearchQuery 垃圾输入不抛 ====================

test('parseSearchQuery：畸形 DSL 输入不抛异常且返回形状稳定', () => {
  const garbage = [
    '',
    '   ',
    '(',
    ')',
    '(((',
    ')))',
    '()()',
    '(a OR (b AND (c',
    '"未闭合引号',
    '"',
    '“中文引号未闭合',
    '“完整中文引号”',
    '""',
    '-',
    '--',
    '- ',
    '-(',
    'field:',
    'title:',
    ':',
    ':value',
    'year:',
    'year:abcd',
    'year:202',
    'year:>=',
    'AND',
    'OR',
    'NOT',
    'AND OR NOT',
    'NOT NOT NOT',
    'a AND',
    'OR b',
    'title:a OR',
    '&&',
    '||',
    'a\x00b',
    '\x00',
    'a'.repeat(100000),
    '('.repeat(400) + 'x' + ')'.repeat(400),
    'title:a title:b tag:x tag:y -tag:z',
    'in:body',
    'body:',
    'body:注意力 in:body',
    'star:✓',
    'notes:.',
    '"a" "b" "c" -"d"',
    '标题：全角冒号',
    'a\tb\nc\rd',
  ];
  // 再用 LCG 生成 100 个随机垃圾串
  const rand = lcg(0xBADC0DE);
  const charset = '()":- abcxyz012\u4e2d\u6587\u201c\u201d<>\t\nANDORNOT'.split('');
  for (let i = 0; i < 100; i++) {
    const len = randInt(rand, 0, 40);
    let s = '';
    for (let j = 0; j < len; j++) s += pick(rand, charset);
    garbage.push(s);
  }
  for (const g of garbage) {
    let r;
    assert.doesNotThrow(() => {
      r = parseSearchQuery(g);
    }, `输入 ${JSON.stringify(g && g.slice ? g.slice(0, 50) : g)} 不应抛异常`);
    // 返回形状：{ ast, metadata:{text:{...}, fields:{...}}, bodyQuery }
    assert.ok(r && typeof r === 'object');
    assert.ok('ast' in r);
    assert.ok(r.metadata && typeof r.metadata === 'object');
    assert.ok(Array.isArray(r.metadata.text.words));
    assert.ok(Array.isArray(r.metadata.text.phrases));
    assert.ok(Array.isArray(r.metadata.text.excludeWords));
    assert.ok(Array.isArray(r.metadata.text.excludePhrases));
    assert.ok(r.metadata.fields && typeof r.metadata.fields === 'object');
    assert.ok(r.bodyQuery === null || typeof r.bodyQuery === 'string');
  }
});

// ==================== 4. newCardId 唯一性 ====================

test('newCardId：1000 次生成全部唯一且匹配 /^nc-/', () => {
  const seen = new Set();
  const now = 1700000000000;
  for (let i = 0; i < 1000; i++) {
    const id = newCardId(now); // 同一 now：同 ms 内连建不撞由随机后缀保证
    assert.ok(/^nc-/.test(id), `id 应以 nc- 开头：${id}`);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 1000, '1000 次生成不应有重复');
  // 不传 now 也能生成合法 id
  assert.ok(/^nc-/.test(newCardId()));
});

// ==================== 5. normalizeAnnotations 幂等性 ====================

test('normalizeAnnotations 幂等：二次归一化与一次深相等（TypedArray / 稠密键对象混合）', () => {
  const corrupted = JSON.parse(JSON.stringify({ q: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) })).q;
  const cases = [
    {
      items: [
        {
          id: 1,
          annotationType: 9,
          quadPoints: new Float32Array([265, 660, 329, 660, 265, 649, 329, 649]),
          rect: [69, 524, 525, 664],
          inkLists: [new Float32Array([1, 2, 3])],
        },
        { id: 2, annotationType: 1, quadPoints: corrupted, nested: { pts: corrupted } },
        { id: 3, annotationType: 3, text: '纯文字批注' },
      ],
      updatedAt: 1,
      hash: 'abc',
    },
    { items: [] },
    { items: [{ a: [1, [2, [3, new Float32Array([9])]]] }] },
    null,
    undefined,
    'not-object',
    { noItems: true },
    { items: 'not-array' },
    [],
  ];
  for (const input of cases) {
    const once = normalizeAnnotations(input);
    const twice = normalizeAnnotations(once);
    assert.deepStrictEqual(twice, once, '二次归一化不应再改变结果');
  }
  // 修复语义本身：TypedArray 与稠密键对象都变真数组
  const r = normalizeAnnotations({
    items: [{ quadPoints: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) }, { quadPoints: corrupted }],
  });
  assert.ok(Array.isArray(r.items[0].quadPoints));
  assert.ok(Array.isArray(r.items[1].quadPoints));
  assert.deepStrictEqual(r.items[1].quadPoints, [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ==================== 6. splitTerms / buildSnippets XSS 安全 ====================

test('buildSnippets：恶意 HTML 输入被转义，输出只含 <mark> 这一种标签', () => {
  const maliciousTexts = [
    '前文 <script>alert(1)</script> 中间 attention 后文',
    '<img src=x onerror=alert(1)> attention 命中',
    '<svg onload=alert(1)>attention</svg>',
    '"><script>alert(document.cookie)</script> attention',
    'attention <iframe src="javascript:alert(1)"></iframe>',
    '<b>正常标签</b> attention &amp; 已有实体',
  ];
  for (const text of maliciousTexts) {
    const { snippets, matches } = buildSnippets(text, ['attention']);
    assert.ok(matches >= 1, '应命中 attention');
    assert.ok(snippets.length >= 1);
    for (const sn of snippets) {
      assert.ok(!sn.includes('<script'), '不应含未转义的 <script');
      assert.ok(!sn.includes('<img'), '不应含未转义的 <img');
      assert.ok(!sn.includes('<svg'), '不应含未转义的 <svg');
      assert.ok(!sn.includes('<iframe'), '不应含未转义的 <iframe');
      // 强不变量：去掉 <mark>/</mark> 与省略号后，不应残留任何尖括号
      const stripped = sn.replace(/<\/?mark>/g, '').replace(/…/g, '');
      assert.ok(!stripped.includes('<') && !stripped.includes('>'), `片段含未转义尖括号：${sn}`);
      // 命中词用 <mark> 包裹
      assert.ok(sn.includes('<mark>attention</mark>'), '命中词应被 <mark> 包裹');
    }
  }
});

test('buildSnippets：恶意查询词经 splitTerms 后也不会注入标签', () => {
  // 查询词本身带尖括号：snippet 里 mark 内容也走 escapeHtml
  const text = '普通文本 <markup> 与 </markup> 内容';
  const terms = splitTerms('<markup>');
  const { snippets } = buildSnippets(text, terms);
  for (const sn of snippets) {
    const stripped = sn.replace(/<\/?mark>/g, '').replace(/…/g, '');
    assert.ok(!stripped.includes('<') && !stripped.includes('>'), `片段含未转义尖括号：${sn}`);
  }
  // CJK 查询整串为单一词，可正常高亮
  const cjk = buildSnippets('本文研究注意力机制在翻译中的应用。注意力机制很重要。', splitTerms('注意力机制'));
  assert.ok(cjk.matches === 2);
  assert.ok(cjk.snippets[0].includes('<mark>注意力机制</mark>'));
  // 无命中 → 空结果
  assert.deepStrictEqual(buildSnippets('abc def', ['zzz']), { snippets: [], matches: 0 });
  assert.deepStrictEqual(buildSnippets('', ['a']), { snippets: [], matches: 0 });
  assert.deepStrictEqual(buildSnippets('abc', []), { snippets: [], matches: 0 });
});

test('splitTerms：确定性行为（去引号 / 去重 / 单字母过滤 / CJK 整串）', () => {
  assert.deepStrictEqual(splitTerms('"attention" attention ATTN attn'), ['attention', 'attn']);
  assert.deepStrictEqual(splitTerms('a b cd'), ['cd'], '单字母词应被过滤');
  assert.deepStrictEqual(splitTerms('注意力 机制'), ['注意力 机制'], 'CJK 查询整串为单一词');
  assert.deepStrictEqual(splitTerms(''), []);
  assert.deepStrictEqual(splitTerms(null), []);
});
