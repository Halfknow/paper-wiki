// 论文列表与全文检索结果渲染
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { api, jget } from '../core/api.js';
import { $, selectionWithin } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { escapeHtml, starBadge, statusDot } from '../core/format.js';
import { gotoPaperRoute, router } from '../core/nav.js';
import { buildPath } from '../core/router.js';
import { state } from '../core/state.js';
import { chipList, compactChipList, progressPercent, readStatusLabel, shortAuthors, statusLabel, toast } from '../core/ui-kit.js';
import { reader } from '../detail/info-tab.js';
import { togglePick } from './bulk.js';
import { refresh } from './refresh.js';

// ---- 列表 ----
// 拖选文本后的 click/dblclick 抑制：拖选结束的 mouseup 会紧跟一个 click，若因此触发
// 打开论文/阅读器，路由重建立刻摧毁选区——「选中了却复制不了」。选区非空且落在本条目内时，
// 视为选择手势的尾巴，不触发导航。（普通点击：mousedown 已使旧选区塌陷，isCollapsed 为真，不受影响。）
const hasSelectionWithin = selectionWithin;

/** 全文检索（搜索框 body: 触发）：GET /api/search 命中论文 + 高亮片段，列表切到结果视图。 */
async function runFulltextSearch(query) {
  state.ft = { query, results: null }; // results=null → loading 态
  renderList();
  try {
    const r = await jget('/api/search?q=' + encodeURIComponent(query));
    if (!state.ft || state.ft.query !== query) return; // 已被新查询/退出覆盖
    state.ft.results = (r && r.data && r.data.results) || [];
  } catch (e) {
    if (state.ft) state.ft.results = [];
    toast(e.message || '全文检索失败', 'error');
  }
  renderList();
}

/** v3.2 统一搜索触发：根据 DSL 是否含 body:/in:body 分流。
 *  - body: → /api/search（正文检索 + 元数据 id 子集交集）
 *  - 否则 → /api/papers?q=DSL（元数据即时筛选，后端解析字段前缀）
 *  immediate=true 时跳过防抖（Enter 触发）。 */
export function triggerSearch(value) {
  const v = String(value != null ? value : ($('search') && $('search').value) || '').trim();
  const isBody = window.PaperWikiSearch && window.PaperWikiSearch.isBodySearch(v);
  if (isBody) {
    runFulltextSearch(v);
  } else {
    if (state.ft) { state.ft = null; renderList(); }
    refresh();
  }
}

/** DSL 模式提示：含 body: 时给搜索框加 .body-mode 类（CSS 显示正文检索态）。 */
export function updateSearchModeIndicator(v) {
  const inp = $('search');
  if (!inp) return;
  const isBody = window.PaperWikiSearch && window.PaperWikiSearch.isBodySearch(v);
  inp.classList.toggle('body-mode', !!isBody);
}

/** 渲染全文检索结果视图（banner + 命中论文卡 + 高亮 snippet；snippet 由后端转义并 <mark>） */
function renderFulltextResults(ul) {
  const ft = state.ft;
  const banner = document.createElement('li');
  banner.className = 'paper-item ft-banner';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <span class="ft-banner-text">全文检索「${escapeHtml(ft.query)}」${ft.results == null ? '…' : ` · 命中 ${ft.results.length} 篇`}</span>
    <button class="btn ghost xs icon ft-banner-close" type="button" title="退出全文检索 (Esc)" aria-label="退出全文检索">${icon('x', { size: 14 })}</button>`;
  banner.querySelector('.ft-banner-close').onclick = () => { state.ft = null; renderList(); };
  ul.appendChild(banner);
  if (ft.results == null) {
    ul.insertAdjacentHTML('beforeend', '<li class="paper-item empty-list">正在检索论文正文…</li>');
    return;
  }
  if (!ft.results.length) {
    ul.insertAdjacentHTML('beforeend', '<li class="paper-item empty-list">正文中未找到该关键词。英文词支持词形变化（mechanism/mechanisms），中文按子串匹配。</li>');
    return;
  }
  for (const p of ft.results) {
    const li = document.createElement('li');
    li.className = 'paper-item ft-item' + (state.current === p.id ? ' active' : '');
    li.dataset.id = p.id;
    const title = escapeHtml(p.title || '') + (p.rating > 0 ? starBadge(p.rating) : '');
    const meta = escapeHtml(`${(p.authors || [])[0] || '未知作者'}${p.year ? ' · ' + p.year : ''}`);
    li.innerHTML = `
      <div class="pt"><span class="dot ${statusDot(p)}"></span>${title}</div>
      <div class="pm"><span>${meta}</span><span class="mini-metric badge">${p.matches >= 50 ? '50+' : p.matches} 处命中</span></div>
      <div class="ft-snips">${(p.snippets || []).map((sn) => `<div class="ft-snip">${sn}</div>`).join('')}</div>`;
    li.onclick = () => { if (hasSelectionWithin(li)) return; gotoPaperRoute(p.id); };
    ul.appendChild(li);
  }
}

export function renderList() {
  const ul = $('paper-list');
  ul.innerHTML = '';
  ul.classList.toggle('compact', state.compact);
  if (state.ft) return renderFulltextResults(ul);
  // 视图密度分段控件：两个按钮固定图标，按 state.compact 切 active 高亮（不再动态换 innerHTML）
  const vc = $('view-compact'), vf = $('view-comfort');
  if (vc && vf) {
    vc.classList.toggle('active', state.compact);
    vc.setAttribute('aria-pressed', String(state.compact));
    vf.classList.toggle('active', !state.compact);
    vf.setAttribute('aria-pressed', String(!state.compact));
  }
  if (!state.papers.length) {
    // 首次加载（数据未到）：骨架行替代空态——深链首帧不再是空白列表（R2）
    if (state._listLoading) {
      ul.innerHTML = Array.from({ length: 6 }, () => `<li class="paper-item skel-card" aria-hidden="true"><div class="skel skel-title"></div><div class="skel skel-meta"></div><div class="skel-chips"><i class="skel"></i><i class="skel"></i><i class="skel"></i></div><div class="skel skel-progress"></div></li>`).join('');
      return;
    }
    const f = state.filter;
    // 注意字段名：筛选态是 tags/topics（数组）——旧的 f.tag/f.topic 恒 undefined，
    // 仅按标签/主题筛选零命中时会误显示「欢迎来到 PaperWiki」新手引导
    const hasFilter = f.q || f.status || f.readStatus || (f.tags && f.tags.length) || (f.topics && f.topics.length) || f.starred || f.folder || f.mode;
    if (!hasFilter) {
      // 真正的空库：给新手引导，而不是一句干巴巴的"暂无论文"
      ul.innerHTML = `<li class="paper-item empty-guide">
        <div class="eg-card">
          <div class="eg-emoji"><svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M14 4v6h6"/><path d="M8 13h6"/><path d="M8 16h4"/></svg></div>
          <h3>欢迎来到 PaperWiki</h3>
          <p class="eg-sub">把 arXiv 论文 PDF 丢进来，AI 帮你读、总结、抽概念、打标签。</p>
          <ol class="eg-steps">
            <li><b>1.</b> 把 PDF 放进程序的 <code>papers/</code> 文件夹</li>
            <li><b>2.</b> 点右上角「扫描」，等待 AI 处理（可在顶栏看进度）</li>
            <li><b>3.</b> 左侧列表选一篇，看总结 · 双击或回车打开 PDF 做高亮笔记</li>
          </ol>
          <p class="eg-tip">首次使用：点左下角「设置」配置 AI 接口（API Base / Key / 模型），即可开始自动总结。</p>
        </div>
      </li>`;
    } else {
      ul.innerHTML = `<li class="paper-item empty-list">
        <div class="empty-state">
          <div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/></svg></div>
          <p class="es-main">没有匹配的论文</p>
          <p class="es-sub">当前筛选（搜索词 / 标签 / 主题 / 状态）过窄，试试放宽条件。</p>
          <div class="es-actions"><button class="btn sm es-clear-filter" type="button">清除全部筛选</button></div>
        </div>
      </li>`;
      ul.querySelector('.es-clear-filter').onclick = () => {
        state.filter = { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: state.filter.sort };
        const searchBox = document.getElementById('search');
        if (searchBox && searchBox.value) searchBox.value = '';
        refresh();
      };
    }
    return;
  }
  for (const p of state.papers) {
    const li = document.createElement('li');
    li.className = 'paper-item' + (state.current === p.id ? ' active' : '');
    li.dataset.id = p.id;
    li.dataset.status = p.status || '';
    li.setAttribute('aria-selected', state.current === p.id ? 'true' : 'false');
    const sel = state.pickMode && state.selected.has(p.id) ? icon('check-square') : (state.pickMode ? icon('square') : '');
    const title = escapeHtml(p.title || p.filename) + (p.rating > 0 ? starBadge(p.rating) : '');
    const read = readStatusLabel(p.readStatus);
    const progress = progressPercent(p);
    if (state.compact) {
      const meta = escapeHtml(`${(p.authors || [])[0] || '未知作者'}${p.year ? ' · ' + p.year : ''}`);
      const chips = compactChipList(p, 4);
      const isBusy = ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status);
      li.innerHTML = `
        <div class="compact-row">
          <span class="compact-pick-slot ${state.pickMode ? 'on' : ''}">${state.pickMode ? sel : ''}</span>
          <span class="dot ${statusDot(p)}${isBusy ? ' busy' : ''}" title="${statusLabel(p.status)}"></span>
          <div class="compact-main">
            <div class="compact-title-line">
              <span class="compact-title">${title}</span>
              ${isBusy ? `<span class="busy-tag badge warning is-live">${statusLabel(p.status)}</span>` : `<span class="read-chip badge">${read}</span>`}
              ${progress != null && progress > 0 ? `<span class="mini-metric badge read">${progress}%</span>` : ''}
              ${!isBusy && p.conceptCount ? `<span class="mini-metric badge">${p.conceptCount}</span>` : ''}
            </div>
            <div class="compact-meta">${meta}</div>
            ${progress != null && progress > 0 && progress < 100 ? `<div class="progress-row thin"><div class="progress-bar"><i style="width:${progress}%"></i></div></div>` : ''}
            ${chips ? `<div class="compact-chips">${chips}</div>` : ''}
          </div>
        </div>`;
    } else {
      // 舒适：原完整布局
      const topics = chipList(p.topics, 'topic', 3);
      const tags = chipList(p.tags, 'tag', 4);
      const isBusy = ['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status);
      const contHint = (!isBusy && progress != null && progress > 0 && progress < 100) ? ' · 双击继续阅读' : '';
      li.innerHTML = `
        ${state.pickMode ? `<span class="pick">${sel}</span>` : ''}
        <div class="pt"><span class="dot ${statusDot(p)}${isBusy ? ' busy' : ''}" title="${statusLabel(p.status)}"></span>${title}</div>
        <div class="pm">
          <span>${escapeHtml(shortAuthors(p))}${p.year ? ' · ' + p.year : ''}</span>
          ${isBusy ? `<span class="busy-tag badge warning is-live">${statusLabel(p.status)}</span>` : `<span class="read-chip badge">${read}</span>`}
          ${p.conceptCount ? `<span class="mini-metric badge">${p.conceptCount} 概念</span>` : ''}
          ${progress != null && progress >= 100 ? '<span class="read-chip badge success">读完</span>' : ''}
        </div>
        <div class="chips">${topics}${tags}</div>
        ${progress != null ? `<div class="progress-row"><div class="progress-bar"><i style="width:${progress}%"></i></div><span title="${escapeHtml('读到 ' + progress + '%' + contHint)}">${progress}%</span></div>` : ''}`;
    }
    li.onclick = () => { if (hasSelectionWithin(li)) return; state.pickMode ? togglePick(p.id) : gotoPaperRoute(p.id); };
    li.ondblclick = () => { if (hasSelectionWithin(li)) return; router.navigate(buildPath('/reader/:id', { id: p.id }), { keepQuery: true }); };
    // 拖入收藏夹：draggable 起拖时把 id 集（多选=全部选中、否则=本篇）写入 dataTransfer。
    // 不再常驻 draggable=true——Chromium UA 样式会给 [draggable] 元素上 user-select:none，
    // 整张卡片的标题/作者/标签全部无法选中复制（「列表文字复制不了」的根因），且作者 CSS
    // 盖不掉（拖拽手势恒优先于选择）。改为 hover 分派：悬在文本区（标题/作者/chips）→ 不可拖
    // （拖动手势=文本选择）；悬在留白/圆点/进度条 → 可拖（拖入侧栏收藏夹）。
    // draggable 必须在 mousedown 之前就位（mousedown 里再设来不及触发原生 DnD），故用 mouseover。
    li.draggable = false;
    li.addEventListener('mouseover', (e) => {
      li.draggable = !e.target.closest('.pt, .pm, .chips, .compact-title-line, .compact-meta, .compact-chips, .ft-snips');
    });
    li.addEventListener('dragstart', (e) => {
      const ids = state.pickMode && state.selected.size ? [...state.selected] : [p.id];
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/paperwiki-ids', JSON.stringify(ids));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.draggable = false; // 复位（hover 分派的临时态），防拖完卡在可拖态挡住文本选择
      li.classList.remove('dragging');
      document.querySelectorAll('.side-item.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
    ul.appendChild(li);
  }
}
