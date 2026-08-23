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
const { looksLikeFormula } = require('../core/formulas');

const { parseJsonLenient } = require('../core/util');
/** 字符串 → sha1 hex（core/util 只有 sha1OfFile，这里要字符串哈希作降级 canonicalName） */
function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

const DEFAULT_MINERU_URL = 'http://127.0.0.1:8000/file_parse';
const DEFAULT_TIMEOUT_MS = 300000; // MinerU 解析一篇 PDF 实测约 1-3 分钟，给 5 分钟兜底
/** 单篇公式上限：一篇论文的 $…$ 片段动辄上百，全量喂 AI 命名会超输出 token（JSON 截断→整批降级）
 *  且产出大量记号噪声。display 段先入（几乎都是真公式），超出截断。 */
const MAX_FORMULAS_PER_PAPER = 48;

/** MinerU 命名提示词默认值（可在设置页 formulas.namingPrompt 覆盖）。
 *  MinerU 只产出高保真 LaTeX，不给 canonicalName（跨论文合并 key），故需 AI 补命名/解读。
 *  v3.27：要求回显 index（防漏答错位）+ 允许 skip 拒判记号噪声（单符号/下标/序列/引文标记）。
 *  旧自定义提示词（无 index/skip 语义）按位置对齐兼容。 */
const DEFAULT_MINERU_NAMING_PROMPT =
  '你是公式规范化助手。给定一组带序号的 LaTeX 片段，为每个序号输出一个 JSON 对象，组成数组：\n' +
  '[{"index":1,"canonicalName":"小写连字符英文","name":"中文名","description":"简短解读（1-2 句）","category":"attention/loss/optimization/normalization/activation/embedding/distance/regularization/bayesian/other"}]\n' +
  '规则：\n' +
  '- canonicalName 用学界通用名（如 scaled-dot-product-attention、kl-divergence、cross-entropy-loss），相同数学结构给同一名字。\n' +
  '- **不是公式的片段**（单个符号、上下标记号、逗号/省略号序列、引文标记、残缺片段）输出 {"index":<序号>,"skip":true}，不要硬起名。\n' +
  '- 每个输入序号恰好输出一次。只输出 JSON 数组，不要输出其它内容。';

/** 从 MinerU 返回的 md_content 提取 LaTeX 公式（display $$…$$ 优先，inline $…$ 次之）。
 *  去重 + looksLikeFormula 结构过滤（单符号/下标/序列省略/引文标记等记号噪声不入清单）。
 *  返回 [{ latex, rawLatex, context }]，最多 MAX_FORMULAS_PER_PAPER 条（display 优先）。 */
function extractLatexFromMarkdown(md) {
  if (!md || typeof md !== 'string') return [];
  const out = [];
  const seen = new Set();
  const push = (latex, ctx) => {
    const s = String(latex || '').trim();
    // 过滤空、过短（<3 字符基本是单变量噪声）、明显非公式（纯数字）
    if (s.length < 3 || /^\d+(\.\d+)?$/.test(s)) return;
    // 结构门槛：无关系符/大算符的是记号不是公式（display 段统一适用——MinerU 也会把
    // 残缺片段/裸符号放进 $$…$$）
    if (!looksLikeFormula(s)) return;
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
  return out.slice(0, MAX_FORMULAS_PER_PAPER);
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

/** 把 AI 返回的命名数组对齐回 latexList（等长，skip/漏答处为 null）。
 *  - 元素带合法 index（1 基）→ 按 index 对齐（漏答/乱序不错位）；
 *  - 都没有 index（旧自定义提示词）→ 按位置对齐，但**不 filter**（历史上 map+filter 移位
 *    会让 AI 漏答后所有名字错配到下一条 latex——v3.27 生产数据错位根因之一）。
 *  - skip:true 的元素对齐为 null（调用方丢弃该项）。 */
function alignNamed(latexList, arr) {
  const aligned = new Array(latexList.length).fill(null);
  let hasIndex = false;
  for (const e of arr) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const idx = Number(e.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= latexList.length) {
      hasIndex = true;
      if (!e.skip) aligned[idx - 1] = e;
    }
  }
  if (!hasIndex) {
    for (let i = 0; i < latexList.length && i < arr.length; i++) {
      const e = arr[i];
      if (e && typeof e === 'object' && !Array.isArray(e) && !e.skip) aligned[i] = e;
    }
  }
  return aligned;
}

/** 把 MinerU 的 LaTeX 列表批量喂给 AI，产出归一化命名 + 解读（canonicalName 是合并 key）。
 *  一次调用处理全篇所有公式（而非逐个），省请求数。AI 不可用时返回 null（由调用方降级）。
 *  返回数组与 latexList 等长：skip/漏答处为 null（该项丢弃，不入库）。 */
/** 把命名响应的原始文本强制转成「条目数组」。
 *
 *  背景（v3.61 生产事故）：整篇论文的公式集体变成 fm_lat_<hash>。根因是解析太脆——
 *  只做 indexOf("[")/lastIndexOf("]") 截一段再 JSON.parse，任何一步不合预期就返回 null，
 *  调用方随即把**整批**降级成哈希名。实际会遇到的形态至少有四种：
 *    ① 裸数组 [{...}]                     —— 老提示词的期望形态
 *    ② 对象包裹 {"items":[{...}]}          —— 请求带 response_format:json_object，
 *       模型被强制返回对象；这种靠 indexOf("[") 侥幸能救
 *    ③ 序号映射 {"1":{...},"2":{...}}      —— 同样是 json_object 的自然产物，
 *       但整段里根本没有 "["，旧代码必然全批降级
 *    ④ 被 max_tokens 截断的半截 JSON       —— JSON.parse 直接抛
 *  这里逐层降级地救：完整解析 → 括号配平 → 逐个抓完整对象。 */
/** 降级条目：AI 命名不可用时的入库形态。
 *  canonicalName 仍用 LaTeX 稳定哈希——它是入库与跨论文合并的 key，必须有且必须稳定；
 *  但 name 用可读占位而非 fm_lat_xxx（那串标识符会直接显示在公式卡与信息页清单上），
 *  并打 needsNaming 标记，让重抽与统计能定位这些待命名条目。 */
function pushDegraded(items, x) {
  const hash = sha1(x.latex).slice(0, 10);
  items.push({
    canonicalName: 'fm_lat_' + hash,
    name: placeholderName(x.latex),
    needsNaming: true,
    latex: x.latex,
    description: '',
    category: '',
    variables: [],
    rawLatex: x.rawLatex,
    context: x.context,
    source: 'mineru',
  });
}
/** 未命名公式的可读占位：截一小段 LaTeX 当名字，比 fm_lat_<hash> 有信息量得多。
 *  去掉换行与多余空白，过长截断。 */
function placeholderName(latex) {
  const t = String(latex || '').replace(/\s+/g, ' ').trim();
  if (!t) return '未命名公式';
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

function coerceNamedList(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const fromValue = (v) => {
    if (Array.isArray(v)) return v;
    if (!v || typeof v !== "object") return null;
    // ② 对象包裹：取第一个「数组」字段（items/formulas/result/data…，不写死键名）
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
    // ③ 序号映射：键全是数字 → 展开成带 index 的数组
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return keys.map((k) => {
        const e = v[k];
        return e && typeof e === "object" ? { index: Number(k), ...e } : null;
      }).filter(Boolean);
    }
    return null;
  };

  // 第一层：完整 / 括号配平解析（parseJsonLenient 能吃掉尾部垃圾）
  try {
    const arr = fromValue(parseJsonLenient(s));
    if (arr && arr.length) return arr;
  } catch { /* 落到下一层 */ }

  // 第二层：截断救回——逐个抓出「完整的 {...}」，半截的那个自然被丢掉。
  // 括号配平在字符串内不计数，避免 latex 里的花括号把深度算乱。
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(i, j + 1));
          if (o && typeof o === "object" && !Array.isArray(o)) out.push(o);
        } catch { /* 该片段不是合法对象，跳过 */ }
        i = j;
        break;
      }
    }
  }
  // 只有「像条目」的才算（有 index / canonicalName / skip 之一），否则可能是包裹对象本身
  const items = out.filter((o) => o.index != null || o.canonicalName != null || o.skip != null);
  return items.length ? items : null;
}

/** 单批命名的条数上限。MAX_FORMULAS_PER_PAPER 是 48——48 条挤一次请求，输出 JSON 很长，
 *  很容易撞 max_tokens 被截断；而截断在旧实现里等于**整篇**降级成 fm_lat_。公式越多的
 *  论文越容易中招，偏偏那正是最需要命名的论文。分批后单批失败只影响这一批，
 *  且每批输出短得多、基本不会被截。 */
const NAMING_BATCH_SIZE = 12;

/** 批次失败的占位。必须与「模型明确说 skip / 漏答」区分开：
 *  后者意味着「这不是公式」，该丢弃；前者只是这一批没问成，公式本身是真的，
 *  丢掉就是静默丢数据（20 条只剩 8 条且无任何提示）。占位让调用方把它降级入库。 */
const NAMING_FAILED = Object.freeze({ __namingFailed: true });

/** 分批命名：切成若干批分别调用再合并。返回与 latexList 等长的数组（未命名处 null）；
 *  只有**所有批次都失败**才返回 null（调用方据此整体降级）。 */
async function nameFormulasViaAi(latexList, opts) {
  if (!latexList.length) return [];
  const cfg = (opts || {}).config;
  // 没 apiKey 直接降级，不浪费一次注定 401 的请求
  if (!cfg || !cfg.ai || !cfg.ai.apiKey) return null;
  if (latexList.length <= NAMING_BATCH_SIZE) return nameBatch(latexList, opts, 0);

  const aligned = new Array(latexList.length).fill(null);
  let anyOk = false;
  for (let start = 0; start < latexList.length; start += NAMING_BATCH_SIZE) {
    const chunk = latexList.slice(start, start + NAMING_BATCH_SIZE);
    const part = await nameBatch(chunk, opts, start);   // offset 让序号保持全局连续，便于排查
    if (!part) {                                         // 该批失败：只降级这一批，不波及其它批
      for (let i = 0; i < chunk.length; i++) aligned[start + i] = NAMING_FAILED;
      continue;
    }
    anyOk = true;
    for (let i = 0; i < chunk.length; i++) aligned[start + i] = part[i];
  }
  return anyOk ? aligned : null;
}

async function nameBatch(latexList, { title, config, fetchImpl, prompt }, offset) {
  if (!latexList.length) return [];
  // 没 apiKey 直接降级，不浪费一次注定 401 的请求
  if (!config || !config.ai || !config.ai.apiKey) return null;
  const list = latexList.map((x, i) => `${(offset || 0) + i + 1}. $${x.latex}$`).join('\n');
  // 提示词三级回退：传参（config.formulas.namingPrompt）> 内置默认
  const sys = prompt && String(prompt).trim() ? String(prompt).trim() : DEFAULT_MINERU_NAMING_PROMPT;
  const user = `论文标题：${title || '（未知）'}\n\n公式列表：\n${list}\n\n请为每个序号输出归一化信息（不是公式的输出 skip）。`;
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
    // 解析交给 coerceNamedList（见其注释：四种响应形态逐层救）
    const arr = coerceNamedList(text);
    if (!arr) return null;
    // 提示词里的序号是全局的（offset+i+1），对齐前换回批内下标，否则整批错位
    const rebased = (offset || 0)
      ? arr.map((e) => (e && Number.isInteger(Number(e.index)) ? { ...e, index: Number(e.index) - offset } : e))
      : arr;
    return alignNamed(latexList, rebased);
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
    throw new Error('MinerU 服务不可达：' + (e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : e && e.message));
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
  const items = [];
  latexList.forEach((x, i) => {
    const n = named && named[i];
    if (n === NAMING_FAILED) return pushDegraded(items, x);   // 该批没问成：降级这一条，公式是真的
    if (named && !n) return;                                   // 模型明确 skip / 漏答：记号噪声，丢弃
    if (n && n.canonicalName) {
      items.push({
        canonicalName: n.canonicalName,
        name: n.name || n.canonicalName,
        latex: x.latex,
        description: n.description || '',
        category: n.category || '',
        variables: [],
        rawLatex: x.rawLatex,
        context: x.context,
        source: 'mineru',
      });
    } else {
      // named === null（AI 整体不可用）或该条缺 canonicalName → 降级
      pushDegraded(items, x);
    }
  });  return items;
}

module.exports = {
  extractFormulas,
  extractLatexFromMarkdown,
  alignNamed,
  pickMdContent,
  DEFAULT_MINERU_URL,
  DEFAULT_MINERU_NAMING_PROMPT,
  MAX_FORMULAS_PER_PAPER,
};
