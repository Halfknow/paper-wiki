const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { joinTextContent, extractText } = require('../lib/parser');

test('joinTextContent 拼接多页 items 为文本，页间空行', () => {
  const pages = [
    { items: [{ str: 'Hello ' }, { str: 'World' }] },
    { items: [{ str: 'Page 2' }] },
  ];
  const out = joinTextContent(pages);
  assert.strictEqual(out, 'Hello World\n\nPage 2');
});

test('joinTextContent 折叠多余空白', () => {
  const out = joinTextContent([{ items: [{ str: 'a   b' }, { str: '  c' }] }]);
  assert.strictEqual(out, 'a b c');
});

test('extractText 对真实 PDF 提取非空文本（冒烟）', async (t) => {
  const dir = path.join(__dirname, '..', 'papers');
  if (!fs.existsSync(dir)) return t.skip('no papers/ dir');
  const pdf = fs.readdirSync(dir).find((f) => /\.pdf$/i.test(f));
  if (!pdf) return t.skip('no pdf to smoke-test');
  const { text, charCount, numPages } = await extractText(path.join(dir, pdf));
  assert.ok(numPages >= 1);
  assert.ok(charCount > 0);
  assert.ok(text.length > 0);
});
