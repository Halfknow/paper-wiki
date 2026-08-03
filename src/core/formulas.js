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

/** plotHint 结构校验：必须有 variable + 二元数值 range，否则降级 null（宁缺勿错，画图功能才好接）。 */
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
  return { variable: variable.slice(0, 60), range: [lo, hi], params };
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
 *     rawLatex, context, symbolMap }
 * 其中后三个是「本篇的 occurrence 属性」，会被折进 occurrences。
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

/** 把公式清单渲染为 Markdown 文档，便于导出/外部查看（KaTeX 语法，Obsidian 可直接渲染）。 */
function formulasToMarkdown(store) {
  const items = store.formulas || [];
  if (!items.length) {
    return '# 公式清单\n\n_（暂无公式，运行 AI 扫描或在论文页「抽取并追加公式」即可生成）_\n';
  }
  const lines = ['# 公式清单', '', `> 共 ${items.length} 个公式，由 PaperWiki 自动归一化整理。`, ''];
  for (const f of items) {
    lines.push(`## ${f.name}`, '', `\`${f.canonicalName}\`${f.category ? ` · 分类：\`${f.category}\`` : ''}`, '');
    lines.push('$$', f.latex, '$$', '');
    if (f.description) lines.push(f.description, '');
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
  normalizeCanonicalName,
  normalizeLatex,
  formulaIdFor,
  normalizeVariables,
  normalizePlotHint,
  normalizeOccurrence,
  normalizeFormula,
  normalizeFormulas,
  mergeFormulas,
  deleteFormula,
  removePaperFromFormulas,
  formulasToMarkdown,
};
