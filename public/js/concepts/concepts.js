// 概念清单与概念地图制品
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { DEL, PATCH, POST, PUT, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { gotoPaper, renderConceptAlphaBar } from '../formulas/formulas.js';
import { showView } from '../views/view-switch.js';

// ---- 概念清单视图 ----
export async function showConcepts(view) {
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
  showView('concepts');
  renderConcepts();
  switchConceptView(view || _conceptView); // 路由指定的视图优先于 localStorage 记忆的上次选择
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

/** 切换概念页视图（清单 / 地图），持久化用户选择，控制两个 pane 显隐 + 工具栏控件可见性。 */
function switchConceptView(view) {
  _conceptView = view;
  localStorage.setItem('pw-concept-view', view);
  const isMaps = view === 'maps';
  const listPane = $('concept-list-pane');
  const mapsPane = $('concept-maps-pane');
  if (listPane) listPane.hidden = isMaps;
  if (mapsPane) mapsPane.hidden = !isMaps;
  // 地图视图下隐藏搜索/布局/排序（它们只对清单有意义）
  document.querySelectorAll('#concept-q, #concept-layout, #concept-sort').forEach((el) => {
    el.style.display = isMaps ? 'none' : '';
  });
  document.querySelectorAll('#concept-view button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (isMaps) renderConceptMaps();
}

export function renderConcepts() {
  const q = ($('concept-q').value || '').trim().toLowerCase();
  const sort = _conceptSort;
  const layout = _conceptLayout;
  // 筛选
  let list = state.concepts.filter((c) => !q || (c.term + ' ' + (c.definition || '')).toLowerCase().includes(q));
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
  // 卡片渲染
  const g = $('concepts-grid');
  g.className = 'concepts-grid' + (layout === 'list' ? ' list-view' : ' masonry-view');
  g.innerHTML = '';
  if (!list.length) {
    g.innerHTML = '<div class="empty-state">' + (q ? '没有匹配「' + escapeHtml(q) + '」的概念' : '无概念。在论文详情「信息」tab 点「重新抽取并追加」，或多选论文后批量抽取。') + '</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of list) {
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
    frag.appendChild(card);
  }
  g.appendChild(frag);
  // 论文胶囊跳转：回论文库 → 选中该论文 → 列表滚动定位 + 高亮
  g.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => gotoPaper(b.dataset.goto));
  // 「+N 篇」展开剩余胶囊
  g.querySelectorAll('[data-more]').forEach((b) => b.onclick = () => {
    b.closest('.meta-line').querySelectorAll('.paper-chip[hidden]').forEach((x) => { x.hidden = false; });
    b.remove();
  });
  g.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const c = state.concepts.find((x) => x.id === b.dataset.del);
    if (!(await PWDialog.confirm(`删除概念「${c ? c.term : b.dataset.del}」？`, { title: '删除概念', danger: true, okText: '删除' }))) return;
    const r = await DEL('/api/concepts/' + b.dataset.del);
    if (r.ok) toast('概念已删除');
    else toast(r.error || '删除失败', 'error');
    showConcepts();
  });
  g.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const c = state.concepts.find((x) => x.id === b.dataset.edit);
    const def = await PWDialog.prompt('编辑「' + c.term + '」的解释：', { title: '编辑概念解释', value: c.definition || '', multiline: true, okText: '保存' });
    if (def != null) {
      const r = await PATCH('/api/concepts/' + c.id, { definition: def });
      if (r.ok) toast('概念解释已更新');
      else toast(r.error || '保存失败', 'error');
      showConcepts();
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
