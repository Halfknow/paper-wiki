// MinerU 公式抽取后端（v3.9 公式引擎可选项）。
//
// 与 ai.extractFormulas 的差异：MinerU 直接解析 PDF 产出高保真 LaTeX（pdfjs 抽行间公式会塌掉：
// 分式横线/矩阵结构丢失），但 MinerU 不给 canonicalName/解读，而 canonicalName 是 mergeFormulas
// 的跨论文合并 key。故采用混合策略——MinerU 出 LaTeX，再喂给 AI 一次批量命名/解读。
// AI 不可用时退化为 LaTeX 哈希作 canonicalName（能入库但不跨论文合并）。
//
// 接口形态（实测 MinerU 3.4.0 官方镜像，端口 8000）：
//   POST /file_parse   multipart 字段名 files（复数）；同步返回
//   { status, results: { "<文件名去扩展>": { md_content: "…markdown…" } } }
//   公式以内联 LaTeX 出现在 md_content：$$…$$（display）与 $…$（inline）。
//
// 失败语义：MinerU 不可达/超时/无公式 → 抛错（scanner 的 try/catch 捕获，单篇失败不阻断批量）。
// 不偷偷回退 AI 引擎——引擎选择是用户显式行为，回退会让「MinerU 没生效」不可见。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callChat } = require('./ai');

/** 字符串 → sha1 hex（core/util 只有 sha1OfFile，这里要字符串哈希作降级 canonicalName） */
function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

const DEFAULT_MINERU_URL = 'http://127.0.0.1:8000/file_parse';
const DEFAULT_TIMEOUT_MS = 300000; // MinerU 解析一篇 PDF 实测约 1-3 分钟，给 5 分钟兜底

/** MinerU 命名提示词默认值（可在设置页 formulas.namingPrompt 覆盖）。
 *  MinerU 只产出高保真 LaTeX，不给 canonicalName（跨论文合并 key），故需 AI 补命名/解读。 */
const DEFAULT_MINERU_NAMING_PROMPT =
  '你是公式规范化助手。给定一组 LaTeX 公式，为每个输出规范的 canonicalName（小写连字符英文，' +
  '如 scaled-dot-product-attention、kl-divergence、cross-entropy-loss）、中文 name、简短 description、' +
  'category（attention/loss/optimization/normalization/activation/embedding/distance/regularization/bayesian/other）。' +
  '相同数学结构的公式（如同一公式的不同写法）给同一 canonicalName。只输出 JSON 数组，' +
  '元素顺序与输入一致：[{"canonicalName":"...","name":"...","description":"...","category":"..."}]';

/** 从 MinerU 返回的 md_content 提取 LaTeX 公式（display $$…$$ 优先，inline $…$ 次之）。
 *  去重 + 去过短噪声（单字符变量之类）。返回 [{ latex, rawLatex, context }]。 */
function extractLatexFromMarkdown(md) {
  if (!md || typeof md !== 'string') return [];
  const out = [];
  const seen = new Set();
  const push = (latex, ctx) => {
    const s = String(latex || '').trim();
    // 过滤空、过短（<3 字符基本是单变量噪声）、明显非公式（纯数字）
    if (s.length < 3 || /^\d+(\.\d+)?$/.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ latex: s, rawLatex: s, context: (ctx || '').slice(0, 500) });
  };
  // display：$$…$$（含跨行）。非贪婪匹配，避免吞掉相邻公式。
  const displayRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = displayRe.exec(md)) !== null) {
    // 上下文：display 公式前后各取一段文本
    const start = Math.max(0, m.index - 120);
    const ctx = md.slice(start, m.index) + md.slice(m.index + m[0].length, m.index + m[0].length + 120);
    push(m[1], ctx);
  }
  // inline：$…$（单行，排除 $$）。要求 $ 内不含 $ 且长度合理，防误伤货币符号。
  // 先把已匹配的 display 段落抠掉再扫 inline，避免重复。
  const stripped = md.replace(/\$\$[\s\S]+?\$\$/g, '');
  const inlineRe = /\$([^$\n]+?)\$/g;
  while ((m = inlineRe.exec(stripped)) !== null) {
    const start = Math.max(0, m.index - 120);
    const ctx = stripped.slice(start, m.index);
    push(m[1], ctx);
  }
  return out;
}

/** 取 md_content：MinerU 同步返回 results.<name>.md_content，name = 文件名去扩展。
 *  results 可能有多个键（多文件上传），取第一个非空 md_content 兜底。 */
function pickMdContent(body, fileBaseName) {
  if (!body || typeof body !== 'object') return '';
  const results = body.results;
  if (results && typeof results === 'object') {
    if (fileBaseName && results[fileBaseName] && results[fileBaseName].md_content) {
      return results[fileBaseName].md_content;
    }
    for (const k of Object.keys(results)) {
      const r = results[k];
      if (r && r.md_content) return r.md_content;
    }
  }
  // 兜底：有些版本直接顶层返回 md_content
  if (typeof body.md_content === 'string') return body.md_content;
  return '';
}

/** 把 MinerU 的 LaTeX 列表批量喂给 AI，产出归一化命名 + 解读（canonicalName 是合并 key）。
 *  一次调用处理全篇所有公式（而非逐个），省请求数。AI 不可用时返回 null（由调用方降级）。 */
async function nameFormulasViaAi(latexList, { title, config, fetchImpl, prompt }) {
  if (!latexList.length) return [];
  // 没 apiKey 直接降级，不浪费一次注定 401 的请求
  if (!config || !config.ai || !config.ai.apiKey) return null;
  const list = latexList.map((x, i) => `${i + 1}. $${x.latex}$`).join('\n');
  // 提示词三级回退：传参（config.formulas.namingPrompt）> 内置默认
  const sys = (prompt && String(prompt).trim()) ? String(prompt).trim() : DEFAULT_MINERU_NAMING_PROMPT;
  const user = `论文标题：${title || '（未知）'}\n\n公式列表：\n${list}\n\n请为每个公式输出归一化信息。`;
  try {
    const text = await callChat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      config,
      fetchImpl,
      jsonMode: true,
    });
    let arr = null;
    const s = String(text || '').trim();
    const aFirst = s.indexOf('[');
    const aLast = s.lastIndexOf(']');
    if (aFirst !== -1 && aLast !== -1 && aLast > aFirst) {
      try {
        const parsed = JSON.parse(s.slice(aFirst, aLast + 1));
        if (Array.isArray(parsed)) arr = parsed;
      } catch {}
    }
    if (!arr) return null;
    // 按输入顺序对齐（AI 可能漏/多，按 index 取）
    return latexList.map((_, i) => arr[i]).filter(Boolean);
  } catch {
    return null;
  }
}

/** MinerU 公式抽取主入口。返回与 ai.extractFormulas 同形状的 items 数组。
 *  入参：{ filepath, title, config, fetchImpl }。
 *  config.formulas.mineruUrl / config.formulas.timeoutMs 可覆盖默认。 */
async function extractFormulas({ filepath, title, config, fetchImpl = fetch }) {
  if (!filepath) throw new Error('mineru.extractFormulas: filepath required');
  const fcfg = (config && config.formulas) || {};
  const url = fcfg.mineruUrl || DEFAULT_MINERU_URL;
  const timeoutMs = fcfg.timeoutMs || DEFAULT_TIMEOUT_MS;

  // 读 PDF（binary）→ multipart。Node 18+ 全局 FormData/Blob 可用。
  const buf = fs.readFileSync(filepath);
  const baseName = path.basename(filepath).replace(/\.pdf$/i, '');
  const form = new FormData();
  // MinerU 3.x 字段名 files（复数，FastAPI List[UploadFile]）
  form.append('files', new Blob([buf], { type: 'application/pdf' }), path.basename(filepath));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', body: form, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('MinerU 服务不可达：' + (e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : (e && e.message)));
  }
  clearTimeout(timer);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MinerU 返回 ${res.status}：${String(detail).slice(0, 200)}`);
  }
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('MinerU 返回非 JSON');

  // 状态检查（部分版本 async，status !== completed 时报错提示用户查 status_url）
  if (body.status && body.status !== 'completed' && body.status !== 'processing') {
    if (body.error) throw new Error('MinerU 解析失败：' + body.error);
  }

  const md = pickMdContent(body, baseName);
  if (!md) throw new Error('MinerU 返回无 md_content');
  const latexList = extractLatexFromMarkdown(md);
  if (!latexList.length) return []; // 无公式不算错（纯文本论文），返回空让 mergeFormulas 跳过

  // AI 批量命名（可选；失败降级哈希 canonicalName）。提示词从 config.formulas.namingPrompt 取（设置页可改）
  const namingPrompt = config && config.formulas && config.formulas.namingPrompt;
  const named = await nameFormulasViaAi(latexList, { title, config, fetchImpl, prompt: namingPrompt });
  const items = latexList.map((x, i) => {
    const n = named && named[i];
    if (n && n.canonicalName) {
      return {
        canonicalName: n.canonicalName,
        name: n.name || n.canonicalName,
        latex: x.latex,
        description: n.description || '',
        category: n.category || '',
        variables: [],
        rawLatex: x.rawLatex,
        context: x.context,
        source: 'mineru',
      };
    }
    // 降级：LaTeX 哈希作 canonicalName（能入库但不跨论文合并）
    const hash = sha1(x.latex).slice(0, 10);
    return {
      canonicalName: 'fm_lat_' + hash,
      name: 'fm_lat_' + hash,
      latex: x.latex,
      description: '',
      category: '',
      variables: [],
      rawLatex: x.rawLatex,
      context: x.context,
      source: 'mineru',
    };
  });
  return items;
}

module.exports = {
  extractFormulas,
  extractLatexFromMarkdown,
  pickMdContent,
  DEFAULT_MINERU_URL,
  DEFAULT_MINERU_NAMING_PROMPT,
};
