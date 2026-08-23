// 高级搜索面板（DSL 双向同步）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。
// v3.20：按 currentView() 渲染不同字段集——论文页走后端 DSL，概念/公式页走前端客户端过滤
// （数据全量在内存，无需调后端，面板改 → 写搜索框 DSL → renderConcepts/renderFormulas）。

import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { select } from '../detail/detail.js';
import { triggerSearch, updateSearchModeIndicator } from '../library/list.js';
import { renderConcepts } from '../concepts/concepts.js';
import { renderFormulas } from '../formulas/formulas.js';
import { currentView } from '../views/view-switch.js';
import { positionSavedSearches, saveCurrentSearch } from './saved.js';

/** 高级面板状态（与 DSL 双向同步）。null = 未渲染。 */
let _advPanel = null;

/** 当前面板渲染的视图（切换视图时需重渲字段集）。null = 未渲染过。 */
let _advView = null;

/** 是否正在程序化同步（避免循环：面板改 → DSL → 面板回填）。 */
let _advSyncing = false;

/** 写搜索框 DSL 并按视图触发对应渲染。
 *  论文页：triggerSearch（后端 /api/papers?q= 或 /api/search）。
 *  概念/公式页：直接 renderConcepts/renderFormulas（客户端内存过滤，不调后端）。
 *  侧栏分类 active 态由各自的 renderConceptSidebar/renderFormulaSidebar 读 DSL 派生，
 *  故这里只触发 renderConcepts/renderFormulas（它们内部不重渲侧栏——侧栏是独立调用点）。
 *  概念/公式页的侧栏 active 由 nav.js 路由 enter 或用户点击分类时单独同步。 */
function applyDslFromPanel(dsl) {
  const inp = $('search'); if (!inp) return;
  inp.value = dsl;
  const view = currentView();
  if (view === 'concepts') {
    if (inp._advTimer) clearTimeout(inp._advTimer);
    inp._advTimer = setTimeout(() => renderConcepts(), 200);
  } else if (view === 'formulas') {
    if (inp._advTimer) clearTimeout(inp._advTimer);
    inp._advTimer = setTimeout(() => renderFormulas(), 200);
  } else {
    state.filter.q = dsl;
    updateSearchModeIndicator(dsl);
    if (inp._advTimer) clearTimeout(inp._advTimer);
    inp._advTimer = setTimeout(() => triggerSearch(dsl), 200);
  }
}

/** 渲染高级搜索面板外壳到 #advanced-search（仅一次），字段集按视图动态填充。 */
function ensureAdvancedPanel() {
  const root = $('advanced-search');
  if (!root) return root;
  if (!_advPanel) {
    // 外壳：grid 容器 + footer（footer 按视图显隐「保存为预设」）
    root.innerHTML = `<div class="sf-grid" id="sf-grid"></div>
      <div class="sf-footer">
        <button class="btn ghost sm" id="sf-clear" type="button">清空</button>
        <button class="btn ghost sm" id="sf-save" type="button">保存为预设…</button>
        <span class="sf-spacer"></span>
        <span class="sf-dsl-preview" id="sf-dsl-preview" title="等效查询语法"></span>
        <button class="btn sm" id="sf-search" type="button">搜索</button>
      </div>`;
    _advPanel = { preview: $('sf-dsl-preview') };
  }
  // 按当前视图（重）渲染字段集
  const view = currentView();
  if (_advView !== view) {
    if (view === 'concepts') renderConceptFields();
    else if (view === 'formulas') renderFormulaFields();
    else renderLibraryFields();
    _advView = view;
  }
  // footer「保存为预设」仅论文页有（保存的搜索是论文库功能）
  const saveBtn = $('sf-save');
  if (saveBtn) saveBtn.style.display = view === 'library' ? '' : 'none';
  return root;
}

/** 论文页字段集（v3.2 原有字段，从原 ensureAdvancedPanel 迁移）。 */
function renderLibraryFields() {
  $('sf-grid').innerHTML = `
    <label class="sf-field sf-full"><span>关键词</span><input type="text" id="sf-text" autocomplete="off" placeholder="同时搜标题 / 摘要 / 总结 / 笔记，多个词需同时命中"></label>
    <label class="sf-field"><span>标题</span><input type="text" id="sf-title" autocomplete="off" placeholder="标题中包含…"></label>
    <label class="sf-field"><span>作者</span><input type="text" id="sf-author" autocomplete="off" placeholder="作者名包含…"></label>
    <label class="sf-field sf-year"><span>年份</span>
      <div class="sf-year-row">
        <input type="number" id="sf-year-from" autocomplete="off" placeholder="起" min="1900" max="2099">
        <span class="sf-dash">–</span>
        <input type="number" id="sf-year-to" autocomplete="off" placeholder="止" min="1900" max="2099">
      </div>
    </label>
    <label class="sf-field sf-tags"><span>标签</span><div class="sf-chips" id="sf-tags-row"></div><input type="text" id="sf-tag-input" autocomplete="off" placeholder="输入后回车添加"></label>
    <label class="sf-field sf-tags"><span>主题</span><div class="sf-chips" id="sf-topics-row"></div><input type="text" id="sf-topic-input" autocomplete="off" placeholder="输入后回车添加"></label>
    <label class="sf-field"><span>处理状态</span>
      <select id="sf-status"><option value="">不限</option><option value="ready">已就绪</option><option value="error">出错</option><option value="pending">处理中</option><option value="missing">缺失</option></select>
    </label>
    <label class="sf-field"><span>摘要</span><input type="text" id="sf-abstract" autocomplete="off" placeholder="摘要中包含…"></label>
    <label class="sf-field"><span>AI 总结</span><input type="text" id="sf-summary" autocomplete="off" placeholder="总结中包含…"></label>
    <label class="sf-field"><span>阅读状态</span>
      <select id="sf-read"><option value="">不限</option><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读</option></select>
    </label>
    <div class="sf-field sf-full sf-scope">
      <span>正文全文</span>
      <div class="sf-scope-row">
        <label class="sf-radio"><input type="radio" name="sf-scope" value="metadata" checked> 不搜正文</label>
        <label class="sf-radio"><input type="radio" name="sf-scope" value="body"> 搜正文</label>
        <input type="text" id="sf-body-text" autocomplete="off" placeholder="正文中包含的词（含高亮片段结果）" disabled>
      </div>
    </div>
    <div class="sf-full sf-checks">
      <label class="sf-check"><input type="checkbox" id="sf-starred"> 仅星标</label>
      <label class="sf-check"><input type="checkbox" id="sf-has-notes"> 仅含笔记</label>
    </div>`;
  Object.assign(_advPanel, {
    grid: $('sf-grid'),
    title: $('sf-title'), author: $('sf-author'), abstract: $('sf-abstract'), summary: $('sf-summary'),
    yearFrom: $('sf-year-from'), yearTo: $('sf-year-to'), status: $('sf-status'), read: $('sf-read'),
    tagsRow: $('sf-tags-row'), tagInput: $('sf-tag-input'),
    topicsRow: $('sf-topics-row'), topicInput: $('sf-topic-input'),
    text: $('sf-text'), scopeBody: document.querySelector('input[name="sf-scope"][value="body"]'),
    bodyText: $('sf-body-text'), starred: $('sf-starred'), hasNotes: $('sf-has-notes'),
  });
  wireLibraryFields();
}

/** 概念页字段集（v3.29 扩容）：关键词 + 分类 + 热度 + 核心度 + 最近新增 + 质量 + 出处。 */
function renderConceptFields() {
  $('sf-grid').innerHTML = `
    <label class="sf-field sf-full"><span>关键词</span><input type="text" id="sf-text" autocomplete="off" placeholder="术语、解释或出处中包含…（多个词需同时命中）"></label>
    <label class="sf-field sf-tags sf-full"><span>分类</span><div class="sf-chips" id="sf-cat-row"></div><input type="text" id="sf-cat-input" autocomplete="off" placeholder="输入分类名后回车添加（如 attention）"></label>
    <label class="sf-field"><span>热度</span>
      <select id="sf-freq"><option value="">全部</option><option value="hot">高频（≥4 篇）</option><option value="shared">多篇共享（≥2 篇）</option><option value="solo">仅单篇</option></select>
    </label>
    <label class="sf-field"><span>核心度</span>
      <select id="sf-importance"><option value="">不限</option><option value="core">核心创新</option><option value="supporting">支撑技术</option></select>
    </label>
    <label class="sf-field"><span>最近新增</span>
      <select id="sf-added"><option value="">不限</option><option value="7d">7 天内</option><option value="30d">30 天内</option></select>
    </label>
    <label class="sf-field"><span>质量</span>
      <select id="sf-quality"><option value="">不限</option><option value="nodef">缺解释</option></select>
    </label>
    <div class="sf-full sf-checks">
      <label class="sf-check"><input type="checkbox" id="sf-has-context"> 有章节出处</label>
    </div>`;
  Object.assign(_advPanel, {
    grid: $('sf-grid'),
    text: $('sf-text'),
    catRow: $('sf-cat-row'), catInput: $('sf-cat-input'),
    freq: $('sf-freq'), hasContext: $('sf-has-context'),
    importance: $('sf-importance'), added: $('sf-added'), quality: $('sf-quality'),
  });
  wireConceptFields();
}

/** 公式页字段集（v3.29 扩容）：关键词 + 分类 + 热度 + 来源 + 最近新增 + 质量 + 可绘图。 */
function renderFormulaFields() {
  $('sf-grid').innerHTML = `
    <label class="sf-field sf-full"><span>关键词</span><input type="text" id="sf-text" autocomplete="off" placeholder="公式名 / LaTeX / 解读中包含…"></label>
    <label class="sf-field sf-tags sf-full"><span>分类</span><div class="sf-chips" id="sf-cat-row"></div><input type="text" id="sf-cat-input" autocomplete="off" placeholder="输入分类名后回车添加（如 loss）"></label>
    <label class="sf-field"><span>热度</span>
      <select id="sf-freq"><option value="">全部</option><option value="hot">高频（≥4 篇）</option><option value="shared">多篇共享（≥2 篇）</option><option value="solo">仅单篇</option></select>
    </label>
    <label class="sf-field"><span>来源</span>
      <select id="sf-source"><option value="">全部</option><option value="ai">AI 抽取</option><option value="vision">阅读器框选</option><option value="mineru">MinerU</option><option value="manual">手动录入 / 人工修订</option></select>
    </label>
    <label class="sf-field"><span>最近新增</span>
      <select id="sf-added"><option value="">不限</option><option value="7d">7 天内</option><option value="30d">30 天内</option></select>
    </label>
    <label class="sf-field"><span>质量</span>
      <select id="sf-quality"><option value="">不限</option><option value="nodef">缺解读</option></select>
    </label>
    <div class="sf-full sf-checks">
      <label class="sf-check"><input type="checkbox" id="sf-plottable"> 仅可绘图</label>
    </div>`;
  Object.assign(_advPanel, {
    grid: $('sf-grid'),
    text: $('sf-text'),
    catRow: $('sf-cat-row'), catInput: $('sf-cat-input'),
    source: $('sf-source'), plottable: $('sf-plottable'),
    freq: $('sf-freq'), added: $('sf-added'), quality: $('sf-quality'),
  });
  wireFormulaFields();
}

/** 论文页字段事件接线（原 ensureAdvancedPanel 逻辑迁移）。 */
function wireLibraryFields() {
  const p = _advPanel;
  const onChange = () => {
    if (_advSyncing) return;
    const dsl = dslFromPanelInputs();
    p.preview.textContent = dsl || '（无筛选）';
    applyDslFromPanel(dsl);
  };
  [p.title, p.author, p.abstract, p.summary, p.yearFrom, p.yearTo, p.text, p.bodyText].forEach((el) => { if (el) el.addEventListener('input', onChange); });
  [p.status, p.read].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  [p.starred, p.hasNotes].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  document.querySelectorAll('input[name="sf-scope"]').forEach((r) => r.addEventListener('change', () => { p.bodyText.disabled = !p.scopeBody.checked; onChange(); }));
  let _tags = [], _topics = [];
  const getTags = () => _tags, setTags = (a) => { _tags = a; };
  const getTopics = () => _topics, setTopics = (a) => { _topics = a; };
  wireChipInput(p.tagInput, getTags, setTags, p.tagsRow, onChange);
  wireChipInput(p.topicInput, getTopics, setTopics, p.topicsRow, onChange);
  p._tags = () => _tags; p._setTags = (a) => { _tags = a.slice(); renderAdvChips(p.tagsRow, _tags, setTags); };
  p._topics = () => _topics; p._setTopics = (a) => { _topics = a.slice(); renderAdvChips(p.topicsRow, _topics, setTopics); };
  bindFooterButtons(onChange);
}

/** 概念页字段事件接线。 */
function wireConceptFields() {
  const p = _advPanel;
  const onChange = () => {
    if (_advSyncing) return;
    const dsl = dslFromPanelInputs();
    p.preview.textContent = dsl || '（无筛选）';
    applyDslFromPanel(dsl);
  };
  if (p.text) p.text.addEventListener('input', onChange);
  [p.freq, p.importance, p.added, p.quality].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  if (p.hasContext) p.hasContext.addEventListener('change', onChange);
  let _cats = [];
  const getCats = () => _cats, setCats = (a) => { _cats = a; };
  wireChipInput(p.catInput, getCats, setCats, p.catRow, onChange);
  p._cats = () => _cats; p._setCats = (a) => { _cats = a.slice(); renderAdvChips(p.catRow, _cats, setCats); };
  bindFooterButtons(onChange);
}

/** 公式页字段事件接线。 */
function wireFormulaFields() {
  const p = _advPanel;
  const onChange = () => {
    if (_advSyncing) return;
    const dsl = dslFromPanelInputs();
    p.preview.textContent = dsl || '（无筛选）';
    applyDslFromPanel(dsl);
  };
  if (p.text) p.text.addEventListener('input', onChange);
  [p.source, p.freq, p.added, p.quality].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  if (p.plottable) p.plottable.addEventListener('change', onChange);
  let _cats = [];
  const getCats = () => _cats, setCats = (a) => { _cats = a; };
  wireChipInput(p.catInput, getCats, setCats, p.catRow, onChange);
  p._cats = () => _cats; p._setCats = (a) => { _cats = a.slice(); renderAdvChips(p.catRow, _cats, setCats); };
  bindFooterButtons(onChange);
}

/** 底部按钮接线：清空（按视图）、搜索（关闭面板+立即应用）、保存（仅论文页）。 */
function bindFooterButtons(onChange) {
  const clearBtn = $('sf-clear');
  const searchBtn = $('sf-search');
  const saveBtn = $('sf-save');
  if (clearBtn) clearBtn.onclick = () => { clearAdvancedPanel(); onChange && onChange(); };
  if (searchBtn) searchBtn.onclick = () => {
    const v = $('search').value;
    const view = currentView();
    if (view === 'concepts') renderConcepts();
    else if (view === 'formulas') renderFormulas();
    else triggerSearch(v, { immediate: true });
    toggleAdvancedPanel(false);
  };
  if (saveBtn) saveBtn.onclick = () => saveCurrentSearch();
}

/** chip 输入接线（回车/逗号添加）。onChange 用于添加后触发同步。 */
function wireChipInput(input, getArr, setArr, row, onChange) {
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      const arr = getArr();
      if (!arr.includes(v)) { arr.push(v); setArr(arr); renderAdvChips(row, arr, setArr); onChange && onChange(); }
      input.value = '';
    }
  });
}

/** 渲染可移除 chip 行。onChange 用于移除后触发同步（缺省回退到 applyDslFromPanel）。 */
function renderAdvChips(row, arr, setArr, onChange) {
  if (!row) return;
  row.innerHTML = arr.map((v, i) => `<span class="sf-chip">${escapeHtml(v)}<button class="sf-chip-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`).join('');
  row.querySelectorAll('.sf-chip-x').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.i); arr.splice(i, 1); setArr(arr); renderAdvChips(row, arr, setArr, onChange);
      const dsl = dslFromPanelInputs();
      _advPanel.preview.textContent = dsl || '（无筛选）';
      applyDslFromPanel(dsl);
    };
  });
}

/** 从面板输入读出 panelState（供 buildDslFromPanel）。按当前视图读对应字段。 */
function panelStateFromInputs() {
  const p = _advPanel; if (!p) return {};
  const view = currentView();
  if (view === 'concepts') {
    return {
      text: p.text ? p.text.value : '',
      categories: p._cats ? p._cats() : [], excludeCategories: [],
      freq: p.freq ? p.freq.value : '', hasContext: p.hasContext ? p.hasContext.checked : false,
      importance: p.importance ? p.importance.value : '',
      added: p.added ? p.added.value : '',
      quality: p.quality ? p.quality.value : '',
    };
  }
  if (view === 'formulas') {
    return {
      text: p.text ? p.text.value : '',
      categories: p._cats ? p._cats() : [], excludeCategories: [],
      source: p.source ? p.source.value : '', plottable: p.plottable ? p.plottable.checked : false,
      freq: p.freq ? p.freq.value : '',
      added: p.added ? p.added.value : '',
      quality: p.quality ? p.quality.value : '',
    };
  }
  // 论文页（字段判空防御：视图刚切换、字段集还没按 library 重渲的窗口期内不抛 TypeError）
  return {
    title: p.title ? p.title.value : '', author: p.author ? p.author.value : '',
    abstract: p.abstract ? p.abstract.value : '', summary: p.summary ? p.summary.value : '',
    notes: p.hasNotes && p.hasNotes.checked ? '.' : '',
    tags: p._tags ? p._tags() : [], excludeTags: [], topics: p._topics ? p._topics() : [], excludeTopics: [],
    yearFrom: p.yearFrom ? p.yearFrom.value : '', yearTo: p.yearTo ? p.yearTo.value : '',
    status: p.status ? p.status.value : '', readStatus: p.read ? p.read.value : '',
    starred: !!(p.starred && p.starred.checked), hasNotes: !!(p.hasNotes && p.hasNotes.checked),
    scope: p.scopeBody && p.scopeBody.checked ? 'body' : 'metadata', bodyText: p.bodyText ? p.bodyText.value : '',
    text: p.text ? p.text.value : '',
  };
}

function dslFromPanelInputs() {
  const S = window.PaperWikiSearch;
  if (!S) return '';
  return S.buildDslFromPanel(panelStateFromInputs());
}

/** 搜索框 DSL → 面板回填（parseToPanel）。按视图回填对应字段。
 *  仅论文页在 oninput 时调（DSL 实时镜像面板）；概念/公式页在面板打开时调一次。 */
export function syncAdvancedPanelFromDsl(dsl) {
  const S = window.PaperWikiSearch;
  if (!S || !_advPanel) return;
  // 字段集可能还是上一个视图的（在概念/公式页开过面板，切回论文页后视图切换只隐藏面板、
  // 不重置 _advPanel/_advView）：先按当前视图重渲，否则下方 library 分支读 _advPanel.title
  // 等直接 TypeError，且异常会打断 bind.js 的 oninput 链——搜索框打字完全无反应。
  if (_advView !== currentView()) ensureAdvancedPanel();
  _advSyncing = true;
  try {
    const panel = S.parseToPanel(dsl);
    const view = currentView();
    if (view === 'concepts') {
      if (_advPanel.text) _advPanel.text.value = panel.text || '';
      if (_advPanel._setCats) _advPanel._setCats(panel.categories || []);
      if (_advPanel.freq) _advPanel.freq.value = panel.freq || '';
      if (_advPanel.hasContext) _advPanel.hasContext.checked = !!panel.hasContext;
      if (_advPanel.importance) _advPanel.importance.value = panel.importance || '';
      if (_advPanel.added) _advPanel.added.value = panel.added || '';
      if (_advPanel.quality) _advPanel.quality.value = panel.quality || '';
    } else if (view === 'formulas') {
      if (_advPanel.text) _advPanel.text.value = panel.text || '';
      if (_advPanel._setCats) _advPanel._setCats(panel.categories || []);
      if (_advPanel.source) _advPanel.source.value = panel.source || '';
      if (_advPanel.plottable) _advPanel.plottable.checked = !!panel.plottable;
      if (_advPanel.freq) _advPanel.freq.value = panel.freq || '';
      if (_advPanel.added) _advPanel.added.value = panel.added || '';
      if (_advPanel.quality) _advPanel.quality.value = panel.quality || '';
    } else {
      _advPanel.title.value = panel.title || '';
      _advPanel.author.value = panel.author || '';
      _advPanel.abstract.value = panel.abstract || '';
      _advPanel.summary.value = panel.summary || '';
      _advPanel.yearFrom.value = panel.yearFrom || '';
      _advPanel.yearTo.value = panel.yearTo || '';
      _advPanel.status.value = panel.status || '';
      _advPanel.read.value = panel.readStatus || '';
      _advPanel._setTags(panel.tags || []);
      _advPanel._setTopics(panel.topics || []);
      _advPanel.text.value = panel.text || '';
      _advPanel.starred.checked = !!panel.starred;
      _advPanel.hasNotes.checked = !!panel.hasNotes;
      const bodyRadio = document.querySelector('input[name="sf-scope"][value="' + panel.scope + '"]');
      if (bodyRadio) bodyRadio.checked = true;
      _advPanel.bodyText.value = panel.bodyText || '';
      _advPanel.bodyText.disabled = panel.scope !== 'body';
    }
    _advPanel.preview.textContent = dsl || '（无筛选）';
  } finally { _advSyncing = false; }
}

/** 清空面板（按视图）。 */
function clearAdvancedPanel() {
  if (!_advPanel) return;
  const view = currentView();
  if (view === 'concepts') {
    if (_advPanel.text) _advPanel.text.value = '';
    if (_advPanel._setCats) _advPanel._setCats([]);
    if (_advPanel.freq) _advPanel.freq.value = '';
    if (_advPanel.hasContext) _advPanel.hasContext.checked = false;
    if (_advPanel.importance) _advPanel.importance.value = '';
    if (_advPanel.added) _advPanel.added.value = '';
    if (_advPanel.quality) _advPanel.quality.value = '';
  } else if (view === 'formulas') {
    if (_advPanel.text) _advPanel.text.value = '';
    if (_advPanel._setCats) _advPanel._setCats([]);
    if (_advPanel.source) _advPanel.source.value = '';
    if (_advPanel.plottable) _advPanel.plottable.checked = false;
    if (_advPanel.freq) _advPanel.freq.value = '';
    if (_advPanel.added) _advPanel.added.value = '';
    if (_advPanel.quality) _advPanel.quality.value = '';
  } else {
    _advPanel.title.value = ''; _advPanel.author.value = ''; _advPanel.abstract.value = ''; _advPanel.summary.value = '';
    _advPanel.yearFrom.value = ''; _advPanel.yearTo.value = ''; _advPanel.status.value = ''; _advPanel.read.value = '';
    _advPanel._setTags([]); _advPanel._setTopics([]);
    _advPanel.text.value = ''; _advPanel.starred.checked = false; _advPanel.hasNotes.checked = false;
    _advPanel.bodyText.value = '';
    const meta = document.querySelector('input[name="sf-scope"][value="metadata"]'); if (meta) meta.checked = true;
    _advPanel.bodyText.disabled = true;
  }
  _advPanel.preview.textContent = '（无筛选）';
  applyDslFromPanel('');
}

export function toggleAdvancedPanel(open) {
  const root = ensureAdvancedPanel();
  if (!root) return;
  const btn = $('search-advanced-toggle');
  const shouldOpen = open == null ? root.hidden : open;
  root.hidden = !shouldOpen;
  if (btn) { btn.setAttribute('aria-expanded', String(shouldOpen)); btn.classList.toggle('active', shouldOpen); }
  if (shouldOpen) {
    syncAdvancedPanelFromDsl($('search').value);
    positionAdvancedPanel();
    // 打开时挂滚动/缩放监听，关闭时摘除（避免泄漏）
    if (!_advReposition) {
      _advReposition = () => {
        if ($('advanced-search') && !$('advanced-search').hidden) positionAdvancedPanel();
        positionSavedSearches();
      };
      window.addEventListener('resize', _advReposition);
      window.addEventListener('scroll', _advReposition, true);
    }
    // 面板打开后让保存的搜索行让位下移（仅论文页有保存的搜索行）
    if (currentView() === 'library') setTimeout(positionSavedSearches, 0);
  } else {
    if (currentView() === 'library') setTimeout(positionSavedSearches, 0);
  }
}

let _advReposition = null;

/** 把高级面板定位到搜索框正下方（fixed 浮层，宽度对齐搜索框，不超过视口）。 */
function positionAdvancedPanel() {
  const root = $('advanced-search');
  const inp = $('search');
  if (!root || !inp || root.hidden) return;
  const r = inp.getBoundingClientRect();
  const gap = 6;
  const margin = 12; // 离视口左右边的最小留白
  const vw = window.innerWidth;
  // 宽度策略：
  //   - 窄视口（<720px）：面板铺满可用宽度（全宽，消除内部横向滚动）。
  //   - 宽视口：面板宽度 = max(搜索框宽+80, 620)，并设上限 880。下限 620 保证至少能排 3 列
  //     （每列 minmax 180px × 3 + gap ≈ 568px），避免宽屏下面板反窄于中屏。
  let panelW, left;
  if (vw < 720) {
    panelW = vw - margin * 2;     // 全宽减两边留白
    left = margin;
  } else {
    panelW = Math.max(620, Math.min(880, r.width + 80));
    left = Math.max(margin, Math.min(vw - panelW - margin, r.left));
  }
  // 列数切换：按面板实际宽度挂 .narrow（<400 单列）/ .medium（<560 两列）/ 默认三列。
  // 宽度档位与 CSS 断点必须一致，否则列数和字段布局会错位。
  root.classList.toggle('narrow', panelW < 400);
  root.classList.toggle('medium', panelW >= 400 && panelW < 560);
  let top = r.bottom + gap;
  // 下方空间不足 → 尝试放搜索框上方
  const estH = Math.min(640, window.innerHeight * 0.8);
  if (top + estH > window.innerHeight - 8) {
    const aboveTop = r.top - estH - gap;
    if (aboveTop > 8) top = aboveTop;
  }
  root.style.top = top + 'px';
  root.style.left = left + 'px';
  root.style.width = panelW + 'px';
}
