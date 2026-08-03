// MinerU 公式抽取后端单测（v3.9 公式引擎）。
// 纯函数（extractLatexFromMarkdown / pickMdContent）确定性测试；
// extractFormulas 集成路径用临时 PDF + mock fetch（返回 md_content）+ 无 apiKey 配置（降级哈希 canonicalName）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractLatexFromMarkdown, pickMdContent, extractFormulas } = require('../src/services/mineru');

// ---------------------------------------------------------------- LaTeX 提取（纯函数）

test('extractLatexFromMarkdown：提取 $$display$$ 与 $inline$，去重 + 过滤噪声', () => {
  const md = [
    '正文里的行内公式 $a^2 + b^2 = c^2$ 后面还有。',
    '',
    '$$\\text{Attention}(Q,K,V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$',
    '',
    '再来一个行内 $x$ 和重复的 $a^2 + b^2 = c^2$。',
  ].join('\n');
  const list = extractLatexFromMarkdown(md);
  // display 1 个 + inline 去重后（a^2... 出现两次只算一次；x 单字符被滤掉）
  const latexs = list.map((x) => x.latex);
  assert.ok(latexs.some((s) => s.includes('Attention')));
  assert.ok(latexs.includes('a^2 + b^2 = c^2'));
  // 单字符 x 被过滤
  assert.ok(!latexs.includes('x'));
  // 重复的 a^2 只出现一次
  assert.strictEqual(latexs.filter((s) => s === 'a^2 + b^2 = c^2').length, 1);
});

test('extractLatexFromMarkdown：空/非字符串返回空数组', () => {
  assert.deepStrictEqual(extractLatexFromMarkdown(''), []);
  assert.deepStrictEqual(extractLatexFromMarkdown(null), []);
  assert.deepStrictEqual(extractLatexFromMarkdown(undefined), []);
});

test('extractLatexFromMarkdown：纯数字/过短被过滤', () => {
  const list = extractLatexFromMarkdown('$3.14$ $ab$ $42$');
  // 3.14 / 42 纯数字过滤；ab 长度 2 < 3 过滤
  assert.strictEqual(list.length, 0);
});

test('extractLatexFromMarkdown：display 优先，inline 不重复抓 $$ 内内容', () => {
  const md = '$$E=mc^2$$';
  const list = extractLatexFromMarkdown(md);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].latex, 'E=mc^2');
});

// ---------------------------------------------------------------- pickMdContent（纯函数）

test('pickMdContent：按文件名取 md_content', () => {
  const body = { results: { 'my-paper': { md_content: '# 标题\n$$x^2$$' } } };
  assert.strictEqual(pickMdContent(body, 'my-paper'), '# 标题\n$$x^2$$');
});

test('pickMdContent：文件名不匹配时取第一个非空', () => {
  const body = { results: { 'a': { md_content: 'AAA' }, 'b': { md_content: 'BBB' } } };
  assert.strictEqual(pickMdContent(body, 'not-exist'), 'AAA');
});

test('pickMdContent：兜底顶层 md_content', () => {
  assert.strictEqual(pickMdContent({ md_content: 'TOP' }, 'x'), 'TOP');
});

test('pickMdContent：无内容返回空串', () => {
  assert.strictEqual(pickMdContent({}, 'x'), '');
  assert.strictEqual(pickMdContent(null, 'x'), '');
  assert.strictEqual(pickMdContent({ results: { a: {} } }, 'x'), '');
});

// ---------------------------------------------------------------- extractFormulas（集成路径）

/** 写一个临时假 PDF（内容无所谓，只读字节做 multipart 附件） */
function tmpPdf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-test-'));
  const fp = path.join(dir, 'fake.pdf');
  fs.writeFileSync(fp, Buffer.from('%PDF-1.4 fake'));
  return fp;
}

test('extractFormulas：MinerU 返回 md_content → 提取公式（无 apiKey 降级哈希 canonicalName）', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async (url, opts) => {
      assert.ok(String(url).includes('/file_parse'), 'POST 到 /file_parse');
      // multipart body 是 FormData，不深检
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          results: { fake: { md_content: '## 公式\n\n$$\\sigma(x) = \\frac{1}{1+e^{-x}}$$\n\n行内 $y=mx+b$' } },
        }),
      };
    };
    // 无 apiKey → nameFormulasViaAi 返回 null → 降级 fm_lat_<hash>
    const items = await extractFormulas({ filepath: fp, title: 'T', config: { formulas: {} }, fetchImpl: fakeFetch });
    assert.ok(Array.isArray(items));
    assert.strictEqual(items.length, 2, 'sigmoid + 线性方程');
    assert.ok(items.every((it) => it.source === 'mineru'));
    assert.ok(items.every((it) => it.canonicalName.startsWith('fm_lat_')), '降级哈希 canonicalName');
    assert.ok(items.some((it) => it.latex.includes('sigma') || it.latex.includes('\\frac')));
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：MinerU 不可达抛错（不偷偷回退）', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async () => { const e = new Error('ECONNREFUSED'); throw e; };
    await assert.rejects(
      () => extractFormulas({ filepath: fp, config: { formulas: {} }, fetchImpl: fakeFetch }),
      /MinerU 服务不可达/,
    );
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：MinerU 非 2xx 抛错', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
    await assert.rejects(
      () => extractFormulas({ filepath: fp, config: { formulas: {} }, fetchImpl: fakeFetch }),
      /500/,
    );
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：无 md_content 抛错', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async () => ({ ok: true, json: async () => ({ status: 'completed', results: {} }) });
    await assert.rejects(
      () => extractFormulas({ filepath: fp, config: { formulas: {} }, fetchImpl: fakeFetch }),
      /无 md_content/,
    );
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：纯文本无公式返回空数组（非错误）', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ status: 'completed', results: { fake: { md_content: '# 只有标题\n\n纯文字段落，没有公式。' } } }),
    });
    const items = await extractFormulas({ filepath: fp, config: { formulas: {} }, fetchImpl: fakeFetch });
    assert.deepStrictEqual(items, []);
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：mineruUrl 从 config.formulas.mineruUrl 读取', async () => {
  const fp = tmpPdf();
  try {
    let calledUrl = '';
    const fakeFetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ status: 'completed', results: { fake: { md_content: '$$x^2$$' } } }) };
    };
    await extractFormulas({ filepath: fp, config: { formulas: { mineruUrl: 'http://example:9999/custom' } }, fetchImpl: fakeFetch });
    assert.strictEqual(calledUrl, 'http://example:9999/custom');
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});
