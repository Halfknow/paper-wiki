// 概念 ↔ 公式 跨页知识联动（v3.28，纯前端派生，无 IO）。
//
// 关联来源两层：
//  1. **显式关联**：公式抽取提示词输出 conceptTerms（与本篇概念清单对齐的 term），
//     mergeFormulas 并集落库（formulas.concept_terms）。
//  2. **名称匹配兜底**：概念 term（Title Case 英文 / 中文）与公式 canonicalName（小写连字符）
//     归一到同一 key 后比对——MinerU / 框选路径的公式没有 conceptTerms，靠这层兜住；
//     两侧提示词的规范名对照表保证命名收敛，匹配率可观。
// state 依赖：concepts / formulas / papers 全量在内存（两页本就全量拉取）。

import { state } from './state.js';

/** 名称匹配 key：小写 + 去掉所有非字母数字字符。
 *  'Scaled Dot-Product Attention' 与 'scaled-dot-product-attention' 同得 'scaleddotproductattention'；
 *  中文概念/公式名（'缩放点积注意力'）原样保留参与比对。 */
export function termKey(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 名称相似度（v3.30 合并候选推荐用）：termKey 的 bigram Jaccard，0~1。
 *  命中场景：'Self-Attention' vs 'self attention'（=1）、'Variational Autoencoder' vs
 *  'Variational Auto-Encoder'（≈0.9）——命名漂移产生的疑似重复条目。 */
export function termSimilarity(a, b) {
  const ka = termKey(a);
  const kb = termKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.length < 2 || kb.length < 2) return 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(ka);
  const gb = grams(kb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** 概念 → 相关公式：显式 conceptTerms 命中 + canonicalName/name 名称匹配兜底。 */
export function formulasForConcept(concept) {
  if (!concept) return [];
  const key = termKey(concept.term);
  if (!key) return [];
  return (state.formulas || []).filter((f) => {
    if ((f.conceptTerms || []).some((t) => termKey(t) === key)) return true;
    return termKey(f.canonicalName) === key || termKey(f.name) === key;
  });
}

/** 公式 → 相关概念：显式 conceptTerms（term 写法对齐）+ 名称匹配兜底。 */
export function conceptsForFormula(f) {
  if (!f) return [];
  const explicit = new Set((f.conceptTerms || []).map(termKey));
  const own = new Set([termKey(f.canonicalName), termKey(f.name)]);
  return (state.concepts || []).filter((c) => {
    const k = termKey(c.term);
    return !!k && (explicit.has(k) || own.has(k));
  });
}

/** 概念共现：与给定概念出现在同一些论文里的其他概念，按共现篇数降序（学者视角的
 *  「读这篇还会碰到什么」）。返回 [{concept, count}]。 */
export function coOccurringConcepts(concept, limit = 8) {
  if (!concept) return [];
  const ids = new Set(concept.paperIds || []);
  const out = [];
  for (const c of state.concepts || []) {
    if (c.id === concept.id) continue;
    let n = 0;
    for (const pid of c.paperIds || []) if (ids.has(pid)) n++;
    if (n > 0) out.push({ concept: c, count: n });
  }
  out.sort(
    (a, b) =>
      b.count - a.count || String(a.concept.term || '').localeCompare(String(b.concept.term || '')),
  );
  return out.slice(0, limit);
}

/** 概念 → 论文主题集合（出现论文的 topics 聚合）。概念页侧栏的「主题」分面按同一口径计数。 */
export function topicsOfConcept(concept) {
  if (!concept) return [];
  const set = new Set();
  for (const pid of concept.paperIds || []) {
    const p = (state.papers || []).find((x) => x.id === pid);
    for (const t of (p && p.topics) || []) set.add(t);
  }
  return [...set];
}

/** KaTeX 安全渲染（与公式页 renderKatex 同规则）：模型 LaTeX 超出 KaTeX 子集时
 *  throwOnError:false 渲染红字，再兜 try/catch 防单条打断整块。无 katex 全局（jsdom）时回退 code。 */
export function renderKatexSafe(latex, display) {
  if (typeof katex === 'undefined' || !katex) return '<code>' + String(latex || '') + '</code>';
  try {
    return katex.renderToString(String(latex || ''), { displayMode: !!display, throwOnError: false });
  } catch {
    return '<code>' + String(latex || '') + '</code>';
  }
}
