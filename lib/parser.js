const fsp = require('fs/promises');

/** 把 pdfjs 的 textContent.pages 拼接为纯文本：每页内部 join，页间空行 */
function joinTextContent(pages) {
  return pages
    .map((page) => (page.items || [])
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n\n');
}

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      try { return await import('pdfjs-dist/legacy/build/pdf.mjs'); } // Node 友好，无 DOM worker
      catch { return await import('pdfjs-dist/build/pdf.mjs'); }
    })();
  }
  return pdfjsPromise;
}

/** 提取 PDF 全文。返回 { text, charCount, numPages } */
async function extractText(filepath) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await fsp.readFile(filepath));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(await page.getTextContent());
  }
  const numPages = doc.numPages;
  const text = joinTextContent(pages);
  try { await doc.destroy(); } catch {}
  return { text, charCount: text.length, numPages };
}

module.exports = { joinTextContent, extractText };
