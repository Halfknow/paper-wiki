const api = async (p, opt) => {
  const r = await fetch(p, opt);
  if (r.headers.get('content-type', '').includes('application/json')) return r.json();
  return r;
};
const jget = (p) => fetch(p).then((r) => r.json());
const jsend = (method) => (p, body) => fetch(p, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const PATCH = jsend('PATCH');
const POST = jsend('POST');
const PUT = jsend('PUT');
const DEL = (p) => fetch(p, { method: 'DELETE' }).then((r) => r.json());

/** 网络安全版 jget：fetch 层错误（离线/DNS/拒绝连接/超时）返回 {ok:false,error} 而非抛出，
 *  供 refresh() 的 Promise.allSettled 用——单个接口失败时不至于整页卡死或清空列表。 */
async function safeGet(p) {
  try {
    const r = await fetch(p);
    const body = await r.json().catch(() => null);
    if (body && typeof body === 'object') return body;
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '网络错误' };
  }
}

const state = {
  papers: [], tags: [], topics: [], folders: [], concepts: [],
  current: null, detail: null, tab: 'summary',
  filter: { q: '', status: '', readStatus: '', tag: '', topic: '', starred: false, folder: '', mode: '', sort: 'addedDesc' },
  pickMode: false,
  selected: new Set(),
  compact: localStorage.getItem('pw-compact') === '1',
  sidebarCollapsed: localStorage.getItem('pw-sidebar') === 'collapsed',
  listWidth: Number(localStorage.getItem('pw-list-width')) || 410,
};

// 笔记编辑的单一状态（模块级），避免每次 renderDetail/renderTabBody 重建局部 saveTimer
// 导致旧定时器里那次 patch 永不执行、切论文时丢失最后 800ms 的输入。
// 结构：{ id, el, dirty, saveTimer, hint }
let notesState = null;

/** 立即落盘待保存的笔记。在切论文/切 tab/renderDetail 重建前调用。
 *  返回的 Promise 调用方可 await 也可不 await（fire-and-forget 也安全：值已先从 DOM 读出）。 */
async function flushPendingNotes() {
  const ns = notesState;
  if (!ns || !ns.dirty) return;
  const value = ns.el.value; // 先读出最新内容，避免 DOM 被重建后读空
  clearTimeout(ns.saveTimer);
  ns.saveTimer = null;
  ns.dirty = false;          // 标记已提交，防止重入重复写
  const hint = ns.hint;
  try {
    await PATCH('/api/papers/' + encodeURIComponent(ns.id), { notes: value });
    if (hint) hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
  } catch (e) {
    // 落盘失败：恢复 dirty 以便下次再试，并提示
    ns.dirty = true;
    if (hint) hint.textContent = '保存失败，将重试';
    console.warn('[PaperWiki] notes flush failed', e && e.message);
  }
}

const $ = (id) => document.getElementById(id);
const PALETTE = window.READER_PALETTE || ['#4f46e5', '#7c3aed', '#0891b2', '#d97706', '#db2777', '#2563eb', '#16a34a', '#475569'];
// ---- 统一标签/主题配色（文章 chips + 设置中心分类管理 共用）----
// 8 色柔和配色：name 稳定 hash → 下标 → {主色, 柔底, 柔边}，全文统一、告别单调灰标签。
// indigo/violet/cyan/blue/pink/amber 六色延续旧主题视觉，新增 green/rose 扩展多样性。
const CHIP_PALETTE = [
  { c: '#4f46e5', s: '#eef2ff', b: '#c7d2fe' }, // indigo
  { c: '#7c3aed', s: '#f3e8ff', b: '#ddd6fe' }, // violet
  { c: '#0891b2', s: '#cffafe', b: '#a5f3fc' }, // cyan
  { c: '#2563eb', s: '#dbeafe', b: '#bfdbfe' }, // blue
  { c: '#db2777', s: '#fce7f3', b: '#fbcfe8' }, // pink
  { c: '#d97706', s: '#fef3c7', b: '#fde68a' }, // amber
  { c: '#16a34a', s: '#dcfce7', b: '#bbf7d0' }, // green
  { c: '#e11d48', s: '#ffe4e6', b: '#fecdd3' }, // rose
];
/** 名字 → 稳定下标（djb2-like hash mod 8，保证同名 chip 永远同色）。 */
function chipIndex(name) {
  let h = 0;
  for (const ch of String(name ?? '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % CHIP_PALETTE.length;
}
/** 返回某 name 的配色对象 {c 主色, s 柔底, b 柔边}。 */
function chipOf(name) {
  return CHIP_PALETTE[chipIndex(name)];
}

function statusDot(p) {
  if (p.status === 'ready') return 'ready';
  if (p.status === 'error') return 'error';
  if (p.status === 'missing') return 'missing';
  return 'busy';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 星级评分（1–5）----
// 线性 SVG 星形：filled 表示实心，否则描边。统一替换原 emoji ⭐ / ★ ☆。
const STAR_PATH = 'M12 2.6l2.9 6.05 6.6.78-4.9 4.5 1.32 6.52L12 17.9l-5.92 3.07 1.32-6.52-4.9-4.5 6.6-.78z';
function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
}
/** 紧凑角标：列表标题后跟单颗星 + 数字。 */
function starBadge(rating) {
  const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return r ? `<span class="star-badge"><i class="star on">${starSvg(true)}</i>${r}</span>` : '';
}

function renderMd(md) {
  const raw = marked.parse(md || '', { breaks: true });
  let html = DOMPurify.sanitize(raw);
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => katex.renderToString(e, { displayMode: true, throwOnError: false }));
  html = html.replace(/\$([^$\n]+?)\$/g, (_, e) => katex.renderToString(e, { displayMode: false, throwOnError: false }));
  return html;
}

function toast(message, type = 'info') {
  const root = $('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 180);
  }, type === 'error' ? 5200 : 3200);
}

function setBusy(el, busy, label) {
  if (!el) return;
  if (busy) {
    el.dataset.prevText = el.textContent;
    el.textContent = label || '处理中…';
    el.disabled = true;
    el.classList.add('is-busy');
  } else {
    el.textContent = el.dataset.prevText || el.textContent;
    el.disabled = false;
    el.classList.remove('is-busy');
    delete el.dataset.prevText;
  }
}

function statusLabel(status) {
  return ({ ready: '就绪', error: '出错', missing: '缺失', pending: '排队', parsing: '解析中', enriching: '补元数据', summarizing: '总结中' }[status] || '处理中');
}

function readStatusLabel(status) {
  return ({ unread: '未读', reading: '在读', done: '已读' }[status || 'unread'] || '未读');
}

function shortAuthors(p, limit = 2) {
  const authors = p.authors || [];
  if (!authors.length) return '未知作者';
  const base = authors.slice(0, limit).join(', ');
  return authors.length > limit ? base + ' 等' : base;
}

function progressPercent(p) {
  return (p.readProgress && p.readProgress.total)
    ? Math.min(100, Math.max(0, Math.round(100 * p.readProgress.page / p.readProgress.total)))
    : null;
}

function chipList(items, cls, limit = 4, clsFor) {
  const shown = (items || []).slice(0, limit);
  const rest = Math.max(0, (items || []).length - shown.length);
  // 统一内联配色：主题/标签按名 hash 落到同一套柔和 8 色，告别单调灰标签。
  return shown.map((t) => {
    const extra = clsFor ? ' ' + clsFor(t) : '';
    const p = chipOf(t);
    return `<span class="${cls}${extra}" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(t)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted">+${rest}</span>` : '');
}

function compactChipList(p, limit = 4) {
  const items = [
    ...(p.topics || []).map((name) => ({ name, cls: 'topic' })),
    ...(p.tags || []).map((name) => ({ name, cls: 'tag' })),
  ];
  const shown = items.slice(0, limit);
  const rest = Math.max(0, items.length - shown.length);
  return shown.map((it) => {
    const p = chipOf(it.name);
    return `<span class="${it.cls}" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(it.name)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted compact-more">+${rest}</span>` : '');
}

function renderStats(stats) {
  // 处理中时，把当前在跑的阶段从 state.papers 聚合出来，让批量首扫不再是黑盒
  let processingHtml = '';
  if (stats.processing > 0) {
    const stageCount = {};
    for (const p of state.papers) {
      if (['pending', 'parsing', 'enriching', 'summarizing'].includes(p.status)) {
        const label = statusLabel(p.status);
        stageCount[label] = (stageCount[label] || 0) + 1;
      }
    }
    const detail = Object.entries(stageCount)
      .map(([k, v]) => `${k} ${v}`).join(' · ');
    processingHtml = `<span class="stat-pill busy" title="${escapeHtml(detail || '处理中')}">
      <span class="pulse"></span>${stats.processing} 处理中${detail ? ' · ' + escapeHtml(detail) : ''}</span>`;
  }
  $('stats').innerHTML = `
    <span class="stat-pill good">${stats.ready}/${stats.total} 就绪</span>
    ${processingHtml}
    ${stats.error ? `<span class="stat-pill bad">${stats.error} 错误</span>` : ''}
    <span class="stat-pill">${stats.concepts} 概念</span>`;
}

// ---- 刷新数据 ----
async function refresh() {
  const params = new URLSearchParams();
  const f = state.filter;
  if (f.q) params.set('q', f.q);
  if (f.status) {
    if (['unread', 'reading', 'done'].includes(f.status)) params.set('readStatus', f.status);
    else params.set('status', f.status);
  }
  if (f.readStatus) params.set('readStatus', f.readStatus);
  if (f.tag) params.set('tag', f.tag);
  if (f.topic) params.set('topic', f.topic);
  if (f.folder) params.set('folder', f.folder);
  if (f.starred) params.set('starred', '1');
  if (f.sort) params.set('sort', f.sort);

  // 接口级降级：每个请求独立成功/失败，单个接口（尤其 papers 列表）失败时保留旧数据，
  // 而不是整页清空或卡死。safeGet 把网络错误吞成 {ok:false}，这里再据此分派。
  const results = await Promise.all([
    safeGet('/api/papers?' + params), safeGet('/api/tags'), safeGet('/api/topics'),
    safeGet('/api/folders'), safeGet('/api/stats'),
  ]);
  const [papers, tags, topics, folders, stats] = results;
  const failed = results.filter((x) => !x.ok);
  // 仅在各自成功时更新对应 state；失败的保留旧值，UI 不清空
  if (papers.ok) {
    state.papers = papers.data || [];
    renderList();
  }
  if (tags.ok) state.tags = tags.data || [];
  if (topics.ok) state.topics = topics.data || [];
  if (folders.ok) state.folders = folders.data || [];
  if (stats.ok) renderStats(stats.data || { ready: 0, total: 0, processing: 0, error: 0, concepts: 0 });
  // 至少 papers 成功时才重渲染依赖它的侧栏/筛选器，避免半失败态下清空
  if (papers.ok) {
    renderSidebar();
    renderFilters();
  }
  if (failed.length) toast(`刷新部分失败：${failed.length} 个接口（已保留旧数据）`, 'error');
  if (state.current && !state.detail) ; // 列表选中后由 select 拉详情
  if (state.current) {
    // 列表里刷新当前项的概要
    const fresh = state.papers.find((p) => p.id === state.current);
    if (fresh && state.detail) {
      state.detail = { ...state.detail, ...fresh };
      renderDetail();
    }
  }
}

// ---- 侧栏 ----
function renderSidebar() {
  // 计数：全部/星标/未读
  $('cnt-all').textContent = state.papers.length || '';
  $('cnt-star').textContent = state.papers.filter((p) => p.starred).length || '';
  $('cnt-unread').textContent = state.papers.filter((p) => (p.readStatus || 'unread') === 'unread').length || '';

  // 高亮当前视图
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => {
    const m = el.dataset.mode;
    // 仅星标特殊：starred 模式
    el.classList.toggle('active',
      (m === 'starred' && state.filter.starred) ||
      (m === 'all' && !state.filter.mode && !state.filter.starred && !state.filter.folder && !state.filter.readStatus) ||
      (m === 'unread' && (state.filter.mode === 'unread' || state.filter.readStatus === 'unread')));
  });

  // 收藏夹列表
  const fl = $('folder-list');
  fl.innerHTML = '';
  $('folder-empty').hidden = state.folders.length > 0;
  for (const fo of state.folders) {
    const el = document.createElement('div');
    el.className = 'side-item' + (state.filter.folder === fo.id ? ' active' : '');
    el.dataset.folderId = fo.id;
    el.innerHTML = `<span class="swatch" style="background:${escapeHtml(fo.color)}"></span>
      <span>${escapeHtml(fo.name)}</span>
      <span class="count">${fo.count || ''}</span>
      <span class="ico folder-edit" data-edit="${fo.id}" title="编辑收藏夹" aria-label="编辑收藏夹"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>`;
    el.onclick = (e) => {
      if (e.target.dataset.edit) { openFolderModal(fo); return; }
      setView({ folder: fo.id, mode: '', starred: false, readStatus: '', status: '' });
    };
    setupFolderDropTarget(el, fo);
    fl.appendChild(el);
  }
}

/** 把论文拖入收藏夹：dragover 高亮目标，drop 把 id 加入该收藏夹（去重），批量多选一次性处理。 */
function setupFolderDropTarget(el, fo) {
  const readIds = (e) => {
    try { return JSON.parse(e.dataTransfer.getData('text/paperwiki-ids') || '[]'); }
    catch { return []; }
  };
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/paperwiki-ids')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    const ids = readIds(e);
    if (!ids.length) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    await addPapersToFolder(ids, fo.id);
  });
}

/** 把若干论文加入收藏夹（合并去重，仅 PATCH 真正变动的论文）。 */
async function addPapersToFolder(ids, folderId) {
  const toUpdate = [];
  for (const id of ids) {
    const p = state.papers.find((x) => x.id === id);
    if (!p) continue;
    const cur = new Set(p.folders || []);
    if (cur.has(folderId)) continue; // 已在该夹，跳过
    cur.add(folderId);
    toUpdate.push({ id, folders: [...cur] });
  }
  if (!toUpdate.length) { toast('这些论文已在该收藏夹'); return; }
  let okN = 0;
  for (const u of toUpdate) {
    const r = await PATCH('/api/papers/' + encodeURIComponent(u.id), { folders: u.folders });
    if (r.ok) okN++;
  }
  toast(okN === toUpdate.length ? `已把 ${okN} 篇加入收藏夹` : `已加入 ${okN}/${toUpdate.length} 篇（部分失败）`, okN === toUpdate.length ? 'success' : 'error');
  refresh();
}

function setView(patch) {
  // 切视图时清掉与之互斥的筛选
  state.filter = { ...state.filter, ...patch };
  if (patch.folder !== undefined || patch.mode !== undefined || patch.starred !== undefined) {
    // 选中具体视图时，重置这些维度
  }
  refresh();
}

// ---- 列表 ----
function renderList() {
  const ul = $('paper-list');
  ul.innerHTML = '';
  ul.classList.toggle('compact', state.compact);
  // 紧凑/舒适视图切换：换线性 SVG（紧凑＝单行条；舒适＝三行）。紧凑态加 active 强调。
  $('btn-compact').innerHTML = state.compact
    ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="3.5" rx="1"/><rect x="3" y="11" width="18" height="3.5" rx="1"/><rect x="3" y="17" width="18" height="2.5" rx="1"/></svg>';
  $('btn-compact').title = state.compact ? '切回舒适视图' : '切到紧凑视图';
  $('btn-compact').classList.toggle('active', state.compact);
  if (!state.papers.length) {
    const f = state.filter;
    const hasFilter = f.q || f.status || f.readStatus || f.tag || f.topic || f.starred || f.folder || f.mode;
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
      ul.innerHTML = '<li class="paper-item empty-list">暂无匹配论文。可以调整筛选，或把 PDF 放入 papers/ 后点击「扫描」。</li>';
    }
    return;
  }
  for (const p of state.papers) {
    const li = document.createElement('li');
    li.className = 'paper-item' + (state.current === p.id ? ' active' : '');
    li.dataset.status = p.status || '';
    li.setAttribute('aria-selected', state.current === p.id ? 'true' : 'false');
    const sel = state.pickMode && state.selected.has(p.id) ? '☑' : (state.pickMode ? '☐' : '');
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
              ${isBusy ? `<span class="busy-tag">${statusLabel(p.status)}</span>` : `<span class="read-chip">${read}</span>`}
              ${progress != null && progress > 0 ? `<span class="mini-metric read">${progress}%</span>` : ''}
              ${!isBusy && p.conceptCount ? `<span class="mini-metric">${p.conceptCount}</span>` : ''}
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
        ${state.pickMode ? `<span class="pick" style="font-size:14px;">${sel}</span>` : ''}
        <div class="pt"><span class="dot ${statusDot(p)}${isBusy ? ' busy' : ''}" title="${statusLabel(p.status)}"></span>${title}</div>
        <div class="pm">
          <span>${escapeHtml(shortAuthors(p))}${p.year ? ' · ' + p.year : ''}</span>
          ${isBusy ? `<span class="busy-tag">${statusLabel(p.status)}</span>` : `<span class="read-chip">${read}</span>`}
          ${p.conceptCount ? `<span class="mini-metric">${p.conceptCount} 概念</span>` : ''}
          ${progress != null && progress >= 100 ? '<span class="read-chip done">读完</span>' : ''}
        </div>
        <div class="chips">${topics}${tags}</div>
        ${progress != null ? `<div class="progress-row"><div class="progress-bar"><i style="width:${progress}%"></i></div><span title="${escapeHtml('读到 ' + progress + '%' + contHint)}">${progress}%</span></div>` : ''}`;
    }
    li.onclick = () => state.pickMode ? togglePick(p.id) : select(p.id);
    li.ondblclick = () => openReader(p);
    // 拖入收藏夹：draggable 起拖时把 id 集（多选=全部选中、否则=本篇）写入 dataTransfer。
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      const ids = state.pickMode && state.selected.size ? [...state.selected] : [p.id];
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/paperwiki-ids', JSON.stringify(ids));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      document.querySelectorAll('.side-item.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
    ul.appendChild(li);
  }
}

function renderFilters() {
  $('filter-status').value = state.filter.status || state.filter.readStatus || '';
  $('filter-starred').checked = state.filter.starred;
  // 标签下拉
  const tagSel = $('filter-tag'); const tagCur = tagSel.value;
  tagSel.innerHTML = '<option value="">全部标签</option>' +
    state.tags.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${t.count})</option>`).join('');
  tagSel.value = tagCur;
  // 主题下拉
  const topicSel = $('filter-topic'); const topicCur = topicSel.value;
  topicSel.innerHTML = '<option value="">全部主题</option>' +
    state.topics.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${t.count})</option>`).join('');
  topicSel.value = topicCur;
}

// ---- 详情 ----
async function select(id) {
  await flushPendingNotes(); // 切论文前，先把旧论文的待存笔记落盘，避免丢失最后 800ms 输入
  state.current = id;
  const { data: p } = await jget('/api/papers/' + encodeURIComponent(id));
  state.detail = p;
  state.tab = 'summary';
  renderList();
  renderDetail();
}

function renderDetail() {
  flushPendingNotes(); // 轮询刷新也会重建详情面板，先把待存笔记落盘（不 await：值已先从 DOM 读出）
  const p = state.detail;
  const d = $('detail');
  if (!p) { d.innerHTML = '<div class="empty"><span class="big"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M14 4v6h6"/><path d="M8 13h6"/><path d="M8 16h4"/></svg></span>从左侧选择一篇论文</div>'; return; }
  const authorsStr = (p.authors && p.authors.length) ? p.authors.join(', ') : '未知作者';
  // tail 拼接：year / category badge / arXiv 链接 / 来源徽标，各段之间用 · 分隔
  const tailYear = p.year ? escapeHtml(p.year) : '';
  const tailCat = p.primaryCategory ? `<span class="badge">arXiv ${escapeHtml(p.primaryCategory)}</span>` : '';
  const tailLink = p.arxivUrl ? `<a href="${escapeHtml(p.arxivUrl)}" target="_blank">arXiv ${escapeHtml(p.arxivId || '')} ↗</a>` : '';
  const tailSrc = p.metaSource === 'ai-fallback'
    ? '<span class="badge warn">元数据为 AI 推断</span>'
    : (p.metaSource ? `<span class="badge src">${escapeHtml(p.metaSource)}</span>` : '');
  const metaTail = [tailYear, tailCat, tailLink, tailSrc].filter(Boolean).join(' · ');
  const meta = `<span class="meta-authors">${escapeHtml(authorsStr)}</span><span class="meta-tail">${metaTail}</span>`;
  const topics = chipList(p.topics, 'topic', 5);
  const tags = chipList(p.tags, 'tag', 12);
  const folders = (p.folders || []).map((fid) => {
    const fo = state.folders.find((x) => x.id === fid);
    return fo ? `<span class="tag folder-chip" style="border-color:${escapeHtml(fo.color)};color:${escapeHtml(fo.color)}">${escapeHtml(fo.name)}</span>` : '';
  }).join('');
  const progress = progressPercent(p);
  d.innerHTML = `
    <div class="detail-head">
      <div class="dh">
        <div class="title-block">
          <div class="detail-state">
            <span class="status-badge ${statusDot(p)}">${statusLabel(p.status)}</span>
            <span class="read-chip">${readStatusLabel(p.readStatus)}</span>
            ${progress != null ? `<span class="mini-metric">读到 ${progress}%</span>` : ''}
            ${p.conceptCount ? `<span class="mini-metric">${p.conceptCount} 概念</span>` : ''}
          </div>
          <h2>${escapeHtml(p.title || p.filename)}</h2>
        </div>
        <div class="dh-actions">
          <span class="rate" id="rate" role="radiogroup" aria-label="星级评分">
            <span class="rate-label">评分</span>
            ${[1, 2, 3, 4, 5].map((n) => `<i class="star ${(p.rating || 0) >= n ? 'on' : ''}" data-r="${n}" role="radio" aria-checked="${(p.rating || 0) >= n}" tabindex="0" title="${n} 星">${starSvg((p.rating || 0) >= n)}</i>`).join('')}
            ${(p.rating || 0) > 0 ? `<button class="rate-clear" id="b-rate-clear" title="清除评分">清除</button>` : ''}
          </span>
          <span class="dh-spacer"></span>
          <button class="btn sm" id="b-open-pdf" title="在新视图打开 PDF 阅读器">打开 PDF</button>
          <button class="btn ghost sm" id="b-read" title="切换阅读状态">${p.readStatus === 'done' ? '✓ 已读' : '标记已读'}</button>
          <button class="btn ghost sm" id="b-resume" title="重新总结（含主题/概念）">重新总结</button>
          <button class="btn ghost sm danger" id="b-delete" title="删除论文（连同本地 PDF 与全文，不可恢复）">删除</button>
        </div>
      </div>
      <div class="meta">${meta}</div>
      <div class="detail-chips">${topics}${tags}${folders || ''}</div>
    </div>
    <div class="tabs">
      <div class="tab ${state.tab === 'summary' ? 'active' : ''}" data-tab="summary">总结</div>
      <div class="tab ${state.tab === 'notes' ? 'active' : ''}" data-tab="notes">笔记</div>
      <div class="tab ${state.tab === 'info' ? 'active' : ''}" data-tab="info">信息</div>
    </div>
    <div id="tab-body" style="padding-top:14px;"></div>`;
  $('b-open-pdf').onclick = () => openReader(p);
  // 星级评分控件：点击设为 N 星，再点同一颗清零；hover 预览；键盘 ← → 调节、0 清除。
  (function () {
    const rate = $('rate');
    if (!rate) return;
    const stars = () => Array.from(rate.querySelectorAll('.star'));
    const paint = (n) => stars().forEach((s) => {
      const on = Number(s.dataset.r) <= n;
      s.classList.toggle('on', on);
      s.setAttribute('aria-checked', String(on));
      s.innerHTML = starSvg(on);
    });
    let cur = Math.max(0, Math.min(5, Math.round(p.rating || 0)));
    const apply = async (n) => {
      const next = n === cur ? 0 : n; // 再点同一颗清零
      cur = next;
      paint(next);
      await patch(p.id, { rating: next });
      toast(next ? `已评 ${next} 星` : '已清除评分');
    };
    stars().forEach((s) => {
      const n = Number(s.dataset.r);
      s.onclick = (e) => { e.stopPropagation(); apply(n); };
      s.onmouseenter = () => paint(n);
      s.onmouseleave = () => paint(cur);
      s.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(n); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); apply(Math.min(5, cur + 1)); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); apply(Math.max(0, cur - 1)); }
        else if (e.key === '0') { e.preventDefault(); apply(0); }
      };
    });
    const clr = $('b-rate-clear');
    if (clr) clr.onclick = (e) => { e.stopPropagation(); apply(0); };
  })();
  $('b-read').onclick = async () => {
    const next = p.readStatus === 'done' ? 'unread' : 'done';
    await patch(p.id, { readStatus: next });
    toast(next === 'done' ? '已标记为已读' : '已标记为未读');
  };
  $('b-resume').onclick = async () => {
    const btn = $('b-resume');
    setBusy(btn, true, '已排队…');
    const r = await POST('/api/papers/' + p.id + '/summarize');
    setBusy(btn, false);
    if (r.ok) toast('已加入重新总结队列');
    else toast(r.error || '重新总结失败', 'error');
    setTimeout(refresh, 600);
  };
  $('b-delete').onclick = async () => {
    if (!confirm(`删除论文「${p.title || p.filename}」？\n将同时删除本地 PDF 与全文文本，且不可恢复。`)) return;
    const btn = $('b-delete');
    setBusy(btn, true, '删除中…');
    const r = await DEL('/api/papers/' + p.id);
    setBusy(btn, false);
    if (r.ok) {
      toast('已删除');
      state.detail = null; // 清空详情，回到「从左侧选择一篇论文」
      renderDetail();
      refresh();
    } else {
      toast(r.error || '删除失败', 'error');
    }
  };
  d.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    if (state.tab !== t.dataset.tab) flushPendingNotes(); // 离开笔记 tab 前落盘
    state.tab = t.dataset.tab;
    renderDetail();
  });
  renderTabBody();
}

function renderTabBody() {
  const p = state.detail;
  const body = $('tab-body');
  if (state.tab === 'summary') {
    body.innerHTML = `<div class="md">${renderMd(p.summary || '*（尚无总结，处理中或点击「重新总结」）*')}</div>
      <p class="save-hint" style="margin-top:18px;">由 ${escapeHtml(p.summaryModel || 'AI')} 生成${p.summaryAt ? ' · ' + new Date(p.summaryAt).toLocaleString() : ''}</p>`;
  } else if (state.tab === 'notes') {
    body.innerHTML = `<div class="notes-grid">
      <textarea id="notes-edit" placeholder="用 Markdown 记笔记，右侧实时预览（支持 $公式$）…">${escapeHtml(p.notes || '')}</textarea>
      <div class="md md-preview" id="notes-preview"></div></div>
      <p class="save-hint" id="notes-hint" style="margin-top:6px;"></p>`;
    const te = $('notes-edit'), pv = $('notes-preview'), hint = $('notes-hint');
    const render = () => { pv.innerHTML = renderMd(te.value); };
    render();
    // 绑定到模块级 notesState：切论文/切 tab 前由 flushPendingNotes 立即落盘
    notesState = { id: p.id, el: te, dirty: false, saveTimer: null, hint };
    te.oninput = () => {
      render();
      hint.textContent = '编辑中…';
      notesState.dirty = true;
      clearTimeout(notesState.saveTimer);
      notesState.saveTimer = setTimeout(async () => {
        await flushPendingNotes();
      }, 800);
    };
    te.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); notesState.dirty = true; flushPendingNotes(); } };
  } else if (state.tab === 'info') {
    renderInfoTab(body, p);
  }
}

function renderInfoTab(body, p) {
  const folderChecks = state.folders.map((fo) => `
    <label class="tag folder-check" style="border-color:${escapeHtml(fo.color)};color:${escapeHtml(fo.color)}">
      <input type="checkbox" value="${fo.id}" ${(p.folders || []).includes(fo.id) ? 'checked' : ''} data-fcheck/>
      ${escapeHtml(fo.name)}
    </label>`).join(' ');
  const progress = p.readProgress
    ? `第 ${p.readProgress.page}/${p.readProgress.total || '?'} 页（${new Date(p.readProgress.updatedAt).toLocaleString()})`
    : '尚未阅读';
  body.innerHTML = `
    <div class="info-grid">
      <div class="field field-wide">
        <label>摘要</label>
        <div class="v abstract-text">${escapeHtml(p.abstract || '（无）')}</div>
      </div>
      <div class="field field-wide">
        <label>阅读状态</label>
        <div class="field-line">
          <div class="read-pill" id="read-pill">
            <button data-rs="unread" class="${(p.readStatus || 'unread') === 'unread' ? 'active' : ''}">未读</button>
            <button data-rs="reading" class="${p.readStatus === 'reading' ? 'active' : ''}">在读</button>
            <button data-rs="done" class="${p.readStatus === 'done' ? 'active' : ''}">已读</button>
          </div>
          <span class="save-hint">阅读进度：${escapeHtml(progress)}</span>
        </div>
      </div>
      <div class="field field-wide">
        <label>主题（点 × 移除，Enter 添加）</label>
        <div class="chip-row" id="topic-row">${(p.topics || []).map((t) => { const p = chipOf(t); return `<span class="topic" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(t)} <span class="x" data-topic-del="${escapeHtml(t)}">×</span></span>`; }).join(' ') || '<span class="save-hint">无</span>'}
        <input type="text" id="topic-add" class="chip-input" placeholder="+ 主题" /></div>
      </div>
      <div class="field">
        <label>所属收藏夹</label>
        <div class="chip-row">${folderChecks || '<span class="save-hint">暂无收藏夹，点侧栏「＋」新建</span>'}</div>
      </div>
      <div class="field">
        <label>标签（Enter 添加）</label>
        <div class="chip-row">${(p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)} <span class="x" data-tag-del="${escapeHtml(t)}">×</span></span>`).join(' ') || '<span class="save-hint">无</span>'}
        <input type="text" id="tag-add" class="chip-input" placeholder="+ 标签" /></div>
      </div>
      <div class="field">
        <label>概念贡献</label>
        <div class="v save-hint">本篇已贡献 ${(p.conceptIds || []).length} 个概念。</div>
        <button class="btn ghost sm field-action" id="b-concepts-this">重新抽取并追加</button>
      </div>
      <div class="field">
        <label>文件</label>
        <div class="v save-hint">${escapeHtml(p.filename)}${p.fulltextChars ? ' · ' + Math.round(p.fulltextChars / 1000) + 'k 字' : ''}</div>
      </div>
    </div>`;

  // 阅读状态
  body.querySelectorAll('#read-pill button').forEach((b) => b.onclick = () => patch(p.id, { readStatus: b.dataset.rs }));
  // 收藏夹勾选
  body.querySelectorAll('[data-fcheck]').forEach((cb) => cb.onchange = () => {
    const next = body.querySelectorAll('[data-fcheck]:checked');
    patch(p.id, { folders: [...next].map((x) => x.value) });
  });
  // 主题增删
  body.querySelectorAll('[data-topic-del]').forEach((x) => x.onclick = () => {
    patch(p.id, { topics: (p.topics || []).filter((t) => t !== x.dataset.topicDel) });
  });
  const ta = $('topic-add');
  if (ta) ta.onkeydown = (e) => {
    if (e.key === 'Enter' && ta.value.trim()) {
      patch(p.id, { topics: Array.from(new Set([...(p.topics || []), ta.value.trim()])) });
      toast('主题已添加');
    }
  };
  // 标签增删
  body.querySelectorAll('[data-tag-del]').forEach((x) => x.onclick = () => {
    patch(p.id, { tags: (p.tags || []).filter((t) => t !== x.dataset.tagDel) });
  });
  const tg = $('tag-add');
  if (tg) tg.onkeydown = (e) => {
    if (e.key === 'Enter' && tg.value.trim()) {
      patch(p.id, { tags: Array.from(new Set([...(p.tags || []), tg.value.trim()])) });
      toast('标签已添加');
    }
  };
  // 对本篇抽取概念
  const bc = $('b-concepts-this');
  if (bc) bc.onclick = async () => {
    setBusy(bc, true, '抽取中…');
    const r = await POST('/api/papers/concepts', { ids: [p.id] });
    setBusy(bc, false);
    if (r.data && r.data.added != null) toast(`完成：处理 ${r.data.processed} 篇，新增 ${r.data.added} 个概念`);
    else toast(r.error || '抽取失败', 'error');
    refresh();
  };
}

async function patch(id, fields, silent) {
  const r = await PATCH('/api/papers/' + encodeURIComponent(id), fields);
  if (!silent && r.ok && r.data) {
    state.detail = r.data;
    renderDetail();
    refresh();
  } else if (!silent && !r.ok) {
    toast(r.error || '保存失败', 'error');
  }
  return r;
}

// ---- 阅读器 ----
let reader = null;
function syncLocalAnnotations(id, annotations, extra) {
  if (state.detail && state.detail.id === id) {
    state.detail = { ...state.detail, ...(extra || {}), annotations };
  }
  const row = state.papers.find((p) => p.id === id);
  if (row) row.annotations = annotations;
  if (reader && reader.paper && reader.paper.id === id) reader.paper.annotations = annotations;
}

// 打开前总是拉一次 detailView：summaryView 不含 annotations，且刚保存后的详情缓存也可能是旧的。
async function openReader(paper) {
  if (!window.PaperReader) { toast('阅读器尚未加载', 'error'); return; }
  try {
    const { data: full } = await jget('/api/papers/' + encodeURIComponent(paper.id));
    if (full) {
      paper = { ...paper, ...full, annotations: full.annotations || null, readProgress: full.readProgress || paper.readProgress };
      if (state.detail && state.detail.id === paper.id) state.detail = { ...state.detail, ...full };
    }
  } catch (e) { /* 拉取失败不阻塞阅读，只是可能无法回显最新批注 */ }
  if (!reader) {
    reader = new window.PaperReader({
      view: $('reader-view'),
      canvasWrap: $('reader-canvas-wrap'),
      back: $('reader-back'),
      prev: $('reader-prev'), next: $('reader-next'),
      pageInput: $('reader-page-input'), pageTotal: $('reader-page-total'),
      zoomIn: $('reader-zoom-in'), zoomOut: $('reader-zoom-out'), zoomLabel: $('reader-zoom-label'),
      zoomFit: $('reader-zoom-fit'),
      spread: $('reader-spread'),
      toolCursor: $('reader-tool-cursor'), toolHighlight: $('reader-tool-highlight'),
      toolNote: $('reader-tool-note'), toolInk: $('reader-tool-ink'),
      toolDelete: $('reader-tool-delete'),
      colorsEl: $('reader-colors'),
      title: $('reader-title'), saved: $('reader-saved'),
      onClose: () => { flushPendingNotes(); setTimeout(refresh, 200); },
      onSaveProgress: async (id, payload) => {
        // 阅读进度 ≥ 95% 自动判为已读，免去手动改状态；首次进入(reading)也一起带上
        const patchBody = { readProgress: payload };
        const pct = (payload && payload.total) ? payload.page / payload.total : 0;
        if (pct >= 0.95) patchBody.readStatus = 'done';
        else if (pct > 0.02) patchBody.readStatus = 'reading';
        await PATCH('/api/papers/' + encodeURIComponent(id), patchBody);
      },
      onSaveAnnotations: async (id, payload) => {
        const r = await PATCH('/api/papers/' + encodeURIComponent(id), { annotations: payload });
        if (r && r.ok) syncLocalAnnotations(id, (r.data && r.data.annotations) || payload, r.data || null);
      },
    });
  }
  reader.open(paper, paper.readProgress, paper.annotations);
}

// ---- 视图切换：library / concepts / settings ----
function showView(name) {
  $('library-view').style.display = (name === 'library') ? '' : 'none';
  $('concepts-view').style.display = (name === 'concepts') ? '' : 'none';
  $('settings-view').style.display = (name === 'settings') ? '' : 'none';
  document.body.dataset.view = name;
  $('btn-concepts').classList.toggle('active', name === 'concepts');
  $('btn-prompt').classList.toggle('active', name === 'settings');
}

// ---- 概念清单视图 ----
async function showConcepts() {
  const { data } = await jget('/api/concepts');
  state.concepts = data || [];
  showView('concepts');
  renderConcepts();
}
function renderConcepts() {
  const q = ($('concept-q').value || '').toLowerCase();
  const list = state.concepts.filter((c) => !q || (c.term + ' ' + (c.definition || '')).toLowerCase().includes(q));
  const g = $('concepts-grid');
  g.innerHTML = '';
  if (!list.length) { g.innerHTML = '<div class="empty-state">无概念。在论文详情「信息」tab 点「重新抽取并追加」，或多选论文后批量抽取。</div>'; return; }
  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'concept-card';
    const papers = (c.paperIds || []).map((id) => {
      const p = state.papers.find((x) => x.id === id);
      return p ? (p.title || p.filename) : id;
    });
    card.innerHTML = `
      <div class="ct"><h3>${escapeHtml(c.term)}</h3>
        <div class="row-actions">
          <button class="btn ghost sm" data-edit="${c.id}">编辑</button>
          <button class="btn ghost sm danger" data-del="${c.id}">删除</button>
        </div>
      </div>
      <div class="cd">${escapeHtml(c.definition || '（无解释）')}</div>
      <div class="meta-line">${papers.length ? '出现于 ' + papers.slice(0, 3).map(escapeHtml).join(' / ') + (papers.length > 3 ? ' 等' : '') : '（独立条目）'}</div>`;
    g.appendChild(card);
  }
  g.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const c = state.concepts.find((x) => x.id === b.dataset.del);
    if (!confirm(`删除概念「${c ? c.term : b.dataset.del}」？`)) return;
    const r = await DEL('/api/concepts/' + b.dataset.del);
    if (r.ok) toast('概念已删除');
    else toast(r.error || '删除失败', 'error');
    showConcepts();
  });
  g.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const c = state.concepts.find((x) => x.id === b.dataset.edit);
    const def = prompt('编辑「' + c.term + '」的解释：', c.definition || '');
    if (def != null) {
      const r = await PATCH('/api/concepts/' + c.id, { definition: def });
      if (r.ok) toast('概念解释已更新');
      else toast(r.error || '保存失败', 'error');
      showConcepts();
    }
  });
}

// ---- 多选 + 抽取概念 ----
function togglePick(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  $('sel-count').textContent = '已选 ' + state.selected.size + ' 篇';
  renderList();
}
function togglePickMode(on) {
  state.pickMode = on;
  $('bulk-bar').classList.toggle('active', on);
  if (!on) state.selected.clear();
  $('sel-count').textContent = '已选 ' + state.selected.size + ' 篇';
  const pickBtn = $('btn-pick');
  pickBtn.querySelector('.btn-text').textContent = on ? '退出多选' : '多选';
  pickBtn.classList.toggle('active', on);
  pickBtn.classList.toggle('subtle', !on);
  renderList();
}

// ---- 收藏夹模态 ----
let editingFolder = null;
let pickedColor = PALETTE[0];
function openFolderModal(folder) {
  editingFolder = folder || null;
  $('folder-modal-title').textContent = folder ? '编辑收藏夹' : '新建收藏夹';
  $('folder-name-input').value = folder ? folder.name : '';
  pickedColor = folder ? folder.color : PALETTE[0];
  const cp = $('folder-color-picks');
  cp.innerHTML = PALETTE.map((c) => `<span class="${c === pickedColor ? 'sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
  cp.querySelectorAll('span').forEach((s) => s.onclick = () => {
    pickedColor = s.dataset.c;
    cp.querySelectorAll('span').forEach((x) => x.classList.toggle('sel', x === s));
  });
  $('folder-modal-delete').style.display = folder ? '' : 'none';
  $('folder-modal').classList.add('active');
  setTimeout(() => $('folder-name-input').focus(), 30);
}

// ---- 视图切换（概念/库/设置） ----
function showLibrary() { showView('library'); }

// ---- 设置中心（迁移并扩展原 prompt-view） ----
const APIKEY_MASK = '********'; // 占位，表示「未改动」

async function openSettings(tab) {
  showView('settings');
  settingsSwitchTab(tab || 'overview');
  await loadSettingsData();
}

function settingsSwitchTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach((el) => {
    el.hidden = el.dataset.panel !== tab;
  });
  if (tab === 'taxonomy') loadTaxonomy();
}

function fmtDef(v) {
  return v === undefined || v === null || v === '' ? '未设置' : v;
}

async function loadSettingsData() {
  try {
    const { data } = await jget('/api/settings');
    // ---- AI 接口（apiKey 显示占位，保存时若未改则不传）----
    $('ai-baseurl').value = data.ai.baseURL || '';
    $('ai-apikey').value = data.ai.hasApiKey ? APIKEY_MASK : '';
    $('ai-apikey').dataset.masked = data.ai.hasApiKey ? '1' : '';
    $('ai-model').value = data.ai.model || '';
    $('ai-maxinput').value = data.ai.maxInputChars || '';
    $('ai-timeout').value = Math.round((data.ai.timeoutMs || 120000) / 1000);
    $('ai-hint').textContent = '';
    $('ai-config-ref').innerHTML =
      `<span><span class="ref-k">Base URL</span><span class="ref-v">${escapeHtml(data.configAi.baseURL || '（未设置）')}</span></span>` +
      `<span><span class="ref-k">Model</span><span class="ref-v">${escapeHtml(data.configAi.model || '（未设置）')}</span></span>`;
    // ---- 提示词 ----
    $('summary-prompt-edit').value = data.summaryPrompt || '';
    $('summary-prompt-default-pre').textContent = data.defaultPrompt || '';
    $('tags-prompt-edit').value = data.tagsPrompt || '';
    $('tags-prompt-default-pre').textContent = data.defaultTagsPrompt || '';
    // ---- 文件扫描 ----
    $('scan-interval').value = data.scan.scanIntervalMinutes ?? 5;
    $('scan-default-hint').textContent = `config.json 默认：${data.configScan.scanIntervalMinutes} 分钟 · 设为 0 关闭定时扫描，仅手动 / 导入触发`;
    // ---- arXiv 元数据 ----
    $('arxiv-enabled').checked = data.arxiv.enabled !== false;
    $('arxiv-thr').value = data.arxiv.titleSimilarityThreshold ?? '';
    $('arxiv-interval').value = data.arxiv.minIntervalMs ?? '';
    $('arxiv-thr-hint').textContent = `0–1，越高越严格（避免误匹配）。config 默认：${fmtDef(data.configArxiv.titleSimilarityThreshold)}`;
    $('arxiv-interval-hint').textContent = `遵守 arXiv 礼貌限速，建议 ≥3000。config 默认：${fmtDef(data.configArxiv.minIntervalMs)}`;
    // ---- 主题发现 ----
    const d = data.discover;
    const cd = data.configDiscover;
    $('disc-maxresults').value = d.maxResults ?? '';
    $('disc-peraxis').value = d.perAxis ?? '';
    $('disc-recency').value = d.recencyWindowYears ?? '';
    $('disc-titlesim').value = d.titleSimThreshold ?? '';
    $('disc-s2').checked = d.semanticScholar !== false;
    $('disc-openalex').checked = d.openAlex !== false;
    $('disc-s2key').value = d.hasS2Key ? APIKEY_MASK : '';
    $('disc-s2key').dataset.masked = d.hasS2Key ? '1' : '';
    const w = d.weights || {};
    $('disc-w-rel').value = w.rel ?? '';
    $('disc-w-auth').value = w.auth ?? '';
    $('disc-w-rec').value = w.rec ?? '';
    $('disc-maxresults-hint').textContent = `config 默认：${fmtDef(cd.maxResults)}`;
    $('disc-peraxis-hint').textContent = `config 默认：${fmtDef(cd.perAxis)}`;
    renderWeightProp();
    // ---- 概览 / 系统 / 覆盖徽标 ----
    renderOverview(data);
    renderSystem(data);
    markOverrides(data.overrides);
  } catch (e) {
    toast('加载设置失败：' + (e.message || e), 'error');
  }
}

/** 概览仪表盘：生效配置 metric 卡（细线图标 + 点击直达设置页）+ 「已覆盖」汇总 + 实时服务状态点。 */
// 概览 metric 卡用的线性细线图标。
const OV_ICON = {
  model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  endpoint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M9 21h6"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M3 12h18"/></svg>',
  arxiv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M11 8v6M8 11h6"/></svg>',
  discover: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="16 8 13.5 13.5 8 16 10.5 10.5 16 8"/></svg>',
  papers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M14 4v6h6"/></svg>',
  version: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12a10 10 0 1 1-3.5-7.6"/><polyline points="22 4 22 9 17 9"/></svg>',
};
function renderOverview(data) {
  const m = $('ov-metrics');
  if (!m) return;
  const arxivOn = data.arxiv.enabled !== false;
  const sources = [data.discover.semanticScholar !== false ? 'S2' : null, data.discover.openAlex !== false ? 'OpenAlex' : null]
    .filter(Boolean)
    .join(' · ');
  // [key, value, tone, icon, goto?].goto 为可跳转的设置 tab；无 goto 不可点。
  const cards = [
    ['当前模型', data.ai.model || '（未设置）', '', OV_ICON.model, 'ai'],
    ['API 端点', data.ai.baseURL || '（未设置）', '', OV_ICON.endpoint, 'ai'],
    ['扫描间隔', data.scan.scanIntervalMinutes ? data.scan.scanIntervalMinutes + ' 分钟' : '已关闭', '', OV_ICON.scan, 'scan'],
    ['arXiv 自动补全', arxivOn ? '开启' : '关闭', arxivOn ? 'good' : 'muted', OV_ICON.arxiv, 'arxiv'],
    ['发现来源', sources || '（无）', '', OV_ICON.discover, 'discover'],
    ['论文总数', String(data.system.papers ?? '?'), '', OV_ICON.papers, null],
    ['版本', 'v' + (data.system.version || '?'), '', OV_ICON.version, null],
    ['服务状态', '<span class="live-dot"></span>运行中', 'good', OV_ICON.status, null],
  ];
  m.innerHTML = cards
    .map(
      ([k, v, tone, icon, goto]) =>
        `<div class="ov-card${goto ? ' jump' : ''}"${goto ? ` data-goto="${goto}" tabindex="0" role="button" title="跳转到${k}设置"` : ''}>` +
        `<span class="ov-ico">${icon}</span>` +
        `<div class="ov-card-main"><div class="ov-k">${escapeHtml(k)}</div><div class="ov-v ${tone}">${v}</div></div>` +
        `</div>`,
    )
    .join('');
  // 点击 / 回车直达对应设置页
  m.querySelectorAll('.ov-card.jump').forEach((c) => {
    const go = () => settingsSwitchTab(c.dataset.goto);
    c.onclick = go;
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  const ov = data.overrides || {};
  const count =
    (ov.ai || []).length +
    (ov.arxiv || []).length +
    (ov.discover || []).length +
    (ov.scan ? 1 : 0) +
    (ov.summaryPrompt ? 1 : 0) +
    (ov.tagsPrompt ? 1 : 0);
  const bar = $('ov-override-bar');
  if (count > 0) {
    bar.hidden = false;
    $('ov-override-text').innerHTML = `有 <b>${count} 项</b> 设置已覆盖 config.json 默认`;
  } else {
    bar.hidden = true;
  }
}

/** 系统信息：服务级只读项 + 脱敏 config.json。 */
function renderSystem(data) {
  const c = $('system-card');
  if (!c) return;
  const sys = data.system || {};
  const rows = [
    ['版本', 'v' + (sys.version || '?')],
    ['监听地址', (sys.host || '?') + ' : ' + (sys.port ?? '?')],
    ['论文目录', sys.papersDir || '?'],
    ['论文总数', String(sys.papers ?? '?')],
    ['运行时长', sys.uptime != null ? Math.round(sys.uptime / 60) + ' 分钟' : '?'],
  ];
  c.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="about-row"><span class="about-k">${escapeHtml(k)}</span><span class="about-v">${escapeHtml(v)}</span></div>`,
    )
    .join('');
  $('system-raw').textContent = JSON.stringify(sys.rawConfig || {}, null, 2);
}

/** 依据后端 overrides 显隐各字段的「已覆盖」徽标。 */
function markOverrides(ov) {
  ov = ov || {};
  const show = (id, on) => {
    const el = $(id);
    if (el) el.hidden = !on;
  };
  show('ovr-ai', (ov.ai || []).length > 0);
  show('ovr-summary', !!ov.summaryPrompt);
  show('ovr-tags', !!ov.tagsPrompt);
  show('ovr-scan', !!ov.scan);
  const ax = ov.arxiv || [];
  show('ovr-arxiv-enabled', ax.includes('enabled'));
  show('ovr-arxiv-thr', ax.includes('titleSimilarityThreshold'));
  show('ovr-arxiv-interval', ax.includes('minIntervalMs'));
  const dv = ov.discover || [];
  for (const k of [
    'maxResults',
    'perAxis',
    'recencyWindowYears',
    'titleSimThreshold',
    'semanticScholar',
    'openAlex',
    'semanticScholarApiKey',
    'weights',
  ]) {
    show('ovr-discover-' + k, dv.includes(k));
  }
}

async function saveAiConfig() {
  const btn = $('btn-ai-save');
  const hint = $('ai-hint');
  const payload = {
    baseURL: $('ai-baseurl').value.trim(),
    model: $('ai-model').value.trim(),
    maxInputChars: parseInt($('ai-maxinput').value, 10) || 24000,
    timeoutMs: (parseInt($('ai-timeout').value, 10) || 120) * 1000,
  };
  // apiKey：用户没改（仍是占位）则不传，避免误清空；改成新值或清空则传
  const keyVal = $('ai-apikey').value;
  if (keyVal !== APIKEY_MASK) payload.apiKey = keyVal;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/ai', payload);
    if (r.ok) {
      await loadSettingsData(); // 刷新表单 / 概览 / 覆盖徽标
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('AI 配置已保存，立即生效');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

async function testAiConnection() {
  const btn = $('btn-ai-test');
  const hint = $('ai-hint');
  setBusy(btn, true, '测试中…');
  hint.textContent = '正在用当前配置发送测试请求…';
  try {
    const r = await POST('/api/settings/test');
    if (r.ok) {
      hint.textContent = '✓ 连接成功 · ' + new Date().toLocaleTimeString();
      toast('连接成功', 'good');
    } else {
      hint.textContent = '✗ ' + (r.error || '连接失败');
      toast(r.error || '连接失败', 'error');
    }
  } catch (e) {
    hint.textContent = '✗ ' + (e.message || e);
    toast('连接失败', 'error');
  }
  setBusy(btn, false);
}

async function saveSummaryPrompt() {
  const ta = $('summary-prompt-edit');
  const btn = $('btn-summary-prompt-save');
  const hint = $('summary-prompt-hint');
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/summary-prompt', { value: ta.value });
    if (r.ok) {
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString() + '（下次「重新总结」生效）';
      toast('总结提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

async function saveTagsPrompt() {
  const ta = $('tags-prompt-edit');
  const btn = $('btn-tags-prompt-save');
  const hint = $('tags-prompt-hint');
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/tags-prompt', { value: ta.value });
    if (r.ok) {
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('标签/主题提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

// ---- 采集：文件扫描 / arXiv / 主题发现 ----
async function saveScan() {
  const btn = $('btn-scan-save');
  const hint = $('scan-hint');
  let n = parseInt($('scan-interval').value, 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/scan', { scanIntervalMinutes: n });
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString() + '（定时器已重置）';
      toast(n > 0 ? `扫描间隔已设为 ${n} 分钟，立即生效` : '定时扫描已关闭');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

async function saveArxiv() {
  const btn = $('btn-arxiv-save');
  const hint = $('arxiv-hint');
  const payload = { enabled: $('arxiv-enabled').checked };
  const thr = parseFloat($('arxiv-thr').value);
  if (Number.isFinite(thr)) payload.titleSimilarityThreshold = thr;
  const intv = parseInt($('arxiv-interval').value, 10);
  if (Number.isFinite(intv)) payload.minIntervalMs = intv;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/arxiv', payload);
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('arXiv 设置已保存，立即生效');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

/** 实时权重占比条：读取三联输入，按和的比例绘制堆叠条 + 更新提示（和≠1 时提醒）。 */
function renderWeightProp() {
  const bar = $('disc-weight-prop');
  if (!bar) return;
  const vals = {
    rel: parseFloat($('disc-w-rel').value),
    auth: parseFloat($('disc-w-auth').value),
    rec: parseFloat($('disc-w-rec').value),
  };
  const sum = (Number(vals.rel) || 0) + (Number(vals.auth) || 0) + (Number(vals.rec) || 0);
  // 全空：隐藏条，恢复默认提示
  if (!sum) { bar.innerHTML = ''; bar.style.opacity = '0'; const h = $('disc-weights-hint'); if (h) h.textContent = '建议三者之和为 1。'; return; }
  bar.style.opacity = '1';
  const pct = (k) => (sum > 0 ? ((Number(vals[k]) || 0) / sum) * 100 : 0);
  bar.innerHTML =
    `<i class="p-rel" style="width:${pct('rel')}%"></i>` +
    `<i class="p-auth" style="width:${pct('auth')}%"></i>` +
    `<i class="p-rec" style="width:${pct('rec')}%"></i>`;
  const h = $('disc-weights-hint');
  if (h) {
    const drift = Math.abs(sum - 1);
    h.textContent = drift < 0.001 ? '当前和 = 1（已归一化）。' : `当前和 = ${sum.toFixed(2)}，偏离 1。可点「归一化为 1」修正。`;
  }
}

/** 把三联权重按比例缩放为和 = 1（空值视为 0；全 0 不动）。 */
function normalizeWeights() {
  const ids = ['disc-w-rel', 'disc-w-auth', 'disc-w-rec'];
  const vals = ids.map((id) => parseFloat($(id).value)).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (!sum) { toast('三组权重都为 0，无法归一化', 'error'); return; }
  ids.forEach((id, i) => { $(id).value = Math.round((vals[i] / sum) * 1000) / 1000; });
  renderWeightProp();
  toast('已归一化为 1');
}

async function saveDiscover() {
  const btn = $('btn-discover-save');
  const hint = $('discover-hint');
  const payload = { semanticScholar: $('disc-s2').checked, openAlex: $('disc-openalex').checked };
  const setInt = (id, key) => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v)) payload[key] = v;
  };
  const setFloat = (id, key) => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) payload[key] = v;
  };
  setInt('disc-maxresults', 'maxResults');
  setInt('disc-peraxis', 'perAxis');
  setInt('disc-recency', 'recencyWindowYears');
  setFloat('disc-titlesim', 'titleSimThreshold');
  const weights = {};
  for (const [id, k] of [
    ['disc-w-rel', 'rel'],
    ['disc-w-auth', 'auth'],
    ['disc-w-rec', 'rec'],
  ]) {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) weights[k] = v;
  }
  if (Object.keys(weights).length) payload.weights = weights;
  // S2 key：未改（仍是掩码占位）则不传；改成新值或清空则传
  const keyVal = $('disc-s2key').value;
  if (keyVal !== APIKEY_MASK) payload.semanticScholarApiKey = keyVal;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/discover', payload);
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('主题发现设置已保存，立即生效');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

/** 清除某段运行时覆盖，回到 config.json 默认。 */
async function resetSection(section, label) {
  if (!confirm(`将「${label}」恢复为 config.json 默认？这会清除该项的运行时覆盖。`)) return;
  try {
    const r = await POST('/api/settings/reset', { section });
    if (r.ok) {
      await loadSettingsData();
      toast(`「${label}」已恢复默认`);
    } else toast(r.error || '操作失败', 'error');
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

/** 清空全部运行时覆盖。 */
async function resetAllSettings() {
  if (!confirm('清空全部运行时覆盖，所有设置恢复为 config.json 默认？此操作不可撤销。')) return;
  try {
    const r = await POST('/api/settings/reset', { all: true });
    if (r.ok) {
      await loadSettingsData();
      toast('已全部恢复为 config.json 默认');
    } else toast(r.error || '操作失败', 'error');
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

/** 设置内搜索：按标题 / 关键词过滤左侧导航条目。 */
function filterSettingsNav(q) {
  q = (q || '').trim().toLowerCase();
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    const hay = (el.textContent + ' ' + (el.dataset.kw || '')).toLowerCase();
    el.style.display = !q || hay.includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.settings-nav-group').forEach((g) => {
    g.style.display = q ? 'none' : '';
  });
}

// ---- 主题与标签管理（分段单栏 + 搜索/排序/内联重命名/合并/批量，全部复用 PATCH {merge,into}/{delete}）----
const taxState = { kind: 'tag', data: { tag: [], topic: [] }, q: '', sort: 'countDesc', selectMode: false, selected: new Set() };
const TAX_ICON = {
  pencil:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  merge:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7"/><path d="M18 9.5a9 9 0 0 1-9 8.5"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
};
const taxLabel = (kind) => (kind === 'tag' ? '标签' : '主题');
// 分类管理配色直接复用文章 chip 的统一 CHIP_PALETTE，保证「设置里看到的颜色 = 文章里打标的颜色」。
const taxColor = (name) => chipOf(name).c;
function taxPatch(kind, body) {
  return PATCH(kind === 'tag' ? '/api/tags' : '/api/topics', body);
}

async function loadTaxonomy() {
  try {
    const [tg, tr] = await Promise.all([jget('/api/tags'), jget('/api/topics')]);
    taxState.data.tag = tg.data || [];
    taxState.data.topic = tr.data || [];
    $('tax-tag-count').textContent = taxState.data.tag.length;
    $('tax-topic-count').textContent = taxState.data.topic.length;
    taxState.selected.clear();
    renderTaxonomy();
  } catch (e) {
    toast('加载主题/标签失败', 'error');
  }
}

function taxSwitchKind(kind) {
  if (taxState.kind === kind) return;
  taxState.kind = kind;
  taxState.selected.clear();
  document.querySelectorAll('.tax-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  $('tax-search').placeholder = '搜索' + taxLabel(kind) + '…';
  renderTaxonomy();
}

function taxToggleSelectMode(on) {
  taxState.selectMode = on != null ? on : !taxState.selectMode;
  if (!taxState.selectMode) taxState.selected.clear();
  $('tax-select-toggle').classList.toggle('active', taxState.selectMode);
  $('tax-select-toggle').textContent = taxState.selectMode ? '完成' : '多选';
  renderTaxonomy();
}

function taxCurrentItems() {
  let items = taxState.data[taxState.kind].slice();
  const q = taxState.q.trim().toLowerCase();
  if (q) items = items.filter((it) => it.name.toLowerCase().includes(q));
  if (taxState.sort === 'nameAsc') items.sort((a, b) => a.name.localeCompare(b.name));
  else if (taxState.sort === 'countAsc') items.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  else items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return items;
}

function updateTaxBatchBar() {
  const bar = $('tax-batch');
  if (!bar) return;
  bar.hidden = !taxState.selectMode;
  if (taxState.selectMode) $('tax-sel-count').textContent = taxState.selected.size;
}

function renderTaxonomy() {
  const rows = $('tax-rows');
  if (!rows) return;
  const kind = taxState.kind;
  const items = taxCurrentItems();
  const max = items.reduce((m, it) => Math.max(m, it.count), 0) || 1;
  updateTaxBatchBar();
  if (!items.length) {
    rows.innerHTML =
      '<div class="empty-state">' + (taxState.q ? '没有匹配的' + taxLabel(kind) : '暂无' + taxLabel(kind)) + '</div>';
    return;
  }
  rows.innerHTML = '';
  for (const it of items) rows.appendChild(taxRow(it, kind, max));
}

function taxRow(it, kind, max) {
  const row = document.createElement('div');
  row.className = 'tax-row';
  const pct = Math.max(3, Math.round((it.count / max) * 100));
  const low = it.count > 0 && it.count <= 2;
  if (taxState.selectMode) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tax-check';
    cb.checked = taxState.selected.has(it.name);
    row.classList.toggle('sel', cb.checked);
    cb.onchange = () => {
      if (cb.checked) taxState.selected.add(it.name);
      else taxState.selected.delete(it.name);
      row.classList.toggle('sel', cb.checked);
      updateTaxBatchBar();
    };
    row.appendChild(cb);
  }
  const dot = document.createElement('span');
  dot.className = 'tax-dot';
  dot.style.background = taxColor(it.name);
  row.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'tax-row-name';
  name.textContent = it.name;
  name.title = '点击重命名';
  name.onclick = () => {
    if (!taxState.selectMode) taxEnterRename(row, it, kind);
  };
  row.appendChild(name);

  const bar = document.createElement('div');
  bar.className = 'tax-bar';
  const fill = document.createElement('span');
  fill.style.width = pct + '%';
  fill.style.background = taxColor(it.name);
  bar.appendChild(fill);
  row.appendChild(bar);

  const cnt = document.createElement('button');
  cnt.className = 'tax-cnt' + (low ? ' low' : '');
  cnt.textContent = low ? '仅 ' + it.count + ' 篇' : it.count;
  cnt.title = '查看该' + taxLabel(kind) + '下的论文';
  cnt.onclick = () => taxJumpToLibrary(kind, it.name);
  row.appendChild(cnt);

  const acts = document.createElement('span');
  acts.className = 'tax-acts';
  acts.innerHTML =
    '<button class="tax-act" data-a="rename" title="重命名" aria-label="重命名">' +
    TAX_ICON.pencil +
    '</button>' +
    '<button class="tax-act" data-a="merge" title="合并到…" aria-label="合并到">' +
    TAX_ICON.merge +
    '</button>' +
    '<button class="tax-act danger" data-a="delete" title="删除" aria-label="删除">' +
    TAX_ICON.trash +
    '</button>';
  acts.querySelector('[data-a="rename"]').onclick = () => taxEnterRename(row, it, kind);
  acts.querySelector('[data-a="merge"]').onclick = () => taxEnterMerge(row, it, kind);
  acts.querySelector('[data-a="delete"]').onclick = () => taxConfirmDelete(row, it, kind);
  row.appendChild(acts);
  return row;
}

/** 行内重命名（↵ 提交：与现有名相同则忽略；指向已有名即合并）。 */
function taxEnterRename(row, it, kind) {
  if (taxState.selectMode) return;
  row.className = 'tax-row editing';
  row.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'tax-dot';
  dot.style.background = taxColor(it.name);
  row.appendChild(dot);
  const inp = document.createElement('input');
  inp.className = 'tax-edit-input';
  inp.value = it.name;
  row.appendChild(inp);
  const hint = document.createElement('span');
  hint.className = 'tax-edit-hint';
  hint.textContent = '↵ 重命名 / 合并 · Esc 取消';
  row.appendChild(hint);
  inp.focus();
  inp.select();
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    renderTaxonomy();
  };
  const commit = async () => {
    if (done) return;
    const v = inp.value.trim();
    if (!v || v === it.name) return cancel();
    done = true;
    const existed = taxState.data[kind].some((x) => x.name === v);
    const r = await taxPatch(kind, { merge: it.name, into: v });
    if (r.ok) {
      toast(existed ? '「' + it.name + '」已合并到「' + v + '」' : '已重命名为「' + v + '」');
      loadTaxonomy();
    } else {
      toast(r.error || '操作失败', 'error');
      renderTaxonomy();
    }
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  inp.onblur = () => setTimeout(cancel, 120);
}

/** 行内合并到已有项。 */
function taxEnterMerge(row, it, kind) {
  if (taxState.selectMode) return;
  const others = taxState.data[kind]
    .filter((x) => x.name !== it.name)
    .map((x) => x.name)
    .sort((a, b) => a.localeCompare(b));
  if (!others.length) {
    toast('没有可合并的目标');
    return;
  }
  row.className = 'tax-row editing';
  row.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'tax-dot';
  dot.style.background = taxColor(it.name);
  row.appendChild(dot);
  const lbl = document.createElement('span');
  lbl.className = 'tax-row-name strike';
  lbl.textContent = it.name;
  row.appendChild(lbl);
  const to = document.createElement('span');
  to.className = 'tax-merge-to';
  to.textContent = '合并到';
  row.appendChild(to);
  const sel = document.createElement('select');
  sel.className = 'tax-merge-sel';
  for (const n of others) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  row.appendChild(sel);
  const ok = document.createElement('button');
  ok.className = 'btn sm';
  ok.textContent = '确认';
  row.appendChild(ok);
  const no = document.createElement('button');
  no.className = 'btn ghost sm';
  no.textContent = '取消';
  row.appendChild(no);
  sel.focus();
  no.onclick = () => renderTaxonomy();
  ok.onclick = async () => {
    const target = sel.value;
    const r = await taxPatch(kind, { merge: it.name, into: target });
    if (r.ok) {
      toast('「' + it.name + '」已合并到「' + target + '」');
      loadTaxonomy();
    } else {
      toast(r.error || '操作失败', 'error');
      renderTaxonomy();
    }
  };
}

/** 行内删除确认（不弹系统对话框）。 */
function taxConfirmDelete(row, it, kind) {
  if (taxState.selectMode) return;
  row.className = 'tax-row editing danger-row';
  row.innerHTML = '';
  const warn = document.createElement('span');
  warn.className = 'tax-del-warn';
  warn.textContent = '删除「' + it.name + '」？将从 ' + it.count + ' 篇论文移除';
  row.appendChild(warn);
  const sp = document.createElement('span');
  sp.style.flex = '1';
  row.appendChild(sp);
  const del = document.createElement('button');
  del.className = 'btn sm danger';
  del.textContent = '删除';
  row.appendChild(del);
  const no = document.createElement('button');
  no.className = 'btn ghost sm';
  no.textContent = '取消';
  row.appendChild(no);
  no.onclick = () => renderTaxonomy();
  del.onclick = async () => {
    const r = await taxPatch(kind, { delete: it.name });
    if (r.ok) {
      toast('已删除「' + it.name + '」');
      loadTaxonomy();
    } else {
      toast(r.error || '操作失败', 'error');
      renderTaxonomy();
    }
  };
}

async function taxBatchDelete() {
  const names = [...taxState.selected];
  if (!names.length) return toast('未选择任何项');
  if (!confirm('删除选中的 ' + names.length + ' 个' + taxLabel(taxState.kind) + '？将从相关论文移除。')) return;
  for (const n of names) await taxPatch(taxState.kind, { delete: n });
  toast('已删除 ' + names.length + ' 个' + taxLabel(taxState.kind));
  taxState.selected.clear();
  loadTaxonomy();
}

function taxBatchMerge() {
  const names = [...taxState.selected];
  if (names.length < 2) return toast('请至少选择 2 个用于合并');
  const bar = $('tax-batch');
  if (document.getElementById('tax-merge-pick')) return;
  const pick = document.createElement('span');
  pick.id = 'tax-merge-pick';
  pick.className = 'tax-batch-pick';
  const cand = names
    .map((n) => taxState.data[taxState.kind].find((x) => x.name === n))
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);
  const to = document.createElement('span');
  to.textContent = '合并到';
  pick.appendChild(to);
  const sel = document.createElement('select');
  sel.className = 'tax-merge-sel';
  for (const c of cand) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.name + '（' + c.count + '）';
    sel.appendChild(o);
  }
  pick.appendChild(sel);
  const ok = document.createElement('button');
  ok.className = 'btn sm';
  ok.textContent = '合并';
  pick.appendChild(ok);
  const no = document.createElement('button');
  no.className = 'btn ghost sm';
  no.textContent = '取消';
  pick.appendChild(no);
  bar.appendChild(pick);
  no.onclick = () => pick.remove();
  ok.onclick = async () => {
    const target = sel.value;
    const merges = names.filter((n) => n !== target);
    for (const n of merges) await taxPatch(taxState.kind, { merge: n, into: target });
    toast('已合并 ' + merges.length + ' 个到「' + target + '」');
    taxState.selected.clear();
    pick.remove();
    loadTaxonomy();
  };
}

/** 点计数/名称跳回主列表并按该标签/主题筛选。 */
function taxJumpToLibrary(kind, name) {
  if (kind === 'tag') state.filter.tag = name;
  else state.filter.topic = name;
  const selEl = $(kind === 'tag' ? 'filter-tag' : 'filter-topic');
  if (selEl) selEl.value = name;
  showLibrary();
  refresh();
  toast('已按' + taxLabel(kind) + '「' + name + '」筛选');
}

// ---- 系统信息：刷新服务状态（重载设置数据，更新运行时长 / 概览）----
async function refreshSystemHealth() {
  await loadSettingsData();
  toast('服务状态已刷新');
}

// ---- 侧栏收起 ----
function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  localStorage.setItem('pw-sidebar', collapsed ? 'collapsed' : 'open');
  document.getElementById('library-view').classList.toggle('sidebar-collapsed', collapsed);
}

function clampListWidth(width) {
  const layout = $('library-view');
  const listPane = document.querySelector('.list-pane');
  if (!layout || !listPane) return Math.max(320, Math.min(520, width));
  const layoutRect = layout.getBoundingClientRect();
  const listLeft = listPane.getBoundingClientRect().left;
  const detailMin = 420;
  const max = Math.max(320, layoutRect.right - listLeft - detailMin - 8);
  return Math.round(Math.max(320, Math.min(max, width)));
}

function applyListWidth(width, persist = false) {
  const next = clampListWidth(Number(width) || 410);
  state.listWidth = next;
  $('library-view')?.style.setProperty('--list-width', next + 'px');
  if (persist) localStorage.setItem('pw-list-width', String(next));
}

function bindListSplitter() {
  const splitter = $('list-detail-splitter');
  const layout = $('library-view');
  const listPane = document.querySelector('.list-pane');
  if (!splitter || !layout || !listPane) return;

  splitter.onpointerdown = (e) => {
    if (window.innerWidth <= 860) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    layout.classList.add('resizing');
    document.body.classList.add('is-resizing');
    const move = (ev) => applyListWidth(ev.clientX - listPane.getBoundingClientRect().left);
    const up = (ev) => {
      applyListWidth(ev.clientX - listPane.getBoundingClientRect().left, true);
      layout.classList.remove('resizing');
      document.body.classList.remove('is-resizing');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  };

  splitter.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    applyListWidth(state.listWidth + (e.key === 'ArrowRight' ? 24 : -24), true);
  };
}

// ---- 绑定事件 ----
function bind() {
  let t;
  $('search').oninput = (e) => { state.filter.q = e.target.value; clearTimeout(t); t = setTimeout(refresh, 250); };
  $('filter-status').onchange = (e) => {
    state.filter.status = e.target.value;
    state.filter.readStatus = '';
    state.filter.mode = '';
    refresh();
  };
  $('filter-tag').onchange = (e) => { state.filter.tag = e.target.value; refresh(); };
  $('filter-topic').onchange = (e) => { state.filter.topic = e.target.value; refresh(); };
  $('filter-starred').onchange = (e) => { state.filter.starred = e.target.checked; refresh(); };
  $('sort').onchange = (e) => { state.filter.sort = e.target.value; refresh(); };

  // 侧栏视图项
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => {
    el.onclick = () => {
      const m = el.dataset.mode;
      if (m === 'all') state.filter = { ...state.filter, mode: '', starred: false, folder: '', readStatus: '', status: '' };
      else if (m === 'starred') state.filter = { ...state.filter, mode: '', starred: true, folder: '', readStatus: '' };
      else if (m === 'unread') state.filter = { ...state.filter, mode: 'unread', starred: false, folder: '', status: '', readStatus: 'unread' };
      refresh();
    };
  });

  $('btn-scan').onclick = async () => {
    const btn = $('btn-scan');
    setBusy(btn, true, '扫描中…');
    const r = await POST('/api/scan');
    setBusy(btn, false);
    if (r.ok) toast('扫描已触发，处理队列会自动刷新');
    else toast(r.error || '扫描失败', 'error');
    setTimeout(refresh, 600);
  };

  // arXiv 网址导入
  function openImportModal() {
    $('import-url-input').value = '';
    const h = $('import-hint');
    h.textContent = '支持 abs / pdf / html 网址或裸 ID，会自动下载 PDF 并开始 AI 处理。';
    h.classList.remove('error');
    $('import-modal').classList.add('active');
    setTimeout(() => $('import-url-input').focus(), 50);
  }
  function closeImportModal() { $('import-modal').classList.remove('active'); }
  $('btn-import').onclick = openImportModal;
  $('import-modal-cancel').onclick = closeImportModal;
  $('import-modal').addEventListener('click', (e) => { if (e.target.id === 'import-modal') closeImportModal(); });
  $('import-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('import-modal-ok').click(); });
  $('import-modal-ok').onclick = async () => {
    const url = $('import-url-input').value.trim();
    const hint = $('import-hint');
    hint.classList.remove('error');
    if (!url) { hint.textContent = '请粘贴 arXiv 网址或 ID'; hint.classList.add('error'); return; }
    const btn = $('import-modal-ok');
    const old = btn.textContent;
    btn.textContent = '下载中…'; btn.disabled = true;
    try {
      const r = await POST('/api/import', { url });
      if (r.ok) {
        if (r.data.status === 'duplicate') toast('该论文已导入过：' + (r.data.title || r.data.arxivId || r.data.id));
        else toast('已开始下载并处理，可在列表查看进度', 'good');
        closeImportModal();
        setTimeout(refresh, 300);
      } else {
        hint.textContent = r.error || '导入失败';
        hint.classList.add('error');
      }
    } catch (e) {
      hint.textContent = '导入失败：' + ((e && e.message) || '网络错误');
      hint.classList.add('error');
    } finally { btn.textContent = old; btn.disabled = false; }
  };

  // ============================================================
  // 按主题发现论文：输入主题 → claude 生成检索式 → arXiv 候选 + S2 引用量 → 去重 → 勾选批量导入
  // 流程：search 后端 POST /api/discover 返回候选；勾选后逐个 POST /api/import（复用下载+入库）。
  // ============================================================
  const discoverState = { results: [] }; // 最近一次发现结果，供勾选/全选读（mutate results，不重新赋值）
  let discoverES = null; // 当前 SSE 连接；切主题/关弹窗时务必 close()，否则 EventSource 会自动重连重跑
  function stopDiscoverStream() {
    if (discoverES) { try { discoverES.close(); } catch {} discoverES = null; }
  }
  function openDiscoverModal() {
    stopDiscoverStream();
    $('discover-topic-input').value = '';
    $('discover-results').innerHTML = '';
    $('discover-progress').style.display = 'none';
    $('discover-progress').innerHTML = '';
    $('discover-actions').style.display = 'none';
    const h = $('discover-hint');
    h.textContent = 'claude 把主题转成 arXiv 检索式，按「相关度 + 最新」两轴召回，再用 相关度·引用量·新近 复合排序，并剔除已入库论文。';
    h.classList.remove('error');
    $('discover-modal').classList.add('active');
    setTimeout(() => $('discover-topic-input').focus(), 50);
  }
  function closeDiscoverModal() { stopDiscoverStream(); $('discover-modal').classList.remove('active'); }
  $('btn-discover').onclick = openDiscoverModal;
  $('discover-modal-cancel').onclick = closeDiscoverModal;
  $('discover-modal').addEventListener('click', (e) => { if (e.target.id === 'discover-modal') closeDiscoverModal(); });
  $('discover-topic-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('discover-search-btn').click(); });

  function renderDiscoverResults(results) {
    const root = $('discover-results');
    if (!results.length) {
      root.innerHTML = '<div class="discover-empty">没有找到新的相关论文（可能已全部在你的库里，或主题太窄）</div>';
      $('discover-actions').style.display = 'none';
      return;
    }
    root.innerHTML = results
      .map((r, i) => {
        const cite =
          typeof r.citationCount === 'number'
            ? `<span class="discover-cite" title="被引用量（Semantic Scholar / OpenAlex）">引用 ${r.citationCount}${typeof r.influentialCitationCount === 'number' ? `·重要 ${r.influentialCitationCount}` : ''}</span>`
            : '<span class="discover-cite muted" title="未取得引用量">引用 —</span>';
        // 相关度 0~1 → 5 格点条
        const relPct = Math.max(0, Math.min(1, r.relevance || 0));
        const dots = Math.round(relPct * 5);
        const rel = `<span class="discover-rel" title="与主题相关度 ${(relPct * 100).toFixed(0)}%">${'●'.repeat(dots)}${'○'.repeat(5 - dots)}</span>`;
        const meta = [r.year, r.primaryCategory, (r.authors || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ');
        const abs = r.summary ? `<div class="discover-abs">${escapeHtml(r.summary.slice(0, 220))}${r.summary.length > 220 ? '…' : ''}</div>` : '';
        return (
          `<label class="discover-item">
            <input type="checkbox" data-idx="${i}" class="discover-pick" />
            <div class="discover-main">
              <div class="discover-title-line">
                <span class="discover-rank">#${i + 1}</span>
                <a class="discover-title" href="${r.arxivUrl}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
                ${cite}
                ${rel}
              </div>
              <div class="discover-meta">${escapeHtml(meta)}</div>
              ${abs}
            </div>
          </label>`
        );
      })
      .join('');
    $('discover-actions').style.display = 'flex';
    $('discover-select-all').checked = false;
  }

  // 极小的 HTML 转义，避免摘要里的尖括号破坏 DOM（摘要不含脚本，但仍转义更稳妥）
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 进度面板：固定 5 步，随 SSE 事件推进（pending→active→done）
  const DISCOVER_STEPS = [
    { key: 'understanding', label: '理解主题 · 生成检索式' },
    { key: 'searching', label: '检索 arXiv（相关度 + 最新）' },
    { key: 'citations', label: '查询引用量（S2 + OpenAlex 兜底）' },
    { key: 'ranking', label: '去重与复合排序' },
    { key: 'done', label: '完成' },
  ];
  function renderDiscoverProgress(state) {
    const root = $('discover-progress');
    root.style.display = 'block';
    root.innerHTML = DISCOVER_STEPS.map((s) => {
      const st = state[s.key] || {};
      const ico = st.status === 'done' ? '✓' : st.status === 'active' ? '<span class="dsc-spin"></span>' : '○';
      const cls = st.status === 'done' ? 'done' : st.status === 'active' ? 'active' : '';
      const detail = st.detail ? `<span class="dsc-detail">${escapeHtml(st.detail)}</span>` : '';
      return `<div class="dsc-step ${cls}"><span class="dsc-ico">${ico}</span><span class="dsc-label">${s.label}</span>${detail}</div>`;
    }).join('');
  }
  // 把单条 SSE 进度事件映射到 5 步状态机
  function applyDiscoverEvent(state, ev) {
    DISCOVER_STEPS.forEach((s) => (state[s.key] = state[s.key] || { status: 'pending' }));
    const done = (...keys) => keys.forEach((k) => (state[k].status = 'done'));
    switch (ev.stage) {
      case 'start':
      case 'understanding':
        state.understanding.status = 'active';
        break;
      case 'query': {
        state.understanding.status = 'done';
        const eng = ev.engine === 'claude' ? 'claude' : ev.engine === 'gateway' ? 'GLM 网关' : '原始主题';
        state.understanding.detail = `${eng}：${ev.note || (ev.queries || []).join(' / ')}`;
        state.searching.status = 'active';
        break;
      }
      case 'searching':
        state.understanding.status = 'done';
        state.searching.status = 'active';
        state.searching.detail = `已收集 ${ev.total} 篇（本轮 ${ev.label} +${ev.added}）`;
        break;
      case 'searched':
        done('understanding', 'searching');
        state.searching.detail = `候选池 ${ev.total} 篇`;
        state.citations.status = 'active';
        break;
      case 'citations':
        state.citations.status = 'active';
        state.citations.detail = ev.message || '查询引用量…';
        break;
      case 'citations-done':
        state.citations.status = 'done';
        state.citations.detail = ev.available ? `已获取 ${ev.resolved}/${ev.total} 篇引用量` : '引用量暂不可用（S2/OpenAlex 限流）';
        break;
      case 'ranking':
        done('understanding', 'searching', 'citations');
        state.ranking.status = 'active';
        break;
      case 'done':
        done('understanding', 'searching', 'citations', 'ranking');
        state.done.status = 'done';
        state.done.detail = `${ev.count} 篇候选`;
        break;
    }
  }

  $('discover-search-btn').onclick = () => {
    const topic = $('discover-topic-input').value.trim();
    const hint = $('discover-hint');
    hint.classList.remove('error');
    if (!topic) { hint.textContent = '请输入主题或关键词'; hint.classList.add('error'); return; }
    if (typeof EventSource === 'undefined') { hint.textContent = '当前浏览器不支持流式进度'; hint.classList.add('error'); return; }
    const btn = $('discover-search-btn');
    setBusy(btn, true, '搜索中…');
    $('discover-results').innerHTML = '';
    $('discover-actions').style.display = 'none';
    discoverState.results = [];
    const pstate = {};
    renderDiscoverProgress(pstate);
    hint.textContent = '正在发现，下方可查看实时进度…';
    stopDiscoverStream();

    let finished = false; // 收到 done/fail 后置位，避免 SSE 关闭触发的原生 error 被误判为失败
    const es = new EventSource('/api/discover/stream?topic=' + encodeURIComponent(topic));
    discoverES = es;

    es.addEventListener('progress', (e) => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch { return; }
      applyDiscoverEvent(pstate, ev);
      renderDiscoverProgress(pstate);
      if (ev.stage === 'query') {
        const eng = ev.engine === 'claude' ? 'claude' : ev.engine === 'gateway' ? 'GLM 网关' : '原始主题';
        hint.textContent = `检索式（${eng}）：` + (ev.queries || []).join('  |  ');
        hint.classList.toggle('error', ev.engine === 'fallback');
      }
    });

    es.addEventListener('done', (e) => {
      finished = true;
      stopDiscoverStream();
      setBusy(btn, false);
      let data = {};
      try { data = JSON.parse(e.data); } catch {}
      discoverState.results = data.results || [];
      const extra = data.citationsAvailable === false ? '（引用量暂不可用，已按 相关度 + 新近 排序）' : '';
      hint.textContent = `找到 ${discoverState.results.length} 篇未入库候选${extra}`;
      hint.classList.remove('error');
      $('discover-progress').style.display = 'none';
      renderDiscoverResults(discoverState.results);
    });

    es.addEventListener('fail', (e) => {
      finished = true;
      stopDiscoverStream();
      setBusy(btn, false);
      let msg = '发现失败';
      try { msg = JSON.parse(e.data).error || msg; } catch {}
      hint.textContent = msg;
      hint.classList.add('error');
    });

    es.onerror = () => {
      if (finished) return; // 正常结束后的关闭
      finished = true;
      stopDiscoverStream();
      setBusy(btn, false);
      hint.textContent = '发现连接中断，请重试（claude 生成检索式可能较慢，可稍候再试）';
      hint.classList.add('error');
    };
  };

  // 全选联动
  $('discover-select-all').onchange = (e) => {
    document.querySelectorAll('.discover-pick').forEach((cb) => { cb.checked = e.target.checked; });
  };

  // 导入所选：逐个 POST /api/import（已有去重/下载/入队），并发 3 个避免压垮本地
  $('discover-import-btn').onclick = async () => {
    const picks = [...document.querySelectorAll('.discover-pick')];
    const chosen = picks.filter((cb) => cb.checked).map((cb) => discoverState.results[+cb.dataset.idx]).filter(Boolean);
    if (!chosen.length) { toast('请先勾选要导入的论文'); return; }
    const btn = $('discover-import-btn');
    setBusy(btn, true, `导入中 0/${chosen.length}…`);
    let ok = 0,
      dup = 0,
      fail = 0;
    // 简单并发池：最多 3 个在飞
    const queue = chosen.slice();
    const concurrency = Math.min(3, queue.length);
    let done = 0;
    async function worker() {
      while (queue.length) {
        const r = queue.shift();
        try {
          // 带上候选元数据：后端据此命名「作者 等 - 年份 - 标题.pdf」并预填，避免空标题→空总结
          const meta = {
            title: r.title,
            authors: r.authors || [],
            year: r.year,
            abstract: r.summary || '',
            primaryCategory: r.primaryCategory || null,
            arxivId: r.arxivId,
          };
          const res = await POST('/api/import', { url: r.arxivUrl, meta });
          if (res.ok && res.data.status === 'imported') ok++;
          else if (res.ok && res.data.status === 'duplicate') dup++;
          else fail++;
        } catch {
          fail++;
        }
        done++;
        btn.textContent = `导入中 ${done}/${chosen.length}…`;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    setBusy(btn, false);
    const parts = [`成功 ${ok}`];
    if (dup) parts.push(`重复 ${dup}`);
    if (fail) parts.push(`失败 ${fail}`);
    toast('导入完成：' + parts.join(' · '), fail ? 'error' : 'info');
    closeDiscoverModal();
    setTimeout(refresh, 300);
  };
  $('btn-concepts').onclick = showConcepts;
  $('btn-concepts-close').onclick = showLibrary;
  $('concept-q').oninput = renderConcepts;

  // 设置中心（原「提示词」入口）
  $('btn-prompt').onclick = () => openSettings('summary'); // 顶栏「提示词」→ 设置中心·总结提示词
  $('btn-settings').onclick = () => openSettings('overview'); // 左下角「设置」→ 概览
  $('btn-settings-close').onclick = showLibrary;
  // 设置 tab 导航
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    el.onclick = () => settingsSwitchTab(el.dataset.tab);
  });
  // AI 接口
  $('btn-ai-save').onclick = saveAiConfig;
  $('btn-ai-test').onclick = testAiConnection;
  // 总结提示词
  $('btn-summary-prompt-save').onclick = saveSummaryPrompt;
  $('btn-summary-prompt-default').onclick = () => {
    if (confirm('清空当前编辑内容并恢复为内置默认总结提示词？（保存后生效）')) {
      $('summary-prompt-edit').value = $('summary-prompt-default-pre').textContent || '';
      $('summary-prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  // 标签/主题提示词
  $('btn-tags-prompt-save').onclick = saveTagsPrompt;
  $('btn-tags-prompt-default').onclick = () => {
    if (confirm('清空当前编辑内容并恢复为内置默认标签/主题提示词？（保存后生效）')) {
      $('tags-prompt-edit').value = $('tags-prompt-default-pre').textContent || '';
      $('tags-prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  // 采集：文件扫描 / arXiv / 主题发现
  $('btn-scan-save').onclick = saveScan;
  $('btn-scan-reset').onclick = () => resetSection('scan', '文件扫描');
  $('btn-arxiv-save').onclick = saveArxiv;
  $('btn-arxiv-reset').onclick = () => resetSection('arxiv', 'arXiv 元数据');
  $('btn-discover-save').onclick = saveDiscover;
  $('btn-discover-reset').onclick = () => resetSection('discover', '主题发现');
  // 主题发现：权重三联实时占比条 + 一键归一化为 1
  ['disc-w-rel', 'disc-w-auth', 'disc-w-rec'].forEach((id) => { const el = $(id); if (el) el.oninput = renderWeightProp; });
  const wNorm = $('btn-w-norm');
  if (wNorm) wNorm.onclick = normalizeWeights;
  // AI 接口恢复默认
  $('btn-ai-reset').onclick = () => resetSection('ai', 'AI 接口');
  // 概览：全部恢复默认 + 快捷入口
  $('btn-reset-all').onclick = resetAllSettings;
  document.querySelectorAll('.ov-quick-links [data-goto]').forEach((b) => {
    b.onclick = () => settingsSwitchTab(b.dataset.goto);
  });
  // 系统信息：刷新服务状态
  $('btn-system-health').onclick = refreshSystemHealth;
  // 设置内搜索
  $('settings-search-input').oninput = (e) => filterSettingsNav(e.target.value);
  // 主题与标签管理：分段切换 / 搜索 / 排序 / 多选 / 批量
  document.querySelectorAll('.tax-seg-btn').forEach((b) => (b.onclick = () => taxSwitchKind(b.dataset.kind)));
  $('tax-search').oninput = (e) => {
    taxState.q = e.target.value;
    renderTaxonomy();
  };
  $('tax-sort').onchange = (e) => {
    taxState.sort = e.target.value;
    renderTaxonomy();
  };
  $('tax-select-toggle').onclick = () => taxToggleSelectMode();
  $('tax-batch-merge').onclick = taxBatchMerge;
  $('tax-batch-delete').onclick = taxBatchDelete;
  $('tax-batch-cancel').onclick = () => taxToggleSelectMode(false);

  // 多选
  $('btn-pick').onclick = () => togglePickMode(!state.pickMode);

  // 紧凑视图切换（记忆到 localStorage）
  $('btn-compact').onclick = () => {
    state.compact = !state.compact;
    localStorage.setItem('pw-compact', state.compact ? '1' : '0');
    renderList();
  };

  // 侧栏收起 / 展开（记忆到 localStorage）
  $('btn-collapse').onclick = () => setSidebarCollapsed(true);
  $('btn-expand').onclick = () => setSidebarCollapsed(false);
  bindListSplitter();
  window.addEventListener('resize', () => applyListWidth(state.listWidth));
  $('btn-pick-cancel').onclick = () => togglePickMode(false);
  $('btn-pick-concepts').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    const btn = $('btn-pick-concepts');
    setBusy(btn, true, '抽取中…');
    const r = await POST('/api/papers/concepts', { ids });
    setBusy(btn, false);
    if (r.data) toast(`完成：处理 ${r.data.processed} 篇，新增 ${r.data.added} 个概念`);
    else toast(r.error || '抽取失败', 'error');
    if (r.ok) togglePickMode(false);
    refresh();
  };

  // 收藏夹模态
  $('btn-new-folder').onclick = () => openFolderModal(null);
  $('folder-modal-cancel').onclick = () => $('folder-modal').classList.remove('active');
  $('folder-modal-save').onclick = async () => {
    const name = $('folder-name-input').value.trim();
    if (!name) { toast('收藏夹名称不能为空', 'error'); return; }
    if (editingFolder) {
      const r = await PATCH('/api/folders/' + editingFolder.id, { name, color: pickedColor });
      if (!r.ok) { toast(r.error || '收藏夹保存失败', 'error'); return; }
    } else {
      const r = await POST('/api/folders', { name, color: pickedColor });
      if (!r.ok) { toast(r.error || '收藏夹创建失败', 'error'); return; }
    }
    $('folder-modal').classList.remove('active');
    toast(editingFolder ? '收藏夹已更新' : '收藏夹已创建');
    refresh();
  };
  $('folder-modal-delete').onclick = async () => {
    if (!editingFolder) return;
    if (!confirm(`删除收藏夹「${editingFolder.name}」？论文不会被删除。`)) return;
    const r = await DEL('/api/folders/' + editingFolder.id);
    if (!r.ok) { toast(r.error || '收藏夹删除失败', 'error'); return; }
    if (state.filter.folder === editingFolder.id) state.filter.folder = '';
    $('folder-modal').classList.remove('active');
    toast('收藏夹已删除');
    refresh();
  };
  $('folder-modal').onclick = (e) => {
    if (e.target.id === 'folder-modal') $('folder-modal').classList.remove('active');
  };

  // ESC 关闭阅读器/模态
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
      return;
    }
    if ($('reader-view').classList.contains('active') && reader && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); reader.scrollToPage(Math.max(1, reader.page - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); reader.scrollToPage(Math.min(reader.total, reader.page + 1)); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); reader.scale = Math.min(3, +(reader.scale + 0.2).toFixed(2)); reader.rerender(); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); reader.scale = Math.max(0.5, +(reader.scale - 0.2).toFixed(2)); reader.rerender(); return; }
    }
    // 列表键盘导航：仅在不输入、不开阅读器、不开模态、不在设置/概念视图时生效
    if (!$('reader-view').classList.contains('active')
        && !$('folder-modal').classList.contains('active')
        && !$('import-modal').classList.contains('active')
        && !$('discover-modal').classList.contains('active')
        && document.body.dataset.view === 'library'
        && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
        && state.papers.length) {
      const curIdx = state.papers.findIndex((p) => p.id === state.current);
      const move = (d) => {
        const next = state.papers[Math.max(0, Math.min(state.papers.length - 1, (curIdx < 0 ? 0 : curIdx) + d))];
        if (next && next.id !== state.current) select(next.id);
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      if (e.key === 'Enter' && state.current) { e.preventDefault(); openReader(state.papers.find((p) => p.id === state.current)); return; }
      if (e.key.toLowerCase() === 's' && state.current) {
        const cp = state.papers.find((p) => p.id === state.current);
        // 星标：无评分↔5 星来回切（兼容旧「收藏」语义）
        if (cp) { const next = (cp.rating || 0) > 0 ? 0 : 5; e.preventDefault(); patch(cp.id, { rating: next }); toast(next ? '已评 5 星' : '已清除评分'); return; }
      }
    }
    if (e.key === 'Escape') {
      if ($('reader-view').classList.contains('active') && reader) reader.close();
      $('folder-modal').classList.remove('active');
      $('import-modal').classList.remove('active');
      $('discover-modal').classList.remove('active');
      if (document.body.dataset.view === 'settings') showLibrary();
    }
  });
}

bind();
applyListWidth(state.listWidth);
setSidebarCollapsed(state.sidebarCollapsed); // 应用上次记忆的侧栏状态
refresh();
setInterval(() => { if (!$('reader-view').classList.contains('active')) refresh(); }, 10000);

// 全局兜底：任何未被 try/catch 接住的 Promise rejection（如按钮回调里的 await 网络错误）
// 都给出一次性 toast，而不是静默留在控制台里让用户毫无感知。
window.addEventListener('unhandledrejection', (e) => {
  const err = e && e.reason;
  const msg = err && err.message ? err.message : '未知错误';
  toast(msg, 'error');
});
