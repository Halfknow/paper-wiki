const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeNoteCards,
  normalizeCard,
  splitMarkdownToCards,
  newCardId,
  MAX_CARDS,
  MAX_BODY_CHARS,
} = require('../src/core/notes');

test('normalizeCard：非法输入返回 null', () => {
  assert.strictEqual(normalizeCard(null), null);
  assert.strictEqual(normalizeCard('str'), null);
  assert.strictEqual(normalizeCard([1, 2]), null);
  assert.strictEqual(normalizeCard({}), null); // 无标题无正文
  assert.strictEqual(normalizeCard({ title: '  ', body: '  ' }), null);
});

test('normalizeCard：补默认字段 + type 白名单兜底 manual', () => {
  const c = normalizeCard({ title: 'T', body: 'B', type: 'weird' }, 1000);
  assert.strictEqual(c.type, 'manual');
  assert.strictEqual(c.title, 'T');
  assert.strictEqual(c.body, 'B');
  assert.strictEqual(c.createdAt, 1000);
  assert.strictEqual(c.updatedAt, 1000);
  assert.ok(/^nc-/.test(c.id));
  // 合法 type 保留
  assert.strictEqual(normalizeCard({ title: 'T', body: 'B', type: 'qa' }, 1000).type, 'qa');
  // meta 只收对象
  assert.strictEqual(normalizeCard({ title: 'T', body: 'B', meta: [1] }, 1000).meta, undefined);
  assert.deepStrictEqual(
    normalizeCard({ title: 'T', body: 'B', meta: { question: 'q', mi: 3 } }, 1000).meta,
    { question: 'q', mi: 3 }
  );
});

test('normalizeCard：超长截断', () => {
  const c = normalizeCard({ title: 'x'.repeat(500), body: 'y'.repeat(MAX_BODY_CHARS + 100) }, 1);
  assert.strictEqual(c.title.length, 200);
  assert.strictEqual(c.body.length, MAX_BODY_CHARS);
});

test('normalizeNoteCards：非数组回 []，id 撞车重发不丢卡', () => {
  assert.deepStrictEqual(normalizeNoteCards('nope'), []);
  assert.deepStrictEqual(normalizeNoteCards(null), []);
  const cards = normalizeNoteCards(
    [
      { id: 'same', title: 'A', body: 'a' },
      { id: 'same', title: 'B', body: 'b' },
      { title: '', body: '' }, // 非法被滤
    ],
    1000
  );
  assert.strictEqual(cards.length, 2);
  assert.notStrictEqual(cards[0].id, cards[1].id);
  assert.strictEqual(cards[1].title, 'B');
});

test('normalizeNoteCards：限 MAX_CARDS 张', () => {
  const many = Array.from({ length: MAX_CARDS + 50 }, (_, i) => ({ title: 't' + i, body: 'b' }));
  assert.strictEqual(normalizeNoteCards(many, 1).length, MAX_CARDS);
});

test('splitMarkdownToCards：空输入回 []', () => {
  assert.deepStrictEqual(splitMarkdownToCards('', 'manual'), []);
  assert.deepStrictEqual(splitMarkdownToCards('  \n ', 'manual'), []);
  assert.deepStrictEqual(splitMarkdownToCards(null, 'manual'), []);
});

test('splitMarkdownToCards：无 ## 标题整体成一张卡', () => {
  const cards = splitMarkdownToCards('随便写点东西\n第二行', 'manual', 1000);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].title, '笔记');
  assert.strictEqual(cards[0].body, '随便写点东西\n第二行');
  assert.strictEqual(cards[0].type, 'manual');
});

test('splitMarkdownToCards：按 ## 拆多卡 + 导语并入首卡', () => {
  const md = '导语段落\n\n## 研究问题\n问题正文\n## 方法\n方法正文\n多行';
  const cards = splitMarkdownToCards(md, 'skeleton', 1000);
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].title, '研究问题');
  assert.strictEqual(cards[0].body, '导语段落\n\n问题正文');
  assert.strictEqual(cards[0].type, 'skeleton');
  assert.strictEqual(cards[1].title, '方法');
  assert.strictEqual(cards[1].body, '方法正文\n多行');
});

test('splitMarkdownToCards：### 不当标题（只认 ##）', () => {
  const cards = splitMarkdownToCards('## A\nx\n### B\ny', 'manual', 1000);
  assert.strictEqual(cards.length, 1);
  assert.ok(cards[0].body.includes('### B'));
});

test('newCardId：nc- 前缀且同 ms 连调不撞', () => {
  const a = newCardId(1000);
  const b = newCardId(1000);
  assert.ok(/^nc-/.test(a));
  assert.notStrictEqual(a, b);
});
