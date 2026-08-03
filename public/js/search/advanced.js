// 高级搜索面板（DSL 双向同步）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { select } from '../detail/detail.js';
import { triggerSearch, updateSearchModeIndicator } from '../library/list.js';
import { positionSavedSearches, saveCurrentSearch } from './saved.js';

/** 高级面板状态（与 DSL 双向同步）。null = 未渲染。 */
let _advPanel = null;

/** 是否正在程序化同步（避免循环：面板改 → DSL → 面板回填）。 */
let _advSyncing = false;

/** 渲染高级搜索面板到 #advanced-search。仅渲染一次（hidden 切换显隐）。 */
function ensureAdvancedPanel() {
  const root = $('advanced-search');
  if (!root || _advPanel) return root;
  root.innerHTML = `
    <div class="sf-grid">
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
      </div>
    </div>
    <div class="sf-footer">
      <button class="btn ghost sm" id="sf-clear" type="button">清空</button>
      <button class="btn ghost sm" id="sf-save" type="button">保存为预设…</button>
      <span class="sf-spacer"></span>
      <span class="sf-dsl-preview" id="sf-dsl-preview" title="等效查询语法"></span>
      <button class="btn sm" id="sf-search" type="button">搜索</button>
    </div>`;
  _advPanel = {
    title: $('sf-title'), author: $('sf-author'), abstract: $('sf-abstract'), summary: $('sf-summary'),
    yearFrom: $('sf-year-from'), yearTo: $('sf-year-to'), status: $('sf-status'), read: $('sf-read'),
    tagsRow: $('sf-tags-row'), tagInput: $('sf-tag-input'),
    topicsRow: $('sf-topics-row'), topicInput: $('sf-topic-input'),
    text: $('sf-text'), scopeBody: document.querySelector('input[name="sf-scope"][value="body"]'),
    bodyText: $('sf-body-text'), starred: $('sf-starred'), hasNotes: $('sf-has-notes'),
    preview: $('sf-dsl-preview'),
  };
  // 字段变化 → 生成 DSL → 回填搜索框 → 触发搜索
  const onChange = () => {
    if (_advSyncing) return;
    const dsl = dslFromPanelInputs();
    _advPanel.preview.textContent = dsl || '（无筛选）';
    syncSearchBoxFromPanel(dsl);
  };
  [_advPanel.title, _advPanel.author, _advPanel.abstract, _advPanel.summary, _advPanel.yearFrom, _advPanel.yearTo, _advPanel.text, _advPanel.bodyText].forEach((el) => { if (el) el.addEventListener('input', onChange); });
  [_advPanel.status, _advPanel.read].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  [_advPanel.starred, _advPanel.hasNotes].forEach((el) => { if (el) el.addEventListener('change', onChange); });
  document.querySelectorAll('input[name="sf-scope"]').forEach((r) => r.addEventListener('change', () => { _advPanel.bodyText.disabled = !_advPanel.scopeBody.checked; onChange(); }));
  // 标签/主题 chip 输入（回车添加）
  const wireChipInput = (input, getArr, setArr, row) => {
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return;
        const arr = getArr();
        if (!arr.includes(v)) { arr.push(v); setArr(arr); renderAdvChips(row, arr, setArr); onChange(); }
        input.value = '';
      }
    });
  };
  let _tags = [], _topics = [];
  const getTags = () => _tags, setTags = (a) => { _tags = a; };
  const getTopics = () => _topics, setTopics = (a) => { _topics = a; };
  wireChipInput(_advPanel.tagInput, getTags, setTags, _advPanel.tagsRow);
  wireChipInput(_advPanel.topicInput, getTopics, setTopics, _advPanel.topicsRow);
  _advPanel._tags = () => _tags; _advPanel._setTags = (a) => { _tags = a.slice(); renderAdvChips(_advPanel.tagsRow, _tags, setTags); };
  _advPanel._topics = () => _topics; _advPanel._setTopics = (a) => { _topics = a.slice(); renderAdvChips(_advPanel.topicsRow, _topics, setTopics); };
  // 底部按钮
  $('sf-clear').onclick = () => clearAdvancedPanel();
  $('sf-search').onclick = () => { triggerSearch($('search').value, { immediate: true }); toggleAdvancedPanel(false); };
  $('sf-save').onclick = () => saveCurrentSearch();
  return root;
}

/** 渲染可移除 chip 行。 */
function renderAdvChips(row, arr, setArr) {
  if (!row) return;
  row.innerHTML = arr.map((v, i) => `<span class="sf-chip">${escapeHtml(v)}<button class="sf-chip-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`).join('');
  row.querySelectorAll('.sf-chip-x').forEach((b) => {
    b.onclick = () => { const i = Number(b.dataset.i); arr.splice(i, 1); setArr(arr); renderAdvChips(row, arr, setArr); syncSearchBoxFromPanel(dslFromPanelInputs()); };
  });
}

/** 从面板输入读出 panelState（供 buildDslFromPanel）。 */
function panelStateFromInputs() {
  const p = _advPanel; if (!p) return {};
  return {
    title: p.title.value, author: p.author.value, abstract: p.abstract.value, summary: p.summary.value,
    notes: p.hasNotes.checked ? '.' : '',
    tags: p._tags(), excludeTags: [], topics: p._topics(), excludeTopics: [],
    yearFrom: p.yearFrom.value, yearTo: p.yearTo.value,
    status: p.status.value, readStatus: p.read.value,
    starred: p.starred.checked, hasNotes: p.hasNotes.checked,
    scope: p.scopeBody.checked ? 'body' : 'metadata', bodyText: p.bodyText.value,
    text: p.text.value,
  };
}

function dslFromPanelInputs() {
  const S = window.PaperWikiSearch;
  if (!S) return '';
  return S.buildDslFromPanel(panelStateFromInputs());
}

/** 面板字段 → 搜索框（单向：面板改 → 搜索框 + 触发搜索）。 */
function syncSearchBoxFromPanel(dsl) {
  const inp = $('search'); if (!inp) return;
  inp.value = dsl;
  state.filter.q = dsl;
  updateSearchModeIndicator(dsl);
  // 防抖触发
  if (inp._advTimer) clearTimeout(inp._advTimer);
  inp._advTimer = setTimeout(() => triggerSearch(dsl), 200);
}

/** 搜索框 DSL → 面板回填（parseToPanel）。 */
export function syncAdvancedPanelFromDsl(dsl) {
  const S = window.PaperWikiSearch;
  if (!S || !_advPanel) return;
  _advSyncing = true;
  try {
    const panel = S.parseToPanel(dsl);
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
    _advPanel.preview.textContent = dsl || '（无筛选）';
  } finally { _advSyncing = false; }
}

function clearAdvancedPanel() {
  if (!_advPanel) return;
  _advPanel.title.value = ''; _advPanel.author.value = ''; _advPanel.abstract.value = ''; _advPanel.summary.value = '';
  _advPanel.yearFrom.value = ''; _advPanel.yearTo.value = ''; _advPanel.status.value = ''; _advPanel.read.value = '';
  _advPanel._setTags([]); _advPanel._setTopics([]);
  _advPanel.text.value = ''; _advPanel.starred.checked = false; _advPanel.hasNotes.checked = false;
  _advPanel.bodyText.value = '';
  const meta = document.querySelector('input[name="sf-scope"][value="metadata"]'); if (meta) meta.checked = true;
  _advPanel.bodyText.disabled = true;
  _advPanel.preview.textContent = '（无筛选）';
  syncSearchBoxFromPanel('');
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
    // 面板打开后让保存的搜索行让位下移
    setTimeout(positionSavedSearches, 0);
  } else {
    // 关闭后保存的搜索行回到原位
    setTimeout(positionSavedSearches, 0);
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
