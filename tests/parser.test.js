const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { joinTextContent, extractText } = require('../src/services/parser');

test('joinTextContent 拼接多页 items 为文本，页间空行', () => {
  const pages = [{ items: [{ str: 'Hello ' }, { str: 'World' }] }, { items: [{ str: 'Page 2' }] }];
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
  // 空间功能上线后 PDF 落在 papers/<空间>/ 下，只扫顶层会永远找不到样本 →
  // 这条冒烟测试曾长期静默跳过（假的「通过」）。顶层找不到就下探一层。
  const findPdf = (d) => {
    const ents = fs.readdirSync(d, { withFileTypes: true });
    const here = ents.find((e) => e.isFile() && /\.pdf$/i.test(e.name));
    if (here) return path.join(d, here.name);
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const sub = fs.readdirSync(path.join(d, e.name), { withFileTypes: true })
        .find((x) => x.isFile() && /\.pdf$/i.test(x.name));
      if (sub) return path.join(d, e.name, sub.name);
    }
    return null;
  };
  const pdfPath = findPdf(dir);
  if (!pdfPath) return t.skip('no pdf to smoke-test');
  const { text, charCount, numPages } = await extractText(pdfPath);
  assert.ok(numPages >= 1);
  assert.ok(charCount > 0);
  assert.ok(text.length > 0);
});
