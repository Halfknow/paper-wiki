// 公式清单（KaTeX / 瀑布流 / 懒加载）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { DEL, PATCH, POST, jget, sp } from '../core/api.js';
import { $, selectionWithin } from '../core/dom.js';
import { chipClass, escapeHtml } from '../core/format.js';
import { conceptsForFormula } from '../core/knowledge-link.js';
import { gotoPaper, router, syncPageQueryToUrl } from '../core/nav.js';
import { plotSvg } from '../core/plot.js';
import { createPickBar } from '../core/pick-bar.js';
import { renderMd } from '../core/markdown.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { openConceptDetail } from '../concepts/detail-drawer.js';
import { openFormulaEditor } from './editor-drawer.js';
// 模块循环（formulas ↔ detail-overlay）：双方只在事件回调里调对方，顶层求值互不依赖
import { openFormulaDetail } from './detail-overlay.js';
import { setSidebarCollapsed } from '../views/layout.js';
import { showView } from '../views/view-switch.js';

// ---- 公式清单视图（v3.9）----
// 标题头 sticky 的滚动态（v3.36）：>4px 挂 .scrolled 驱动底边阴影；一次性接线
function _wireFormulaHeadScrolled() {
  const v = $('formulas-view');
  if (!v || v.dataset.headWired) return;
  v.dataset.headWired = '1';
  v.addEventListener('scroll', () => v.classList.toggle('scrolled', v.scrollTop > 4), { passive: true });
}
// 与概念清单同构：跨论文按 canonicalName 归并，卡片走 KaTeX display 渲染。
// 「归一化到一般形式」的展示落点在 occurrences[].symbolMap：清单页给一般形式，
// 展开某篇论文能看到「这篇里 d_k 写作 d」。
export async function showFormulas() {
  // showView 必须先于所有 await（v3.17）：排在网络请求之后时，深链 /formulas 刷新会先闪论文页。
  showView('formulas');
  _wireFormulaHeadScrolled();
  // state.papers 只由 refresh()（库视图 / 10s 轮询）填充——v3.15 深链 /formulas 时为空，
  // 卡片 occurrences 全解析不到 → 误显示「独立条目」（等 10s 轮询后渲染的批次才有论文，看起来像时好时坏）。
  // 这里直接补拉一次列表（不走 refresh()，避免 renderList/syncFilterToUrl 副作用污染公式页 URL）。
  // v3.28：相关概念 chips 要 state.concepts（conceptTerms/名称匹配），缺则补拉（概念页对称拉 formulas）。
  // 深链首帧骨架（R2）：公式还没拉过时先出网格骨架，数据到达由 renderFormulas 覆盖
  if (!(state.formulas || []).length) {
    $('formulas-grid').innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="skel-kcard" aria-hidden="true"><div class="skel skel-title" style="width:${52 + ((i * 11) % 34)}%"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-foot"></div></div>`).join('');
  }
  const needPapers = !(state.papers || []).length;
  const needConcepts = !(state.concepts || []).length;
  const [{ data }, pr, cr] = await Promise.all([
    jget('/api/formulas'),
    needPapers ? jget('/api/papers') : null,
    needConcepts ? jget('/api/concepts') : null,
  ]);
  state.formulas = data || [];
  if (pr && Array.isArray(pr.data)) state.papers = pr.data;
  if (cr && Array.isArray(cr.data)) state.concepts = cr.data;
  renderFormulaSidebar(); // 分类计数要等数据到位
  renderFormulas();
}

export let _formulaSort = localStorage.getItem('pw-formula-sort') || 'freq';

export let _formulaLayout = localStorage.getItem('pw-formula-layout') || 'masonry';

// 懒加载：公式清单可能数百条，每张卡跑同步 KaTeX，一次性 innerHTML 会卡顿。
// 故保留「全量排序后的 list」，但分批渲染（首批 _FORMULA_FIRST_BATCH，之后每批 _FORMULA_NEXT_BATCH），
// 用 IntersectionObserver 观察末尾 sentinel 触发追加。jsdom/老浏览器无此 API 时一次性渲染全部（兼容）。
// 批量取小（v3.15）：每张卡 KaTeX 同步渲染 + 全量重排都是主线程开销，小批量滚动更顺滑
// （首批仍按 3 列 × ~10 行留足一屏+overscan，避免刚滚动就等加载）。
const _FORMULA_FIRST_BATCH = 30;

const _FORMULA_NEXT_BATCH = 20;

let _formulaList = []; // 当前排序后的完整列表（renderFormulas 计算）

let _formulaShown = 0; // 已渲染条数

let _formulaObserver = null; // IntersectionObserver 实例（复用，root 滚动容器不变）

/** KaTeX 安全渲染：模型给的 LaTeX 可能超出 KaTeX 子集，throwOnError:false 会渲染成红字而非抛错；
 *  再兜一层 try/catch 防 KaTeX 自身异常把整页卡片渲染链打断。 */
function renderKatex(latex, display) {
  try {
    return katex.renderToString(String(latex || ''), { displayMode: !!display, throwOnError: false });
  } catch {
    return '<code>' + escapeHtml(latex || '') + '</code>';
  }
}

/** 原文写法清理（v3.50）：occurrence 的 rawLatex 带两类显示噪声——
 *  ① 行末 \tag{N}（KaTeX inline 模式不支持，整段红字）；② HTML 实体（&lt; &gt;，入库链路腐蚀）。
 *  只修显示层，库内原始数据不动（审计以原样为准）。 */
// 符号角色中文标签（导出给预览浮窗复用）
export const VAR_ROLE_LABEL = { input: '输入', param: '参数', output: '输出', const: '常量' };

// v3.20：DSL 是单一事实源——搜索框里的 category:/source:/plottable: 决定筛选。
// v3.28 分面扩容：freq:（hot/shared/solo 烒度）、added:7d|30d（最近新增）、quality:nodef（缺解读）。
// _formulaCats / _formulaFilter 从 DSL 派生（renderFormulas 每次刷新），侧栏/高级面板写 DSL。
let _formulaCats = new Set();       // 从 DSL category: 派生（侧栏多选）
let _formulaFilter = { source: '', plottable: false, freq: '', added: '', quality: '', starred: false }; // 从 DSL 派生

/** 从搜索框 DSL 解析派生 _formulaCats / _formulaFilter。返回文本词/短语供 renderFormulas 过滤。 */
function _refreshFormulaFilterFromDsl() {
  const S = window.PaperWikiSearch;
  const dsl = (($('search') || {}).value || '').trim();
  if (!S) {
    _formulaCats = new Set();
    _formulaFilter = { source: '', plottable: false, freq: '', added: '', quality: '', starred: false };
    return { words: dsl ? [dsl.toLowerCase()] : [], phrases: [], excludeWords: [], excludePhrases: [] };
  }
  const { metadata } = S.parseSearchQuery(dsl);
  _formulaCats = new Set((metadata.fields.category || []).filter((e) => !e.exclude).map((e) => e.value));
  _formulaFilter = {
    source: metadata.fields.source || '',
    plottable: metadata.fields.plottable === true,
    freq: metadata.fields.freq || '',
    added: metadata.fields.added || '',
    quality: metadata.fields.quality || '',
    starred: metadata.fields.starred === true, // v3.30 重点标记（star:1，与论文页同语法）
  };
  return {
    words: metadata.text.words,
    phrases: metadata.text.phrases,
    excludeWords: metadata.text.excludeWords,
    excludePhrases: metadata.text.excludePhrases,
  };
}

/** 把分面状态合并进搜索框 DSL（保留裸词/文本部分）。
 *  parts = { categories?, source?, plottable?, freq?, added?, quality? }，缺省的键不动。 */
function _mergeFormulaDsl(parts) {
  const S = window.PaperWikiSearch;
  const inp = $('search');
  if (!inp || !S) return;
  const cur = S.parseToPanel(inp.value);
  const merged = {
    text: cur.text,
    categories: parts.categories !== undefined ? parts.categories : cur.categories,
    source: parts.source !== undefined ? parts.source : cur.source,
    plottable: parts.plottable !== undefined ? parts.plottable : cur.plottable,
    freq: parts.freq !== undefined ? parts.freq : cur.freq,
    added: parts.added !== undefined ? parts.added : cur.added,
    quality: parts.quality !== undefined ? parts.quality : cur.quality,
    starred: parts.starred !== undefined ? parts.starred : cur.starred,
  };
  inp.value = S.buildDslFromPanel(merged);
  syncPageQueryToUrl();
}

/** 「有符号表」临时过滤开关（v3.28）：无对应 DSL 字段，模块级状态即可（不进 URL）。 */
let _formulaTraitHasVars = false;

/** 导出公式清单 Markdown（v3.30）：有激活筛选时导出当前筛选子集（POST ids → blob 下载），
 *  无筛选维持全量（原 GET /api/formulas.md 直链）。与概念页 exportConceptsMd 对称。 */
export async function exportFormulasMd() {
  const total = (state.formulas || []).length;
  const filtered = _formulaList.length;
  if (filtered && filtered < total) {
    try {
      const res = await fetch(sp('/api/formulas.md'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: _formulaList.map((f) => f.id) }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `formulas-${filtered}.md`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
      toast(`已导出当前筛选的 ${filtered} 个公式`);
      return;
    } catch (e) {
      toast('筛选集导出失败：' + (e && e.message ? e.message : e) + '，改为导出全量', 'error');
    }
  }
  window.open(sp('/api/formulas.md'), '_blank');
}

// ---- 多选 + 批量管理（v3.29）----

let _formulaPickMode = false;
const _formulaPicked = new Set();
let _formulaPickBar = null;

export function isFormulaPickMode() {
  return _formulaPickMode;
}

/** 切换公式页多选模式（工具条按钮触发）。批量删除/改分类走 /api/formulas/bulk。 */
export function toggleFormulaPickMode(on) {
  const next = typeof on === 'boolean' ? on : !_formulaPickMode;
  if (next === _formulaPickMode) return;
  _formulaPickMode = next;
  if (_formulaPickMode) {
    if (!_formulaPickBar) {
      _formulaPickBar = createPickBar({
        itemsLabel: '公式',
        categories: null, // 公式分类是自由字符串（非枚举），改分类走文本输入
        onDelete: async () => {
          const ids = [..._formulaPicked];
          try {
            const r = await POST('/api/formulas/bulk', { ids, delete: true });
            if (r && r.ok) {
              toast(`已删除 ${r.data.updated} 个公式`);
              const del = new Set(ids);
              state.formulas = (state.formulas || []).filter((f) => !del.has(f.id));
              toggleFormulaPickMode(false);
              renderFormulaSidebar();
              renderFormulas();
            } else toast((r && r.error) || '删除失败', 'error');
          } catch {
            toast('网络中断，批量删除未完成', 'error');
          }
        },
        onCategorize: async (category) => {
          const ids = [..._formulaPicked];
          try {
            const r = await POST('/api/formulas/bulk', { ids, category });
            if (r && r.ok) {
              toast(`已把 ${r.data.updated} 个公式归入「${category}」`);
              const hit = new Set(ids);
              for (const f of state.formulas || []) if (hit.has(f.id)) f.category = category;
              toggleFormulaPickMode(false);
              renderFormulaSidebar();
              renderFormulas();
            } else toast((r && r.error) || '操作失败', 'error');
          } catch {
            toast('网络中断，批量归类未完成', 'error');
          }
        },
        onExit: () => toggleFormulaPickMode(false),
      });
    }
    _formulaPickBar.open();
    _formulaPickBar.setCount(_formulaPicked.size);
  } else {
    _formulaPicked.clear();
    if (_formulaPickBar) _formulaPickBar.close();
  }
  renderFormulas();
}

/** 多选模式内点击卡片：切换选中（就地改 class + 计数，不整页重渲）。 */
function _toggleFormulaPick(id, cardEl) {
  if (_formulaPicked.has(id)) {
    _formulaPicked.delete(id);
    cardEl.classList.remove('picked');
  } else {
    _formulaPicked.add(id);
    cardEl.classList.add('picked');
  }
  if (_formulaPickBar) _formulaPickBar.setCount(_formulaPicked.size);
}

/** 渲染公式页侧栏（v3.28 重设计，与概念页同构）：全部 + 热度 + 来源 + 特性 + 最近新增 + 分类。
 *  设计动机同概念页：模型打的自由字符串分类导航价值有限，侧栏承载「热度 × 来源 × 特性 ×
 *  新近 × 质量」这些**可行动**的维度；分类（从数据现算）降级到末位。
 *  所有分面写 DSL（v3.20 单一事实源不变），renderFormulas/renderFormulaSidebar 从 DSL 派生。 */
export function renderFormulaSidebar() {
  const host = $('side-formulas');
  if (!host) return;
  _refreshFormulaFilterFromDsl(); // 侧栏 active 态从 DSL 派生
  const formulas = state.formulas || [];
  const now = Date.now();
  const cnt = (fn) => formulas.filter(fn).length;
  const freqCounts = {
    hot: cnt((f) => (f.paperIds || []).length >= 4),
    shared: cnt((f) => (f.paperIds || []).length >= 2),
    solo: cnt((f) => (f.paperIds || []).length === 1),
  };
  const srcCounts = { ai: 0, mineru: 0, vision: 0, manual: 0 };
  for (const f of formulas) {
    const k = f.source || 'ai';
    if (k in srcCounts) srcCounts[k]++;
  }
  const plottableCount = cnt((f) => !!f.plottable);
  const hasVarsCount = cnt((f) => (f.variables || []).length > 0);
  const nodefCount = cnt((f) => !(f.description || '').trim());
  const starCount = cnt((f) => !!f.starred); // v3.30 重点标记
  const added7 = cnt((f) => now - (f.createdAt || 0) < 7 * 86400e3);
  const added30 = cnt((f) => now - (f.createdAt || 0) < 30 * 86400e3);

  const counts = {};
  for (const f of formulas) {
    const k = f.category || '未分类';
    counts[k] = (counts[k] || 0) + 1;
  }
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const total = formulas.length;
  const F = _formulaFilter;
  const anyFacet = _formulaCats.size || F.source || F.plottable || F.freq || F.added || F.quality || F.starred;
  const SRC_LABEL = { ai: 'AI 抽取', mineru: 'MinerU', vision: '阅读器框选', manual: '人工修订' };

  host.innerHTML = `
    <div class="side-section">
      <div class="side-title">
        <span>视图</span>
        <span class="side-actions">
          <button class="btn ghost xs icon side-icon-btn" id="btn-collapse-formulas" title="收起侧栏" aria-label="收起侧栏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button>
        </span>
      </div>
      <div class="side-item${_formulaCats.size ? '' : ' active'}" data-cat=""><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h9"/><path d="M13 4L8 20"/><path d="M4 12h8"/><path d="M15.5 10.5l5 7"/><path d="M20.5 10.5l-5 7"/></svg></span><span>全部公式</span><span class="count">${total || ''}</span></div>
    </div>
    <div class="side-section">
      <div class="side-title"><span>热度</span>${anyFacet ? '<button class="side-clear" id="side-fall-clear" type="button">全部清除</button>' : ''}</div>
      <div class="side-item${F.freq === 'hot' ? ' active' : ''}" data-freq="hot"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c1 4-4 6-4 10a4 4 0 0 0 8 0c0-1.5-.7-2.5-1.5-3.5C13 11 12 9 12 2z" transform="translate(2 4) scale(.9)"/></svg></span><span>高频（≥4 篇）</span><span class="count">${freqCounts.hot || ''}</span></div>
      <div class="side-item${F.freq === 'shared' ? ' active' : ''}" data-freq="shared"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span>多篇共享（≥2 篇）</span><span class="count">${freqCounts.shared || ''}</span></div>
      <div class="side-item${F.freq === 'solo' ? ' active' : ''}" data-freq="solo"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span><span>仅单篇</span><span class="count">${freqCounts.solo || ''}</span></div>
    </div>
    <div class="side-section">
      <div class="side-title"><span>来源</span></div>
      ${Object.entries(SRC_LABEL).filter(([k]) => srcCounts[k]).map(([k, label]) => `<div class="side-item${F.source === k ? ' active' : ''}" data-source="${k}"><span class="cat-dot"></span><span>${label}</span><span class="count">${srcCounts[k]}</span></div>`).join('')}
    </div>
    <div class="side-section">
      <div class="side-title"><span>特性</span></div>
      <div class="side-item${F.starred ? ' active' : ''}" data-trait="star"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span><span>重点</span><span class="count">${starCount || ''}</span></div>
      <div class="side-item${F.plottable ? ' active' : ''}" data-trait="plottable"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg></span><span>可绘图</span><span class="count">${plottableCount || ''}</span></div>
      <div class="side-item${F.quality === 'nodef' ? ' active' : ''}" data-trait="nodef"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span><span>缺解读</span><span class="count">${nodefCount || ''}</span></div>
      <div class="side-item${_formulaTraitHasVars ? ' active' : ''}" data-trait="hasvars" title="带符号表的公式（点击过滤）"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg></span><span>有符号表</span><span class="count">${hasVarsCount || ''}</span></div>
    </div>
    ${(added7 || added30) ? `<div class="side-section">
      <div class="side-title"><span>最近新增</span></div>
      ${added7 ? `<div class="side-item${F.added === '7d' ? ' active' : ''}" data-added="7d"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></span><span>7 天内</span><span class="count">${added7}</span></div>` : ''}
      ${added30 ? `<div class="side-item${F.added === '30d' ? ' active' : ''}" data-added="30d"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span><span>30 天内</span><span class="count">${added30}</span></div>` : ''}
    </div>` : ''}
    <div class="side-section">
      <div class="side-title">
        <span>AI 分类</span>
        ${_formulaCats.size ? '<button class="side-clear" id="side-fcat-clear" type="button">清除</button>' : ''}
      </div>
      ${cats.length
    ? cats.map((k) => `<div class="side-item${_formulaCats.has(k) ? ' active' : ''}" data-cat="${escapeHtml(k)}"><span class="cat-dot"></span><span>${escapeHtml(k)}</span><span class="count">${counts[k]}</span></div>`).join('')
    : '<div class="side-item" style="color:var(--muted2);cursor:default;">（暂无分类）</div>'}
    </div>`;

  // ---- 接线 ----
  host.querySelectorAll('.side-item[data-cat]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.cat;
      // 写 DSL（单一事实源），renderFormulas/renderFormulaSidebar 从 DSL 派生
      const next = new Set(_formulaCats);
      if (!k) next.clear();                                        // 「全部公式」= 清空分面
      else if (next.has(k)) next.delete(k);
      else next.add(k);
      _mergeFormulaDsl({ categories: [...next] });
      renderFormulaSidebar();
      renderFormulas();
    };
  });
  // 热度单选（再点取消）
  host.querySelectorAll('.side-item[data-freq]').forEach((el) => {
    el.onclick = () => {
      const next = F.freq === el.dataset.freq ? '' : el.dataset.freq;
      _mergeFormulaDsl({ freq: next });
      renderFormulaSidebar();
      renderFormulas();
    };
  });
  // 来源单选（再点取消回全部）
  host.querySelectorAll('.side-item[data-source]').forEach((el) => {
    el.onclick = () => {
      const next = F.source === el.dataset.source ? '' : el.dataset.source;
      _mergeFormulaDsl({ source: next });
      renderFormulaSidebar();
      renderFormulas();
    };
  });
  // 特性开关（plottable / nodef / hasvars——hasvars 走临时过滤，DSL 未占用专用字段）
  host.querySelectorAll('.side-item[data-trait]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.trait;
      if (k === 'plottable') _mergeFormulaDsl({ plottable: !F.plottable });
      else if (k === 'star') _mergeFormulaDsl({ starred: !F.starred });
      else if (k === 'nodef') _mergeFormulaDsl({ quality: F.quality === 'nodef' ? '' : 'nodef' });
      else if (k === 'hasvars') _formulaTraitHasVars = !_formulaTraitHasVars;
      renderFormulaSidebar();
      renderFormulas();
    };
  });
  // 最近新增单选（再点取消）
  host.querySelectorAll('.side-item[data-added]').forEach((el) => {
    el.onclick = () => {
      const next = F.added === el.dataset.added ? '' : el.dataset.added;
      _mergeFormulaDsl({ added: next });
      renderFormulaSidebar();
      renderFormulas();
    };
  });
  const clear = $('side-fcat-clear');
  if (clear) clear.onclick = () => { _mergeFormulaDsl({ categories: [] }); renderFormulaSidebar(); renderFormulas(); };
  const allClear = $('side-fall-clear');
  if (allClear)
    allClear.onclick = () => {
      _formulaTraitHasVars = false;
      _mergeFormulaDsl({ categories: [], source: '', plottable: false, freq: '', added: '', quality: '', starred: false });
      renderFormulaSidebar();
      renderFormulas();
    };
  const collapse = $('btn-collapse-formulas');
  if (collapse) collapse.onclick = () => setSidebarCollapsed(true);
  // 收起态 rail 的「全部公式」按钮 active 态（无分面选中时高亮）
  const railAll = $('rail-formula-all');
  if (railAll) railAll.classList.toggle('active', !_formulaCats.size);
}

/** 「全部公式」= 清空分类分面。收起态 rail 按钮（bind.js 接线）与展开侧栏项共用入口。 */
export function resetFormulaFacet() {
  _mergeFormulaDsl({ categories: [] });
  renderFormulaSidebar();
  renderFormulas();
}

export function renderFormulas() {
  // 查询词来自顶栏那个上下文搜索框（v3.17，页内 #formula-q 已退役）。
  // v3.20：解析 DSL——裸词/短语匹配 name/canonicalName/latex/description/category（AND），
  // category:/source:/plottable: 结构化筛选。
  // v3.28：新增 freq:（热度）/ added:（最近新增）/ quality:nodef（缺解读）+ 有符号表临时开关。
  const { words, phrases, excludeWords, excludePhrases } = _refreshFormulaFilterFromDsl();
  const hasText = words.length > 0 || phrases.length > 0;
  const sort = _formulaSort;
  const layout = _formulaLayout;
  const F = _formulaFilter;
  const now = Date.now();
  let list = (state.formulas || []).filter((f) => {
    if (hasText) {
      const hay = [f.name, f.canonicalName, f.latex, f.description, f.category].join(' ').toLowerCase();
      for (const w of words) if (!hay.includes(w)) return false;
      for (const p of phrases) if (!hay.includes(p)) return false;
      for (const w of excludeWords) if (hay.includes(w)) return false;
      for (const p of excludePhrases) if (hay.includes(p)) return false;
    }
    return true;
  });
  if (_formulaCats.size) list = list.filter((f) => _formulaCats.has(f.category || '未分类')); // 侧栏分类分面
  if (F.source) list = list.filter((f) => (f.source || 'ai') === F.source);
  if (F.plottable) list = list.filter((f) => !!f.plottable);
  if (F.freq === 'shared') list = list.filter((f) => (f.paperIds || []).length >= 2);
  else if (F.freq === 'hot') list = list.filter((f) => (f.paperIds || []).length >= 4);
  else if (F.freq === 'solo') list = list.filter((f) => (f.paperIds || []).length === 1);
  if (F.quality === 'nodef') list = list.filter((f) => !(f.description || '').trim());
  if (F.starred) list = list.filter((f) => !!f.starred);
  if (F.added === '7d') list = list.filter((f) => now - (f.createdAt || 0) < 7 * 86400e3);
  else if (F.added === '30d') list = list.filter((f) => now - (f.createdAt || 0) < 30 * 86400e3);
  if (_formulaTraitHasVars) list = list.filter((f) => (f.variables || []).length > 0);
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN-u-co-pinyin');
  if (sort === 'freq') {
    list = list.slice().sort((a, b) => (b.paperIds || []).length - (a.paperIds || []).length || byName(a, b));
  } else if (sort === 'category') {
    list = list.slice().sort((a, b) => String(a.category || '~').localeCompare(String(b.category || '~')) || byName(a, b));
  } else if (sort === 'recent') {
    list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else {
    list = list.slice().sort(byName);
  }
  const cb = $('formulas-count');
  if (cb) cb.textContent = list.length;
  document.querySelectorAll('#formula-sort button').forEach((b) => b.classList.toggle('active', b.dataset.sort === sort));
  document.querySelectorAll('#formula-layout button').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));

  const g = $('formulas-grid');
  g.className = 'formulas-grid' + (layout === 'list' ? ' list-view' : ' masonry-view');
  g.style.height = ''; // 清掉瀑布流遗留的绝对定位容器高度（切布局 / 重渲时复位）
  _formulaMasonryCols = 0;
  g.innerHTML = '';
  _wireFormulaGridOnce(g); // grid 级事件委托（一次性，懒加载追加批次不重复绑）
  if (!list.length) {
    // 结构化空态（R3）：真空给「去抽取 / 手动新增」；筛选无匹配给「清除筛选」
    const hasAny = (state.formulas || []).length > 0;
    g.innerHTML = `<div class="empty-state">
      <div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h9"/><path d="M13 4L8 20"/><path d="M4 12h8"/><path d="M15.5 10.5l5 7"/><path d="M20.5 10.5l-5 7"/></svg></div>
      <p class="es-main">${hasAny ? '没有匹配的公式' : '公式清单还是空的'}</p>
      <p class="es-sub">${hasAny ? '当前搜索 / 分面筛选过窄，试试放宽条件。' : '公式在扫描时自动抽取；也可以手动录入一条（工具条「+ 新增」），或在阅读器里框选公式区域补录。'}</p>
      <div class="es-actions">${hasAny ? '<button class="btn sm es-clear" type="button">清除筛选</button>' : '<button class="btn sm es-goto" type="button">去论文库抽取</button><button class="btn secondary sm es-add" type="button">手动新增公式</button>'}</div>
    </div>`;
    const clearBtn = g.querySelector('.es-clear');
    if (clearBtn) clearBtn.onclick = () => {
      const inp = $('search');
      if (inp) inp.value = '';
      _formulaTraitHasVars = false;
      _mergeFormulaDsl({ categories: [], source: '', plottable: false, freq: '', added: '', quality: '', starred: false });
      renderFormulaSidebar();
      renderFormulas();
    };
    const gotoBtn = g.querySelector('.es-goto');
    if (gotoBtn) gotoBtn.onclick = () => router.navigate('/library', { keepQuery: false });
    const addBtn = g.querySelector('.es-add');
    if (addBtn) addBtn.onclick = () => openFormulaEditor(null);
    return;
  }
  _formulaList = list;
  _formulaShown = 0;
  _renderFormulaBatch(_FORMULA_FIRST_BATCH);
}

/** 构造单张公式卡 DOM（masonry / list 两布局）。KaTeX 在此同步渲染（首批/每批 ≤60，可接受）。
 *  v3.28：①「复制 LaTeX」按钮（写笔记/回论文引用刚需）；②出处明细表——每篇的章节出处、
 *  原文写法（rawLatex）与符号对照（symbolMap）此前只藏在 tooltip，现以可折叠表格直读；
 *  ③相关概念 chips（conceptTerms 显式关联 + 名称匹配兜底），点击直开概念详情抽屉。 */
function _buildFormulaCard(f, layout) {
  const card = document.createElement('div');
  card.className = 'formula-card';
  card.dataset.fid = f.id; // 多选模式的选中定位（v3.29）
  if (_formulaPickMode) {
    card.classList.add('pickable');
    if (_formulaPicked.has(f.id)) card.classList.add('picked');
  }
  const freq = (f.paperIds || []).length;
  const occs = (f.occurrences || [])
    .map((o) => ({ o, p: state.papers.find((x) => x.id === o.paperId) }))
    .filter((x) => x.p);
  // v3.52：卡片只留「扫一眼」密度——关联论文以标签 chips 展示（3 个 + N 折叠），
  // 符号表/出处明细/完整解读全部移入预览浮窗（detail-overlay.js，点卡片打开）。

  // 相关概念 chips（显式 conceptTerms 命中 + 名称匹配兜底，见 core/knowledge-link）
  const relConcepts = conceptsForFormula(f).slice(0, 3);
  const relHtml = relConcepts.length
    ? `<div class="fc-concepts"><span class="meta-label">相关概念</span>${relConcepts
        .map((c) => `<button class="concept-chip ${chipClass(c.term)}" data-cdopen="${c.id}" title="查看概念「${escapeHtml(c.term)}」">${escapeHtml(c.term)}</button>`)
        .join('')}</div>`
    : '';

  // 关联论文标签（v3.52）：3 个 +「+N」折叠；点标签跳论文，点「+N」开预览看全量
  const paperChipsHtml = occs.length
    ? `<div class="fc-papers"><span class="meta-label">出现于</span>${occs
        .slice(0, 3)
        .map((x) => {
          const label = x.p.title || x.p.filename;
          return `<button class="paper-chip" data-goto="${x.o.paperId}" title="打开「${escapeHtml(label)}」">${escapeHtml(label)}</button>`;
        })
        .join('')}${occs.length > 3 ? `<button class="paper-chip more" data-open="${f.id}" title="在预览中查看全部 ${occs.length} 篇出处">+${occs.length - 3}</button>` : ''}</div>`
    : '';

  // 函数曲线（v3.29）：plottable 且 plotExpr 可求值时直接在卡上画形状（求值失败静默降级）
  const plotHtml = f.plottable && f.plotHint ? plotSvg(f.plotHint, 460, 150) || '' : '';

  const starBtn = `<button class="btn ghost xs icon star-btn card-star${f.starred ? ' is-starred' : ''}" data-star="${f.id}" title="${f.starred ? '取消重点' : '标记为重点'}" aria-label="星标" aria-pressed="${!!f.starred}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>`;
  if (layout === 'list') {
    card.innerHTML = `
      <span class="lc-freq ${freq > 1 ? '' : 'dim'}"${freq ? ` title="出现在 ${freq} 篇论文中"` : ''}>${freq || '·'}</span>
      <span class="lc-term" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="lc-formula">${renderKatex(f.latex, false)}</span>
      <span class="lc-count">${occs.length} 篇</span>
      <div class="row-actions">
        <button class="btn ghost xs icon qbtn" data-copy="${f.id}" title="复制 LaTeX（$…$ 包裹，可直接粘进 Markdown 笔记）" aria-label="复制 LaTeX"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="btn ghost xs icon qbtn" data-edit="${f.id}" title="编辑公式（LaTeX / 符号表 / 绘图 / 概念关联）" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        <button class="btn ghost xs icon danger qbtn" data-del="${f.id}" title="删除公式" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>${starBtn}`;
  } else {
    card.innerHTML = `
      <div class="ct">
        <h3>${escapeHtml(f.name)}</h3>${freq ? `<span class="freq-badge badge plain" data-freq="${freq}" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}
        <div class="row-actions">
          <button class="btn ghost xs icon qbtn" data-copy="${f.id}" title="复制 LaTeX（$…$ 包裹，可直接粘进 Markdown 笔记）" aria-label="复制 LaTeX"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <button class="btn ghost xs icon qbtn" data-edit="${f.id}" title="编辑公式（LaTeX / 符号表 / 绘图 / 概念关联）" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
          <button class="btn ghost xs icon danger qbtn" data-del="${f.id}" title="删除公式" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>${starBtn}
      </div>
      <div class="fc-canon"><code>${escapeHtml(f.canonicalName)}</code>${f.category ? `<span class="fc-cat badge">${escapeHtml(f.category)}</span>` : ''}${f.source === 'vision' ? '<span class="fc-src badge" title="由阅读器框选补录">框选</span>' : ''}${f.source === 'mineru' ? '<span class="fc-src badge" title="由 MinerU 抽取">MinerU</span>' : ''}${f.source === 'manual' ? '<span class="fc-src badge" title="已人工修订">人工</span>' : ''}</div>
      <div class="fc-latex">${renderKatex(f.latex, true)}</div>
      ${plotHtml ? `<div class="fc-plot">${plotHtml}</div>` : ''}
      ${f.description ? `<div class="fc-desc">${renderMd(f.description)}</div>` : '<div class="fc-desc muted">（无解读）</div>'}
      ${paperChipsHtml}
      ${relHtml}`;
  }
  return card;
}

/** 解读 4 行截断（v3.49；v3.52 起只做视觉截断——点击展开交互退役，点卡片开预览浮窗看全文）。
 *  必须在卡片挂载后调用——detached 元素 scrollHeight 恒 0，
 *  在 _buildFormulaCard 里检测会永远判「不超长」（生产曾据此 clamp 全不生效）。 */
function _wireDescClamp(descEl) {
  if (!descEl || descEl.classList.contains('muted')) return;
  if (descEl.scrollHeight <= descEl.clientHeight + 4) return;
  descEl.classList.add('clampable');
  descEl.title = '点击卡片打开预览看全文';
}

/** 瀑布流参数：最小列宽与间距（与 CSS grid minmax(340px) / gap:12px 对齐）。 */
const _FORMULA_MASONRY_MIN = 340;

const _FORMULA_MASONRY_GAP = 12;

/** resize 防抖句柄（复用单 timer，避免每次 layout 都新增 listener）。 */
let _formulaResizeTimer = null;

let _formulaResizeWired = false;

/** ResizeObserver 实例 + 上次观测到的 grid 宽度（只认宽度变化，防高度反馈循环）。 */
let _formulaGridRO = null;

let _formulaGridROW = 0;

/** document.fonts.ready 只挂一次（KaTeX 字体到位后重排）。 */
let _formulaFontsWired = false;

/** 上次布局时的列数（resize 改变列数才需重排；纯高度变化由 reflow 触发）。 */
let _formulaMasonryCols = 0;

/** JS 绝对定位瀑布流布局（Pinterest 式）：保留扁平有序 DOM（排序即 document order），
 *  逐卡测高后放进「最短列」设 top/left/width → 顶行从左到右是排序 1..N、下行紧贴上方无竖向空隙。
 *  - 行优先：所有列初始高 0，首张卡放第 1 列、第 2 张放第 2 列…第 N 张放第 N 列（取首个最短列即 round-robin），
 *    之后继续取最短列 → 视觉顶行严格 1..N，下行紧贴。
 *  - 无空隙：每列是独立堆叠，下一张贴在该列已堆内容的正下方（gap 留缝）。
 *  - 兜底：jsdom / 容器未挂载 / 宽度为 0 / 卡高测不到时跳过定位并移除 .js-masonry，
 *    回退到 CSS grid 行优先（有空隙但可读，测试不依赖定位）。
 *  @param {boolean} reflowOnlyHeight true=列数不变只重算高度（如展开符号表），不重置 width */
function _layoutFormulaMasonry(reflowOnlyHeight) {
  const g = $('formulas-grid');
  if (!g || _formulaLayout !== 'masonry') { return; }
  const cards = g.querySelectorAll(':scope > .formula-card');
  if (!cards.length) { g.classList.remove('js-masonry'); g.style.height = ''; return; }
  const width = g.clientWidth;
  // 兜底：宽度测不到（jsdom / 不可见 / display:none）→ 不做绝对定位，回退 CSS grid
  if (!width || width < _FORMULA_MASONRY_MIN / 2) {
    _formulaMasonryCols = 0;
    g.classList.remove('js-masonry');
    cards.forEach((c) => { c.style.position = ''; c.style.top = ''; c.style.left = ''; c.style.width = ''; });
    g.style.height = '';
    return;
  }
  const gap = _FORMULA_MASONRY_GAP;
  let cols = Math.max(1, Math.floor((width + gap) / (_FORMULA_MASONRY_MIN + gap)));
  // 列数受卡片数封顶（3 张卡别开 4 列留大片空白）
  cols = Math.min(cols, cards.length);
  const colWidth = (width - (cols - 1) * gap) / cols;
  // reflowOnlyHeight：列数未变时复用列宽，只重排纵向位置
  if (reflowOnlyHeight && cols !== _formulaMasonryCols) reflowOnlyHeight = false;
  _formulaMasonryCols = cols;
  const colHeights = new Array(cols).fill(0);
  g.classList.add('js-masonry');
  // 三遍分离（写-读-写），避免逐卡「设宽→读高」的同步强制重排（layout thrashing，慢机器上卡死主线程）：
  cards.forEach((card) => {
    card.style.width = colWidth + 'px';
    card.style.position = 'absolute';
  });
  const heights = Array.from(cards, (c) => c.offsetHeight || 0); // 批量读：浏览器合并为一次 reflow
  cards.forEach((card, i) => {
    // 卡高测不到（0）→ 无法精确堆叠，但仍按列宽横向排（纵向会重叠，优于全部压在 top:0）
    const target = colHeights.indexOf(Math.min(...colHeights));
    card.style.top = colHeights[target] + 'px';
    card.style.left = target * (colWidth + gap) + 'px';
    colHeights[target] += heights[i] + gap;
  });
  const maxH = Math.max(...colHeights, 0);
  g.style.height = maxH ? maxH + 'px' : '';
  // sentinel（懒加载提示）贴在最长列底部之下
  const sentinel = g.querySelector(':scope > #formula-sentinel');
  if (sentinel) {
    sentinel.style.position = 'absolute';
    sentinel.style.top = maxH + 'px';
    sentinel.style.left = '0';
    sentinel.style.width = '100%';
  }
}

/** 防抖重排（resize / 字体载入后）：列数可能变，全量重排。 */
function _scheduleFormulaMasonryRelayout() {
  if (_formulaResizeTimer) clearTimeout(_formulaResizeTimer);
  _formulaResizeTimer = setTimeout(() => { _formulaResizeTimer = null; _layoutFormulaMasonry(false); }, 120);
}

/** 渲染 count 张卡（从 _formulaShown 开始追加），插 sentinel 并挂/复用 IntersectionObserver。
 *  无 IntersectionObserver（jsdom/老浏览器）时一次性渲染全部。
 *  渲染后**同步**跑瀑布流定位（KaTeX 本就同步渲染，卡高立即可测）——历史实现用双 rAF 延迟定位，
 *  新批次卡在定位前以「在流、全宽、相对定位」刷出来，慢机器/重负载下 rAF 排队时用户会看到
 *  整段列表态（v3.15 懒加载塌列的根因之一）；同步定位后不再有在流瞬态。
 *  字体/KaTeX 字体异步回流可能导致卡高后变化，再补一次 rAF 校正 + resize/RO 兜底。 */
function _renderFormulaBatch(count) {
  const g = $('formulas-grid');
  if (!g || !_formulaList.length) return;
  const layout = _formulaLayout;
  const total = _formulaList.length;
  const end = Math.min(_formulaShown + count, total);
  if (end <= _formulaShown) return;
  const frag = document.createDocumentFragment();
  const built = [];
  for (let i = _formulaShown; i < end; i++) {
    // 单卡构建异常（极端 LaTeX/Markdown）不得中断整批——否则 observer 反复重试同一批，定位永远不跑
    try {
      const card = _buildFormulaCard(_formulaList[i], layout);
      frag.appendChild(card);
      built.push(card);
    } catch (e) {
    }
  }
  // 移除旧 sentinel（若有）再追加新批次
  const oldSentinel = g.querySelector('#formula-sentinel');
  if (oldSentinel) oldSentinel.remove();
  g.appendChild(frag);
  // 解读截断检测在挂载后跑（detached 时 scrollHeight 恒 0，见 _wireDescClamp 注释）
  for (const c of built) _wireDescClamp(c.querySelector('.fc-desc'));
  _formulaShown = end;
  if (_formulaShown < total) {
    // 还有未渲染 → 插 sentinel 并 observe（旧 sentinel 已在上面移除，新批次会重新 observe）
    const sentinel = document.createElement('div');
    sentinel.id = 'formula-sentinel';
    sentinel.className = 'lazy-sentinel';
    sentinel.textContent = `已加载 ${_formulaShown}/${total}，滚动加载更多…`;
    g.appendChild(sentinel);
    _observeFormulaSentinel(sentinel);
  }
  // 瀑布流定位：同步定位（消除在流瞬态）；list 布局不动
  if (layout === 'masonry') {
    // wire resize 一次性（监听窗口/侧栏宽度变化）
    if (!_formulaResizeWired) {
      _formulaResizeWired = true;
      window.addEventListener('resize', () => { _scheduleFormulaMasonryRelayout(); }, { passive: true });
    }
    // ResizeObserver 盯 grid 本体宽度（v3.14 加固）：window resize 覆盖不到的场景——
    // 侧栏收起/展开、浏览器窗口从窄恢复、DevTools 开合、缩放变化——都曾导致瀑布流按
    // 旧窄宽度算成单列后无人纠正（懒加载新批次沿用错误列数，看起来像「列表」）。
    // 只认宽度变化（高度变化是重排的结果而非原因，过滤掉防反馈循环）。
    if (typeof ResizeObserver !== 'undefined' && !_formulaGridRO) {
      _formulaGridROW = g.clientWidth || 0;
      _formulaGridRO = new ResizeObserver(() => {
        const w = g.clientWidth || 0;
        if (w && Math.abs(w - _formulaGridROW) > 1) {
          _formulaGridROW = w;
          _scheduleFormulaMasonryRelayout();
        }
      });
      _formulaGridRO.observe(g);
    }
    _layoutFormulaMasonry(false);
    // 字体/KaTeX 字体异步回流后的校正（只重算高度，列宽不变）
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => { _layoutFormulaMasonry(true); }));
    }
    // KaTeX 的 woff2 首次加载可能晚于上面的双 rAF——字体到位后公式块高度微变，
    // 卡片会长过布局时测得的高、压到下方的卡（「文字和符号表重叠」的根因）。
    // document.fonts.ready 只挂一次，幂等重排。
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready && !_formulaFontsWired) {
      _formulaFontsWired = true;
      document.fonts.ready.then(() => { _scheduleFormulaMasonryRelayout(); }).catch(() => {});
    }
  }
}

/** 让 observer 观察 sentinel。无 IntersectionObserver（jsdom/老浏览器）时一次性渲染剩余全部。 */
function _observeFormulaSentinel(sentinel) {
  if (typeof IntersectionObserver === 'undefined') {
    // jsdom/老浏览器无此 API：一次性渲染剩余全部（兼容；数据量小或测试场景）
    if (_formulaShown < _formulaList.length) _renderFormulaBatch(_formulaList.length - _formulaShown);
    return;
  }
  // 复用 observer（root=滚动容器 #formulas-view 不变）；建一次后只对新 sentinel observe
  if (!_formulaObserver) {
    const root = $('formulas-view');
    _formulaObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && _formulaShown < _formulaList.length) {
            _renderFormulaBatch(_FORMULA_NEXT_BATCH);
          }
        }
      },
      { root, rootMargin: '300px 0px', threshold: 0 },
    );
  }
  _formulaObserver.observe(sentinel);
}

/** grid 级事件委托（一次性 dataset.wired 守卫）：懒加载追加批次无需重复绑。
 *  data-goto→跳转论文；data-copy→复制 LaTeX；data-cdopen→打开概念详情抽屉；
 *  data-del→删除（局部更新，免重拉）；data-edit→编辑。 */
function _wireFormulaGridOnce(g) {
  if (g.dataset.wired) return;
  g.dataset.wired = '1';
  g.addEventListener('click', async (e) => {
    // 星标切换（v3.30）：就地翻转 + 侧栏计数联动（多选模式下让位给选中）
    const starBtn = e.target.closest('[data-star]');
    if (starBtn && !_formulaPickMode) {
      const f = state.formulas.find((x) => x.id === starBtn.dataset.star);
      if (!f) return;
      const next = !f.starred;
      const r = await PATCH('/api/formulas/' + f.id, { starred: next });
      if (r && r.ok) {
        f.starred = next;
        starBtn.classList.toggle('is-starred', next);
        starBtn.title = next ? '取消重点' : '标记为重点';
        starBtn.setAttribute('aria-pressed', String(next));
        renderFormulaSidebar();
      } else toast((r && r.error) || '操作失败', 'error');
      return;
    }
    // 多选模式优先（v3.29）：点卡片=切换选中，其余动作让位
    if (_formulaPickMode) {
      const pickCard = e.target.closest('.formula-card');
      if (pickCard && pickCard.dataset.fid) {
        e.preventDefault();
        _toggleFormulaPick(pickCard.dataset.fid, pickCard);
        return;
      }
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) { gotoPaper(goto.dataset.goto); return; }
    // 复制 LaTeX（$…$ 包裹，可直接粘进 Markdown 笔记 / 聊天输入框）
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const f = state.formulas.find((x) => x.id === copy.dataset.copy);
      if (!f) return;
      const text = '$' + (f.latex || '') + '$';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        toast('已复制 LaTeX（$…$ 包裹）');
      } catch {
        toast('复制失败——请手动选择公式复制', 'error');
      }
      return;
    }
    // 相关概念 → 概念详情抽屉（跨页知识联动入口）
    const cd = e.target.closest('[data-cdopen]');
    if (cd) { openConceptDetail(cd.dataset.cdopen); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const f = state.formulas.find((x) => x.id === del.dataset.del);
      const name = f ? f.name : del.dataset.del;
      if (!(await PWDialog.confirm(`删除公式「${name}」？`, { title: '删除公式', danger: true, okText: '删除' }))) return;
      const r = await DEL('/api/formulas/' + del.dataset.del);
      if (r.ok) {
        toast('公式已删除');
        // 局部更新：从 state.formulas 删除该条后重渲（免 showFormulas 重拉全量）
        state.formulas = (state.formulas || []).filter((x) => x.id !== del.dataset.del);
        renderFormulaSidebar();
        renderFormulas();
      } else toast(r.error || '删除失败', 'error');
      return;
    }
    // 编辑 → 全字段编辑抽屉（v3.29：LaTeX 预览/解读/符号表/绘图/概念关联）
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const f = state.formulas.find((x) => x.id === edit.dataset.edit);
      if (f) openFormulaEditor(f);
      return;
    }
    // 「+N」标签 → 预览浮窗看全量出处（v3.52）
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { openFormulaDetail(openBtn.dataset.open); return; }
    // 点卡片 → 预览浮窗（v3.52：卡片只扫一眼，深读交给浮窗）。
    // 选区内不导航（拖选解读文字的 mouseup 会紧跟 click）——与论文列表同守卫。
    const card = e.target.closest('.formula-card');
    if (card && card.dataset.fid) {
      if (selectionWithin(card)) return;
      openFormulaDetail(card.dataset.fid);
    }
  });
}

/** 字母索引条：列出 A-Z + 中文首字（按拼音），点击滚动到对应字母段。仅字母排序 + 无搜索词时显示。 */
export function renderConceptAlphaBar(sort, q, list) {
  const bar = $('concepts-alpha-bar');
  if (!bar) return;
  if (sort !== 'alpha' || q) { bar.hidden = true; return; }
  // 收集所有首字符（英文取大写字母，中文原样）
  const heads = new Set();
  for (const c of list) {
    const t = String(c.term || '').trim();
    if (!t) continue;
    const ch = t[0].toUpperCase();
    heads.add(ch);
  }
  // 英文字母 A-Z（存在的点亮，不存在的灰）
  const links = [];
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    const has = heads.has(L);
    links.push(`<a href="#concept-${L}" class="${has ? '' : 'off'}" data-letter="${L}">${L}</a>`);
  }
  // 中文首字单独列（#分隔后）
  const cjkHeads = [...heads].filter((h) => /[^A-Z]/.test(h)).sort();
  if (cjkHeads.length) {
    links.push('<span class="concepts-alpha-sep"></span>');
    for (const h of cjkHeads.slice(0, 30)) links.push(`<a href="#concept-${encodeURIComponent(h)}" data-letter="${encodeURIComponent(h)}">${escapeHtml(h)}</a>`);
  }
  bar.innerHTML = links.join('');
  bar.hidden = false;
  // 点击：滚动到第一个 term 以该字母开头的卡片
  bar.querySelectorAll('a:not(.off)').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const letter = decodeURIComponent(a.dataset.letter);
      const target = [...document.querySelectorAll('#concepts-grid .concept-card h3')].find((h) => h.textContent.trim().toUpperCase().startsWith(letter));
      if (target) {
        const card = target.closest('.concept-card');
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card.style.transition = 'background .12s ease';
        card.style.background = 'var(--accent-soft)';
        setTimeout(() => { card.style.background = ''; }, 800);
      }
    };
  });
}

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_formulaSort(v) {
  _formulaSort = v;
}
export function set_formulaLayout(v) {
  _formulaLayout = v;
}
