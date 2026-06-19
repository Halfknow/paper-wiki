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
const TOPIC_CLASSES = {};
const TOPIC_RING = 6; // c0..c5，与 styles.css 的 .topic.c0..c5 对应
function topicClass(t) {
  const key = String(t ?? '');
  if (TOPIC_CLASSES[key]) return TOPIC_CLASSES[key];
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  TOPIC_CLASSES[key] = 'c' + (Math.abs(h) % TOPIC_RING);
  return TOPIC_CLASSES[key];
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
  return shown.map((t) => {
    const extra = clsFor ? ' ' + clsFor(t) : '';
    return `<span class="${cls}${extra}">${escapeHtml(t)}</span>`;
  }).join('') +
    (rest ? `<span class="tag muted">+${rest}</span>` : '');
}

function compactChipList(p, limit = 4) {
  const items = [
    ...(p.topics || []).map((name) => ({ name, cls: 'topic ' + topicClass(name) })),
    ...(p.tags || []).map((name) => ({ name, cls: 'tag' })),
  ];
  const shown = items.slice(0, limit);
  const rest = Math.max(0, items.length - shown.length);
  return shown.map((it) => `<span class="${it.cls}">${escapeHtml(it.name)}</span>`).join('') +
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

function currentViewLabel() {
  if (state.filter.folder) {
    const folder = state.folders.find((f) => f.id === state.filter.folder);
    return folder ? folder.name : '收藏夹';
  }
  if (state.filter.starred) return '星标';
  if (state.filter.readStatus === 'unread' || state.filter.mode === 'unread') return '未读';
  return '全部论文';
}

function renderListHeader() {
  const el = $('list-kicker');
  if (!el) return;
  const bits = [currentViewLabel(), `${state.papers.length} 篇`];
  if (state.filter.q) bits.push('搜索中');
  if (state.filter.topic) bits.push(state.filter.topic);
  if (state.filter.tag) bits.push(state.filter.tag);
  el.textContent = bits.join(' · ');
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
    renderListHeader();
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
  $('folder-empty').style.display = state.folders.length ? 'none' : '';
  for (const fo of state.folders) {
    const el = document.createElement('div');
    el.className = 'side-item' + (state.filter.folder === fo.id ? ' active' : '');
    el.innerHTML = `<span class="swatch" style="background:${escapeHtml(fo.color)}"></span>
      <span>${escapeHtml(fo.name)}</span>
      <span class="count">${fo.count || ''}</span>
      <span class="ico" data-edit="${fo.id}" title="编辑收藏夹" style="margin-left:2px;cursor:pointer;">⋯</span>`;
    el.onclick = (e) => {
      if (e.target.dataset.edit) { openFolderModal(fo); return; }
      setView({ folder: fo.id, mode: '', starred: false, readStatus: '', status: '' });
    };
    fl.appendChild(el);
  }
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
  $('btn-compact').textContent = state.compact ? '☰' : '≐';
  $('btn-compact').title = state.compact ? '切回舒适视图' : '切到紧凑视图';
  $('btn-compact').classList.toggle('ghost', !state.compact);
  $('btn-compact').classList.toggle('subtle', state.compact);
  if (!state.papers.length) {
    const f = state.filter;
    const hasFilter = f.q || f.status || f.readStatus || f.tag || f.topic || f.starred || f.folder || f.mode;
    if (!hasFilter) {
      // 真正的空库：给新手引导，而不是一句干巴巴的"暂无论文"
      ul.innerHTML = `<li class="paper-item empty-guide">
        <div class="eg-card">
          <div class="eg-emoji">📚</div>
          <h3>欢迎来到 PaperWiki</h3>
          <p class="eg-sub">把 arXiv 论文 PDF 丢进来，AI 帮你读、总结、抽概念、打标签。</p>
          <ol class="eg-steps">
            <li><b>1.</b> 把 PDF 放进程序的 <code>papers/</code> 文件夹</li>
            <li><b>2.</b> 点右上角「扫描」，等待 AI 处理（可在顶栏看进度）</li>
            <li><b>3.</b> 左侧列表选一篇，看总结 · 双击或回车打开 PDF 做高亮笔记</li>
          </ol>
          <p class="eg-tip">💡 首次使用记得在「提示词」里配置你的 AI 接口（config.json）。</p>
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
    const title = escapeHtml(p.title || p.filename) + (p.starred ? ' ⭐' : '');
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
              ${progress != null && progress > 0 ? `<span class="mini-metric">📖 ${progress}%</span>` : ''}
              ${!isBusy && p.conceptCount ? `<span class="mini-metric">${p.conceptCount}</span>` : ''}
            </div>
            <div class="compact-meta">${meta}</div>
            ${progress != null && progress > 0 && progress < 100 ? `<div class="progress-row thin"><div class="progress-bar"><i style="width:${progress}%"></i></div></div>` : ''}
            ${chips ? `<div class="compact-chips">${chips}</div>` : ''}
          </div>
        </div>`;
    } else {
      // 舒适：原完整布局
      const topics = chipList(p.topics, 'topic', 3, topicClass);
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
  if (!p) { d.innerHTML = '<div class="empty"><span class="big">📚</span>从左侧选择一篇论文</div>'; return; }
  const authorsStr = (p.authors && p.authors.length) ? p.authors.join(', ') : '未知作者';
  // tail 拼接：year 紧贴 category badge（无分隔点），其余段之间用 ·
  const tailYear = p.year ? escapeHtml(p.year) : '';
  const tailCat = p.primaryCategory ? `<span class="badge">arXiv ${escapeHtml(p.primaryCategory)}</span>` : '';
  const tailLink = p.arxivUrl ? `<a href="${escapeHtml(p.arxivUrl)}" target="_blank">arXiv ${escapeHtml(p.arxivId || '')} ↗</a>` : '';
  const tailSrc = p.metaSource === 'ai-fallback'
    ? '<span class="badge warn">元数据为 AI 推断</span>'
    : (p.metaSource ? `<span class="badge src">${escapeHtml(p.metaSource)}</span>` : '');
  const head = (tailYear + tailCat);                 // year + category 紧邻，无分隔
  const rest = [tailLink, tailSrc].filter(Boolean).join(' · ');
  const metaTail = [head, rest].filter(Boolean).join(' · ');
  const meta = `<span class="meta-authors">${escapeHtml(authorsStr)}</span><span class="meta-tail">${metaTail}</span>`;
  const topics = chipList(p.topics, 'topic', 5, topicClass);
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
          <button class="btn sm" id="b-open-pdf">打开 PDF</button>
          <button class="btn ${p.starred ? '' : 'ghost'} sm" id="b-star">${p.starred ? '★ 已收藏' : '☆ 收藏'}</button>
          <button class="btn ghost sm" id="b-read" title="切换阅读状态">${p.readStatus === 'done' ? '✓ 已读' : '标记已读'}</button>
          <button class="btn ghost sm" id="b-resume" title="重新总结（含主题/概念）">重新总结</button>
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
  $('b-star').onclick = async () => {
    await patch(p.id, { starred: !p.starred });
    toast(p.starred ? '已取消收藏' : '已收藏');
  };
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
      <textarea id="notes-edit" placeholder="用 Markdown 记笔记，右侧实时预览（支持 \$公式\$）…">${escapeHtml(p.notes || '')}</textarea>
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
        <div class="chip-row" id="topic-row">${(p.topics || []).map((t) => `<span class="topic ${topicClass(t)}">${escapeHtml(t)} <span class="x" data-topic-del="${escapeHtml(t)}">×</span></span>`).join(' ') || '<span class="save-hint">无</span>'}
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
// 双击列表项打开时，p 来自 summaryView（不含 annotations 字段）；详情页打开时含。
// 这里统一兜底：annotations 缺失就懒拉一次 detailView 取 annotations，确保高亮/便签能正确回显。
async function openReader(paper) {
  if (!window.PaperReader) { toast('阅读器尚未加载', 'error'); return; }
  // summaryView 不含 annotations；detialView 才有。缺失时补拉，否则 reader.open 收到 undefined 会跳过回显。
  if (paper.annotations === undefined) {
    try {
      const { data: full } = await jget('/api/papers/' + encodeURIComponent(paper.id));
      if (full) paper = { ...paper, annotations: full.annotations || null, readProgress: full.readProgress || paper.readProgress };
    } catch (e) { /* 拉取失败不阻塞阅读，只是无法回显已存批注 */ }
  }
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
      onSaveAnnotations: async (id, payload) => { await PATCH('/api/papers/' + encodeURIComponent(id), { annotations: payload }); },
    });
  }
  reader.open(paper, paper.readProgress, paper.annotations);
}

// ---- 视图切换：library / concepts / prompt ----
function showView(name) {
  $('library-view').style.display = (name === 'library') ? '' : 'none';
  $('concepts-view').style.display = (name === 'concepts') ? '' : 'none';
  $('prompt-view').style.display = (name === 'prompt') ? '' : 'none';
  document.body.dataset.view = name;
  $('btn-concepts').classList.toggle('active', name === 'concepts');
  $('btn-prompt').classList.toggle('active', name === 'prompt');
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
  $('btn-pick').textContent = on ? '退出多选' : '多选';
  $('btn-pick').classList.toggle('active', on);
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

// ---- 视图切换（概念/库/提示词） ----
function showLibrary() { showView('library'); }

// ---- 提示词编辑视图 ----
async function showPrompt() {
  showView('prompt');
  const ta = $('prompt-edit');
  const hint = $('prompt-hint');
  ta.value = ''; ta.placeholder = '加载中…';
  hint.textContent = '';
  try {
    const { data } = await jget('/api/settings');
    ta.placeholder = '（留空使用内置默认提示词）';
    ta.value = data.summaryPrompt || '';
    $('prompt-default-pre').textContent = data.defaultPrompt || '';
    state.promptDirty = false;
  } catch (e) {
    ta.placeholder = '加载失败：' + (e.message || e);
  }
}
async function savePrompt() {
  const ta = $('prompt-edit');
  const hint = $('prompt-hint');
  const btn = $('btn-prompt-save');
  btn.disabled = true; hint.textContent = '保存中…';
  try {
    const r = await PUT('/api/settings/summary-prompt', { value: ta.value });
    if (r.ok) {
      state.promptDirty = false;
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString() + '（下次「重新总结」生效）';
      toast('提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '提示词保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('提示词保存失败', 'error');
  }
  btn.disabled = false;
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
  $('btn-concepts').onclick = showConcepts;
  $('btn-concepts-close').onclick = showLibrary;
  $('concept-q').oninput = renderConcepts;

  // 提示词
  $('btn-prompt').onclick = showPrompt;
  $('btn-prompt-close').onclick = showLibrary;
  $('btn-prompt-save').onclick = savePrompt;
  $('btn-prompt-default').onclick = () => {
    if (confirm('清空当前编辑内容并恢复为内置默认提示词？（保存后生效）')) {
      $('prompt-edit').value = $('prompt-default-pre').textContent || '';
      state.promptDirty = true;
      $('prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  $('prompt-edit').oninput = () => { state.promptDirty = true; $('prompt-hint').textContent = '未保存的修改'; };

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
    // 列表键盘导航：仅在不输入、不开阅读器、不开模态时生效
    if (!$('reader-view').classList.contains('active')
        && !$('folder-modal').classList.contains('active')
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
        if (cp) { e.preventDefault(); patch(cp.id, { starred: !cp.starred }); toast(cp.starred ? '已取消收藏' : '已收藏'); return; }
      }
    }
    if (e.key === 'Escape') {
      if ($('reader-view').classList.contains('active') && reader) reader.close();
      $('folder-modal').classList.remove('active');
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
