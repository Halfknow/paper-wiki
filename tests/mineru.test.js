// MinerU 公式抽取后端单测（v3.9 公式引擎）。
// 纯函数（extractLatexFromMarkdown / pickMdContent）确定性测试；
// extractFormulas 集成路径用临时 PDF + mock fetch（返回 md_content）+ 无 apiKey 配置（降级哈希 canonicalName）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractLatexFromMarkdown,
  pickMdContent,
  extractFormulas,
  alignNamed,
  MAX_FORMULAS_PER_PAPER,
} = require('../src/services/mineru');

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

test('extractLatexFromMarkdown：记号噪声被结构过滤（v3.27 生产噪声治理）', () => {
  const md = [
    '单符号 $\\tau$ 与预测 $\\hat{p}$ 与下标 $f_{t+1}$。',
    '序列 $f_1, f_2, \\cdots, f_t$ 与元组 $(\\beta_1, \\beta_2)$ 与引文标记 $^{66}\\mathrm{T}^\\prime$。',
    '真公式 $L = \\sum_i \\log p_i$ 保留。',
    '$$\\sigma(x) = \\frac{1}{1+e^{-x}}$$',
  ].join('\n');
  const latexs = extractLatexFromMarkdown(md).map((x) => x.latex);
  assert.strictEqual(latexs.length, 2, '只剩 1 行内真公式 + 1 display');
  assert.ok(latexs.some((s) => s.includes('\\sum')));
  assert.ok(latexs.some((s) => s.includes('\\frac')));
});

test('extractLatexFromMarkdown：超出上限截断（display 优先保留）', () => {
  const parts = ['$$E_{\\text{disp}} = mc^2$$'];
  for (let i = 0; i < MAX_FORMULAS_PER_PAPER + 20; i++) parts.push(`$y_${i} = kx_${i} + b$`);
  const list = extractLatexFromMarkdown(parts.join('\n'));
  assert.strictEqual(list.length, MAX_FORMULAS_PER_PAPER);
  assert.strictEqual(list[0].latex, 'E_{\\text{disp}} = mc^2', 'display 排最前，截断不掉');
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
  const body = { results: { a: { md_content: 'AAA' }, b: { md_content: 'BBB' } } };
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

// ---------------------------------------------------------------- alignNamed（纯函数）

test('alignNamed：按 index 对齐，skip/漏答处为 null（不错位）', () => {
  const latexList = ['a=b', 'c=d', 'e=f', 'g=h'];
  // AI 乱序 + 漏答 index 3 + skip index 2
  const arr = [
    { index: 4, canonicalName: 'fourth' },
    { index: 2, skip: true },
    { index: 1, canonicalName: 'first' },
  ];
  const aligned = alignNamed(latexList, arr);
  assert.strictEqual(aligned.length, 4);
  assert.strictEqual(aligned[0].canonicalName, 'first');
  assert.strictEqual(aligned[1], null, 'skip → null（丢弃）');
  assert.strictEqual(aligned[2], null, '漏答 → null（不错位顶替）');
  assert.strictEqual(aligned[3].canonicalName, 'fourth');
});

test('alignNamed：无 index（旧自定义提示词）按位置对齐，漏答不后移（修复 map+filter 移位）', () => {
  const latexList = ['a=b', 'c=d', 'e=f'];
  // 旧格式（无 index）：AI 漏答第 2 项 → 历史上 filter(Boolean) 会把第 3 项名字顶到第 2 位
  const arr = [{ canonicalName: 'first' }, undefined, { canonicalName: 'third' }];
  const aligned = alignNamed(latexList, arr);
  assert.strictEqual(aligned[0].canonicalName, 'first');
  assert.strictEqual(aligned[1], null, '漏答保持 null，不后移');
  assert.strictEqual(aligned[2].canonicalName, 'third');
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
    assert.ok(
      items.every((it) => it.canonicalName.startsWith('fm_lat_')),
      '降级哈希 canonicalName',
    );
    assert.ok(items.some((it) => it.latex.includes('sigma') || it.latex.includes('\\frac')));
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：MinerU 不可达抛错（不偷偷回退）', async () => {
  const fp = tmpPdf();
  try {
    const fakeFetch = async () => {
      const e = new Error('ECONNREFUSED');
      throw e;
    };
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
      json: async () => ({
        status: 'completed',
        results: { fake: { md_content: '# 只有标题\n\n纯文字段落，没有公式。' } },
      }),
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
    await extractFormulas({
      filepath: fp,
      config: { formulas: { mineruUrl: 'http://example:9999/custom' } },
      fetchImpl: fakeFetch,
    });
    assert.strictEqual(calledUrl, 'http://example:9999/custom');
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

// ---------------------------------------------------------------- 命名链路（mock AI 端点）

/** 双端点 fakeFetch：/file_parse 返回 md_content；/chat/completions 返回 namingReply（可捕获请求体） */
function dualFetch(mdContent, namingReply, capture) {
  return async (url, opts) => {
    if (String(url).includes('/file_parse')) {
      return { ok: true, json: async () => ({ status: 'completed', results: { fake: { md_content: mdContent } } }) };
    }
    if (String(url).includes('/chat/completions')) {
      if (capture) capture(JSON.parse(opts.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(namingReply) } }] }),
      };
    }
    throw new Error('unexpected url: ' + url);
  };
}

const AI_CONFIG = {
  formulas: {},
  ai: { apiKey: 'test-key', baseURL: 'http://ai.test/v1', model: 'test-model', timeoutMs: 5000 },
};

test('extractFormulas：AI 命名按 index 对齐 + skip 项丢弃（v3.27）', async () => {
  const fp = tmpPdf();
  try {
    const md = '$$L = \\sum_i \\log p_i$$\n\n行内 $y = mx + b$\n\n噪声 $\\hat{p}$';
    // index 2 是 skip；index 1 命名——验证名字配到正确的 latex 上
    const reply = [
      { index: 2, skip: true },
      { index: 1, canonicalName: 'log-likelihood', name: '对数似然', description: 'd', category: 'loss' },
    ];
    const items = await extractFormulas({
      filepath: fp,
      title: 'T',
      config: AI_CONFIG,
      fetchImpl: dualFetch(md, reply),
    });
    assert.strictEqual(items.length, 1, 'skip 项丢弃');
    assert.strictEqual(items[0].canonicalName, 'log-likelihood');
    assert.ok(items[0].latex.includes('\\sum'), '名字配到 index 1 的 latex（display 段在最前）');
    assert.strictEqual(items[0].source, 'mineru');
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});

test('extractFormulas：发给 AI 命名的列表不含记号噪声', async () => {
  const fp = tmpPdf();
  try {
    const md = '噪声 $\\tau$ $f_{t+1}$ 与真公式 $L = \\sum_i \\log p_i$';
    let userMsg = '';
    const fetchImpl = dualFetch(md, [{ index: 1, canonicalName: 'x' }], (body) => {
      userMsg = body.messages[body.messages.length - 1].content;
    });
    await extractFormulas({ filepath: fp, title: 'T', config: AI_CONFIG, fetchImpl });
    assert.ok(userMsg.includes('\\sum'), '真公式在列表里');
    assert.ok(!userMsg.includes('\\tau'), '噪声不发给 AI');
  } finally {
    fs.unlinkSync(fp);
    fs.rmdirSync(path.dirname(fp));
  }
});
