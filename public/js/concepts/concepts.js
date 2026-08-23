// 概念清单与概念地图制品
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { DEL, PATCH, POST, PUT, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { openFormDialog } from '../core/form-dialog.js';
import { gotoPaper, router, syncPageQueryToUrl } from '../core/nav.js';
import { createPickBar } from '../core/pick-bar.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { renderConceptAlphaBar } from '../formulas/formulas.js';
import { setSidebarCollapsed } from '../views/layout.js';
import { showView } from '../views/view-switch.js';
import { openConceptDetail } from './detail-drawer.js';

// ---- 概念清单视图 ----
// 标题头 sticky 的滚动态（v3.36）：>4px 挂 .scrolled 驱动底边阴影；一次性接线
function _wireConceptHeadScrolled() {
  const v = $('concepts-view');
  if (!v || v.dataset.headWired) return;
  v.dataset.headWired = '1';
  v.addEventListener('scroll', () => v.classList.toggle('scrolled', v.scrollTop > 4), { passive: true });
}
export async function showConcepts(view) {
  // showView 必须先于所有 await（v3.17）：它排在三个网络请求之后时，深链 /concepts 刷新
  // 会先停在论文页几百毫秒再跳走。先切视图出骨架，数据到了再 render。
  showView('concepts');
  _wireConceptHeadScrolled();
  switchConceptView(view || _conceptView); // 路由指定的视图优先于 localStorage 记忆的上次选择

  // state.papers 只由 refresh()（库视图 / 10s 轮询）填充——v3.15 深链 /concepts 时为空，
  // 概念卡片 paperIds 全解析不到 → 误显示「独立条目」（同 formulas 的深链 bug，一并修）。
  // v3.28：详情抽屉的「相关公式」要 state.formulas（conceptTerms/名称匹配），缺则补拉一次
  //（公式页 showFormulas 对称地补拉 concepts——两页知识互为上下文）。
  // 深链首帧骨架（R2）：概念还没拉过时先出网格骨架，数据到达由 renderConcepts 覆盖
  if (!(state.concepts || []).length) {
    $('concepts-grid').innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="skel-kcard masonry-item" aria-hidden="true"><div class="skel skel-title" style="width:${58 + ((i * 13) % 30)}%"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-foot"></div></div>`).join('');
  }
  const needPapers = !(state.papers || []).length;
  const needFormulas = !(state.formulas || []).length;
  const [{ data }, pr, fr] = await Promise.all([
    jget('/api/concepts'),
    needPapers ? jget('/api/papers') : null,
    needFormulas ? jget('/api/formulas') : null,
  ]);
  state.concepts = data || [];
  if (pr && Array.isArray(pr.data)) state.papers = pr.data;
  if (fr && Array.isArray(fr.data)) state.formulas = fr.data;
  // 概念地图制品元信息（从 settings 回显，html 按需 GET 单个）
  try { const s = await jget('/api/settings'); state.conceptMaps = (s && s.data && s.data.conceptMaps) || []; } catch { state.conceptMaps = []; }
  renderConceptSidebar(); // 分类计数与地图制品数要等数据到位
  renderConcepts();
  if (_conceptView === 'maps') {
    renderConceptMaps(); // 首屏 switchConceptView 时制品元信息还没到，数据到位后补渲一次
    _syncConceptHead(_conceptView); // 制品计数此刻才准
  }
  // 有生成中的制品 → 继续轮询（比如上次生成中切走了页面，后台任务仍在跑）
  if ((state.conceptMaps || []).some((m) => m.status === 'generating')) _startConceptMapPolling();
}

// ---- 概念地图制品（v3.10）：基于概念清单 AI 生成单文件 HTML 全览图，保留历史制品可优化 ----
// v3.14 起生成是**后台任务**：POST/PUT 立即返回占位制品（status:'generating'），AI 在服务端后台跑，
// 切页/刷新都不打断；前端轮询 settings 元信息，完成/失败 toast 通知。
let _cmPollTimer = null; // 轮询句柄（有 generating 制品时存活）

let _cmPrevStatus = {}; // 上次轮询各制品状态（检测 generating→ready/error 跳变）

/** 启动制品状态轮询（4s）。已启动则幂等。 */
function _startConceptMapPolling() {
  if (_cmPollTimer) return;
  _cmPrevStatus = {};
  for (const m of state.conceptMaps || []) _cmPrevStatus[m.id] = m.status;
  _cmPollTimer = setInterval(_pollConceptMaps, 4000);
}

/** 停止轮询（无 generating 制品 / 切空间时）。 */
export function _stopConceptMapPolling() {
  if (_cmPollTimer) { clearInterval(_cmPollTimer); _cmPollTimer = null; }
  _cmPrevStatus = {};
}

/** 轮询一轮：拉 settings 元信息 → 检测状态跳变 toast → 有变化才重渲列表（地图 pane 可见时）。
 *  注意：制品卡是 live iframe 缩略图，重渲 = 卸载重挂 iframe（重新拉 html + 重跑页内动画），
 *  所以必须只在「状态/成员变化」时重渲，不能每轮都刷。 */
async function _pollConceptMaps() {
  if (!_cmPollTimer) return; // 已停止（切空间/无 generating 后）——定时器句柄即开关，防停止后残留回调继续拉取
  let metas;
  try {
    const s = await jget('/api/settings');
    metas = (s && s.data && s.data.conceptMaps) || [];
  } catch { return; } // 网络抖动跳过本轮
  let changed = false;
  const prevIds = new Set(Object.keys(_cmPrevStatus));
  for (const m of metas) {
    const prev = _cmPrevStatus[m.id];
    if (prev !== m.status) {
      changed = true;
      if (prev === 'generating' && m.status === 'ready') toast(`概念地图「${m.name}」已生成`, 'info');
      else if (prev === 'generating' && m.status === 'error') toast(`概念地图「${m.name}」${m.error || '生成失败'}`, 'error');
      _cmPrevStatus[m.id] = m.status;
    }
    prevIds.delete(m.id);
  }
  if (prevIds.size) { changed = true; for (const id of prevIds) delete _cmPrevStatus[id]; } // 制品被删（他端/取消）
  state.conceptMaps = metas;
  if (!metas.some((m) => m.status === 'generating')) { _stopConceptMapPolling(); }
  // 概念页地图 pane 可见且有变化才重渲（其它页面不打扰 DOM；pane 用 .hidden 控制显隐）
  const pane = $('concept-maps-pane');
  if (changed && pane && !pane.hidden && $('concepts-view').style.display !== 'none') renderConceptMaps();
}

/** 生成新地图：可选自定义 prompt → POST 立即返回占位 → 后台生成 → 轮询。 */
export async function generateConceptMap() {
  if (!(state.concepts && state.concepts.length)) { toast('概念清单为空，先抽取概念', 'error'); return; }
  const prompt = await PWDialog.prompt('可选：输入生成要求（留空用默认提示词，如"按分类分组，矩阵图样式，强调高频概念"）：', {
    title: '生成概念地图', multiline: true, okText: '生成',
  });
  if (prompt === null) return; // 取消
  let r;
  try {
    r = await POST('/api/concepts/map', { prompt: prompt || undefined });
  } catch (e) { toast('提交失败：' + (e && e.message || e), 'error'); return; }
  if (r && r.ok && r.data) {
    toast('已开始后台生成（大产出需数分钟~数十分钟），可随时离开本页，完成后会通知', 'info');
    state.conceptMaps = [r.data].concat(state.conceptMaps || []);
    renderConceptMaps();
    if (_conceptView === 'maps') _syncConceptHead(_conceptView); // 新制品入列，计数同步
    _startConceptMapPolling();
  } else toast((r && r.error) || '提交失败', 'error');
}

// 制品卡工具按钮（v3.41）：与概念/公式卡同款 qbtn 语言（图标+短标签，hover 浮现，
// 删除红），图标与 data 属性保持既有委托接线不变。
const _CM_ICON = {
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  opt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.36 6.36l-.7-.7M6.34 6.34l-.7-.7m12.72 0l-.7.7M6.34 17.66l-.7.7"/><circle cx="12" cy="12" r="4"/></svg>',
  tab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};
const _cmBtn = (kind, label, title, attr, danger) =>
  `<button class="qbtn${danger ? ' danger' : ''}" ${attr} title="${title}">${_CM_ICON[kind]}<span>${label}</span></button>`;

/** 渲染制品缩略图网格（元信息从 state.conceptMaps）。
 *  缩略图 = 制品 HTML 在 1280×800 iframe 里真实渲染后 CSS scale 缩小（live preview），
 *  滚进视口才 GET html 挂载（IntersectionObserver 懒挂载；jsdom/老浏览器立即全挂）。
 *  状态感知：generating=spinner 占位（仅可取消）；error=失败原因（有半成品也挂缩略图）。 */
function renderConceptMaps() {
  const box = $('concept-maps-list');
  if (!box) return;
  const maps = state.conceptMaps || [];
  if (!maps.length) { box.innerHTML = '<div class="cms-empty">暂无概念地图。点上方「生成概念地图」基于当前概念清单创建。</div>'; return; }
  box.innerHTML = maps.map((m) => {
    const t = new Date(m.createdAt || 0).toLocaleString();
    let thumbHtml, metaHtml, actions;
    if (m.status === 'generating') {
      thumbHtml = '<div class="cms-thumb-status"><span class="cms-spinner"></span><span>后台生成中…<br>可随时离开本页</span></div>';
      metaHtml = '<span class="cms-item-time cms-generating">生成中</span>';
      actions = _cmBtn('del', '取消', '取消生成并删除', 'data-cm-del="' + m.id + '"', true);
    } else if (m.status === 'error') {
      thumbHtml = m.hasHtml
        ? '<div class="cms-thumb" data-cm-thumb="' + m.id + '"></div><div class="cms-thumb-badge err">不完整</div>'
        : '<div class="cms-thumb-status cms-err">生成失败</div>';
      metaHtml = '<span class="cms-item-time cms-error" title="' + escapeHtml(m.error || '') + '">' + escapeHtml(m.error || '生成失败') + '</span>';
      actions =
        (m.hasHtml ? _cmBtn('view', '查看', '查看半成品', 'data-cm-view="' + m.id + '"') : '') +
        _cmBtn('opt', '优化', '基于本制品再次生成（可输入优化要求）', 'data-cm-opt="' + m.id + '"') +
        _cmBtn('del', '删除', '删除制品', 'data-cm-del="' + m.id + '"', true);
    } else {
      thumbHtml = '<div class="cms-thumb" data-cm-thumb="' + m.id + '" data-cm-view-thumb="' + m.id + '" title="点击查看"></div>';
      metaHtml = '<span class="cms-item-time">' + t + '</span>';
      actions =
        _cmBtn('opt', '优化', '基于本制品再次生成（可输入优化要求）', 'data-cm-opt="' + m.id + '"') +
        _cmBtn('tab', '新标签页', '在新标签页打开', 'data-cm-newtab="' + m.id + '"') +
        _cmBtn('del', '删除', '删除制品', 'data-cm-del="' + m.id + '"', true);
    }
    return '<div class="cms-card' + (m.status === 'generating' ? ' is-generating' : '') + '" data-id="' + m.id + '">' +
      '<div class="cms-thumb-wrap">' + thumbHtml + '</div>' +
      '<div class="cms-card-body">' +
      '<div class="cms-item-main"><span class="cms-item-name">' + escapeHtml(m.name || '概念地图') + '</span>' + metaHtml + '</div>' +
      '<div class="cms-item-actions">' + actions + '</div>' +
      '</div></div>';
  }).join('');
  box.querySelectorAll('[data-cm-view]').forEach((b) => (b.onclick = () => viewConceptMap(b.dataset.cmView)));
  box.querySelectorAll('[data-cm-view-thumb]').forEach((t) => (t.onclick = () => viewConceptMap(t.dataset.cmViewThumb)));
  box.querySelectorAll('[data-cm-opt]').forEach((b) => (b.onclick = () => optimizeConceptMap(b.dataset.cmOpt)));
  box.querySelectorAll('[data-cm-newtab]').forEach((b) => (b.onclick = () => openConceptMapNewTab(b.dataset.cmNewtab)));
  box.querySelectorAll('[data-cm-del]').forEach((b) => (b.onclick = async () => {
    const m = (state.conceptMaps || []).find((x) => x.id === b.dataset.cmDel);
    const isGen = m && m.status === 'generating';
    if (!(await PWDialog.confirm(isGen ? '取消生成并删除这个制品？' : '删除这个概念地图制品？', { title: isGen ? '取消生成' : '删除制品', danger: true, okText: isGen ? '取消生成' : '删除' }))) return;
    const r = await DEL('/api/concepts/map/' + b.dataset.cmDel);
    if (r && r.ok) {
      toast(isGen ? '已取消生成' : '已删除');
      state.conceptMaps = (state.conceptMaps || []).filter((x) => x.id !== b.dataset.cmDel);
      delete _cmPrevStatus[b.dataset.cmDel];
      renderConceptMaps();
    } else toast((r && r.error) || '删除失败', 'error');
  }));
  _observeConceptMapThumbs(box);
}

// ---- 制品缩略图：live iframe 缩放预览 ----
/** 缩略图渲染宽度（iframe 按此渲染再 scale 到卡片宽度；16:10 比例由 CSS aspect-ratio 保证）。 */
const _CM_THUMB_W = 1280;
const _CM_THUMB_H = 800;
let _cmThumbIO = null; // IntersectionObserver 单例（复用）

/** 挂载单个缩略图：GET 制品 html → sandboxed iframe srcdoc → 按容器宽度 scale。幂等。 */
function _mountConceptMapThumb(box, id) {
  if (!box || box.dataset.mounted) return;
  box.dataset.mounted = '1';
  jget('/api/concepts/map/' + id).then((r) => {
    if (!r || !r.data || !r.data.html) { box.classList.add('cms-thumb-failed'); return; }
    const iframe = document.createElement('iframe');
    iframe.className = 'cms-thumb-frame';
    iframe.setAttribute('sandbox', 'allow-scripts'); // 不放 allow-same-origin：制品禁存储 API，隔离更严
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('title', '概念地图缩略预览');
    iframe.style.width = _CM_THUMB_W + 'px';
    iframe.style.height = _CM_THUMB_H + 'px';
    box.appendChild(iframe);
    iframe.srcdoc = r.data.html;
    const scale = (box.clientWidth || 300) / _CM_THUMB_W;
    iframe.style.transform = 'scale(' + scale + ')';
  }).catch(() => { box.classList.add('cms-thumb-failed'); });
}

/** 懒挂载：滚进视口才取 html 挂 iframe（rootMargin 预载一屏）。无 IO（jsdom/老浏览器）立即全挂。 */
function _observeConceptMapThumbs(scope) {
  const thumbs = scope.querySelectorAll('.cms-thumb[data-cm-thumb]');
  if (!thumbs.length) return;
  if (typeof IntersectionObserver === 'undefined') {
    thumbs.forEach((t) => _mountConceptMapThumb(t, t.dataset.cmThumb));
    return;
  }
  if (!_cmThumbIO) {
    _cmThumbIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          _cmThumbIO.unobserve(e.target);
          _mountConceptMapThumb(e.target, e.target.dataset.cmThumb);
        }
      }
    }, { rootMargin: '400px' });
  }
  thumbs.forEach((t) => _cmThumbIO.observe(t));
}

/** 查看制品：按需 GET 单个 html → iframe srcdoc 全屏覆盖层。传 html 则免请求。 */
export async function viewConceptMap(id, html) {
  if (!html) {
    const r = await jget('/api/concepts/map/' + id);
    if (!r || !r.data || !r.data.html) { toast((r && r.data && r.data.status === 'generating') ? '仍在生成中，完成后可查看' : '加载失败', 'error'); return; }
    html = r.data.html;
  }
  openConceptMapOverlay(id, html);
}

/** iframe 全屏覆盖层（带返回 + 新标签页按钮）。 */
function openConceptMapOverlay(id, html) {
  let ov = $('concept-map-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'concept-map-overlay';
    ov.className = 'concept-map-overlay';
    document.body.appendChild(ov);
  }
  ov.innerHTML =
    '<div class="cmo-bar"><button class="btn ghost sm" id="cmo-close">← 返回</button>' +
    '<span class="cmo-title"></span>' +
    '<button class="btn ghost sm" id="cmo-newtab">新标签页打开</button></div>' +
    '<iframe class="cmo-frame" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>';
  ov.classList.add('open');
  ov.querySelector('.cmo-title').textContent = ((state.conceptMaps || []).find((m) => m.id === id) || {}).name || '概念地图';
  const frame = ov.querySelector('.cmo-frame');
  frame.srcdoc = html || '';
  ov.querySelector('#cmo-close').onclick = () => { ov.classList.remove('open'); frame.srcdoc = ''; };
  ov.querySelector('#cmo-newtab').onclick = () => openConceptMapNewTab(id, html);
}

/** 新标签页打开（blob URL，避免 srcdoc 在新标签无法直接打开）。 */
async function openConceptMapNewTab(id, html) {
  if (!html) { const r = await jget('/api/concepts/map/' + id); html = r && r.data ? r.data.html : ''; }
  if (!html) { toast('加载失败', 'error'); return; }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 优化已有制品：输入自定义 prompt → PUT 立即返回（后台任务）→ 轮询。生成期间旧 html 保留可看。 */
async function optimizeConceptMap(id) {
  const prompt = await PWDialog.prompt('输入优化要求（如"把架构图改成矩阵图""增加概念间的连线""只保留高频概念"）：', {
    title: '优化概念地图', multiline: true, okText: '优化',
  });
  if (prompt === null || !prompt) return;
  let r;
  try {
    r = await PUT('/api/concepts/map', { id, prompt });
  } catch (e) { toast('提交失败：' + (e.message || e), 'error'); return; }
  if (r && r.ok && r.data) {
    toast('已开始后台优化（大产出需数分钟~数十分钟），可随时离开本页，完成后会通知', 'info');
    state.conceptMaps = (state.conceptMaps || []).map((x) => (x.id === id ? r.data : x));
    renderConceptMaps();
    _startConceptMapPolling();
  } else toast((r && r.error) || '提交失败', 'error');
}

// 概念页排序状态（localStorage 持久化用户选择）
export let _conceptSort = localStorage.getItem('pw-concept-sort') || 'freq';

// 概念页显示方式：masonry（瀑布流，默认）/ list（紧凑清单）
export let _conceptLayout = localStorage.getItem('pw-concept-layout') || 'masonry';

// 概念页视图：list（概念清单，默认）/ maps（概念地图制品）
export let _conceptView = localStorage.getItem('pw-concept-view') || 'list';

// ---- 概念筛选（v3.16 → v3.20 DSL 驱动 → v3.28 分面扩容）----
// v3.20 起 DSL 是单一事实源：搜索框里的 category:/freq:/context: 决定筛选。
// v3.28 侧栏分面扩容：freq:solo / topic:（按论文主题）/ added:7d|30d（最近新增）/
// importance:core|supporting（核心度）/ quality:nodef（缺解释）。漏斗弹层退役——
// 全部「怎么筛」都长在侧栏，与「看什么」（视图）同一入口。
// _conceptFilter 是 renderConcepts 解析 DSL 后的派生缓存（供侧栏读当前态回填）。
let _conceptFilter = {
  categories: [],   // 从 DSL category: 派生（多选，空=不限）
  freq: '',         // 从 DSL freq: 派生（'' 全部 | 'shared' | 'hot' | 'solo'）
  hasContext: false, // 从 DSL context:. 派生
  topics: [],       // 从 DSL topic: 派生（多选，概念出现论文的主题，ANY 命中）
  added: '',        // 从 DSL added: 派生（'' | '7d' | '30d'）
  importance: '',   // 从 DSL importance: 派生（'' | 'core' | 'supporting'）
  quality: '',      // 从 DSL quality: 派生（'' | 'nodef'）
  starred: false,   // 从 DSL star:1 派生（v3.30 重点标记，与论文页同语法）
};

/** 从搜索框 DSL 解析派生 _conceptFilter（renderConcepts 每次调用前刷新）。 */
function _refreshConceptFilterFromDsl() {
  const S = window.PaperWikiSearch;
  const dsl = (($('search') || {}).value || '').trim();
  if (!S) {
    // search-dsl.js 未加载（极端兜底）：把整串当关键词，无结构化筛选
    _conceptFilter = { categories: [], freq: '', hasContext: false, topics: [], added: '', importance: '', quality: '', starred: false };
    return { words: dsl ? [dsl.toLowerCase()] : [], phrases: [], excludeWords: [], excludePhrases: [] };
  }
  const { metadata } = S.parseSearchQuery(dsl);
  _conceptFilter = {
    categories: (metadata.fields.category || []).filter((e) => !e.exclude).map((e) => e.value),
    freq: metadata.fields.freq || '',
    hasContext: metadata.fields.hasContext === true,
    topics: (metadata.fields.topic || []).filter((e) => !e.exclude).map((e) => e.value),
    added: metadata.fields.added || '',
    importance: metadata.fields.importance || '',
    quality: metadata.fields.quality || '',
    starred: metadata.fields.starred === true,
  };
  return {
    words: metadata.text.words,
    phrases: metadata.text.phrases,
    excludeWords: metadata.text.excludeWords,
    excludePhrases: metadata.text.excludePhrases,
  };
}

/** 把侧栏分面状态合并进搜索框 DSL（保留裸词/文本部分）。
 *  parts 中缺省的键不动（undefined=保留现状）。 */
function _mergeConceptDsl(parts) {
  const S = window.PaperWikiSearch;
  const inp = $('search');
  if (!inp || !S) return;
  const cur = S.parseToPanel(inp.value);
  const merged = {
    text: cur.text,
    categories: parts.categories !== undefined ? parts.categories : cur.categories,
    freq: parts.freq !== undefined ? parts.freq : cur.freq,
    hasContext: parts.hasContext !== undefined ? parts.hasContext : cur.hasContext,
    topics: parts.topics !== undefined ? parts.topics : cur.topics,
    added: parts.added !== undefined ? parts.added : cur.added,
    importance: parts.importance !== undefined ? parts.importance : cur.importance,
    quality: parts.quality !== undefined ? parts.quality : cur.quality,
    starred: parts.starred !== undefined ? parts.starred : cur.starred,
  };
  inp.value = S.buildDslFromPanel(merged);
  syncPageQueryToUrl();
}

// 概念分类枚举（与提示词一致）+ 中文标签（面板显示用）
const _CONCEPT_CATEGORIES = [
  { key: 'architecture', label: '架构' },
  { key: 'attention', label: '注意力' },
  { key: 'loss', label: '损失' },
  { key: 'optimization', label: '优化' },
  { key: 'regularization', label: '正则化' },
  { key: 'generative', label: '生成' },
  { key: 'representation', label: '表示' },
  { key: 'training', label: '训练' },
  { key: 'evaluation', label: '评估' },
  { key: 'inference', label: '推理' },
  // 通用领域类别（v3.42 提示词领域自适应的逃生门：非 AI/ML 论文可能产出这些）
  { key: 'theory', label: '定理/理论' },
  { key: 'method', label: '方法' },
  { key: 'metric', label: '度量' },
  { key: 'phenomenon', label: '现象' },
  { key: 'task', label: '任务' },
  { key: 'dataset', label: '数据/对象' },
  { key: 'protocol', label: '协议/流程' },
  { key: 'other', label: '其他' },
];

// 表单下拉选项（新增/编辑/批量改分类共用）
const _CAT_OPTIONS = _CONCEPT_CATEGORIES.map((c) => ({ value: c.key, label: c.label }));
const _IMPORTANCE_OPTIONS = [
  { value: '', label: '未知' },
  { value: 'core', label: '核心创新' },
  { value: 'supporting', label: '支撑技术' },
];

// ---- 新增 / 编辑（v3.29：手动录入 + 全字段编辑走表单对话框）----

/** 手动新增概念：纸面/组会/其它来源的术语补进知识库（source='manual'）。
 *  term 命中已有概念时后端按合并语义处理（补关联论文与空缺字段），toast 区分提示。 */
export async function createConcept() {
  const values = await openFormDialog({
    title: '新增概念',
    fields: [
      { key: 'term', label: '术语 *', required: true, placeholder: '如 Scaled Dot-Product Attention（规范学术名）' },
      { key: 'definition', label: '解释', type: 'textarea', rows: 4, placeholder: '是什么 + 解决什么问题 + 在论文中的作用' },
      { key: 'category', label: '分类', type: 'select', options: _CAT_OPTIONS, value: 'other' },
      { key: 'importance', label: '核心度', type: 'select', options: _IMPORTANCE_OPTIONS, value: '' },
      { key: 'paperIds', label: '关联论文', type: 'papers', value: [], hint: '不挂论文则成为独立条目' },
    ],
  });
  if (!values) return;
  let r;
  try {
    r = await POST('/api/concepts', values);
  } catch (e) {
    toast('网络错误：' + (e && e.message ? e.message : e), 'error');
    return;
  }
  if (r && r.ok && r.data && r.data.concept) {
    toast(r.data.merged ? `已并入已有概念「${r.data.concept.term}」（补关联与空缺字段）` : '概念已新增');
    const c = r.data.concept;
    const idx = (state.concepts || []).findIndex((x) => x.id === c.id);
    if (idx >= 0) state.concepts[idx] = c;
    else state.concepts = [...(state.concepts || []), c];
    renderConceptSidebar();
    renderConcepts();
  } else toast((r && r.error) || '新增失败', 'error');
}

/** 编辑概念（全字段：术语/解释/分类/核心度）。抽屉与卡片编辑按钮共用。 */
export async function editConceptDialog(c) {
  if (!c) return;
  const values = await openFormDialog({
    title: '编辑概念',
    fields: [
      { key: 'term', label: '术语 *', required: true, value: c.term, hint: '跨论文合并 key，慎改' },
      { key: 'definition', label: '解释', type: 'textarea', rows: 5, value: c.definition || '' },
      { key: 'category', label: '分类', type: 'select', options: _CAT_OPTIONS, value: c.category || 'other' },
      { key: 'importance', label: '核心度', type: 'select', options: _IMPORTANCE_OPTIONS, value: c.importance || '' },
    ],
  });
  if (!values) return;
  const r = await PATCH('/api/concepts/' + c.id, values);
  if (r && r.ok) {
    toast('概念已更新');
    const idx = (state.concepts || []).findIndex((x) => x.id === c.id);
    if (idx >= 0) state.concepts[idx] = r.data;
    renderConcepts();
  } else toast((r && r.error) || '保存失败', 'error');
}

/** 导出概念清单 Markdown（v3.30）：有激活筛选时导出当前筛选子集（POST ids → blob 下载），
 *  无筛选维持全量（原 GET /api/concepts.md 直链）。备课/综述做讲义素材的主路径。 */
export async function exportConceptsMd() {
  const total = (state.concepts || []).length;
  const filtered = _conceptList.length;
  if (filtered && filtered < total) {
    try {
      const res = await fetch(sp('/api/concepts.md'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: _conceptList.map((c) => c.id) }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      _downloadTextBlob(blob, `concepts-${filtered}.md`);
      toast(`已导出当前筛选的 ${filtered} 个概念`);
      return;
    } catch (e) {
      toast('筛选集导出失败：' + (e && e.message ? e.message : e) + '，改为导出全量', 'error');
    }
  }
  window.open(sp('/api/concepts.md'), '_blank');
}

/** Blob 文件下载 helper（POST 导出用；GET 直链不需要）。 */
function _downloadTextBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// ---- 多选 + 批量管理（v3.29）----

let _conceptPickMode = false;
const _conceptPicked = new Set();
let _conceptPickBar = null;

export function isConceptPickMode() {
  return _conceptPickMode;
}

/** 切换概念页多选模式（工具条按钮触发）。选中集合为本模块持有，底栏动作走 bulk 端点。 */
export function toggleConceptPickMode(on) {
  const next = typeof on === 'boolean' ? on : !_conceptPickMode;
  if (next === _conceptPickMode) return;
  _conceptPickMode = next;
  if (_conceptPickMode) {
    if (!_conceptPickBar) {
      _conceptPickBar = createPickBar({
        itemsLabel: '概念',
        categories: _CAT_OPTIONS,
        onDelete: async () => {
          const ids = [..._conceptPicked];
          try {
            const r = await POST('/api/concepts/bulk', { ids, delete: true });
            if (r && r.ok) {
              toast(`已删除 ${r.data.updated} 个概念`);
              const del = new Set(ids);
              state.concepts = (state.concepts || []).filter((c) => !del.has(c.id));
              toggleConceptPickMode(false);
              renderConceptSidebar();
              renderConcepts();
            } else toast((r && r.error) || '删除失败', 'error');
          } catch {
            toast('网络中断，批量删除未完成', 'error');
          }
        },
        onCategorize: async (category) => {
          const ids = [..._conceptPicked];
          try {
            const r = await POST('/api/concepts/bulk', { ids, category });
            if (r && r.ok) {
              toast(`已把 ${r.data.updated} 个概念归入「${category}」`);
              const hit = new Set(ids);
              for (const c of state.concepts || []) if (hit.has(c.id)) c.category = category;
              toggleConceptPickMode(false);
              renderConceptSidebar();
              renderConcepts();
            } else toast((r && r.error) || '操作失败', 'error');
          } catch {
            toast('网络中断，批量归类未完成', 'error');
          }
        },
        onExit: () => toggleConceptPickMode(false),
      });
    }
    _conceptPickBar.open();
    _conceptPickBar.setCount(_conceptPicked.size);
  } else {
    _conceptPicked.clear();
    if (_conceptPickBar) _conceptPickBar.close();
  }
  renderConcepts();
}

/** 多选模式内点击卡片：切换选中（就地改 class + 计数，不整页重渲）。 */
function _toggleConceptPick(id, cardEl) {
  if (_conceptPicked.has(id)) {
    _conceptPicked.delete(id);
    cardEl.classList.remove('picked');
  } else {
    _conceptPicked.add(id);
    cardEl.classList.add('picked');
  }
  if (_conceptPickBar) _conceptPickBar.setCount(_conceptPicked.size);
}

// 懒加载：概念清单可能数百条（一次抽取就 700+），一次性 innerHTML 会卡顿。复用公式清单的分批
// 渲染模式——保留全量排序后的 list，分批渲染（首批 _CONCEPT_FIRST_BATCH，之后每批 _CONCEPT_NEXT_BATCH），
// IntersectionObserver 观察末尾 sentinel 触发追加。jsdom/老浏览器无此 API 时一次性渲染全部（兼容）。
const _CONCEPT_FIRST_BATCH = 40;

const _CONCEPT_NEXT_BATCH = 30;

let _conceptList = []; // 当前排序后的完整列表（renderConcepts 计算）

let _conceptShown = 0; // 已渲染条数

let _conceptObserver = null; // IntersectionObserver 实例（复用，root 滚动容器不变）

// JS 绝对定位瀑布流（对齐公式清单模式）：顶行从左到右是排序 1..N、下行紧贴上方无竖向空隙。
// 概念卡高度因定义长度/论文胶囊数不同有差异，CSS grid 行优先会有同行空隙；JS 瀑布流消除空隙。
const _CONCEPT_MASONRY_MIN = 300;

const _CONCEPT_MASONRY_GAP = 12;

let _conceptResizeTimer = null;

let _conceptGridRO = null;

let _conceptGridROW = 0;

let _conceptResizeWired = false;

/** document.fonts.ready 只挂一次（字体到位后重排）。 */
let _conceptFontsWired = false;

/** 头部标题随视图切换（v3.40）：地图视图不再顶着「概念清单」的标题——两个视图各有
 *  自己的标题/副文案；计数徽章在地图态显示制品数（清单态由 renderConcepts 权威写回）。 */
function _syncConceptHead(view) {
  const h2 = document.querySelector('#concepts-view .concepts-head h2');
  const sub = document.querySelector('#concepts-view .concepts-head-text p');
  const badge = $('concepts-count');
  if (!h2 || !sub) return;
  const isMaps = view === 'maps';
  if (h2.firstChild && h2.firstChild.nodeType === 3) h2.firstChild.nodeValue = isMaps ? '概念地图' : '概念清单';
  sub.textContent = isMaps
    ? '基于概念清单生成的可视化全览图（后台生成，切页不打断），点击缩略图查看。'
    : '跨论文归并的术语与解释。点击卡片看全貌：出处论文、共现概念、相关公式。';
  if (badge && isMaps) badge.textContent = (state.conceptMaps || []).length;
}

/** 切换概念页视图（清单 / 地图），持久化用户选择，控制两个 pane 显隐 + 工具栏控件可见性。 */
function switchConceptView(view) {
  _conceptView = view;
  localStorage.setItem('pw-concept-view', view);
  const isMaps = view === 'maps';
  const listPane = $('concept-list-pane');
  const mapsPane = $('concept-maps-pane');
  if (listPane) listPane.hidden = isMaps;
  if (mapsPane) mapsPane.hidden = !isMaps;
  _syncConceptHead(view); // v3.40：标题/副文案/计数随视图切换
  // 地图视图下隐藏新增/多选/排序/布局/下载（它们只对清单有意义；v3.28 漏斗按钮已退役——
  // 筛全面归侧栏；v3.29 新增/多选按钮也属清单态）
  document.querySelectorAll('#btn-concept-add, #btn-concept-pick, #concept-layout, #concept-sort, #btn-concepts-md').forEach((el) => {
    el.style.display = isMaps ? 'none' : '';
  });
  document.querySelectorAll('#side-concepts .side-item[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === view);
  });
  // 收起态 rail 的 清单/地图 按钮同步 active
  document.querySelectorAll('.rail-ctx[data-ctx="concepts"] .rail-btn[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === view);
  });
  if (isMaps) renderConceptMaps();
  else if (_conceptLayout === 'masonry') {
    // 切回清单：list pane 刚由 hidden 转可见，clientWidth 此刻才可测——
    // renderConcepts 在 pane 还 hidden 时调 _layoutConceptMasonry 会因宽度 0 走兜底（不定位），
    // 故此处补跑一次重排（rAF 等浏览器布局完成后再测宽）。
    requestAnimationFrame(() => _layoutConceptMasonry());
  }
}

/** 渲染概念页侧栏（v3.28 重设计）：视图（清单 / 地图）+ 热度 + 主题 + 质量 + 时间 + 分类。
 *
 *  设计动机（学者/博士视角）：AI 打的方法论分类语义重叠、边界模糊，导航价值有限。侧栏改为
 *  承载研究者真实的检索心智——「什么重要」（热度 / 核心度）×「我在研究什么」（论文主题，
 *  从论文 topics 现算而非模型打标）×「最近有什么」（新增时间）×「哪些要补」（质量分面，
 *  可行动）。分类保留但降级到末位。所有分面写搜索框 DSL（v3.20 单一事实源不变），
 *  renderConcepts/renderConceptSidebar 均从 DSL 派生当前态。 */
export function renderConceptSidebar() {
  const host = $('side-concepts');
  if (!host) return;
  _refreshConceptFilterFromDsl();
  const concepts = state.concepts || [];
  const paperById = new Map((state.papers || []).map((p) => [p.id, p]));
  const now = Date.now();

  // ---- 全量计数（与分类分面同口径：不受其它分面影响）----
  const cnt = (fn) => concepts.filter(fn).length;
  const freqCounts = {
    hot: cnt((c) => (c.paperIds || []).length >= 4),
    shared: cnt((c) => (c.paperIds || []).length >= 2),
    solo: cnt((c) => (c.paperIds || []).length === 1),
  };
  const coreCount = cnt((c) => c.importance === 'core');
  const nodefCount = cnt((c) => !(c.definition || '').trim());
  const ctxCount = cnt((c) => !!(c.context && String(c.context).trim()));
  const starCount = cnt((c) => !!c.starred); // v3.30 重点标记（组会指派/复习清单）
  const added7 = cnt((c) => now - (c.createdAt || 0) < 7 * 86400e3);
  const added30 = cnt((c) => now - (c.createdAt || 0) < 30 * 86400e3);

  // ---- 主题分面：概念出现论文的 topics 聚合（论文自己的主题字典，非模型现打）----
  const topicCounts = new Map();
  for (const c of concepts) {
    const seen = new Set();
    for (const pid of c.paperIds || []) {
      for (const t of (paperById.get(pid) || {}).topics || []) seen.add(t);
    }
    for (const t of seen) topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
  }
  const topics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);
  const selTopics = new Set(_conceptFilter.topics);

  // ---- 分类分面（从数据现算；枚举只提供中文标签与顺序）----
  const catCounts = {};
  for (const c of concepts) {
    const k = c.category || 'other';
    catCounts[k] = (catCounts[k] || 0) + 1;
  }
  const sel = new Set(_conceptFilter.categories);
  const total = concepts.length;
  const mapCount = (state.conceptMaps || []).length;
  const label = Object.fromEntries(_CONCEPT_CATEGORIES.map((c) => [c.key, c.label]));
  const order = _CONCEPT_CATEGORIES.map((c) => c.key);
  const cats = Object.keys(catCounts).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.localeCompare(b);
  }).map((k) => ({ key: k, label: label[k] || k }));

  const anyFacet =
    sel.size > 0 || selTopics.size > 0 || _conceptFilter.freq !== '' || _conceptFilter.hasContext ||
    _conceptFilter.added !== '' || _conceptFilter.importance !== '' || _conceptFilter.quality !== '' ||
    _conceptFilter.starred;

  host.innerHTML = `
    <div class="side-section">
      <div class="side-title">
        <span>视图</span>
        <span class="side-actions">
          <button class="side-icon-btn" id="btn-collapse-concepts" title="收起侧栏" aria-label="收起侧栏"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button>
        </span>
      </div>
      <div class="side-item" data-cview="list"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span><span>概念清单</span><span class="count">${total || ''}</span></div>
      <div class="side-item" data-cview="maps"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M18 19.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M9 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M21 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M9 12h6"/><path d="M7.5 6.5L9 12"/><path d="M16.5 17.5L15 12"/></svg></span><span>概念地图</span><span class="count">${mapCount || ''}</span></div>
    </div>
    <div class="side-section">
      <div class="side-title"><span>热度</span>${anyFacet ? '<button class="side-clear" id="side-all-clear" type="button">全部清除</button>' : ''}</div>
      <div class="side-item${_conceptFilter.freq === 'hot' ? ' active' : ''}" data-freq="hot"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c1 4-4 6-4 10a4 4 0 0 0 8 0c0-1.5-.7-2.5-1.5-3.5C13 11 12 9 12 2z" transform="translate(2 4) scale(.9)"/></svg></span><span>高频（≥4 篇）</span><span class="count">${freqCounts.hot || ''}</span></div>
      <div class="side-item${_conceptFilter.freq === 'shared' ? ' active' : ''}" data-freq="shared"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span><span>多篇共享（≥2 篇）</span><span class="count">${freqCounts.shared || ''}</span></div>
      <div class="side-item${_conceptFilter.freq === 'solo' ? ' active' : ''}" data-freq="solo"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span><span>仅单篇</span><span class="count">${freqCounts.solo || ''}</span></div>
    </div>
    ${topics.length ? `<div class="side-section">
      <div class="side-title"><span>主题</span>${selTopics.size ? '<button class="side-clear" id="side-topic-clear" type="button">清除</button>' : ''}</div>
      ${topics.map(([t, n]) => `<div class="side-item${selTopics.has(t) ? ' active' : ''}" data-topic="${escapeHtml(t)}"><span class="cat-dot"></span><span class="side-ellipsis" title="概念出现论文的主题：${escapeHtml(t)}">${escapeHtml(t)}</span><span class="count">${n}</span></div>`).join('')}
    </div>` : ''}
    <div class="side-section">
      <div class="side-title"><span>质量</span></div>
      <div class="side-item${_conceptFilter.starred ? ' active' : ''}" data-quality="star"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span><span>重点</span><span class="count">${starCount || ''}</span></div>
      <div class="side-item${_conceptFilter.importance === 'core' ? ' active' : ''}" data-quality="core"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span><span>核心创新</span><span class="count">${coreCount || ''}</span></div>
      <div class="side-item${_conceptFilter.quality === 'nodef' ? ' active' : ''}" data-quality="nodef"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span><span>缺解释</span><span class="count">${nodefCount || ''}</span></div>
      <div class="side-item${_conceptFilter.hasContext ? ' active' : ''}" data-quality="ctx"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span><span>有章节出处</span><span class="count">${ctxCount || ''}</span></div>
    </div>
    ${(added7 || added30) ? `<div class="side-section">
      <div class="side-title"><span>最近新增</span></div>
      ${added7 ? `<div class="side-item${_conceptFilter.added === '7d' ? ' active' : ''}" data-added="7d"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></span><span>7 天内</span><span class="count">${added7}</span></div>` : ''}
      ${added30 ? `<div class="side-item${_conceptFilter.added === '30d' ? ' active' : ''}" data-added="30d"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span><span>30 天内</span><span class="count">${added30}</span></div>` : ''}
    </div>` : ''}
    <div class="side-section" id="side-concept-cats">
      <div class="side-title">
        <span>AI 分类</span>
        ${sel.size ? '<button class="side-clear" id="side-cat-clear" type="button">清除</button>' : ''}
      </div>
      ${cats.length
    ? cats.map((c) => `<div class="side-item${sel.has(c.key) ? ' active' : ''}" data-cat="${escapeHtml(c.key)}" title="${escapeHtml(c.key)}"><span class="cat-dot"></span><span>${escapeHtml(c.label)}</span><span class="count">${catCounts[c.key]}</span></div>`).join('')
    : '<div class="side-item" style="color:var(--muted2);cursor:default;">（暂无分类）</div>'}
    </div>`;

  // ---- 接线 ----
  host.querySelectorAll('.side-item[data-cview]').forEach((el) => {
    el.onclick = () => router.navigate(el.dataset.cview === 'maps' ? '/concepts/maps' : '/concepts', { keepQuery: true });
  });
  // 热度单选（再点取消回全部）
  host.querySelectorAll('.side-item[data-freq]').forEach((el) => {
    el.onclick = () => {
      const next = _conceptFilter.freq === el.dataset.freq ? '' : el.dataset.freq;
      _mergeConceptDsl({ freq: next });
      renderConceptSidebar();
      renderConcepts();
    };
  });
  // 主题多选（ANY 命中）
  host.querySelectorAll('.side-item[data-topic]').forEach((el) => {
    el.onclick = () => {
      const next = new Set(_conceptFilter.topics);
      if (next.has(el.dataset.topic)) next.delete(el.dataset.topic);
      else next.add(el.dataset.topic);
      _mergeConceptDsl({ topics: [...next] });
      renderConceptSidebar();
      renderConcepts();
    };
  });
  // 质量四项（各自独立开关；star 为 v3.30 重点标记）
  host.querySelectorAll('.side-item[data-quality]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.quality;
      if (k === 'core') _mergeConceptDsl({ importance: _conceptFilter.importance === 'core' ? '' : 'core' });
      else if (k === 'nodef') _mergeConceptDsl({ quality: _conceptFilter.quality === 'nodef' ? '' : 'nodef' });
      else if (k === 'star') _mergeConceptDsl({ starred: !_conceptFilter.starred });
      else _mergeConceptDsl({ hasContext: !_conceptFilter.hasContext });
      renderConceptSidebar();
      renderConcepts();
    };
  });
  // 最近新增单选（再点取消）
  host.querySelectorAll('.side-item[data-added]').forEach((el) => {
    el.onclick = () => {
      const next = _conceptFilter.added === el.dataset.added ? '' : el.dataset.added;
      _mergeConceptDsl({ added: next });
      renderConceptSidebar();
      renderConcepts();
    };
  });
  // 分类多选（保持既有语义）
  host.querySelectorAll('.side-item[data-cat]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.cat;
      const next = new Set(_conceptFilter.categories);
      if (next.has(k)) next.delete(k); else next.add(k);
      _mergeConceptDsl({ categories: [...next] });
      renderConceptSidebar();
      renderConcepts();
    };
  });
  const wireClear = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  wireClear('side-all-clear', () => {
    _mergeConceptDsl({ categories: [], freq: '', hasContext: false, topics: [], added: '', importance: '', quality: '', starred: false });
    renderConceptSidebar();
    renderConcepts();
  });
  wireClear('side-topic-clear', () => { _mergeConceptDsl({ topics: [] }); renderConceptSidebar(); renderConcepts(); });
  wireClear('side-cat-clear', () => { _mergeConceptDsl({ categories: [] }); renderConceptSidebar(); renderConcepts(); });
  const collapse = $('btn-collapse-concepts');
  if (collapse) collapse.onclick = () => setSidebarCollapsed(true);
  // 只同步 active 态，不走 switchConceptView——后者在地图视图下会 renderConceptMaps()，
  // 而那等于卸载重挂全部缩略图 iframe（重跑页内动画），点一下分面不该付这个代价。
  host.querySelectorAll('.side-item[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === _conceptView);
  });
  // 收起态 rail 的 清单/地图 按钮同步 active（与展开侧栏同一份 _conceptView）
  document.querySelectorAll('.rail-ctx[data-ctx="concepts"] .rail-btn[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === _conceptView);
  });
}

export function renderConcepts() {
  // 查询词来自顶栏那个上下文搜索框（v3.17，页内 #concept-q 已退役）。
  // v3.20：解析 DSL——裸词/短语匹配 term+definition（AND），category:/freq:/context: 结构化筛选。
  // v3.28：新增 topic:（论文主题，ANY 命中）/ freq:solo / added: / importance: / quality:。
  const { words, phrases, excludeWords, excludePhrases } = _refreshConceptFilterFromDsl();
  const hasText = words.length > 0 || phrases.length > 0;
  const sort = _conceptSort;
  const layout = _conceptLayout;
  const F = _conceptFilter;
  const paperById = new Map((state.papers || []).map((p) => [p.id, p]));
  const now = Date.now();
  // 筛选：裸词/短语（term+definition 子串，AND）+ 分类 + 频次 + 主题 + 质量 + 新近 + 出处
  let list = state.concepts.filter((c) => {
    // 由来（context/contexts）也参与裸词搜索——「3.2 节」「式(1)」这类定位信息可直查
    const hay = [
      c.term,
      c.definition || '',
      c.context || '',
      (c.contexts || []).map((x) => x.context).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    if (hasText) {
      for (const w of words) if (!hay.includes(w)) return false;
      for (const p of phrases) if (!hay.includes(p)) return false;
    }
    for (const w of excludeWords) if (hay.includes(w)) return false;
    for (const p of excludePhrases) if (hay.includes(p)) return false;
    return true;
  });
  if (F.categories.length) {
    list = list.filter((c) => F.categories.includes(c.category || 'other'));
  }
  if (F.freq === 'shared') list = list.filter((c) => (c.paperIds || []).length >= 2);
  else if (F.freq === 'hot') list = list.filter((c) => (c.paperIds || []).length >= 4);
  else if (F.freq === 'solo') list = list.filter((c) => (c.paperIds || []).length === 1);
  if (F.topics.length) {
    // 主题匹配：概念出现论文的 topics 与所选主题**任一**命中即通过（导航语义，非交集）
    list = list.filter((c) => {
      for (const pid of c.paperIds || []) {
        const topics = (paperById.get(pid) || {}).topics || [];
        if (topics.some((t) => F.topics.includes(t))) return true;
      }
      return false;
    });
  }
  if (F.importance === 'core') list = list.filter((c) => c.importance === 'core');
  else if (F.importance === 'supporting') list = list.filter((c) => c.importance === 'supporting');
  if (F.quality === 'nodef') list = list.filter((c) => !(c.definition || '').trim());
  if (F.starred) list = list.filter((c) => !!c.starred);
  if (F.added === '7d') list = list.filter((c) => now - (c.createdAt || 0) < 7 * 86400e3);
  else if (F.added === '30d') list = list.filter((c) => now - (c.createdAt || 0) < 30 * 86400e3);
  if (F.hasContext) list = list.filter((c) => !!(c.context && String(c.context).trim()));
  // 排序
  if (sort === 'freq') {
    list = list.slice().sort((a, b) => {
      const d = (b.paperIds || []).length - (a.paperIds || []).length;
      if (d !== 0) return d;
      return String(a.term || '').localeCompare(String(b.term || '')); // 频次相同按字母
    });
  } else if (sort === 'recent') {
    list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else {
    list = list.slice().sort((a, b) => String(a.term || '').localeCompare(String(b.term || ''), 'zh-Hans-CN-u-co-pinyin'));
  }
  // 统计徽章
  const cb = $('concepts-count');
  if (cb) cb.textContent = list.length;
  // 排序切换按钮 active 态
  document.querySelectorAll('#concept-sort button').forEach((b) => b.classList.toggle('active', b.dataset.sort === sort));
  // 显示方式切换按钮 active 态 + 容器 class 切换（瀑布流 / 清单）
  document.querySelectorAll('#concept-layout button').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
  // 字母索引条（仅字母排序 + 无搜索词时显示）
  // q 用于显示：有查询词（裸词/短语/结构化筛选）时给空态/索引条带提示
  const q = (($('search') || {}).value || '').trim();
  renderConceptAlphaBar(sort, q, list);
  // 卡片渲染（懒加载：首批 _CONCEPT_FIRST_BATCH，滚到底由 IntersectionObserver 追加每批）
  const g = $('concepts-grid');
  g.className = 'concepts-grid' + (layout === 'list' ? ' list-view' : ' masonry-view');
  g.innerHTML = '';
  _wireConceptGridOnce(g); // grid 级事件委托（一次性，懒加载追加批次不重复绑）
  if (!list.length) {
    // 结构化空态（R3）：真空给「去抽取」行动；筛选无匹配给「清除筛选」
    const hasAny = (state.concepts || []).length > 0;
    g.innerHTML = `<div class="empty-state">
      <div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/></svg></div>
      <p class="es-main">${hasAny ? '没有匹配的概念' : '概念清单还是空的'}</p>
      <p class="es-sub">${hasAny ? '当前搜索 / 分面筛选过窄，试试放宽条件。' : '概念在扫描时自动抽取——去论文库多选论文批量抽取，或在详情「信息」tab 里单篇追加。'}</p>
      <div class="es-actions">${hasAny ? '<button class="btn sm es-clear" type="button">清除筛选</button>' : '<button class="btn sm es-goto" type="button">去论文库抽取</button>'}</div>
    </div>`;
    const clearBtn = g.querySelector('.es-clear');
    if (clearBtn) clearBtn.onclick = () => {
      const inp = $('search');
      if (inp) inp.value = '';
      _mergeConceptDsl({ categories: [], freq: '', hasContext: false, topics: [], added: '', importance: '', quality: '', starred: false });
      renderConceptSidebar();
      renderConcepts();
    };
    const gotoBtn = g.querySelector('.es-goto');
    if (gotoBtn) gotoBtn.onclick = () => router.navigate('/library', { keepQuery: false });
    return;
  }
  _conceptList = list;
  _conceptShown = 0;
  _renderConceptBatch(_CONCEPT_FIRST_BATCH);
}

/** 构造单张概念卡 DOM（masonry / list 两布局）。论文胶囊 + 频次徽章 + 出处徽章 + 编辑/删除按钮。
 *  v3.28：卡体（非按钮区）点击打开概念详情抽屉；核心创新/章节出处直接上卡（此前抽了不展示）。 */
function _buildConceptCard(c, layout) {
  const card = document.createElement('div');
  card.className = 'concept-card';
  card.dataset.detail = c.id; // 点击卡片（除按钮/胶囊）打开详情抽屉
  if (_conceptPickMode) {
    card.classList.add('pickable');
    if (_conceptPicked.has(c.id)) card.classList.add('picked');
  }
  const freq = (c.paperIds || []).length;
  // 论文胶囊：最多平铺 3 个，其余折叠为「+N」（点击展开）；已不在库内的 id 跳过
  const gotoable = (c.paperIds || [])
    .map((id) => ({ id, p: state.papers.find((x) => x.id === id) }))
    .filter((x) => x.p);
  const allNames = gotoable.map((x) => x.p.title || x.p.filename);
  const chipsHtml = gotoable
    .slice(0, 3)
    .map((x) => {
      const label = x.p.title || x.p.filename;
      return `<button class="paper-chip" data-goto="${x.id}" title="打开「${escapeHtml(label)}」">${escapeHtml(label)}</button>`;
    })
    .join('');
  const moreHtml =
    gotoable.length > 3
      ? `<button class="paper-chip more" data-more title="${escapeHtml(allNames.join('\n'))}">+${gotoable.length - 3} 篇</button>`
      : '';
  const restHtml =
    gotoable.length > 3
      ? gotoable
          .slice(3)
          .map((x) => {
            const label = x.p.title || x.p.filename;
            return `<button class="paper-chip" data-goto="${x.id}" title="打开「${escapeHtml(label)}」" hidden>${escapeHtml(label)}</button>`;
          })
          .join('')
      : '';
  const ctxHtml =
    c.context && String(c.context).trim()
      ? `<span class="ctx-badge" title="出处：${escapeHtml(c.context)}">${escapeHtml(String(c.context).slice(0, 40))}</span>`
      : '';
  const metaBadges = `${c.category && c.category !== 'other' ? `<span class="cat-badge" title="AI 分类">${escapeHtml(c.category)}</span>` : ''}${c.source === 'manual' ? '<span class="src-badge" title="手动录入">人工</span>' : ''}${freq ? `<span class="freq-badge" data-freq="${freq}" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}`;
  const metaHtml = gotoable.length
    ? `<span class="meta-label">出现于</span>${chipsHtml}${moreHtml}${restHtml}${metaBadges}`
    : `<span class="meta-label">（独立条目）</span>${metaBadges}`;
  const starBtn = `<button class="card-star${c.starred ? ' on' : ''}" data-star="${c.id}" title="${c.starred ? '取消重点' : '标记为重点（组会讨论 / 复习清单）'}" aria-label="星标" aria-pressed="${!!c.starred}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>`;
  if (layout === 'list') {
    // 清单视图：单行紧凑——频次徽章 + 术语 + 解释摘要（一行省略）+ 论文数
    card.innerHTML = `
      <span class="lc-freq ${freq > 1 ? '' : 'dim'}"${freq ? ` title="出现在 ${freq} 篇论文中"` : ''}>${freq || '·'}</span>
      <span class="lc-term" title="${escapeHtml(c.term)}">${escapeHtml(c.term)}</span>
      <span class="lc-def" title="${escapeHtml(c.definition || '')}">${escapeHtml(c.definition || '（无解释）')}</span>
      <span class="lc-count">${gotoable.length} 篇</span>
      <div class="row-actions">
        <button class="qbtn icon" data-edit="${c.id}" title="编辑概念（术语/解释/分类/核心度）" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
        <button class="qbtn icon danger" data-del="${c.id}" title="删除概念" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>${starBtn}`;
  } else {
    card.innerHTML = `
      <div class="ct"><h3>${escapeHtml(c.term)}</h3>${c.importance === 'core' ? '<span class="imp-badge" title="至少一篇论文将其列为核心创新">核心</span>' : ''}
        <div class="row-actions">
          <button class="qbtn icon" data-edit="${c.id}" title="编辑概念（术语/解释/分类/核心度）" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
          <button class="qbtn icon danger" data-del="${c.id}" title="删除概念" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>${starBtn}
      </div>
      <div class="cd" title="${escapeHtml((c.definition || '（无解释）').slice(0, 300))}">${escapeHtml(c.definition || '（无解释）')}</div>
      ${ctxHtml ? `<div class="ctx-line">${ctxHtml}</div>` : ''}
      <div class="meta-line">${metaHtml}</div>`;
  }
  return card;
}

/** JS 绝对定位瀑布流（Pinterest 式，对齐公式清单 _layoutFormulaMasonry 模式）：
 *  保留扁平有序 DOM（排序即 document order），逐卡测高后放进「最短列」设 top/left/width →
 *  顶行从左到右是排序 1..N、下行紧贴上方无竖向空隙。
 *  - 行优先：所有列初始高 0，首张卡放第 1 列、第 2 张放第 2 列…（取首个最短列即 round-robin）。
 *  - 兜底：jsdom / 容器未挂载 / 宽度为 0 时跳过定位，回退到 CSS grid 行优先（有空隙但可读）。 */
function _layoutConceptMasonry() {
  const g = $('concepts-grid');
  if (!g || _conceptLayout !== 'masonry') return;
  const cards = g.querySelectorAll(':scope > .concept-card');
  if (!cards.length) { g.classList.remove('js-masonry'); g.style.height = ''; return; }
  const width = g.clientWidth;
  if (!width || width < _CONCEPT_MASONRY_MIN / 2) {
    // 宽度测不到（jsdom / 不可见）→ 不做绝对定位，回退 CSS grid
    g.classList.remove('js-masonry');
    cards.forEach((c) => { c.style.position = ''; c.style.top = ''; c.style.left = ''; c.style.width = ''; });
    g.style.height = '';
    return;
  }
  const gap = _CONCEPT_MASONRY_GAP;
  let cols = Math.max(1, Math.floor((width + gap) / (_CONCEPT_MASONRY_MIN + gap)));
  cols = Math.min(cols, cards.length); // 列数受卡片数封顶
  const colWidth = (width - (cols - 1) * gap) / cols;
  const colHeights = new Array(cols).fill(0);
  g.classList.add('js-masonry');
  // 三遍分离（写-读-写）防 layout thrashing：先批量设宽、再批量读高、最后批量写 top/left
  cards.forEach((card) => { card.style.width = colWidth + 'px'; card.style.position = 'absolute'; });
  const heights = Array.from(cards, (c) => c.offsetHeight || 0);
  cards.forEach((card, i) => {
    const target = colHeights.indexOf(Math.min(...colHeights)); // 最短列
    card.style.top = colHeights[target] + 'px';
    card.style.left = target * (colWidth + gap) + 'px';
    colHeights[target] += heights[i] + gap;
  });
  const maxH = Math.max(...colHeights, 0);
  g.style.height = maxH ? maxH + 'px' : '';
  // sentinel 贴在最长列底部之下
  const sentinel = g.querySelector(':scope > .lazy-sentinel');
  if (sentinel) {
    sentinel.style.position = 'absolute';
    sentinel.style.top = maxH + 'px';
    sentinel.style.left = '0';
    sentinel.style.width = '100%';
  }
}

/** 防抖重排（resize / 字体载入后）：列数可能变，全量重排。 */
function _scheduleConceptMasonryRelayout() {
  if (_conceptResizeTimer) clearTimeout(_conceptResizeTimer);
  _conceptResizeTimer = setTimeout(() => { _conceptResizeTimer = null; _layoutConceptMasonry(); }, 120);
}

/** 渲染 count 张卡（从 _conceptShown 开始追加）。末尾不足一批时插 sentinel 并挂/复用 IntersectionObserver。
 *  无 IntersectionObserver（jsdom/老浏览器）时由调用方一次性渲染全部。
 *  渲染后同步跑瀑布流定位（消除在流瞬态），对齐公式 _renderFormulaBatch 模式。 */
function _renderConceptBatch(count) {
  const g = $('concepts-grid');
  if (!g || _conceptShown >= _conceptList.length) return;
  const layout = _conceptLayout;
  const end = Math.min(_conceptShown + count, _conceptList.length);
  const frag = document.createDocumentFragment();
  const built = [];
  for (let i = _conceptShown; i < end; i++) {
    const card = _buildConceptCard(_conceptList[i], layout);
    frag.appendChild(card);
    built.push(card);
  }
  // 移除上一批的 sentinel（若有）
  const oldSentinel = g.querySelector('.lazy-sentinel');
  if (oldSentinel) oldSentinel.remove();
  g.appendChild(frag);
  // 定义 3 行截断检测在挂载后跑（detached 元素 scrollHeight 恒 0，检测会误判「不超长」）
  for (const c of built) {
    const cdEl = c.querySelector('.cd');
    if (cdEl && cdEl.scrollHeight > cdEl.clientHeight + 4) cdEl.classList.add('clampable');
  }
  _conceptShown = end;
  // 瀑布流定位（masonry 布局才跑；list 不动）+ wire resize/RO 一次性
  if (layout === 'masonry') {
    if (!_conceptResizeWired) {
      _conceptResizeWired = true;
      window.addEventListener('resize', () => _scheduleConceptMasonryRelayout(), { passive: true });
    }
    // ResizeObserver 盯 grid 本体宽度（侧栏收起/DevTools 开合等不触发 window resize 的场景）
    if (typeof ResizeObserver !== 'undefined' && !_conceptGridRO) {
      _conceptGridROW = g.clientWidth || 0;
      _conceptGridRO = new ResizeObserver(() => {
        const w = g.clientWidth || 0;
        if (w && Math.abs(w - _conceptGridROW) > 1) { _conceptGridROW = w; _scheduleConceptMasonryRelayout(); }
      });
      _conceptGridRO.observe(g);
    }
    _layoutConceptMasonry();
    // 字体异步到位后重排（概念卡主要是文本，行高微变同样会让卡片压到下方——同公式页 v3.51 修）
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready && !_conceptFontsWired) {
      _conceptFontsWired = true;
      document.fonts.ready.then(() => { _scheduleConceptMasonryRelayout(); }).catch(() => {});
    }
  }
  // 还有剩余：插 sentinel + observer 触发下批
  if (_conceptShown < _conceptList.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'lazy-sentinel';
    sentinel.textContent = `加载更多（${_conceptShown}/${_conceptList.length}）…`;
    g.appendChild(sentinel);
    _observeConceptSentinel(sentinel);
    if (layout === 'masonry') _layoutConceptMasonry(); // sentinel 加入后重定位（贴底）
  }
}

/** 让 observer 观察 sentinel。无 IntersectionObserver（jsdom/老浏览器）时一次性渲染剩余全部。 */
function _observeConceptSentinel(sentinel) {
  if (typeof IntersectionObserver === 'undefined') {
    if (_conceptShown < _conceptList.length) _renderConceptBatch(_conceptList.length - _conceptShown);
    return;
  }
  if (!_conceptObserver) {
    _conceptObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          _conceptObserver.unobserve(e.target);
          _renderConceptBatch(_CONCEPT_NEXT_BATCH);
        }
      }
    }, { rootMargin: '600px' });
  }
  _conceptObserver.observe(sentinel);
}

/** grid 级事件委托（一次性绑定，懒加载追加批次不重复绑）。
 *  论文胶囊跳转 / 「+N 篇」展开 / 删除 / 编辑解释。 */
function _wireConceptGridOnce(g) {
  if (g.dataset.wired) return;
  g.dataset.wired = '1';
  g.addEventListener('click', async (e) => {
    // 星标切换（v3.30）：就地翻转 + 侧栏计数联动，不打断浏览（多选模式下让位给选中）
    const starBtn = e.target.closest('[data-star]');
    if (starBtn && !_conceptPickMode) {
      const c = state.concepts.find((x) => x.id === starBtn.dataset.star);
      if (!c) return;
      const next = !c.starred;
      const r = await PATCH('/api/concepts/' + c.id, { starred: next });
      if (r && r.ok) {
        c.starred = next;
        starBtn.classList.toggle('on', next);
        starBtn.title = next ? '取消重点' : '标记为重点（组会讨论 / 复习清单）';
        starBtn.setAttribute('aria-pressed', String(next));
        renderConceptSidebar();
      } else toast((r && r.error) || '操作失败', 'error');
      return;
    }
    // 多选模式优先（v3.29）：点卡片=切换选中，其余动作让位
    if (_conceptPickMode) {
      const pickCard = e.target.closest('.concept-card[data-detail]');
      if (pickCard) {
        e.preventDefault();
        _toggleConceptPick(pickCard.dataset.detail, pickCard);
        return;
      }
    }
    // 论文胶囊跳转：回论文库 → 选中该论文
    const goto = e.target.closest('[data-goto]');
    if (goto) { gotoPaper(goto.dataset.goto); return; }
    // 「+N 篇」展开剩余胶囊
    const more = e.target.closest('[data-more]');
    if (more) {
      more.closest('.meta-line').querySelectorAll('.paper-chip[hidden]').forEach((x) => { x.hidden = false; });
      more.remove();
      return;
    }
    // 删除概念
    const del = e.target.closest('[data-del]');
    if (del) {
      const c = state.concepts.find((x) => x.id === del.dataset.del);
      if (!(await PWDialog.confirm(`删除概念「${c ? c.term : del.dataset.del}」？`, { title: '删除概念', danger: true, okText: '删除' }))) return;
      const r = await DEL('/api/concepts/' + del.dataset.del);
      if (r.ok) {
        toast('概念已删除');
        state.concepts = (state.concepts || []).filter((x) => x.id !== del.dataset.del);
        renderConceptSidebar();
        renderConcepts();
      } else toast(r.error || '删除失败', 'error');
      return;
    }
    // 编辑概念（v3.29：全字段表单——术语/解释/分类/核心度）
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const c = state.concepts.find((x) => x.id === edit.dataset.edit);
      if (c) await editConceptDialog(c);
      return;
    }
    // 卡片本体点击 → 概念详情抽屉（v3.28）。卡内有活动文本选区时不开——
    // 拖选结束的 mouseup 紧跟 click，开抽屉重渲会摧毁选区（同陷阱 32 的语义）。
    const cardEl = e.target.closest('.concept-card[data-detail]');
    if (cardEl) {
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (sel && sel.toString() && cardEl.contains(sel.anchorNode)) return;
      openConceptDetail(cardEl.dataset.detail);
    }
  });
}

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_conceptSort(v) {
  _conceptSort = v;
}
export function set_conceptLayout(v) {
  _conceptLayout = v;
}
