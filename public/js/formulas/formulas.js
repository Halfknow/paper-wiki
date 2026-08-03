// 公式清单（KaTeX / 瀑布流 / 懒加载）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { DEL, PATCH, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { renderMd } from '../core/markdown.js';
import { router } from '../core/nav.js';
import { buildPath } from '../core/router.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { showView } from '../views/view-switch.js';

// ---- 公式清单视图（v3.9）----
// 与概念清单同构：跨论文按 canonicalName 归并，卡片走 KaTeX display 渲染。
// 「归一化到一般形式」的展示落点在 occurrences[].symbolMap：清单页给一般形式，
// 展开某篇论文能看到「这篇里 d_k 写作 d」。
export async function showFormulas() {
  // state.papers 只由 refresh()（库视图 / 10s 轮询）填充——v3.15 深链 /formulas 时为空，
  // 卡片 occurrences 全解析不到 → 误显示「独立条目」（等 10s 轮询后渲染的批次才有论文，看起来像时好时坏）。
  // 这里直接补拉一次列表（不走 refresh()，避免 renderList/syncFilterToUrl 副作用污染公式页 URL）。
  const needPapers = !(state.papers || []).length;
  const [{ data }, pr] = await Promise.all([jget('/api/formulas'), needPapers ? jget('/api/papers') : null]);
  state.formulas = data || [];
  if (pr && Array.isArray(pr.data)) state.papers = pr.data;
  const dl = document.querySelector('a[href="/api/formulas.md"]');
  if (dl) dl.href = sp('/api/formulas.md');
  showView('formulas');
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

const VAR_ROLE_LABEL = { input: '输入', param: '参数', output: '输出', const: '常量' };

export function renderFormulas() {
  const q = ($('formula-q').value || '').trim().toLowerCase();
  const sort = _formulaSort;
  const layout = _formulaLayout;
  let list = (state.formulas || []).filter(
    (f) => !q || [f.name, f.canonicalName, f.latex, f.description, f.category].join(' ').toLowerCase().includes(q),
  );
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN-u-co-pinyin');
  if (sort === 'freq') {
    list = list.slice().sort((a, b) => (b.paperIds || []).length - (a.paperIds || []).length || byName(a, b));
  } else if (sort === 'category') {
    list = list.slice().sort((a, b) => String(a.category || '~').localeCompare(String(b.category || '~')) || byName(a, b));
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
    g.innerHTML =
      '<div class="empty-state">' +
      (q
        ? '没有匹配「' + escapeHtml(q) + '」的公式'
        : '无公式。在论文详情「信息」tab 点「重新抽取并追加」，或多选论文后批量抽取；也可在阅读器里框选公式区域补录。') +
      '</div>';
    return;
  }
  _formulaList = list;
  _formulaShown = 0;
  _renderFormulaBatch(_FORMULA_FIRST_BATCH);
}

/** 构造单张公式卡 DOM（masonry / list 两布局）。KaTeX 在此同步渲染（首批/每批 ≤60，可接受）。 */
function _buildFormulaCard(f, layout) {
  const card = document.createElement('div');
  card.className = 'formula-card';
  const freq = (f.paperIds || []).length;
  const occs = (f.occurrences || [])
    .map((o) => ({ o, p: state.papers.find((x) => x.id === o.paperId) }))
    .filter((x) => x.p);
  const chipsHtml = occs
    .map((x) => {
      const label = x.p.title || x.p.filename;
      const bits = [];
      if (x.o.context) bits.push(x.o.context);
      const map = Object.entries(x.o.symbolMap || {});
      if (map.length) bits.push('符号 ' + map.map(([k, v]) => `${k}→${v}`).join('、'));
      const tip = `打开「${label}」${bits.length ? '\n' + bits.join('；') : ''}`;
      return `<button class="paper-chip" data-goto="${x.o.paperId}" title="${escapeHtml(tip)}">${escapeHtml(label)}</button>`;
    })
    .join('');
  const metaHtml = occs.length ? `<span class="meta-label">出现于</span>${chipsHtml}` : '<span class="meta-label">（独立条目）</span>';

  if (layout === 'list') {
    card.innerHTML = `
      <span class="lc-freq ${freq > 1 ? '' : 'dim'}"${freq ? ` title="出现在 ${freq} 篇论文中"` : ''}>${freq || '·'}</span>
      <span class="lc-term" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="lc-formula">${renderKatex(f.latex, false)}</span>
      <span class="lc-count">${occs.length} 篇</span>
      <div class="row-actions">
        <button class="btn ghost sm" data-edit="${f.id}" title="编辑公式">编辑</button>
        <button class="btn ghost sm danger" data-del="${f.id}" title="删除公式">删除</button>
      </div>`;
  } else {
    const varsHtml = (f.variables || []).length
      ? `<details class="fc-vars"><summary>符号表（${f.variables.length}）</summary><table>${f.variables
          .map(
            (v) =>
              `<tr><td class="vs">${renderKatex(v.symbol, false)}</td><td>${escapeHtml(v.meaning || '')}</td><td class="vr">${VAR_ROLE_LABEL[v.role] || v.role}</td></tr>`,
          )
          .join('')}</table></details>`
      : '';
    card.innerHTML = `
      <div class="ct">
        <h3>${escapeHtml(f.name)}</h3>
        ${freq ? `<span class="freq-badge" data-freq="${freq}" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}
        <div class="row-actions">
          <button class="btn ghost sm" data-edit="${f.id}" title="编辑公式">编辑</button>
          <button class="btn ghost sm danger" data-del="${f.id}" title="删除公式">删除</button>
        </div>
      </div>
      <div class="fc-canon"><code>${escapeHtml(f.canonicalName)}</code>${f.category ? `<span class="fc-cat">${escapeHtml(f.category)}</span>` : ''}${f.source === 'vision' ? '<span class="fc-src" title="由阅读器框选补录">框选</span>' : ''}${f.source === 'mineru' ? '<span class="fc-src" title="由 MinerU 抽取">MinerU</span>' : ''}${f.source === 'manual' ? '<span class="fc-src" title="已人工修订">人工</span>' : ''}</div>
      <div class="fc-latex">${renderKatex(f.latex, true)}</div>
      ${f.description ? `<div class="fc-desc">${renderMd(f.description)}</div>` : '<div class="fc-desc muted">（无解读）</div>'}
      ${varsHtml}
      <div class="meta-line">${metaHtml}</div>`;
    // 符号表 <details> 展开/折叠会改变卡片高度 → 绝对定位瀑布流需重排（仅重算纵向，列宽不变）。
    // 注意 toggle 事件不冒泡（spec），不能靠 grid 级事件委托，必须直挂在 <details> 上。
    const det = card.querySelector('details.fc-vars');
    if (det) det.addEventListener('toggle', () => { if (_formulaLayout === 'masonry') _layoutFormulaMasonry(true); });
  }
  return card;
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
// TEMP-DEBUG：瀑布流懒加载塌列问题取证（定位后删除）
function _mdbg(ev, extra) {
  try {
    (window._masonryDebug = window._masonryDebug || []).push({
      t: Math.round(performance.now()), ev,
      w: ($('formulas-grid') || {}).clientWidth,
      view: ($('formulas-view') || {}).offsetWidth,
      ...extra,
    });
    if (window._masonryDebug.length > 200) window._masonryDebug.shift();
  } catch {}
}
function _layoutFormulaMasonry(reflowOnlyHeight) {
  const g = $('formulas-grid');
  if (!g || _formulaLayout !== 'masonry') { _mdbg('layout-skip', { layout: _formulaLayout }); return; }
  const cards = g.querySelectorAll(':scope > .formula-card');
  if (!cards.length) { g.classList.remove('js-masonry'); g.style.height = ''; _mdbg('layout-empty'); return; }
  const width = g.clientWidth;
  // 兜底：宽度测不到（jsdom / 不可见 / display:none）→ 不做绝对定位，回退 CSS grid
  if (!width || width < _FORMULA_MASONRY_MIN / 2) {
    _mdbg('layout-fallback', { width, cards: cards.length });
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
  _mdbg('layout-apply', { width, cols, cards: cards.length, reflow: !!reflowOnlyHeight });
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
  _formulaResizeTimer = setTimeout(() => { _formulaResizeTimer = null; _mdbg('debounce-run'); _layoutFormulaMasonry(false); }, 120);
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
  _mdbg('batch', { from: _formulaShown, to: end, total });
  const frag = document.createDocumentFragment();
  for (let i = _formulaShown; i < end; i++) {
    // 单卡构建异常（极端 LaTeX/Markdown）不得中断整批——否则 observer 反复重试同一批，定位永远不跑
    try {
      frag.appendChild(_buildFormulaCard(_formulaList[i], layout));
    } catch (e) {
      _mdbg('card-error', { i, msg: String((e && e.message) || e).slice(0, 120) });
    }
  }
  // 移除旧 sentinel（若有）再追加新批次
  const oldSentinel = g.querySelector('#formula-sentinel');
  if (oldSentinel) oldSentinel.remove();
  g.appendChild(frag);
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
      window.addEventListener('resize', () => { _mdbg('win-resize'); _scheduleFormulaMasonryRelayout(); }, { passive: true });
    }
    // ResizeObserver 盯 grid 本体宽度（v3.14 加固）：window resize 覆盖不到的场景——
    // 侧栏收起/展开、浏览器窗口从窄恢复、DevTools 开合、缩放变化——都曾导致瀑布流按
    // 旧窄宽度算成单列后无人纠正（懒加载新批次沿用错误列数，看起来像「列表」）。
    // 只认宽度变化（高度变化是重排的结果而非原因，过滤掉防反馈循环）。
    if (typeof ResizeObserver !== 'undefined' && !_formulaGridRO) {
      _formulaGridROW = g.clientWidth || 0;
      _formulaGridRO = new ResizeObserver(() => {
        const w = g.clientWidth || 0;
        _mdbg('ro-fire', { w, prev: _formulaGridROW });
        if (w && Math.abs(w - _formulaGridROW) > 1) {
          _formulaGridROW = w;
          _scheduleFormulaMasonryRelayout();
        }
      });
      _formulaGridRO.observe(g);
    }
    _mdbg('sync-run');
    _layoutFormulaMasonry(false);
    // 字体/KaTeX 字体异步回流后的校正（只重算高度，列宽不变）
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => { _mdbg('raf-recheck'); _layoutFormulaMasonry(true); }));
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
 *  data-goto→跳转论文；data-del→删除（局部更新，免重拉）；data-edit→编辑。 */
function _wireFormulaGridOnce(g) {
  if (g.dataset.wired) return;
  g.dataset.wired = '1';
  g.addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { gotoPaper(goto.dataset.goto); return; }
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
        renderFormulas();
      } else toast(r.error || '删除失败', 'error');
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const f = state.formulas.find((x) => x.id === edit.dataset.edit);
      if (f) await editFormula(f);
    }
  });
}

/** 编辑公式：两步 PWDialog（LaTeX → 解读）。canonicalName 是合并 key 不可改，故不提供入口。 */
async function editFormula(f) {
  const latex = await PWDialog.prompt(`编辑「${f.name}」的 LaTeX（一般形式，不含 $ 包裹）：`, {
    title: '编辑公式',
    value: f.latex || '',
    multiline: true,
    okText: '下一步',
  });
  if (latex == null) return;
  const description = await PWDialog.prompt(`编辑「${f.name}」的解读（支持 Markdown 与 $公式$）：`, {
    title: '编辑解读',
    value: f.description || '',
    multiline: true,
    okText: '保存',
  });
  if (description == null) return;
  const r = await PATCH('/api/formulas/' + f.id, { latex, description });
  if (r.ok) {
    toast('公式已更新');
    // 局部更新：PATCH 不返回新对象，用提交值就地改 state.formulas 后重渲（免 showFormulas 重拉全量）
    const idx = (state.formulas || []).findIndex((x) => x.id === f.id);
    if (idx >= 0) {
      state.formulas[idx] = { ...state.formulas[idx], latex, description, source: 'manual', updatedAt: Date.now() };
      renderFormulas();
    }
  } else toast(r.error || '保存失败', 'error');
}

/** 从概念清单跳转到论文：回论文库视图 → 选中（加载详情）→ 列表定位并高亮。
 *  论文被当前筛选/搜索排除时列表里没有对应项，仅打开详情，不报错。 */
export async function gotoPaper(id) {
  if (!id) return;
  await router.navigate(buildPath('/paper/:id', { id }));
  const el = document.querySelector('.paper-list .paper-item[data-id="' + CSS.escape(id) + '"]');
  if (el) {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1300);
  }
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
