// 概念清单与概念地图制品
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { DEL, PATCH, POST, PUT, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { gotoPaper, renderConceptAlphaBar } from '../formulas/formulas.js';
import { router } from '../core/nav.js';
import { setSidebarCollapsed } from '../views/layout.js';
import { showView } from '../views/view-switch.js';

// ---- 概念清单视图 ----
export async function showConcepts(view) {
  // showView 必须先于所有 await（v3.17）：它排在三个网络请求之后时，深链 /concepts 刷新
  // 会先停在论文页几百毫秒再跳走。先切视图出骨架，数据到了再 render。
  showView('concepts');
  switchConceptView(view || _conceptView); // 路由指定的视图优先于 localStorage 记忆的上次选择

  // state.papers 只由 refresh()（库视图 / 10s 轮询）填充——v3.15 深链 /concepts 时为空，
  // 概念卡片 paperIds 全解析不到 → 误显示「独立条目」（同 formulas 的深链 bug，一并修）。
  const needPapers = !(state.papers || []).length;
  const [{ data }, pr] = await Promise.all([jget('/api/concepts'), needPapers ? jget('/api/papers') : null]);
  state.concepts = data || [];
  if (pr && Array.isArray(pr.data)) state.papers = pr.data;
  // 概念 Markdown 下载链接带当前空间（静态 <a href> 不经 sp()，这里手动注入）
  const dl = document.querySelector('a[href="/api/concepts.md"]');
  if (dl) dl.href = sp('/api/concepts.md');
  // 概念地图制品元信息（从 settings 回显，html 按需 GET 单个）
  try { const s = await jget('/api/settings'); state.conceptMaps = (s && s.data && s.data.conceptMaps) || []; } catch { state.conceptMaps = []; }
  renderConceptSidebar(); // 分类计数与地图制品数要等数据到位
  renderConcepts();
  if (_conceptView === 'maps') renderConceptMaps(); // 首屏 switchConceptView 时制品元信息还没到，数据到位后补渲一次
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
    _startConceptMapPolling();
  } else toast((r && r.error) || '提交失败', 'error');
}

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
      actions = '<button class="btn ghost sm danger" data-cm-del="' + m.id + '" title="取消生成并删除">取消</button>';
    } else if (m.status === 'error') {
      thumbHtml = m.hasHtml
        ? '<div class="cms-thumb" data-cm-thumb="' + m.id + '"></div><div class="cms-thumb-badge err">不完整</div>'
        : '<div class="cms-thumb-status cms-err">生成失败</div>';
      metaHtml = '<span class="cms-item-time cms-error" title="' + escapeHtml(m.error || '') + '">' + escapeHtml(m.error || '生成失败') + '</span>';
      actions =
        (m.hasHtml ? '<button class="btn ghost sm" data-cm-view="' + m.id + '">查看</button>' : '') +
        '<button class="btn ghost sm" data-cm-opt="' + m.id + '">优化</button>' +
        '<button class="btn ghost sm danger" data-cm-del="' + m.id + '">删除</button>';
    } else {
      thumbHtml = '<div class="cms-thumb" data-cm-thumb="' + m.id + '" data-cm-view-thumb="' + m.id + '" title="点击查看"></div>';
      metaHtml = '<span class="cms-item-time">' + t + '</span>';
      actions =
        '<button class="btn ghost sm" data-cm-opt="' + m.id + '">优化</button>' +
        '<button class="btn ghost sm" data-cm-newtab="' + m.id + '">新标签页</button>' +
        '<button class="btn ghost sm danger" data-cm-del="' + m.id + '">删除</button>';
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

// ---- 概念筛选（v3.16）：分类多选 + 共享频次 + 章节出处 ----
// 筛选状态（内存态，不持久化；清空即取消筛选）。
const _conceptFilter = {
  categories: [],   // 选中的分类（多选，空=不限）
  freq: 'all',      // 'all' 全部 | 'shared' 多篇共享（≥2 篇）| 'hot' 高频（≥4 篇）
  hasContext: false, // 有章节出处（context 非空）
};

/** 是否有激活的筛选条件（非默认态）。 */
function _conceptFilterActive() {
  return _conceptFilter.categories.length > 0 || _conceptFilter.freq !== 'all' || _conceptFilter.hasContext;
}

/** 筛选条件个数（用于徽标计数）。 */
function _conceptFilterCount() {
  let n = _conceptFilter.categories.length;
  if (_conceptFilter.freq !== 'all') n++;
  if (_conceptFilter.hasContext) n++;
  return n;
}

/** 更新漏斗按钮激活态徽标（有筛选时显示计数）。 */
function _updateConceptFilterBadge() {
  const badge = $('concept-filter-badge');
  const btn = $('concept-filter-btn');
  if (!badge || !btn) return;
  const n = _conceptFilterCount();
  badge.hidden = n === 0;
  badge.textContent = n;
  btn.classList.toggle('active', n > 0);
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
  { key: 'other', label: '其他' },
];

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

/** 切换概念页视图（清单 / 地图），持久化用户选择，控制两个 pane 显隐 + 工具栏控件可见性。 */
function switchConceptView(view) {
  _conceptView = view;
  localStorage.setItem('pw-concept-view', view);
  const isMaps = view === 'maps';
  const listPane = $('concept-list-pane');
  const mapsPane = $('concept-maps-pane');
  if (listPane) listPane.hidden = isMaps;
  if (mapsPane) mapsPane.hidden = !isMaps;
  // 地图视图下隐藏筛选/布局/排序/下载（它们只对清单有意义）
  document.querySelectorAll('#concept-filter-btn, #concept-layout, #concept-sort, #btn-concepts-md').forEach((el) => {
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

/** 渲染概念页侧栏（v3.17 第二步）：视图（清单 / 地图）+ 分类分面。
 *
 *  分类从漏斗面板搬到这里 —— 分类是「决定看哪一批概念」的分面导航，和论文页的收藏夹同性质，
 *  属于侧栏；漏斗只留「怎么筛」的次级条件（共享频次 / 章节出处）。同一状态只有一处入口。
 *  分类项点击是**多选切换**（同 Zotero 标签选择器），与 _conceptFilter.categories 直接对应。 */
export function renderConceptSidebar() {
  const host = $('side-concepts');
  if (!host) return;
  const counts = {};
  for (const c of state.concepts || []) {
    const k = c.category || 'other';
    counts[k] = (counts[k] || 0) + 1;
  }
  const sel = new Set(_conceptFilter.categories);
  const total = (state.concepts || []).length;
  const mapCount = (state.conceptMaps || []).length;
  // 分类清单**从数据现算**，不是照着 _CONCEPT_CATEGORIES 枚举列——提示词里的枚举只是建议，
  // 模型完全可能返回枚举外的值；照枚举过滤会让那些概念在分面里彻底消失（旧漏斗面板就是这个毛病）。
  // 枚举在这里只用来提供中文标签，顺带定义已知分类的展示顺序。
  const label = Object.fromEntries(_CONCEPT_CATEGORIES.map((c) => [c.key, c.label]));
  const order = _CONCEPT_CATEGORIES.map((c) => c.key);
  const cats = Object.keys(counts).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); // 枚举外的排到最后
    return a.localeCompare(b);
  }).map((k) => ({ key: k, label: label[k] || k }));

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
    <div class="side-section" id="side-concept-cats">
      <div class="side-title">
        <span>分类</span>
        ${sel.size ? '<button class="side-clear" id="side-cat-clear" type="button">清除</button>' : ''}
      </div>
      ${cats.length
    ? cats.map((c) => `<div class="side-item${sel.has(c.key) ? ' active' : ''}" data-cat="${c.key}" title="${c.key}"><span class="cat-dot"></span><span>${escapeHtml(c.label)}</span><span class="count">${counts[c.key]}</span></div>`).join('')
    : '<div class="side-item" style="color:var(--muted2);cursor:default;">（暂无分类）</div>'}
    </div>`;

  host.querySelectorAll('.side-item[data-cview]').forEach((el) => {
    el.onclick = () => router.navigate(el.dataset.cview === 'maps' ? '/concepts/maps' : '/concepts', { keepQuery: true });
  });
  host.querySelectorAll('.side-item[data-cat]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.cat;
      const next = new Set(_conceptFilter.categories);
      if (next.has(k)) next.delete(k); else next.add(k);
      _conceptFilter.categories = [...next];
      _updateConceptFilterBadge();
      renderConceptSidebar();
      renderConcepts();
    };
  });
  const clear = $('side-cat-clear');
  if (clear) clear.onclick = () => {
    _conceptFilter.categories = [];
    _updateConceptFilterBadge();
    renderConceptSidebar();
    renderConcepts();
  };
  const collapse = $('btn-collapse-concepts');
  if (collapse) collapse.onclick = () => setSidebarCollapsed(true);
  // 只同步 active 态，不走 switchConceptView——后者在地图视图下会 renderConceptMaps()，
  // 而那等于卸载重挂全部缩略图 iframe（重跑页内动画），点一下分类不该付这个代价。
  host.querySelectorAll('.side-item[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === _conceptView);
  });
  // 收起态 rail 的 清单/地图 按钮同步 active（与展开侧栏同一份 _conceptView）
  document.querySelectorAll('.rail-ctx[data-ctx="concepts"] .rail-btn[data-cview]').forEach((el) => {
    el.classList.toggle('active', el.dataset.cview === _conceptView);
  });
}

/** 打开概念筛选面板（漏斗按钮触发）：频次单选 + 出处复选（分类分面已移到侧栏）。
 *  复用 filter-pop 模式（遮罩 + 面板，点外部/Esc 关闭）。确定后 renderConcepts。 */
export function openConceptFilterPop() {
  closeConceptFilterPop();
  const btn = $('concept-filter-btn');
  if (!btn) return;
  const mask = document.createElement('div');
  mask.className = 'filter-pop-mask';
  const pop = document.createElement('div');
  pop.className = 'filter-pop concept-filter-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '概念筛选');
  const freqOpt = (k, label) => `<button class="cf-freq-opt${_conceptFilter.freq === k ? ' on' : ''}" data-freq="${k}" type="button">${label}</button>`;
  pop.innerHTML = `
    <div class="cf-section"><div class="cf-label">共享频次</div><div class="cf-freq-opts">${freqOpt('all', '全部')}${freqOpt('shared', '多篇共享 ≥2')}${freqOpt('hot', '高频 ≥4')}</div></div>
    <div class="cf-section cf-row">
      <label class="cf-check"><input type="checkbox" id="cf-ctx" ${_conceptFilter.hasContext ? 'checked' : ''} /><span>有章节出处</span></label>
    </div>
    <div class="cf-foot">
      <button class="btn ghost sm" id="cf-clear" type="button">清除</button>
      <span class="cf-sel"></span>
      <button class="btn sm" id="cf-ok" type="button">确定</button>
    </div>`;
  mask.appendChild(pop);
  mask.onclick = (e) => { if (e.target === mask) closeConceptFilterPop(); };
  pop.onclick = (e) => e.stopPropagation();
  document.body.appendChild(mask);
  // 定位：面板贴在按钮下方
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
  pop.style.left = Math.max(8, r.left + window.scrollX - 240) + 'px'; // 右对齐按钮，防溢出
  // 频次单选
  pop.querySelectorAll('.cf-freq-opt').forEach((opt) => {
    opt.onclick = () => {
      _conceptFilter.freq = opt.dataset.freq;
      pop.querySelectorAll('.cf-freq-opt').forEach((o) => o.classList.toggle('on', o === opt));
    };
  });
  // 清除（只清本面板管的两项——分类分面归侧栏，不在这里连带清掉）
  pop.querySelector('#cf-clear').onclick = () => {
    _conceptFilter.freq = 'all';
    _conceptFilter.hasContext = false;
    _updateConceptFilterBadge();
    closeConceptFilterPop();
    renderConcepts();
  };
  // 确定
  pop.querySelector('#cf-ok').onclick = () => {
    _conceptFilter.hasContext = !!pop.querySelector('#cf-ctx').checked;
    _updateConceptFilterBadge();
    closeConceptFilterPop();
    renderConcepts();
  };
  btn.setAttribute('aria-expanded', 'true');
  // Esc 关闭
  document.addEventListener('keydown', onConceptFilterPopKey);
}

function closeConceptFilterPop() {
  const existing = document.querySelector('.filter-pop-mask');
  if (existing) existing.remove();
  const btn = $('concept-filter-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', onConceptFilterPopKey);
}

function onConceptFilterPopKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeConceptFilterPop(); }
}

export function renderConcepts() {
  // 查询词来自顶栏那个上下文搜索框（v3.17，页内 #concept-q 已退役）
  const q = (($('search') || {}).value || '').trim().toLowerCase();
  const sort = _conceptSort;
  const layout = _conceptLayout;
  // 筛选：搜索词（term/definition 子串）+ 分类 + 频次 + 出处
  let list = state.concepts.filter((c) => !q || (c.term + ' ' + (c.definition || '')).toLowerCase().includes(q));
  if (_conceptFilter.categories.length) {
    list = list.filter((c) => _conceptFilter.categories.includes(c.category || 'other'));
  }
  if (_conceptFilter.freq === 'shared') list = list.filter((c) => (c.paperIds || []).length >= 2);
  else if (_conceptFilter.freq === 'hot') list = list.filter((c) => (c.paperIds || []).length >= 4);
  if (_conceptFilter.hasContext) list = list.filter((c) => !!(c.context && String(c.context).trim()));
  // 排序
  if (sort === 'freq') {
    list = list.slice().sort((a, b) => {
      const d = (b.paperIds || []).length - (a.paperIds || []).length;
      if (d !== 0) return d;
      return String(a.term || '').localeCompare(String(b.term || '')); // 频次相同按字母
    });
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
  renderConceptAlphaBar(sort, q, list);
  // 卡片渲染（懒加载：首批 _CONCEPT_FIRST_BATCH，滚到底由 IntersectionObserver 追加每批）
  const g = $('concepts-grid');
  g.className = 'concepts-grid' + (layout === 'list' ? ' list-view' : ' masonry-view');
  g.innerHTML = '';
  _wireConceptGridOnce(g); // grid 级事件委托（一次性，懒加载追加批次不重复绑）
  if (!list.length) {
    g.innerHTML = '<div class="empty-state">' + (q ? '没有匹配「' + escapeHtml(q) + '」的概念' : '无概念。在论文详情「信息」tab 点「重新抽取并追加」，或多选论文后批量抽取。') + '</div>';
    return;
  }
  _conceptList = list;
  _conceptShown = 0;
  _renderConceptBatch(_CONCEPT_FIRST_BATCH);
}

/** 构造单张概念卡 DOM（masonry / list 两布局）。论文胶囊 + 频次徽章 + 编辑/删除按钮。 */
function _buildConceptCard(c, layout) {
  const card = document.createElement('div');
  card.className = 'concept-card';
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
  const metaHtml = gotoable.length
    ? `<span class="meta-label">出现于</span>${chipsHtml}${moreHtml}${restHtml}`
    : '<span class="meta-label">（独立条目）</span>';
  if (layout === 'list') {
    // 清单视图：单行紧凑——频次徽章 + 术语 + 解释摘要（一行省略）+ 论文数
    card.innerHTML = `
      <span class="lc-freq ${freq > 1 ? '' : 'dim'}"${freq ? ` title="出现在 ${freq} 篇论文中"` : ''}>${freq || '·'}</span>
      <span class="lc-term" title="${escapeHtml(c.term)}">${escapeHtml(c.term)}</span>
      <span class="lc-def" title="${escapeHtml(c.definition || '')}">${escapeHtml(c.definition || '（无解释）')}</span>
      <span class="lc-count">${gotoable.length} 篇</span>
      <div class="row-actions">
        <button class="btn ghost sm" data-edit="${c.id}" title="编辑解释">编辑</button>
        <button class="btn ghost sm danger" data-del="${c.id}" title="删除概念">删除</button>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="ct"><h3>${escapeHtml(c.term)}</h3>${c.category && c.category !== 'other' ? `<span class="cat-badge" title="分类">${escapeHtml(c.category)}</span>` : ''}${freq ? `<span class="freq-badge" data-freq="${freq}" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}
        <div class="row-actions">
          <button class="btn ghost sm" data-edit="${c.id}" title="编辑解释">编辑</button>
          <button class="btn ghost sm danger" data-del="${c.id}" title="删除概念">删除</button>
        </div>
      </div>
      <div class="cd">${escapeHtml(c.definition || '（无解释）')}</div>
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
  for (let i = _conceptShown; i < end; i++) frag.appendChild(_buildConceptCard(_conceptList[i], layout));
  // 移除上一批的 sentinel（若有）
  const oldSentinel = g.querySelector('.lazy-sentinel');
  if (oldSentinel) oldSentinel.remove();
  g.appendChild(frag);
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
      if (r.ok) toast('概念已删除');
      else toast(r.error || '删除失败', 'error');
      showConcepts();
      return;
    }
    // 编辑解释
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const c = state.concepts.find((x) => x.id === edit.dataset.edit);
      if (!c) return;
      const def = await PWDialog.prompt('编辑「' + c.term + '」的解释：', { title: '编辑概念解释', value: c.definition || '', multiline: true, okText: '保存' });
      if (def != null) {
        const r = await PATCH('/api/concepts/' + c.id, { definition: def });
        if (r.ok) toast('概念解释已更新');
        else toast(r.error || '保存失败', 'error');
        showConcepts();
      }
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
