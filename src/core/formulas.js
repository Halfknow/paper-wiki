/**
 * 公式清单纯逻辑层（零 IO，可独立单测）。
 *
 * 设计要点（见 docs/superpowers/specs/2026-08-03-formula-extraction-design.md）：
 * - **合并 key = canonicalName**（归一化小写连字符英文名），与概念的 normalizeTerm 同构。
 *   同一公式在不同论文里符号写法不同，靠模型给出的规范名归并到「一般形式」。
 * - **paperIds 与 occurrences 并存**：前者让 DELETE /api/papers/:id 的清理逻辑复用 concepts 那套；
 *   后者承载多对多附加属性（每篇的原写法 rawLatex / 章节 context / 符号映射 symbolMap）。
 *   不变式 `paperIds === occurrences.map(o => o.paperId)` 由 mergeFormulas 单点维护。
 * - **normalizeFormula 是唯一写入边界**：router PATCH 与 db 读取都过它（同 notes 的 normalizeNoteCards）。
 */

const { stableShortHash } = require('./store');

const VAR_ROLES = ['input', 'param', 'output', 'const'];
const SOURCES = ['ai', 'mineru', 'vision', 'manual'];
const MAX_VARIABLES = 24;
const MAX_LATEX_CHARS = 2000;
const MAX_DESC_CHARS = 4000;
const MAX_CONCEPT_TERMS = 6; // 公式 ↔ 概念关联词上限（提示词要求 ≤3，合并并集后封顶防膨胀）

/** 关系符（含裸 = < >）与大算符/多行环境——判定一段 LaTeX 是「公式」还是「记号」。
 *  MinerU 的 md_content 里行内 $…$ 绝大多数是单符号/下标/序列省略/引文标记（v3.27 生产数据
 *  97% 为单篇噪声），靠这条结构门槛在入库前拦掉；纯表达式无关系符的损失（如 softmax 写法）偶被
 *  误杀，可接受——噪声治理优先。注意 (?![a-zA-Z]) 防 \left 命中 \le、\infty 命中 \in 这类前缀误报。 */
const RELATION_RE =
  /=|<|>|\\(?:approx|equiv|simeq|sim|propto|leq|geq|ll|gg|neq|subset|subseteq|supset|supseteq|cong|doteq|rightarrow|longrightarrow|leftarrow|mapsto|to|in|ge|le|ne)(?![a-zA-Z])/;
/** 注意 (?![a-zA-Z])（而非 \b）：\sum_{i=1} 的下划线是词字符，\b 会漏配；同时防 \limits 命中 \lim */
const BIGOP_RE = /\\(?:sum|int|oint|prod|lim|bigcup|bigcap|bigoplus|bigotimes|begin)(?![a-zA-Z])/;
/** 目标式算子（v3.50）：\max_{\pi} E[…] / \min_{\theta} D_KL[…] 这类优化目标没有关系符，
 *  但显然是公式——生产清理时曾按纯关系符误杀。\mid 同理（条件概率 p(x\mid y)）。 */
const OBJECTIVE_RE = /\\(?:max|min|arg|mid)(?![a-zA-Z])/;

/** 结构判定：含关系符（= ≤ ≥ → ∈ …）、大算符（∑ ∫ ∏ lim）、目标式算子（max/min/arg/mid）
 *  或多行环境（aligned/cases…）才视为公式；单符号、上下标记号、逗号序列、引文上标等记号噪声返回 false。 */
function looksLikeFormula(latex) {
  const s = String(latex == null ? '' : latex).trim();
  if (s.length < 3 || /^\d+(\.\d+)?$/.test(s)) return false;
  return RELATION_RE.test(s) || BIGOP_RE.test(s) || OBJECTIVE_RE.test(s);
}

/** 规范名归一化：小写 + 空白/下划线→连字符 + 折叠重复连字符 + 去首尾连字符。 */
function normalizeCanonicalName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 剥离数学环境/代码围栏包裹，存裸公式体；渲染时再决定 display 模式。
 *  逐层剥（`$$\begin{equation}…\end{equation}$$` 要剥两层），但 aligned/align/cases 等
 *  多行环境是公式本体的一部分，保留。 */
function normalizeLatex(s) {
  let t = String(s == null ? '' : s).trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    const fence = t.match(/^```(?:latex|tex|math)?\s*([\s\S]*?)```$/i);
    if (fence) t = fence[1].trim();
    else if (t.startsWith('$$') && t.endsWith('$$') && t.length > 4) t = t.slice(2, -2).trim();
    else if (t.startsWith('\\[') && t.endsWith('\\]')) t = t.slice(2, -2).trim();
    else if (t.startsWith('\\(') && t.endsWith('\\)')) t = t.slice(2, -2).trim();
    else if (t.startsWith('$') && t.endsWith('$') && t.length > 2) t = t.slice(1, -1).trim();
    else {
      const env = t.match(/^\\begin\{(equation\*?|displaymath|math|gather\*?)\}([\s\S]*?)\\end\{\1\}$/);
      if (env) t = env[2].trim();
    }
    if (t === before) break;
  }
  return t.slice(0, MAX_LATEX_CHARS);
}

/** 公式 id：与 conceptIdFor 共用 stableShortHash，前缀 fm_ 区分命名空间。 */
function formulaIdFor(canonicalName) {
  return 'fm_' + stableShortHash(normalizeCanonicalName(canonicalName));
}

function normalizeVariables(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const symbol = String(v.symbol || '').trim();
    if (!symbol) continue;
    out.push({
      symbol: symbol.slice(0, 60),
      meaning: String(v.meaning || '')
        .trim()
        .slice(0, 200),
      role: VAR_ROLES.includes(v.role) ? v.role : 'param',
    });
    if (out.length >= MAX_VARIABLES) break;
  }
  return out;
}

/** plotHint 结构校验：必须有 variable + 二元数值 range，否则降级 null（宁缺勿错，画图功能才好接）。
 *  plotExpr（v3.29）：可直接求值的数学表达式字符串（变量 x，plotHint.params 里的符号可用），
 *  白名单字符集校验（数字/字母/运算符/括号/逗号/空白/小数点）——真正的安全防线在前端求值器
 *  （core/plot.js 只认白名单 token，未知标识符解析期拒绝），这里只拦明显脏数据 + 限长。 */
const PLOT_EXPR_RE = /^[A-Za-z0-9+\-*/^().,\s]*$/;

function normalizePlotHint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const variable = String(raw.variable || '').trim();
  if (!variable) return null;
  const r = raw.range;
  if (!Array.isArray(r) || r.length !== 2) return null;
  const lo = Number(r[0]);
  const hi = Number(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const params = {};
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    for (const [k, v] of Object.entries(raw.params)) {
      const n = Number(v);
      if (Number.isFinite(n)) params[k] = n;
    }
  }
  const plotExprRaw = String(raw.plotExpr || '').trim();
  const plotExpr = plotExprRaw && plotExprRaw.length <= 300 && PLOT_EXPR_RE.test(plotExprRaw) ? plotExprRaw : '';
  return { variable: variable.slice(0, 60), range: [lo, hi], params, plotExpr };
}

/** 公式 ↔ 概念关联词归一化：字符串数组 → 去空/去重/截长，封顶 MAX_CONCEPT_TERMS。
 *  只认字符串（模型 JSON 输出的 term 应为字符串，数字/对象属脏数据直接丢）。
 *  值应与概念清单的 term 写法一致（提示词把本篇概念清单喂给模型供其挑选）。 */
function normalizeConceptTerms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (!s || s.length > 200) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_CONCEPT_TERMS) break;
  }
  return out;
}

function normalizeOccurrence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const paperId = String(raw.paperId || '').trim();
  if (!paperId) return null;
  const symbolMap = {};
  if (raw.symbolMap && typeof raw.symbolMap === 'object' && !Array.isArray(raw.symbolMap)) {
    for (const [k, v] of Object.entries(raw.symbolMap)) {
      const key = String(k).trim();
      if (key)
        symbolMap[key.slice(0, 60)] = String(v == null ? '' : v)
          .trim()
          .slice(0, 60);
    }
  }
  return {
    paperId,
    rawLatex: normalizeLatex(raw.rawLatex),
    context: String(raw.context || '')
      .trim()
      .slice(0, 200),
    symbolMap,
  };
}

/** 归一化单条公式；缺规范名或缺 latex 视为非法，返回 null。 */
function normalizeFormula(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const canonicalName = normalizeCanonicalName(raw.canonicalName);
  if (!canonicalName) return null;
  const latex = normalizeLatex(raw.latex);
  if (!latex) return null;

  const occurrences = [];
  const seen = new Set();
  for (const o of Array.isArray(raw.occurrences) ? raw.occurrences : []) {
    const n = normalizeOccurrence(o);
    if (!n || seen.has(n.paperId)) continue;
    seen.add(n.paperId);
    occurrences.push(n);
  }

  return {
    id: raw.id && /^fm_[\w-]+$/.test(raw.id) ? raw.id : formulaIdFor(canonicalName),
    canonicalName,
    name:
      String(raw.name || '')
        .trim()
        .slice(0, 200) || canonicalName,
    latex,
    description: String(raw.description || '')
      .trim()
      .slice(0, MAX_DESC_CHARS),
    category: normalizeCanonicalName(raw.category),
    variables: normalizeVariables(raw.variables),
    plottable: !!raw.plottable,
    plotHint: normalizePlotHint(raw.plotHint),
    occurrences,
    paperIds: occurrences.map((o) => o.paperId),
    source: SOURCES.includes(raw.source) ? raw.source : 'ai',
    starred: !!raw.starred,
    conceptTerms: normalizeConceptTerms(raw.conceptTerms),
    // 显式 0 予以保留（否则 db 读取边界每次 load 都会拿到新 now → 假 diff）
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now,
  };
}

/** 批量归一化：过滤非法项 + 按 canonicalName 去重（先到先得）。读取/写入边界都用它。 */
function normalizeFormulas(raw, now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const f = normalizeFormula(item, now);
    if (!f || seen.has(f.canonicalName)) continue;
    seen.add(f.canonicalName);
    out.push(f);
  }
  return out;
}

/**
 * 把若干抽取结果归并入公式清单，返回本次**新增**的公式 id 列表。
 *
 * 三条关键规则：
 * 1. 命中已有条目时**只补空字段**，不覆盖已有 latex/description/variables——
 *    否则后来论文的粗糙解读会冲掉先前的好解读。
 * 2. 同 paperId 的 occurrence **覆盖而非追加**——保证重复抽取幂等。
 * 3. 收尾同步 paperIds 不变式并按 canonicalName 排序（同 mergeConcepts 的排序语义）。
 *
 * 入参 item 形状（AI 层直接产出）：
 *   { canonicalName, name, latex, description, category, variables, plottable, plotHint,
 *     rawLatex, context, symbolMap, conceptTerms }
 * 其中后三个是「本篇的 occurrence 属性」，会被折进 occurrences；conceptTerms 是公式级
 * 的概念关联（与本篇概念清单的 term 对齐），命中已有条目时取并集。
 */
function mergeFormulas(store, items, paperId, now = Date.now()) {
  if (!Array.isArray(items) || !items.length) return [];
  store.formulas = Array.isArray(store.formulas) ? store.formulas : [];
  const byKey = new Map(store.formulas.map((f) => [f.canonicalName, f]));
  const newIds = [];

  for (const raw of items) {
    // 借 normalizeFormula 做字段校验/清洗：occurrence 属性单独折叠，避免模型乱塞 occurrences
    const incoming = normalizeFormula({ ...raw, occurrences: [], id: null }, now);
    if (!incoming) continue;

    const occ = paperId
      ? normalizeOccurrence({
          paperId,
          rawLatex: raw && raw.rawLatex,
          context: raw && raw.context,
          symbolMap: raw && raw.symbolMap,
        })
      : null;

    let f = byKey.get(incoming.canonicalName);
    if (!f) {
      f = incoming;
      f.occurrences = [];
      f.paperIds = [];
      byKey.set(f.canonicalName, f);
      store.formulas.push(f);
      newIds.push(f.id);
    } else {
      // 规则 1：只补空字段
      if (!f.latex) f.latex = incoming.latex;
      if (!f.description) f.description = incoming.description;
      if (!f.name || f.name === f.canonicalName) f.name = incoming.name;
      if (!f.category) f.category = incoming.category;
      if (!f.variables.length) f.variables = incoming.variables;
      if (!f.plotHint) f.plotHint = incoming.plotHint;
      if (incoming.plottable) f.plottable = true;
      // 概念关联取并集（不同论文可能各连到不同概念），封顶防膨胀
      if (incoming.conceptTerms.length) {
        const merged = [...(f.conceptTerms || [])];
        for (const t of incoming.conceptTerms) {
          if (!merged.includes(t)) merged.push(t);
          if (merged.length >= MAX_CONCEPT_TERMS) break;
        }
        f.conceptTerms = merged.slice(0, MAX_CONCEPT_TERMS);
      }
    }

    if (occ) {
      // 规则 2：同 paperId 覆盖
      const at = f.occurrences.findIndex((o) => o.paperId === occ.paperId);
      if (at >= 0) f.occurrences[at] = occ;
      else f.occurrences.push(occ);
    }
    f.updatedAt = now;
  }

  // 规则 3：不变式 + 排序
  for (const f of store.formulas) f.paperIds = f.occurrences.map((o) => o.paperId);
  store.formulas.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  return newIds;
}

/** 删除公式条目，并从所有 paper.formulaIds 里清除 */
function deleteFormula(store, id) {
  const before = (store.formulas || []).length;
  store.formulas = (store.formulas || []).filter((f) => f.id !== id);
  for (const p of Object.values(store.papers || {})) {
    if (Array.isArray(p.formulaIds)) p.formulaIds = p.formulaIds.filter((x) => x !== id);
  }
  return before !== store.formulas.length;
}

/** 删论文时清理其 occurrence；occurrence 清空后整条删除（对齐 concepts 的现有行为）。 */
function removePaperFromFormulas(store, paperId) {
  if (!Array.isArray(store.formulas)) return;
  for (const f of store.formulas) {
    f.occurrences = (f.occurrences || []).filter((o) => o.paperId !== paperId);
    f.paperIds = f.occurrences.map((o) => o.paperId);
  }
  store.formulas = store.formulas.filter((f) => f.occurrences.length > 0);
}

/** 把 source 公式并入 target（v3.30 治理：canonicalName 漂移产生的重复条目收敛）。
 *  并集语义：occurrences 按 paperId 合并（target 已有的槽位保留）并重算 paperIds 不变式；
 *  name/latex/description/category/variables/plotHint 只在 target 缺时补；
 *  conceptTerms 并集封顶；plottable/starred 取或；papers[].formulaIds 反向替换；删除 source。
 *  返回合并后的 target（不存在/自并时 null）。 */
function mergeFormulaInto(store, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = (store.formulas || []).find((f) => f.id === sourceId);
  const target = (store.formulas || []).find((f) => f.id === targetId);
  if (!source || !target) return null;
  const occBy = new Map((target.occurrences || []).map((o) => [o.paperId, o]));
  for (const o of source.occurrences || []) if (!occBy.has(o.paperId)) occBy.set(o.paperId, o);
  target.occurrences = [...occBy.values()];
  target.paperIds = target.occurrences.map((o) => o.paperId); // 不变式单点维护
  if ((!target.name || target.name === target.canonicalName) && source.name) target.name = source.name;
  if (!target.description && source.description) target.description = source.description;
  if (!target.category && source.category) target.category = source.category;
  if (!target.variables.length && source.variables.length) target.variables = source.variables;
  if (!target.plotHint && source.plotHint) target.plotHint = source.plotHint;
  if (source.plottable) target.plottable = true;
  if (source.starred) target.starred = true;
  const terms = [...(target.conceptTerms || [])];
  for (const t of source.conceptTerms || []) {
    if (!terms.includes(t)) terms.push(t);
    if (terms.length >= MAX_CONCEPT_TERMS) break;
  }
  target.conceptTerms = terms.slice(0, MAX_CONCEPT_TERMS);
  target.updatedAt = Date.now();
  store.formulas = store.formulas.filter((f) => f.id !== sourceId);
  for (const p of Object.values(store.papers || {})) {
    if (Array.isArray(p.formulaIds)) {
      const set = new Set(p.formulaIds.map((x) => (x === sourceId ? targetId : x)));
      p.formulaIds = [...set];
    }
  }
  return target;
}

/** 把公式清单渲染为 Markdown 文档，便于导出/外部查看（KaTeX 语法，Obsidian 可直接渲染）。
 *  opts.ids（v3.30）：限定导出子集（「按当前筛选导出」）。 */
function formulasToMarkdown(store, opts = {}) {
  const ids = Array.isArray(opts && opts.ids) && opts.ids.length ? new Set(opts.ids) : null;
  let items = store.formulas || [];
  if (ids) items = items.filter((f) => ids.has(f.id));
  if (!items.length) {
    return '# 公式清单\n\n_（暂无公式，运行 AI 扫描或在论文页「抽取并追加公式」即可生成）_\n';
  }
  const lines = ['# 公式清单', '', `> 共 ${items.length} 个公式，由 PaperWiki 自动归一化整理。`, ''];
  for (const f of items) {
    lines.push(
      `## ${f.starred ? '⭐ ' : ''}${f.name}`,
      '',
      `\`${f.canonicalName}\`${f.category ? ` · 分类：\`${f.category}\`` : ''}`,
      '',
    );
    lines.push('$$', f.latex, '$$', '');
    if (f.description) lines.push(f.description, '');
    if (f.conceptTerms && f.conceptTerms.length) lines.push(`**相关概念：** ${f.conceptTerms.join('、')}`, '');
    if (f.variables.length) {
      lines.push('| 符号 | 含义 | 角色 |', '| --- | --- | --- |');
      for (const v of f.variables) lines.push(`| \`${v.symbol}\` | ${v.meaning} | ${v.role} |`);
      lines.push('');
    }
    if (f.occurrences.length) {
      lines.push(`**出现于 ${f.occurrences.length} 篇：**`, '');
      for (const o of f.occurrences) {
        const p = store.papers && store.papers[o.paperId];
        const title = p ? p.title || p.filename || o.paperId : o.paperId;
        const bits = [];
        if (o.context) bits.push(o.context);
        if (o.rawLatex) bits.push(`原文写作 $${o.rawLatex}$`);
        const map = Object.entries(o.symbolMap || {});
        if (map.length) bits.push(`符号对照 ${map.map(([k, v]) => `${k}→${v}`).join('、')}`);
        lines.push(`- ${title}${bits.length ? `\u3000（${bits.join('；')}）` : ''}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = {
  VAR_ROLES,
  SOURCES,
  MAX_VARIABLES,
  MAX_CONCEPT_TERMS,
  normalizeCanonicalName,
  normalizeConceptTerms,
  looksLikeFormula,
  normalizeLatex,
  formulaIdFor,
  normalizeVariables,
  normalizePlotHint,
  normalizeOccurrence,
  normalizeFormula,
  normalizeFormulas,
  mergeFormulas,
  mergeFormulaInto,
  deleteFormula,
  removePaperFromFormulas,
  formulasToMarkdown,
};
