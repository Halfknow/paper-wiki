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

// ---------------------------------------------------------------------------
// v3.61 生产事故回归：整篇论文的公式集体变成 fm_lat_<hash>
//
// nameFormulasViaAi 一旦返回 null，extractFormulas 会把**整批**公式降级成哈希名
// （既是 name 也是跨论文合并用的 canonicalName），产出一堆 fm_lat_xxx 且不可自动恢复。
// 触发 null 的路径有三条，下面逐条锁住：
//   ① 响应是对象而非数组——请求带 response_format:json_object，模型被强制包成对象，
//      而解析只会 indexOf("[") 截数组；键为序号的映射形态里根本没有 "["
//   ② 输出被 max_tokens 截断——48 条一次请求，JSON.parse 直接抛
//   ③ 瞬时故障（超时/429/5xx）——没有任何重试
// ---------------------------------------------------------------------------

/** 假 fetch：命名响应的原始字符串由调用方给定（用于构造非数组/截断等畸形响应）。 */
function dualFetchRaw(mdContent, rawReply, opts = {}) {
  let n = 0;
  return async (url, o) => {
    if (String(url).includes("/file_parse")) {
      return { ok: true, json: async () => ({ status: "completed", results: { fake: { md_content: mdContent } } }) };
    }
    if (String(url).includes("/chat/completions")) {
      n++;
      if (opts.onCall) opts.onCall(JSON.parse(o.body), n);
      const body = typeof rawReply === "function" ? rawReply(n) : rawReply;
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: body } }] }) };
    }
    throw new Error("unexpected url: " + url);
  };
}

const MD_3 = [
  '$$L = \\sum_i \\log p_i$$',
  '$$E = mc^2 + \\alpha$$',
  '$$y = \\int f(x) dx$$',
].join('\n\n');

test("命名响应是对象包裹的数组 {formulas:[…]} → 正常命名，不降级", async () => {
  const fp = tmpPdf();
  try {
    const raw = JSON.stringify({ formulas: [
      { index: 1, canonicalName: "log-likelihood", name: "对数似然", category: "loss" },
      { index: 2, canonicalName: "mass-energy", name: "质能方程", category: "other" },
      { index: 3, canonicalName: "integral", name: "积分", category: "other" },
    ] });
    const items = await extractFormulas({ filepath: fp, title: "T", config: AI_CONFIG, fetchImpl: dualFetchRaw(MD_3, raw) });
    assert.strictEqual(items.length, 3);
    assert.ok(items.every((it) => !it.canonicalName.startsWith("fm_lat_")), "不应降级：" + items.map((i) => i.canonicalName));
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});

test("命名响应是序号映射对象 {\"1\":{…}} → 正常命名，不降级", async () => {
  const fp = tmpPdf();
  try {
    const raw = JSON.stringify({
      1: { canonicalName: "log-likelihood", name: "对数似然", category: "loss" },
      2: { canonicalName: "mass-energy", name: "质能方程", category: "other" },
      3: { canonicalName: "integral", name: "积分", category: "other" },
    });
    const items = await extractFormulas({ filepath: fp, title: "T", config: AI_CONFIG, fetchImpl: dualFetchRaw(MD_3, raw) });
    assert.strictEqual(items.length, 3);
    assert.ok(items.every((it) => !it.canonicalName.startsWith("fm_lat_")), "不应降级：" + items.map((i) => i.canonicalName));
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});

test("命名响应被 max_tokens 截断 → 已完整的条目仍能救回", async () => {
  const fp = tmpPdf();
  try {
    // 第 3 条写到一半就断了（真实截断长这样）
    const raw = '[{"index":1,"canonicalName":"log-likelihood","name":"对数似然"},'
      + '{"index":2,"canonicalName":"mass-energy","name":"质能方程"},{"index":3,"canonical';
    const items = await extractFormulas({ filepath: fp, title: "T", config: AI_CONFIG, fetchImpl: dualFetchRaw(MD_3, raw) });
    const named = items.filter((it) => !it.canonicalName.startsWith("fm_lat_"));
    assert.ok(named.length >= 2, "前两条完整条目应救回，实得 " + named.length);
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});

test("命名调用瞬时失败 → 重试一次后成功，不降级", async () => {
  const fp = tmpPdf();
  try {
    const good = JSON.stringify([
      { index: 1, canonicalName: "log-likelihood", name: "对数似然" },
      { index: 2, canonicalName: "mass-energy", name: "质能方程" },
      { index: 3, canonicalName: "integral", name: "积分" },
    ]);
    let calls = 0;
    const items = await extractFormulas({
      filepath: fp, title: "T", config: AI_CONFIG,
      fetchImpl: dualFetchRaw(MD_3, (n) => { calls = n; return n === 1 ? new Error("ETIMEDOUT") : good; }),
    });
    assert.ok(calls >= 2, "应重试，实际调用 " + calls + " 次");
    assert.ok(items.every((it) => !it.canonicalName.startsWith("fm_lat_")), "重试成功后不应降级");
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});

test("降级项：name 是可读占位而不是 fm_lat_ 标识符，并打 needsNaming 标记", async () => {
  const fp = tmpPdf();
  try {
    // 无 apiKey → 确定性降级路径
    const items = await extractFormulas({
      filepath: fp, title: "T", config: { formulas: {}, ai: {} }, fetchImpl: dualFetchRaw(MD_3, "[]"),
    });
    assert.ok(items.length >= 1);
    for (const it of items) {
      assert.ok(it.canonicalName.startsWith("fm_lat_"), "合并 key 仍用稳定哈希");
      assert.ok(!/^fm_lat_/.test(it.name), "name 不该是哈希标识符，实得：" + it.name);
      assert.strictEqual(it.needsNaming, true, "应标记待命名，便于事后重命名与统计");
    }
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});

test("公式数超过单批上限 → 分批命名；单批失败只降级该批，其余照常命名", async () => {
  const fp = tmpPdf();
  try {
    // 20 条 display 公式 → 分 2 批（12 + 8）
    const md = Array.from({ length: 20 }, (_, i) => `$$x_{${i}} = a_{${i}} + b_{${i}}$$`)
      .join(String.fromCharCode(10, 10));
    const batches = [];
    const fetchImpl = dualFetchRaw(md, (n) => {
      if (n === 1) return "整段不是 JSON——模拟第一批被截断/畸形";
      // 第二批正常应答：序号是全局的（13..20）
      return JSON.stringify({ items: Array.from({ length: 8 }, (_, k) => ({
        index: 13 + k, canonicalName: "named-" + (13 + k), name: "公式" + (13 + k),
      })) });
    }, { onCall: (body) => batches.push(body.messages[1].content) });
    const items = await extractFormulas({ filepath: fp, title: "T", config: AI_CONFIG, fetchImpl });
    assert.ok(batches.length >= 2, "应分多批调用，实际 " + batches.length + " 次");
    const named = items.filter((it) => !it.canonicalName.startsWith("fm_lat_"));
    const degraded = items.filter((it) => it.canonicalName.startsWith("fm_lat_"));
    assert.ok(named.length >= 8, "第二批应正常命名，实得 " + named.length);
    assert.ok(degraded.length > 0, "第一批降级");
    assert.ok(degraded.length < items.length, "不应整篇降级——这正是本次要修的事故形态");
    // 序号重基：第二批的名字必须配到第二批的公式上，不能整体错位
    for (const it of named) {
      const idx = Number(String(it.canonicalName).replace("named-", ""));
      assert.ok(it.latex.includes("x_{" + (idx - 1) + "}"), "名字应配到对应 latex：" + it.canonicalName + " / " + it.latex);
    }
  } finally { fs.unlinkSync(fp); fs.rmdirSync(path.dirname(fp)); }
});
