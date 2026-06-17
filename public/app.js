const api = (p, opt) => fetch(p, opt).then((r) => r.json());

const state = {
  papers: [], tags: [], current: null, detail: null, tab: 'summary',
  filter: { q: '', status: '', tag: '', starred: false },
};

const $ = (id) => document.getElementById(id);

function statusDot(p) {
  if (p.status === 'ready') return 'ready';
  if (p.status === 'error') return 'error';
  if (p.status === 'missing') return 'missing';
  return 'busy';
}

async function refresh() {
  const params = new URLSearchParams();
  if (state.filter.q) params.set('q', state.filter.q);
  if (state.filter.status) {
    if (['unread', 'reading', 'done'].includes(state.filter.status)) params.set('readStatus', state.filter.status);
    else params.set('status', state.filter.status);
  }
  if (state.filter.tag) params.set('tag', state.filter.tag);
  if (state.filter.starred) params.set('starred', '1');
  const [{ data: papers }, { data: tags }, { data: stats }] = await Promise.all([
    api('/api/papers?' + params), api('/api/tags'), api('/api/stats'),
  ]);
  state.papers = papers || [];
  state.tags = tags || [];
  $('stats').textContent = `${stats.ready}/${stats.total} 已就绪 · ${stats.processing} 处理中 · ${stats.error} 出错`;
  renderList();
  renderTagFilter();
  if (state.current) renderDetail();
}

function renderList() {
  const ul = $('paper-list');
  ul.innerHTML = '';
  for (const p of state.papers) {
    const li = document.createElement('li');
    li.className = 'paper-item' + (state.current === p.id ? ' active' : '');
    li.innerHTML = `
      <div class="pt"><span class="dot ${statusDot(p)}"></span>${escapeHtml(p.title || p.filename)}</div>
      <div class="pm">${(p.authors || []).slice(0, 2).join(', ')}${p.authors && p.authors.length > 2 ? ' 等' : ''} · ${p.year || ''} ${p.starred ? '★' : ''}</div>
      <div class="tags">${(p.tags || []).slice(0, 5).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`;
    li.onclick = () => select(p.id);
    ul.appendChild(li);
  }
  if (!state.papers.length) ul.innerHTML = '<li class="paper-item">暂无论文，把 PDF 放入 papers/ 并点「扫描」</li>';
}

function renderTagFilter() {
  const sel = $('filter-tag');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部标签</option>' +
    state.tags.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} (${t.count})</option>`).join('');
  sel.value = cur;
}

async function select(id) {
  state.current = id;
  const { data: p } = await api('/api/papers/' + encodeURIComponent(id));
  state.detail = p;
  renderList();
  renderDetail();
}

function renderDetail() {
  const p = state.detail;
  if (!p) { $('detail').innerHTML = '<div class="empty">从左侧选择一篇论文</div>'; return; }
  const meta = `${(p.authors || []).join(', ') || '未知作者'}${p.year ? ' · ' + p.year : ''}` +
    (p.arxivUrl ? ` · <a href="${p.arxivUrl}" target="_blank">arXiv ${p.arxivId || ''} ↗</a>` : '') +
    (p.metaSource === 'ai-fallback' ? ' · <span class="badge warn">元数据为 AI 推断</span>' : (p.metaSource ? ` · <span class="badge">${p.metaSource}</span>` : ''));
  $('detail').innerHTML = `
    <div class="dh">
      <h2>${escapeHtml(p.title || p.filename)}</h2>
      <button class="ghost" id="b-star">${p.starred ? '★ 已收藏' : '☆ 收藏'}</button>
      <select id="sel-read"><option value="unread">未读</option><option value="reading">在读</option><option value="done">已读</option></select>
      <button id="b-resume">⟳ 重新总结</button>
    </div>
    <div class="meta">${meta}</div>
    <div class="paper-item-tags" style="margin-bottom:8px;">${(p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    <div class="tabs">
      <div class="tab ${state.tab === 'summary' ? 'active' : ''}" data-tab="summary">总结</div>
      <div class="tab ${state.tab === 'notes' ? 'active' : ''}" data-tab="notes">笔记</div>
      <div class="tab ${state.tab === 'pdf' ? 'active' : ''}" data-tab="pdf">PDF 原文</div>
    </div>
    <div id="tab-body"></div>`;
  $('sel-read').value = p.readStatus || 'unread';
  $('b-star').onclick = () => patch(p.id, { starred: !p.starred });
  $('sel-read').onchange = (e) => patch(p.id, { readStatus: e.target.value });
  $('b-resume').onclick = async () => { await api('/api/papers/' + p.id + '/summarize', { method: 'POST' }); setTimeout(refresh, 500); };
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => { state.tab = t.dataset.tab; renderDetail(); });
  renderTabBody();
}

function renderTabBody() {
  const p = state.detail;
  const body = $('tab-body');
  if (state.tab === 'summary') {
    body.innerHTML = `<div class="md">${renderMd(p.summary || '*（尚无总结，处理中或点击「重新总结」）*')}</div>`;
  } else if (state.tab === 'notes') {
    body.innerHTML = `<div class="notes-grid">
      <textarea id="notes-edit" placeholder="用 Markdown 记笔记，右侧实时预览（支持 \$公式\$）…">${escapeHtml(p.notes || '')}</textarea>
      <div class="md md-preview" id="notes-preview"></div></div>`;
    const te = $('notes-edit'), pv = $('notes-preview');
    const render = () => { pv.innerHTML = renderMd(te.value); };
    render();
    let saveTimer;
    te.oninput = () => { render(); clearTimeout(saveTimer); saveTimer = setTimeout(() => patch(p.id, { notes: te.value }, true), 800); };
    te.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); patch(p.id, { notes: te.value }); } };
  } else if (state.tab === 'pdf') {
    body.innerHTML = `<iframe class="pdf" src="/papers/${encodeURIComponent(p.filename)}"></iframe>`;
  }
}

async function patch(id, fields, silent) {
  await api('/api/papers/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!silent && state.detail) { state.detail = { ...state.detail, ...fields }; renderDetail(); }
}

function renderMd(md) {
  const raw = marked.parse(md || '', { breaks: true });
  let html = DOMPurify.sanitize(raw);
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => katex.renderToString(e, { displayMode: true, throwOnError: false }));
  html = html.replace(/\$([^$\n]+?)\$/g, (_, e) => katex.renderToString(e, { displayMode: false, throwOnError: false }));
  return html;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bind() {
  $('search').oninput = (e) => { state.filter.q = e.target.value; clearTimeout(window._t); window._t = setTimeout(refresh, 250); };
  $('filter-status').onchange = (e) => { state.filter.status = e.target.value; refresh(); };
  $('filter-tag').onchange = (e) => { state.filter.tag = e.target.value; refresh(); };
  $('filter-starred').onchange = (e) => { state.filter.starred = e.target.checked; refresh(); };
  $('btn-scan').onclick = async () => { await api('/api/scan', { method: 'POST' }); setTimeout(refresh, 500); };
}

bind();
refresh();
setInterval(refresh, 10000);
