const api = async (p, opt) => {
  const r = await fetch(sp(p), opt);
  if (r.headers.get('content-type', '').includes('application/json')) return r.json();
  return r;
};
const jget = (p) => fetch(sp(p)).then((r) => r.json());
const jsend = (method) => (p, body) => fetch(sp(p), {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());
const PATCH = jsend('PATCH');
const POST = jsend('POST');
const PUT = jsend('PUT');
const DEL = (p) => fetch(sp(p), { method: 'DELETE' }).then((r) => r.json());

/** 网络安全版 jget：fetch 层错误（离线/DNS/拒绝连接/超时）返回 {ok:false,error} 而非抛出，
 *  供 refresh() 的 Promise.allSettled 用——单个接口失败时不至于整页卡死或清空列表。 */
async function safeGet(p) {
  try {
    const r = await fetch(sp(p));
    const body = await r.json().catch(() => null);
    if (body && typeof body === 'object') return body;
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '网络错误' };
  }
}

/** 空间上下文注入器：把 ?space=<activeSpaceId> 自动加到所有 /api/ 和 /papers/ 请求 URL。
 *  - 已有 ?space= 的不动（允许显式覆盖）。
 *  - 纯路径（无 query）追加；有 query 的合并。
 *  - state.space 为空（启动初期未拉到空间列表）时不注入，后端回退 active 空间。
 *  EventSource（chat/discover）无法设 header，统一走 query，后端按 ?space= 路由。 */
function sp(url) {
  if (!state || !state.space) return url;
  const s = String(url || '');
  if (!s.startsWith('/api/') && !s.startsWith('/papers/')) return s; // 只接管后端路由
  const i = s.indexOf('?');
  if (i === -1) return s + '?space=' + encodeURIComponent(state.space);
  if (/[?&]space=/.test(s)) return s; // 已带 space，不覆盖
  return s + '&space=' + encodeURIComponent(state.space);
}

const state = {
  papers: [], tags: [], topics: [], folders: [], concepts: [],
  stats: null, // 全局统计（total/starred/unread 等），不随筛选变，供侧栏徽标
  globalCounts: null, // 兜底：旧后端 stats 无 starred/unread 时，前端独立算的全局计数
  current: null, detail: null, tab: 'summary',
  aiModels: null, // Phase 2 模型切换器：{ models, default, current, source }（GET /api/ai/models 缓存）
  // 当前空间：localStorage 持久化用户选择；启动时从 /api/spaces 拉 active 校验
  space: localStorage.getItem('pw-space') || '',
  spaces: [], // 所有空间列表（GET /api/spaces）
  filter: { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: 'addedDesc' },
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

// AI 聊天的单一状态（模块级）。与 notesState 同理：定时 refresh() 会调 renderDetail 全量重建
// 详情面板（含 AI 聊天 tab），若不保存草稿/忙碌态，用户正打的字会被清空、回复会追加到已被
// 重建掉的「孤儿」旧 DOM 节点（stale list 引用）→ 表现为「发送无回复 + 输入被清空」。
// 结构：{ id, draft, busy, reqId }
//   draft  —— textarea 当前未发送文本（renderDetail 重建后回填，杜绝「打字被清空」）
//   busy   —— 是否有进行中的请求（true 时禁用发送键 + 锁定 textarea，防双发）
//   reqId  —— 当前请求 id（递增），响应只处理「id 匹配且当前 tab 仍是 chat」的那次，
//             且追加目标用实时 document.getElementById 重查（绝不用 stale 闭包引用）
// 参考：现代 LLM 对话 UI 最佳实践——optimistic append、请求级 id 定位、发送期禁用。
let chatState = null;

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
/** 聊天专用 Markdown 渲染：renderMd 之上加代码块强化（语言标签 + 复制按钮 + 超长折叠）。
 *  final=true（完成态）才对 >20 行的代码块应用折叠（流式中 final=false 不折叠，避免半截 fence 抖动）。
 *  用 DOMParser 做后处理（比正则可靠），每段 <pre><code class="language-xx"> 改写成 .cb-card 结构。
 *  复制按钮经事件委托（.cb-copy 点击 → 读同卡片 pre.textContent → clipboard），无需内联 onclick。 */
const CODE_COLLAPSE_LINES = 20; // 超过此行数的代码块在完成态默认折叠
function renderChatMd(md, opts) {
  opts = opts || {};
  const html = renderMd(md || '');
  try {
    const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    const root = doc.getElementById('r');
    const pres = root.querySelectorAll('pre');
    pres.forEach((pre) => {
      const code = pre.querySelector('code');
      const cls = (code && code.className) || '';
      const lm = /language-([\w+-]+)/.exec(cls);
      const lang = lm ? lm[1] : '';
      const text = (code ? code.textContent : pre.textContent) || '';
      const lineCount = text.split('\n').length;
      const card = doc.createElement('div');
      card.className = 'cb-card' + (opts.final && lineCount > CODE_COLLAPSE_LINES ? ' collapsed' : '');
      // 头部：语言标签 + 复制按钮
      const head = doc.createElement('div');
      head.className = 'cb-head';
      const langEl = doc.createElement('span');
      langEl.className = 'cb-lang';
      langEl.textContent = lang || 'text';
      const copyBtn = doc.createElement('button');
      copyBtn.className = 'cb-copy';
      copyBtn.type = 'button';
      copyBtn.title = '复制代码';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制</span>';
      head.appendChild(langEl);
      head.appendChild(copyBtn);
      // 正文：保留原 pre/code（含 class 供后续高亮）
      pre.parentNode.replaceChild(card, pre);
      card.appendChild(head);
      card.appendChild(pre);
      // 折叠态：加展开遮罩按钮
      if (card.classList.contains('collapsed')) {
        const exp = doc.createElement('button');
        exp.className = 'cb-expand';
        exp.type = 'button';
        exp.textContent = '展开 ' + lineCount + ' 行';
        exp.onclick = () => {}; // 委托：见 CSS .cb-card:not(.collapsed) .cb-expand 隐藏 + JS toggle
        card.appendChild(exp);
      }
    });
    return root.innerHTML;
  } catch {
    return html; // DOMParser 失败回退原样
  }
}
// 暴露给 reader.js（ESM 模块，无法 import 本文件）：抽屉 AI 对话复用同一份 markdown+公式渲染。
if (typeof window !== 'undefined') { window.renderMd = renderMd; window.renderChatMd = renderChatMd; }
// 暴露空间注入器给 reader.js：reader 直接 fetch /api/papers/:id 等，需带 ?space= 避免串空间。
if (typeof window !== 'undefined') window.sp = sp;

/** 截取问答大纲条目标题：去首尾空白/换行，按字符截断到 max 字符 + 省略号（供 AI 对话大纲用）。 */
function truncateChatTitle(s, max = 24) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（空问题）';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 流式读取 AI 对话：GET /api/papers/:id/chat?message=（EventSource，discover 同款模式）。
 *  - 用 EventSource 而非 fetch+ReadableStream：POST+fetch SSE 在浏览器有挂起/缓冲问题（实测 await fetch
 *    promise 不 resolve），EventSource 是 SSE 原生可靠通道。
 *  - onToken(text)：每个增量 token；onDone({reply,chat})：完成；onFail(err)：失败。
 *  - 返回一个 close() 函数，调用即中止（切论文/关抽屉时调，防止 EventSource 自动重连重跑）。
 *  事件名 token/done/fail（避免 error 防 EventSource 原生 error 误判 + 自动重连，沿用 discover 约定）。 */
function streamChatFetch(paperId, message, { onToken, onDone, onFail, regenerate, chatParams, extraIds } = {}) {
  const params = new URLSearchParams();
  if (message) params.set('message', message);
  if (regenerate) params.set('regenerate', '1');
  // @ 引用论文（逗号分隔透传）
  if (Array.isArray(extraIds) && extraIds.length) params.set('extraIds', extraIds.join(','));
  // 透传模型参数（thinking/temperature/topP/maxTokens）
  const cp = chatParams || getChatParams();
  for (const k of ['thinking', 'temperature', 'topP', 'maxTokens']) {
    if (cp[k] != null && cp[k] !== '' && !Number.isNaN(cp[k])) params.set(k, String(cp[k]));
  }
  // Phase 2 模型切换：透传选中模型（空=默认）
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  if (selModel) params.set('model', selModel);
  const url = sp('/api/papers/' + encodeURIComponent(paperId) + '/chat?' + params.toString());
  const es = new EventSource(url);
  let finished = false; // 收到 done/fail 后置位，避免连接关闭触发的原生 error 被误判为失败
  es.addEventListener('token', (e) => {
    let obj = null;
    try { obj = JSON.parse(e.data); } catch { return; }
    if (obj && obj.t && typeof onToken === 'function') onToken(obj.t, obj.kind || 'content');
  });
  es.addEventListener('done', (e) => {
    finished = true;
    try { es.close(); } catch {}
    let obj = {};
    try { obj = JSON.parse(e.data); } catch {}
    if (typeof onDone === 'function') onDone(obj);
  });
  es.addEventListener('fail', (e) => {
    finished = true;
    try { es.close(); } catch {}
    let msg = 'AI 回答失败';
    try { msg = JSON.parse(e.data).error || msg; } catch {}
    if (typeof onFail === 'function') onFail(msg);
  });
  es.onerror = () => {
    if (finished) return; // 正常结束后的关闭
    finished = true;
    try { es.close(); } catch {}
    if (typeof onFail === 'function') onFail('连接中断，请重试');
  };
  return () => { finished = true; try { es.close(); } catch {} }; // 返回中止函数
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
  state.stats = stats; // 缓存全局统计，供 renderSidebar 读「全部/星标/未读」计数（不随筛选变）
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
  (f.tags || []).forEach((t) => params.append('tag', t));
  (f.topics || []).forEach((t) => params.append('topic', t));
  if ((f.tags || []).length > 1 && f.tagOp) params.set('tagOp', f.tagOp);
  if ((f.topics || []).length > 1 && f.topicOp) params.set('topicOp', f.topicOp);
  if (f.folder) params.set('folder', f.folder);
  if (f.starred) params.set('starred', '1');
  if (f.sort) params.set('sort', f.sort);

  // 接口级降级：每个请求独立成功/失败，单个接口（尤其 papers 列表）失败时保留旧数据，
  // 而不是整页清空或卡死。safeGet 把网络错误吞成 {ok:false}，这里再据分派。
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
  // 旧后端 stats 不含 starred/unread 字段（需重启才有）→ 此处兜底：独立拉一次无筛选 papers 算全局计数，
  // 供侧栏徽标用（不随当前筛选变）。新后端有字段时跳过（stats 优先）。
  const stData = stats.ok ? stats.data : {};
  if (stats.ok && stData.starred == null) {
    try {
      const all = await safeGet('/api/papers?sort=addedDesc');
      if (all.ok && Array.isArray(all.data)) {
        state.globalCounts = {
          total: all.data.length,
          starred: all.data.filter((p) => p.starred).length,
          unread: all.data.filter((p) => (p.readStatus || 'unread') === 'unread').length,
        };
        renderSidebar();
      }
    } catch { /* ignore */ }
  }
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
  // 计数：全部/星标/未读 —— 必须用「全局统计(state.stats)」而非「当前筛选列表(state.papers)」，
  // 否则点未读/星标/收藏夹视图后 state.papers 被缩小，徽标会显示成筛选后的子集数（而非全局总数）。
  const st = state.stats || {};
  // 全局计数优先用 state.stats（全局统计，不随筛选变）。stats 缺 starred/unread 字段时
  // （旧后端未重启）回退到 state.globalCounts（前端独立 fetch 的全局计数）。
  const gc = state.globalCounts || {};
  const allCount = st.total != null ? st.total : (gc.total != null ? gc.total : state.papers.length);
  const starCount = st.starred != null ? st.starred : (gc.starred || 0);
  const unreadCount = st.unread != null ? st.unread : (gc.unread || 0);
  $('cnt-all').textContent = allCount != null ? allCount : '';
  $('cnt-star').textContent = starCount || '';
  $('cnt-unread').textContent = unreadCount || '';

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
      // 点编辑入口（铅笔图标）：e.target 可能是 svg/path，需 closest 向上找 data-edit
      if (e.target.closest('[data-edit]')) { openFolderModal(fo); return; }
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
  // 视图密度分段控件：两个按钮固定图标，按 state.compact 切 active 高亮（不再动态换 innerHTML）
  const vc = $('view-compact'), vf = $('view-comfort');
  if (vc && vf) {
    vc.classList.toggle('active', state.compact);
    vc.setAttribute('aria-pressed', String(state.compact));
    vf.classList.toggle('active', !state.compact);
    vf.setAttribute('aria-pressed', String(!state.compact));
  }
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
  const statusSel = $('filter-status');
  const statusVal = state.filter.status || state.filter.readStatus || '';
  if (statusSel) { statusSel.value = statusVal; statusSel.classList.toggle('active', !!statusVal); }
  $('filter-starred').checked = state.filter.starred;
  // 主题/标签触发器：同步选中数徽标；并剔除已删除/合并的失效项（保留仍存在的）。
  const tagSet = new Set(state.tags.map((t) => t.name));
  state.filter.tags = (state.filter.tags || []).filter((t) => tagSet.has(t));
  const topicSet = new Set(state.topics.map((t) => t.name));
  state.filter.topics = (state.filter.topics || []).filter((t) => topicSet.has(t));
  const tn = state.filter.tags.length, mn = state.filter.topics.length;
  const tagTrig = $('filter-tag-trigger'), topicTrig = $('filter-topic-trigger');
  if (tagTrig) {
    tagTrig.classList.toggle('active', tn > 0);
    tagTrig.querySelector('.ft-count').textContent = tn ? tn : '';
  }
  if (topicTrig) {
    topicTrig.classList.toggle('active', mn > 0);
    topicTrig.querySelector('.ft-count').textContent = mn ? mn : '';
  }
}

// ---- 主题/标签 WPS 式可搜索多选筛选面板 ----
/** 当前展开的筛选面板信息（用于 ESC / 点遮罩关闭）。 */
let curFilterPop = null;
function closeFilterPop() {
  if (!curFilterPop) return;
  curFilterPop.mask.remove();
  curFilterPop = null;
  document.removeEventListener('keydown', onFilterPopKey);
}
function onFilterPopKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeFilterPop(); }
}
/** 从「当前筛选后的论文(state.papers，含全部筛选条件含 tags/topics)」派生标签/主题列表。
 *  facet 联动语义：选中一个标签 → state.papers 缩小到含该标签的论文 → 面板相应减少（只显示这些论文共现的标签），
 *  实现「筛选完标签也要相应减少」。已选中的标签始终保留可见（防勾选后从面板消失）。
 *  注意：本函数的 items 由 openFilterPop 捕获后，rerender 也复用同一份（而非切回全局字典），
 *  保证勾选/搜索触发重渲时面板内容稳定不闪。 */
function deriveTaxonomyForView(kind) {
  const counts = new Map(); // name -> 当前筛选结果内篇数
  for (const p of state.papers || []) {
    const arr = kind === 'tag' ? (p.tags || []) : (p.topics || []);
    for (const t of arr) counts.set(t, (counts.get(t) || 0) + 1);
  }
  // 并入当前已选项（保留勾选可见性），count 取当前筛选计数或全局字典
  const selected = kind === 'tag' ? (state.filter.tags || []) : (state.filter.topics || []);
  const global = kind === 'tag' ? state.tags : state.topics;
  const globalCount = new Map((global || []).map((t) => [t.name, t.count || 0]));
  for (const s of selected) {
    if (!counts.has(s)) counts.set(s, globalCount.get(s) || 0);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

/**
 * 打开主题/标签筛选面板（WPS/Excel 列筛选器风格：搜索框 + 全选 + 勾选列表）。
 * @param {'tag'|'topic'} kind
 * 选中态用 state.filter.tags/topics（数组，维度内 OR）；确定后 refresh()。
 */
function openFilterPop(kind) {
  closeFilterPop(); // 关掉可能存在的旧面板
  const label = kind === 'tag' ? '标签' : '主题';
  // 关键：项列表根据「当前视图的论文(state.papers)」派生，而非全局字典——
  // 这样切收藏夹/星标/状态视图时，面板只显示该视图论文实际有的标签/主题，
  // 数量也是该视图内的篇数。当前已选中的标签/主题即使不在视图论文里也保留（防勾选后消失）。
  const items = deriveTaxonomyForView(kind);
  const selected = new Set(kind === 'tag' ? state.filter.tags : state.filter.topics);
  // AND/OR 模式：默认 OR（满足任一），可切 AND（必须全部）。按维度独立记忆（tagOp/topicOp）。
  const opKey = kind === 'tag' ? 'tagOp' : 'topicOp';
  let op = state.filter[opKey] === 'and' ? 'and' : 'or';
  const trigger = $(kind === 'tag' ? 'filter-tag-trigger' : 'filter-topic-trigger');
  if (!trigger) return;

  // 面板 + 遮罩（遮罩接收点击关闭，面板 stopPropagation）
  const mask = document.createElement('div');
  mask.className = 'filter-pop-mask';
  const pop = document.createElement('div');
  pop.className = 'filter-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label + '筛选');
  const renderList = (query) => {
    const q = (query || '').trim().toLowerCase();
    const matched = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
    const allChecked = matched.length > 0 && matched.every((it) => selected.has(it.name));
    let html = `<div class="fp-search"><input type="text" class="fp-search-input" placeholder="搜索${label}…" value="${escapeHtml(query || '')}" /></div>`;
    // 多选逻辑切换：AND（满足全部）/ OR（满足任一）。仅当选中 ≥2 时有意义，但始终可切（持久记忆）。
    const isAnd = op === 'and';
    html += `<div class="fp-op-row"><span class="fp-op-label">多选匹配</span><div class="fp-op-toggle" role="tablist" aria-label="多选匹配模式"><button class="fp-op-btn${!isAnd ? ' active' : ''}" data-op="or" role="tab" aria-selected="${!isAnd}">满足任一 OR</button><button class="fp-op-btn${isAnd ? ' active' : ''}" data-op="and" role="tab" aria-selected="${isAnd}">满足全部 AND</button></div></div>`;
    html += `<div class="fp-toolbar"><label class="fp-all"><input type="checkbox" id="fp-all" ${allChecked ? 'checked' : ''} /><span>全选${matched.length ? ` (${matched.length})` : ''}</span></label>${selected.size ? `<button class="fp-clear" id="fp-clear">清除已选</button>` : ''}</div>`;
    html += '<div class="fp-list">';
    if (!matched.length) html += '<div class="fp-empty">无匹配</div>';
    for (const it of matched) {
      const on = selected.has(it.name);
      const p = chipOf(it.name);
      html += `<div class="check-row${on ? ' on' : ''}" data-name="${escapeHtml(it.name)}"><span class="fp-check">${on ? CHECK_SVG : UNCHECK_SVG}</span><span class="fp-name" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(it.name)}</span><span class="fp-count">${it.count}</span></div>`;
    }
    html += '</div>';
    html += `<div class="fp-foot"><span class="fp-sel-count">已选 ${selected.size}</span><button class="btn ghost sm" id="fp-cancel">取消</button><button class="btn sm" id="fp-ok">确定</button></div>`;
    return html;
  };
  pop.innerHTML = renderList('');
  mask.appendChild(pop);
  mask.onclick = (e) => { if (e.target === mask) closeFilterPop(); };
  pop.onclick = (e) => e.stopPropagation();
  document.body.appendChild(mask);
  curFilterPop = { mask, kind, selected };
  document.addEventListener('keydown', onFilterPopKey);

  // 定位：面板贴在触发器下方（顶栏下方）
  const r = trigger.getBoundingClientRect();
  pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
  pop.style.left = (r.left + window.scrollX) + 'px';
  // 搜索框聚焦
  const searchInput = pop.querySelector('.fp-search-input');
  if (searchInput) { searchInput.focus(); searchInput.select(); }

  let curQuery = '';
  const rerender = () => {
    const sc = searchInput ? searchInput.value : curQuery;
    curQuery = sc;
    const selCount = pop.querySelector('.fp-sel-count');
    if (selCount) selCount.textContent = '已选 ' + selected.size;
    // 仅重渲列表 + 全选行 + 清除按钮（保留搜索框焦点）
    // 关键：用与初始 renderList 同一份「按视图派生」的 items，而非全局字典——
    // 否则勾选一项触发 rerender 时会切回全局字典，导致面板显示全部标签。
    const items2 = items;
    const q = sc.trim().toLowerCase();
    const matched = q ? items2.filter((it) => it.name.toLowerCase().includes(q)) : items2;
    const allChecked = matched.length > 0 && matched.every((it) => selected.has(it.name));
    const allEl = pop.querySelector('#fp-all');
    if (allEl) allEl.checked = allChecked;
    const allSpan = pop.querySelector('.fp-all span');
    if (allSpan) allSpan.textContent = '全选' + (matched.length ? ` (${matched.length})` : '');
    const clearBtn = pop.querySelector('#fp-clear');
    if (selected.size && !clearBtn) {
      const tb = pop.querySelector('.fp-toolbar');
      if (tb) tb.insertAdjacentHTML('beforeend', `<button class="fp-clear" id="fp-clear">清除已选</button>`);
      pop.querySelector('#fp-clear').onclick = () => { selected.clear(); rerender(); };
    } else if (!selected.size && clearBtn) clearBtn.remove();
    // 同步 AND/OR 切换按钮的激活态（op 变化后）
    pop.querySelectorAll('.fp-op-btn').forEach((b) => b.classList.toggle('active', b.dataset.op === op));
    // 重渲列表
    let html = '';
    const listEl = pop.querySelector('.fp-list');
    if (!matched.length) { listEl.innerHTML = '<div class="fp-empty">无匹配</div>'; return; }
    for (const it of matched) {
      const on = selected.has(it.name);
      const p = chipOf(it.name);
      html += `<div class="check-row${on ? ' on' : ''}" data-name="${escapeHtml(it.name)}"><span class="fp-check">${on ? CHECK_SVG : UNCHECK_SVG}</span><span class="fp-name" style="background:${p.s};color:${p.c};border-color:${p.b}">${escapeHtml(it.name)}</span><span class="fp-count">${it.count}</span></div>`;
    }
    listEl.innerHTML = html;
  };

  // 搜索
  searchInput.oninput = rerender;
  // 全选 / 清除已选 / AND/OR 切换
  const wireToolbar = () => {
    const allEl = pop.querySelector('#fp-all');
    if (allEl) allEl.onchange = () => {
      const q = (searchInput.value || '').trim().toLowerCase();
      // 用面板的 items（按视图派生），而非全局字典——避免全选时把视图外的标签也加进来
      const matched = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
      if (allEl.checked) matched.forEach((it) => selected.add(it.name));
      else matched.forEach((it) => selected.delete(it.name));
      rerender();
    };
    const clearBtn = pop.querySelector('#fp-clear');
    if (clearBtn) clearBtn.onclick = () => { selected.clear(); rerender(); };
    // AND/OR 切换按钮
    pop.querySelectorAll('.fp-op-btn').forEach((btn) => {
      btn.onclick = () => { op = btn.dataset.op; rerender(); };
    });
  };
  wireToolbar();
  // 勾选行（事件委托，rerender 后仍有效）
  pop.querySelector('.fp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.check-row');
    if (!row) return;
    const name = row.dataset.name;
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    rerender();
  });
  // 全选/清除行用 mutation 重新接线（rerender 后 toolbar 可能重建）
  const obs = new MutationObserver(wireToolbar);
  obs.observe(pop.querySelector('.fp-toolbar'), { childList: true });
  // 底部按钮
  pop.querySelector('#fp-cancel').onclick = closeFilterPop;
  pop.querySelector('#fp-ok').onclick = () => {
    const arr = items.map((it) => it.name).filter((n) => selected.has(n));
    if (kind === 'tag') { state.filter.tags = arr; state.filter.tagOp = op; }
    else { state.filter.topics = arr; state.filter.topicOp = op; }
    closeFilterPop();
    refresh();
    const opTxt = op === 'and' ? '（满足全部）' : (arr.length > 1 ? '（满足任一）' : '');
    toast(arr.length ? `已按 ${arr.length} 个${label}筛选${opTxt}` : `已清除${label}筛选`);
  };
}
// 复选框图标（线性 SVG，复用全站描边风格）
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" fill="#4f46e5" stroke="#4f46e5"/><polyline points="8 12 11 15 16 9" stroke="#fff"/></svg>';
const UNCHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>';

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
  // chat tab 特殊保护：流式中(busy) 或 用户正在输入框打字时，整体跳过重建（d.innerHTML 会销毁 textarea → 失焦 + 打断流式）。
  // 定时 refresh 触发的重建在此被拦截，保留当前 DOM + 焦点 + 草稿。切论文/切 tab 等主动操作不受影响（那时 chatState 已失效）。
  if (state.tab === 'chat' && chatState && chatState.id === p.id) {
    const chatInput = document.getElementById('chat-input');
    const typing = chatInput && (document.activeElement === chatInput || chatState.draft);
    if (chatState.busy || typing) return; // 不重建
  }
  // notes tab 同理：用户正在编辑笔记时跳过重建（d.innerHTML 会销毁 textarea → 失焦 + 未落盘的内容丢失）。
  // notesState.dirty 标记有未保存的输入；notesState.id === p.id 确保是同一篇论文。
  if (state.tab === 'notes' && notesState && notesState.id === p.id) {
    const notesEdit = document.getElementById('notes-edit');
    const typing = notesEdit && document.activeElement === notesEdit;
    if (typing || notesState.dirty) return; // 不重建，保留 textarea + 焦点 + 内容
  }
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
          <button class="btn ghost sm" id="b-retag" title="用当前标签提示词重新打标（标签库联动增删）">重新打标</button>
          <button class="btn ghost sm danger" id="b-delete" title="删除论文（连同本地 PDF 与全文，不可恢复）">删除</button>
        </div>
        <div class="title-block">
          <div class="title-row">
            <h2>${escapeHtml(p.title || p.filename)}</h2>
            <span class="status-badge ${statusDot(p)}">${statusLabel(p.status)}</span>
            <span class="read-chip">${readStatusLabel(p.readStatus)}</span>
            ${progress != null ? `<span class="mini-metric">读到 ${progress}%</span>` : ''}
            ${p.conceptCount ? `<span class="mini-metric">${p.conceptCount} 概念</span>` : ''}
          </div>
        </div>
      </div>
      <div class="meta">${meta}</div>
      <div class="detail-chips">${topics}${tags}${folders || ''}</div>
    </div>
    <div class="tabs">
      <div class="tab ${state.tab === 'summary' ? 'active' : ''}" data-tab="summary">总结</div>
      <div class="tab ${state.tab === 'notes' ? 'active' : ''}" data-tab="notes">笔记</div>
      <div class="tab ${state.tab === 'chat' ? 'active' : ''}" data-tab="chat">AI 聊天</div>
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
  // 重新打标：用当前标签提示词重新生成标签/主题（同步覆盖 + 标签库联动增删）
  $('b-retag').onclick = async () => {
    const btn = $('b-retag');
    setBusy(btn, true, '打标中…');
    $('b-resume').disabled = true;
    const r = await POST('/api/papers/' + p.id + '/retag');
    setBusy(btn, false);
    $('b-resume').disabled = false;
    if (r.ok) { toast('已重新打标'); refresh(); }
    else toast(r.error || '重新打标失败', 'error');
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
  // chat tab 特殊保护：流式中（busy）或用户正在输入框打字时，不重建（避免打断流式 + 抢焦点失焦）。
  const chatInput = document.getElementById('chat-input');
  const chatActive = state.tab === 'chat' && chatInput && document.body.contains(chatInput);
  const isTypingInChat = chatActive && (document.activeElement === chatInput || (chatState && chatState.draft));
  if (chatActive && ((chatState && chatState.busy) || isTypingInChat)) {
    // 流式中：确保 sendBtn 是「停止」
    if (chatState && chatState.busy) {
      const sb = document.getElementById('chat-send');
      if (sb && sb.textContent !== '停止') { sb.classList.add('danger'); sb.textContent = '停止'; sb.disabled = false; }
    }
    return; // 不重建，保留当前 DOM + 焦点 + 草稿
  }
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
  } else if (state.tab === 'chat') {
    renderChatTab(body, p);
  } else if (state.tab === 'info') {
    renderInfoTab(body, p);
  }
}

/** 格式化消息时间戳：今天显 HH:mm，昨天显「昨天 HH:mm」，更早显 MM-DD HH:mm。 */
function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hh + ':' + mm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hh + ':' + mm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hh + ':' + mm;
}
/** AI 图标（角色标识用）+ 你/AI label。统一线性 SVG 风格。 */
const CHAT_ROLE_ICO = {
  user: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  assistant: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
};
/** 操作按钮图标（线性 SVG，统一风格）：复制 / 重新生成 / 显示原文 / 编辑 / 删除。 */
const CHAT_COPY_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHAT_REGEN_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
const CHAT_SOURCE_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
const CHAT_EDIT_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const CHAT_DELETE_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
/** 把引用论文 id 渲染成只读 chip 行（历史消息回显：显示「这条问题引用了哪些论文」）。
 *  titles 从 state.papers 查；查不到的用 id 兜底。只读（无 ×），区别于输入框的可移除 chip。 */
function extraChipsReadonlyHtml(extraIds) {
  const ids = Array.isArray(extraIds) ? extraIds : [];
  if (!ids.length) return '';
  const chips = ids.map((id) => {
    const pp = (state.papers || []).find((x) => x.id === id);
    const title = (pp && pp.title) || id;
    return `<span class="extra-chip readonly" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escapeHtml(truncateChatTitle(title, 18))}</span>`;
  }).join('');
  return `<div class="chat-extra-row">${chips}</div>`;
}
/** 单条聊天消息 HTML（现代气泡风格：头像 + 气泡 + meta 行 + 内联操作条）。
 *  - user 右对齐（accent-soft 气泡）/ assistant 左对齐（白底卡片气泡 + 渐变圆形头像）。
 *  - assistant 内容走 renderChatMd（markdown/公式 + 代码块强化），user 走 escapeHtml + 换行保留。
 *  - 内联操作条（hover 显示，气泡下方）：assistant = 复制 / 重新生成(末条) / 显示原文 / 删除；user = 编辑 / 删除。
 *  - assistant 支持显示原文切换：data-show-source 标记。
 *  - user 若带 extraIds（@ 引用）或 images（Phase 3 附图），在气泡内顶部渲染。
 *  - meta 行：时间戳 + 模型徽章（assistant，可选 m.model）。 */
function chatMsgHtml(m, i, opts) {
  opts = opts || {};
  const role = m.role || 'assistant';
  const rawContent = m.content || '';
  const content = role === 'assistant' ? renderChatMd(rawContent, { final: true }) : escapeHtml(rawContent).replace(/\n/g, '<br/>');
  // 原始 Markdown（显示原文态用）：等宽 <pre>，转义防渲染
  const rawHtml = role === 'assistant' ? '<pre class="chat-raw">' + escapeHtml(rawContent) + '</pre>' : '';
  // 附图缩略图（Phase 3 视觉问答；user 消息回显）
  const imagesHtml = role === 'user' && Array.isArray(m.images) && m.images.length
    ? '<div class="chat-images">' + m.images.map((src) => `<img class="chat-image-thumb" src="${escapeHtml(src)}" alt="附图" loading="lazy" />`).join('') + '</div>'
    : '';
  // 内联操作条（气泡下方，hover 显示）
  let actionsHtml = '';
  if (role === 'assistant') {
    const acts = [`<button class="chat-act" data-act="copy" data-mi="${i}" title="复制">${CHAT_COPY_ICO}</button>`];
    if (opts.regenerable) acts.push(`<button class="chat-act" data-act="regen" data-mi="${i}" title="重新生成">${CHAT_REGEN_ICO}</button>`);
    acts.push(`<button class="chat-act" data-act="source" data-mi="${i}" title="显示原文">${CHAT_SOURCE_ICO}</button>`);
    acts.push(`<button class="chat-act danger" data-act="delete" data-mi="${i}" title="删除">${CHAT_DELETE_ICO}</button>`);
    actionsHtml = `<div class="chat-actions">${acts.join('')}</div>`;
  } else {
    actionsHtml = `<div class="chat-actions"><button class="chat-act" data-act="edit" data-mi="${i}" title="编辑并重发">${CHAT_EDIT_ICO}</button><button class="chat-act danger" data-act="delete" data-mi="${i}" title="删除">${CHAT_DELETE_ICO}</button></div>`;
  }
  // meta 行（时间戳 + 模型徽章）
  const showMeta = m.ts || (role === 'assistant' && m.model);
  const metaHtml = showMeta
    ? `<div class="chat-meta">${m.ts ? `<span class="chat-time">${formatChatTime(m.ts)}</span>` : ''}${role === 'assistant' && m.model ? `<span class="chat-model-badge" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>` : ''}</div>`
    : '';
  const extraRow = role === 'user' && m.extraIds && m.extraIds.length ? extraChipsReadonlyHtml(m.extraIds) : '';
  return `<div class="chat-msg ${role}" data-mi="${i}">
    <div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO[role] || CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">${role === 'user' ? '你' : 'AI'}</span></div>
    <div class="chat-body">${extraRow}<div class="chat-bubble">${imagesHtml}<div class="chat-content">${content}</div></div>${rawHtml ? `<div class="chat-raw-wrap" hidden>${rawHtml}</div>` : ''}${metaHtml}${actionsHtml}</div>
  </div>`;
}
/** 空状态：大渐变图标 + 标题 + 副标题 + 2×2 建议卡片网格 + 快捷键提示。
 *  CHAT_SUGGESTIONS 取自 DEFAULT_CHAT_PRESETS 的 prompt（下方预置段定义）。 */
function chatEmptyHtml() {
  const presets = getChatPresets();
  const chips = presets.slice(0, 4).map((pr) => `<button class="chat-suggest" data-q="${escapeHtml(pr.prompt)}"><span class="chat-suggest-text">${escapeHtml(pr.label)}</span><svg class="chat-suggest-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`).join('');
  return `<div class="chat-empty">
    <div class="chat-empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>
    <div class="chat-empty-title">开始与 AI 探讨这篇论文</div>
    <div class="chat-empty-hint">基于全文的多轮问答 · 支持公式 / 代码 / 思考过程</div>
    <div class="chat-empty-grid">${chips}</div>
    <div class="chat-empty-tip">输入 <kbd>@</kbd> 可引用其它论文联合提问</div>
  </div>`;
}

/** 聊天预置快捷提问（输入框上方按钮）。结构 {label, prompt}。
 *  内置默认 4 条；store.settings.chatPresets（用户自定义）覆盖。getChatPresets() 合并两者。
 *  CHAT_SUGGESTIONS 保留为向后兼容（reader.js 旧引用），现取自预置的 prompt。 */
const DEFAULT_CHAT_PRESETS = [
  { label: '核心方法', prompt: '这篇论文的核心方法是什么？' },
  { label: '创新点', prompt: '这篇论文有什么创新点和贡献？' },
  { label: '实验结果', prompt: '实验结果如何？相比 baseline 提升多少？' },
  { label: '一句话总结', prompt: '请用一句话总结这篇论文。' },
];
let chatPresetsOverride = null; // 由 GET /api/settings 拉取的 store.settings.chatPresets（null=未拉取用默认）
function getChatPresets() {
  return (Array.isArray(chatPresetsOverride) && chatPresetsOverride.length) ? chatPresetsOverride : DEFAULT_CHAT_PRESETS;
}

/** Phase 2 模型切换器：可用模型列表（GET /api/ai/models 缓存）。
 *  state.aiModels = { models: [{id,owned_by}], default, current, source }
 *  用户选择存 localStorage('pw-chat-model')，空串/不存在=用默认。
 *  getSelectedModel() 返回当前选中（默认时返回 ''，后端回退 config.ai.model）。 */
async function loadAiModels() {
  try {
    const r = await fetch(sp('/api/ai/models')).then((r) => r.json());
    // 后端 ok() 包装为 {ok:true, data:{models,default,current,source}}；兼容裸返回
    const d = r && r.ok && r.data ? r.data : r;
    if (d && Array.isArray(d.models)) {
      state.aiModels = { models: d.models, default: d.default, current: d.current, source: d.source };
    } else {
      state.aiModels = { models: [], default: (d && d.default) || '默认模型', current: (d && d.current) || '', source: 'config' };
    }
  } catch {
    state.aiModels = state.aiModels || { models: [], default: '默认模型', current: '', source: 'config' };
  }
  // 同步刷新所有可见的模型按钮文案 + reader 抽屉徽章
  const def = (state.aiModels && state.aiModels.default) || '默认模型';
  const shown = getSelectedModel() || def;
  document.querySelectorAll('.chat-model-btn .cm-name').forEach((el) => { el.textContent = shown; });
  document.querySelectorAll('.rcd-model-pill').forEach((el) => { el.textContent = shown; el.title = shown; });
}
function getSelectedModel() {
  const m = localStorage.getItem('pw-chat-model') || '';
  // 校验仍在可用列表中（用户切换空间/配置后可能失效），失效则清空回默认
  if (m && state.aiModels && Array.isArray(state.aiModels.models)) {
    if (!state.aiModels.models.some((x) => x.id === m)) {
      localStorage.removeItem('pw-chat-model');
      return '';
    }
  }
  return m;
}
/** 模型切换下拉（详情 tab + reader 抽屉共用，锚定到触发按钮上方）。
 *  window.toggleModelSwitcher 暴露给 reader.js 复用。 */
function toggleModelSwitcher(btn) {
  if (!btn) return;
  const existing = document.querySelector('.chat-model-pop');
  if (existing) { existing.remove(); return; } // 再次点击 = 关闭
  const models = (state.aiModels && state.aiModels.models) || [];
  const selected = getSelectedModel();
  const def = (state.aiModels && state.aiModels.default) || '';
  if (!models.length) { toast('暂无可用模型列表（检查 AI 接口配置）', 'info'); return; }
  const pop = document.createElement('div');
  pop.className = 'chat-model-pop';
  pop.innerHTML = '<div class="cmp-head"><span>选择模型</span><button class="cmp-close" type="button" aria-label="关闭">×</button></div>' +
    '<div class="cmp-list">' +
    models.map((m) => {
      const isSel = (m.id === selected) || (!selected && m.id === def);
      const tag = m.id === def ? '<span class="cmp-tag">默认</span>' : '';
      return `<button class="cmp-item${isSel ? ' active' : ''}" data-model="${escapeHtml(m.id)}" type="button"><span class="cmp-id"></span>${tag}<span class="cmp-check">${isSel ? '✓' : ''}</span></button>`;
    }).join('') +
    '</div>';
  document.body.appendChild(pop);
  // 文本注入（防 XSS：用 textContent 而非 innerHTML）
  pop.querySelectorAll('.cmp-item').forEach((it) => { const id = it.dataset.model; const span = it.querySelector('.cmp-id'); if (span) span.textContent = id; });
  // 定位：锚定到按钮上方
  const rect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.top - popRect.height - 6;
  if (top < 8) top = rect.bottom + 6; // 上方空间不足放下方
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.left)) + 'px';
  // 选项点击：写入 localStorage + 刷新所有按钮文案 + 关闭
  pop.querySelectorAll('.cmp-item').forEach((it) => {
    it.onclick = (e) => {
      e.stopPropagation();
      const id = it.dataset.model;
      if (id === def) localStorage.removeItem('pw-chat-model'); // 选默认 = 清空覆盖
      else localStorage.setItem('pw-chat-model', id);
      document.querySelectorAll('.chat-model-btn .cm-name').forEach((el) => {
        el.textContent = getSelectedModel() || def || '默认模型';
      });
      // reader 抽屉头部模型徽章同步
      document.querySelectorAll('.rcd-model-pill').forEach((el) => {
        const m = getSelectedModel() || def || '';
        el.textContent = m; el.title = m;
      });
      pop.remove();
      toast(id === def ? '已切回默认模型' : `已切换到 ${id}`, 'info');
    };
  });
  pop.querySelector('.cmp-close').onclick = () => pop.remove();
  // 点外部关闭
  setTimeout(() => {
    const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { pop.remove(); document.removeEventListener('click', onDoc); } };
    document.addEventListener('click', onDoc);
  }, 0);
}
if (typeof window !== 'undefined') {
  window.toggleModelSwitcher = toggleModelSwitcher;
  window.getSelectedModel = getSelectedModel;
  window.loadAiModels = loadAiModels;
  window.pwState = state; // reader.js 读 state.aiModels（模型列表/默认）用
}
// 向后兼容：旧 CHAT_SUGGESTIONS（reader.js 空状态卡片用）改为从预置取 prompt
const CHAT_SUGGESTIONS = DEFAULT_CHAT_PRESETS.map((x) => x.prompt);

/** 模型参数定义（浮层用）：key / 显示名 / 滑块范围或数字 / 默认值。enabled 标志决定是否发送。 */
const CHAT_PARAM_FIELDS = [
  { key: 'thinking', label: '思考强度', kind: 'range', min: 0, max: 1, step: 0.1, def: '' },
  { key: 'temperature', label: '温度', kind: 'range', min: 0, max: 2, step: 0.1, def: '' },
  { key: 'topP', label: 'Top-P', kind: 'range', min: 0, max: 1, step: 0.05, def: '' },
  { key: 'maxTokens', label: '最大 token', kind: 'number', min: 0, step: 256, def: '' },
];
/** 读取聊天模型参数（从 localStorage）。仅返回 enabled=true 且有值的字段（后端只收启用的）。
 *  存储结构 chatParams = { thinking:{enabled,val}, temperature:{...}, ... }；向后兼容旧扁平结构。 */
function getChatParams() {
  const raw = {};
  try { Object.assign(raw, JSON.parse(localStorage.getItem('chatParams') || '{}')); } catch {}
  const p = {};
  for (const f of CHAT_PARAM_FIELDS) {
    const cell = raw[f.key];
    // 兼容旧扁平：raw.thinking 是值字符串 → 视为启用
    const enabled = cell && typeof cell === 'object' ? !!cell.enabled : cell != null && cell !== '';
    const val = cell && typeof cell === 'object' ? cell.val : cell;
    if (!enabled || val == null || val === '') continue;
    const num = f.kind === 'number' ? parseInt(val, 10) : Number(val);
    if (!Number.isFinite(num)) continue;
    if (f.key === 'maxTokens' && num <= 0) continue;
    p[f.key] = num;
  }
  return p;
}
/** 统计已启用的参数数量（浮层按钮徽章用）。 */
function countChatParams() {
  return Object.keys(getChatParams()).length;
}
/** 接线参数浮层（按钮徽章 + 浮层内每参数：启用开关 + 滑块/数字 + 值 badge）。
 *  shellId 参数浮层根 id；btnId 触发按钮 id。reader.js 复用时传不同 id。 */
function wireChatParamsShell(shellId, btnId) {
  const shell = document.getElementById(shellId);
  const btn = document.getElementById(btnId);
  if (!shell || !btn) return;
  const raw = {};
  try { Object.assign(raw, JSON.parse(localStorage.getItem('chatParams') || '{}')); } catch {}
  // 兼容旧扁平 → 规整为 {enabled,val}
  const norm = {};
  for (const f of CHAT_PARAM_FIELDS) {
    const cell = raw[f.key];
    if (cell && typeof cell === 'object') norm[f.key] = { enabled: !!cell.enabled, val: cell.val != null ? cell.val : f.def };
    else norm[f.key] = { enabled: cell != null && cell !== '', val: cell != null && cell !== '' ? cell : f.def };
  }
  const updateBadge = () => {
    const b = btn.querySelector('.cp-badge');
    const n = countChatParams();
    if (b) { b.textContent = n || ''; b.style.display = n ? '' : 'none'; }
  };
  const saveAll = () => {
    const out = {};
    for (const f of CHAT_PARAM_FIELDS) out[f.key] = norm[f.key];
    localStorage.setItem('chatParams', JSON.stringify(out));
    updateBadge();
  };
  // 浮层内渲染每参数卡片
  for (const f of CHAT_PARAM_FIELDS) {
    const card = shell.querySelector('[data-key="' + f.key + '"]');
    if (!card) continue;
    const sw = card.querySelector('.pp-switch');
    const inp = card.querySelector('.pp-in');
    const valEl = card.querySelector('.pp-val');
    const refresh = () => {
      const en = norm[f.key].enabled;
      card.classList.toggle('on', en);
      if (sw) sw.checked = en;
      if (inp) inp.value = norm[f.key].val != null ? norm[f.key].val : f.def;
      if (valEl) valEl.textContent = (norm[f.key].val != null && norm[f.key].val !== '') ? norm[f.key].val : '默认';
      if (inp) inp.disabled = !en;
    };
    refresh();
    if (sw) sw.onchange = () => { norm[f.key].enabled = sw.checked; refresh(); saveAll(); };
    if (inp) inp.oninput = () => {
      norm[f.key].val = inp.value;
      if (valEl) valEl.textContent = inp.value || '默认';
      saveAll();
    };
  }
  updateBadge();
}

/** @ 引用论文搜索：基于 state.papers（summaryView 列表）客户端多字段匹配。
 *  - 匹配维度：标题（最高分）/ 作者 / 年份 / 标签 / 主题；token 级「每个 query 词都命中」加权。
 *  - excludeId 排除当前论文（不@自己）；已选 ids 排重（避免重复 @）。
 *  - 空 query：返回最近添加的论文（按 addedAt 倒序），让用户开 @ 就能看到候选。
 *  - 限 10 条。返回 {id,title,authors,year,status,tags,topics} 供浮层渲染。
 *  供输入框 @ 触发器 + reader.js（经 window 桥）复用。 */
function searchPapersForMention(query, excludeId, selectedIds) {
  const q = String(query || '').trim().toLowerCase();
  const sel = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
  const list = (state.papers || []).filter((x) => x.id !== excludeId && !(sel && sel.has(x.id)));
  const proj = (x) => ({
    id: x.id, title: x.title,
    authors: Array.isArray(x.authors) ? x.authors.join(', ') : (x.authors || ''),
    year: x.year,
    status: x.status, tags: Array.isArray(x.tags) ? x.tags.slice(0, 3) : [], topics: x.topics,
  });
  // 空 query：最近添加（addedAt 倒序），让用户开 @ 就有候选
  if (!q) {
    return list
      .slice()
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 10)
      .map(proj);
  }
  // 拆 token：每个 token 都须在任一字段命中（AND 语义，更精准）
  const tokens = q.split(/\s+/).filter(Boolean);
  const fieldOf = (x) => {
    const t = String(x.title || '').toLowerCase();
    const a = String(x.authors || '').toLowerCase();
    const y = String(x.year || '');
    const tags = (Array.isArray(x.tags) ? x.tags : []).join(' ').toLowerCase();
    const topics = (Array.isArray(x.topics) ? x.topics : []).join(' ').toLowerCase();
    return { t, a, y, tags, topics };
  };
  const scored = list
    .map((x) => {
      const f = fieldOf(x);
      let score = 0;
      for (const tk of tokens) {
        let hit = false;
        if (f.t.includes(tk)) { score += f.t.startsWith(tk) ? 10 : 6; hit = true; }
        if (f.a.includes(tk)) { score += 3; hit = true; }
        if (f.tags.includes(tk)) { score += 2; hit = true; }
        if (f.topics.includes(tk)) { score += 2; hit = true; }
        if (f.y.includes(tk)) { score += 1; hit = true; }
        if (!hit) return { x, score: -1 }; // 该 token 未命中 → 整体淘汰
      }
      return { x, score };
    })
    .filter((r) => r.score >= 0)
    .sort((m, n) => n.score - m.score)
    .slice(0, 10)
    .map((r) => proj(r.x));
  return scored;
}

/** ===== @ 引用论文选择浮层（详情 tab + reader 抽屉共用）=====
 *  现代化版（v2.7）：body 级 position:fixed 浮层，锚定到 textarea 上方；
 *  实时随输入筛选（每次 input 触发重建列表）；↑↓ 键盘导航 + Enter 选中 + Esc 关闭；
 *  匹配标题高亮；状态点 + 标签 chip；空结果提示。
 *
 *  单例：全局只有一个 .chat-mention-pop（挂在 body）。openChatMentionPicker 再次调用 = 刷新内容。
 *  closeChatMentionPicker() 关闭。reader.js 经 window 桥复用。
 *
 *  参数：
 *    inputEl   —— 触发的 textarea（用于定位 + 读光标位置 + 选中后删 @query 文本）
 *    ctx       —— { excludeId, selectedIds, onPick(id) }
 *    query     —— @ 后已输入的筛选词（空 = 显示最近）
 *    atIdx     —— @ 在输入框文本中的索引（选中后从这里截断到光标） */
let _mentionPop = null;     // 当前浮层 DOM
let _mentionItems = [];     // 当前列表项数据 [{id,title,...}]
let _mentionActive = 0;     // 当前高亮项下标
let _mentionCtx = null;     // 当前 onPick 回调等上下文

function highlightMatch(text, query) {
  const esc = escapeHtml(text || '');
  const q = String(query || '').trim();
  if (!q) return esc;
  // 转义 query 后按 token 拆，逐个用 <mark> 包裹（大小写不敏感）
  const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!tokens.length) return esc;
  const re = new RegExp('(' + tokens.join('|') + ')', 'gi');
  // 先在原文上标记，再整体转义（避免转义后字串被当成正则）
  return esc.replace(re, '<mark>$1</mark>');
}
function mentionItemHtml(r, idx, active, query) {
  const cls = 'cm-item' + (active ? ' active' : '');
  const dotCls = r.status ? statusDot(r) : '';
  const dotHtml = r.status ? `<span class="cm-dot ${dotCls}" title="${escapeHtml(r.status)}"></span>` : '';
  const meta = [];
  if (r.authors) meta.push(escapeHtml(truncateChatTitle(r.authors, 22)));
  if (r.year) meta.push(escapeHtml(String(r.year)));
  const metaHtml = meta.length ? `<span class="cm-meta">${meta.join(' · ')}</span>` : '';
  const tagsHtml = (r.tags && r.tags.length)
    ? `<span class="cm-tags">${r.tags.slice(0, 3).map((t) => `<span class="cm-tag">${escapeHtml(t)}</span>`).join('')}</span>`
    : '';
  return `<div class="${cls}" data-idx="${idx}" role="option"><div class="cm-row1">${dotHtml}<span class="cm-title">${highlightMatch(r.title || r.id, query)}</span></div><div class="cm-row2">${metaHtml}${tagsHtml}</div></div>`;
}
function renderMentionList(query) {
  if (!_mentionPop) return;
  const list = _mentionPop.querySelector('.cm-list');
  if (!list) return;
  if (!_mentionItems.length) {
    list.innerHTML = '<div class="cm-empty">' + (query ? '没有匹配的论文' : '没有可引用的论文') + '</div>';
    const f = _mentionPop.querySelector('.cm-foot'); if (f) f.style.display = 'none';
    return;
  }
  list.innerHTML = _mentionItems.map((r, i) => mentionItemHtml(r, i, i === _mentionActive, query)).join('');
  const f = _mentionPop.querySelector('.cm-foot'); if (f) { f.style.display = ''; const c = f.querySelector('.cm-count'); if (c) c.textContent = _mentionItems.length; }
  // 滚动让 active 可见
  const activeEl = list.children[_mentionActive];
  if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
}
function positionMentionPop(inputEl) {
  if (!_mentionPop) return;
  const r = inputEl.getBoundingClientRect();
  const popH = _mentionPop.offsetHeight || 320;
  const gap = 6;
  let top = r.top - popH - gap;
  if (top < 8) top = r.bottom + gap; // 上方空间不足 → 放下方
  _mentionPop.style.top = top + 'px';
  // 左对齐 textarea，但不超过视口右边界
  const w = Math.min(380, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  _mentionPop.style.left = left + 'px';
  _mentionPop.style.width = Math.max(280, Math.min(w, r.width + 40)) + 'px';
}
function openChatMentionPicker(inputEl, ctx, query, atIdx) {
  _mentionCtx = ctx || {};
  const results = searchPapersForMention(query, ctx.excludeId, ctx.selectedIds);
  _mentionItems = results;
  _mentionActive = 0;
  if (!_mentionPop) {
    _mentionPop = document.createElement('div');
    _mentionPop.className = 'chat-mention-pop fixed';
    _mentionPop.innerHTML =
      '<div class="cm-head"><span class="cm-title-label">引用论文</span><span class="cm-foot-hint">↑↓ 选择 · Enter 确认 · Esc 取消</span></div>' +
      '<div class="cm-list"></div>' +
      '<div class="cm-foot"><span>共 <b class="cm-count">0</b> 篇</span><span class="cm-foot-tip">输入关键词筛选</span></div>';
    document.body.appendChild(_mentionPop);
    // 委托：点击/mouseover
    _mentionPop.addEventListener('click', (e) => {
      const it = e.target.closest('.cm-item');
      if (!it) return;
      const idx = Number(it.dataset.idx);
      confirmMention(idx, inputEl, atIdx);
    });
    _mentionPop.addEventListener('mouseover', (e) => {
      const it = e.target.closest('.cm-item');
      if (!it) return;
      const idx = Number(it.dataset.idx);
      if (idx !== _mentionActive) { _mentionActive = idx; renderMentionList(_mentionQuery); }
    });
    // 全局点击外部关闭（持久绑定一次；浮层单例）
    document.addEventListener('mousedown', (e) => {
      if (!_mentionPop || _mentionPop.hidden || _mentionPop.style.display === 'none') return;
      if (!_mentionPop.contains(e.target)) closeChatMentionPicker();
    }, true);
  }
  _mentionQuery = query || '';
  _mentionAtIdx = atIdx != null ? atIdx : 0;
  renderMentionList(_mentionQuery);
  _mentionPop.style.display = 'flex';
  _mentionPop.hidden = false;
  positionMentionPop(inputEl);
}
let _mentionQuery = '';
let _mentionAtIdx = 0;
function confirmMention(idx, inputEl, atIdx) {
  const r = _mentionItems[idx];
  if (!r) return;
  // 先把回调/id 切到本地变量：dispatchEvent('input') 会触发 oninput → handleMentionTrigger →
  // closeChatMentionPicker()，那会把 _mentionCtx 置 null。若放在 dispatchEvent 之后读 _mentionCtx
  // 就丢了 onPick（历史 bug：选了论文但 chip 不出现）。先捕获再触发。
  const onPick = _mentionCtx && typeof _mentionCtx.onPick === 'function' ? _mentionCtx.onPick : null;
  const pickedId = r.id;
  // 从输入框移除 @query 文本（从 atIdx 到当前光标）
  const v = inputEl.value;
  const cursor = inputEl.selectionStart != null ? inputEl.selectionStart : v.length;
  const a = atIdx != null ? atIdx : _mentionAtIdx;
  inputEl.value = v.slice(0, a) + v.slice(cursor);
  closeChatMentionPicker();           // 先关浮层（清状态）
  // 触发 input 事件让 oninput 处理 draft 同步（reader/app 各自的 handler 会接管；此时浮层已关，不会再触发 open）
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  if (onPick) onPick(pickedId);       // 最后回调：push extraIds + 渲染 chip
  try { inputEl.focus(); } catch {}
}
function moveMentionActive(delta) {
  if (!_mentionItems.length) return;
  _mentionActive = (_mentionActive + delta + _mentionItems.length) % _mentionItems.length;
  renderMentionList(_mentionQuery);
}
function closeChatMentionPicker() {
  if (_mentionPop) { _mentionPop.style.display = 'none'; _mentionPop.hidden = true; }
  _mentionItems = []; _mentionActive = 0; _mentionCtx = null; _mentionQuery = '';
}
/** 全局键盘路由：当浮层打开时，↑↓/Enter/Esc 走浮层；返回 true 表示已消费。 */
function handleMentionKeydown(e, inputEl) {
  if (!_mentionPop || _mentionPop.hidden || !_mentionPop.style.display || _mentionPop.style.display === 'none') return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionActive(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionActive(-1); return true; }
  if (e.key === 'Enter') { e.preventDefault(); confirmMention(_mentionActive, inputEl, _mentionAtIdx); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeChatMentionPicker(); return true; }
  return false;
}

// 暴露给 reader.js（ESM，无法 import 本文件）：抽屉 AI 对话复用同一份全宽扁平渲染 + 辅助函数。
if (typeof window !== 'undefined') {
  window.formatChatTime = formatChatTime;
  window.CHAT_ROLE_ICO = CHAT_ROLE_ICO;
  window.chatMsgHtml = chatMsgHtml;
  window.chatEmptyHtml = chatEmptyHtml;
  window.CHAT_SUGGESTIONS = CHAT_SUGGESTIONS;
  window.getChatParams = getChatParams;
  window.getChatPresets = getChatPresets;
  window.CHAT_PARAM_FIELDS = CHAT_PARAM_FIELDS;
  window.wireChatParamsShell = wireChatParamsShell;
  window.searchPapersForMention = searchPapersForMention;
  window.extraChipsReadonlyHtml = extraChipsReadonlyHtml;
  window.truncateChatTitle = truncateChatTitle;
  // @ 引用选择浮层（v2.7 现代化版，详情 tab + reader 抽屉共用）
  window.openChatMentionPicker = openChatMentionPicker;
  window.closeChatMentionPicker = closeChatMentionPicker;
  window.handleMentionKeydown = handleMentionKeydown;
}

/** 详情「AI 聊天」tab：消息列表（user 右 / assistant 左）+ 输入框 + 发送 + 清空。
 *  数据源 p.chat（detailView 回传）。发送走 POST /api/papers/:id/chat，回复追加到 state.detail.chat。
 *
 *  竞态防护（核心）：定时 refresh() 每 10s 调 renderDetail 全量重建本 tab，会导致
 *    ① 用户未发送的输入被清空 ② 进行中的请求把回复 append 到「已被重建掉的旧 list 节点」
 *    （stale 闭包引用）→ 用户永远看不到回复。两症状同源。
 *  解法（参考现代 LLM 对话 UI 最佳实践）：
 *    - chatState（模块级）保存 draft/busy，renderDetail 重建后回填，杜绝「打字被清空」
 *    - 追加目标用 document.getElementById 实时重查，绝不用 stale 闭包引用
 *    - 发送期间 busy=true 禁用发送键 + 锁 textarea，防双发；切论文时 chatState 失效（id 不符即忽略响应） */
function renderChatTab(body, p) {
  // 切论文时 chatState 归零（旧论文的 draft/busy/extraIds 不带到新论文）。
  // 关键：若旧论文有进行中的流式请求，必须先关闭 EventSource（否则旧流继续往新 tab 灌 token → 串论文 + 重连）。
  if (!chatState || chatState.id !== p.id) {
    if (chatState && chatState.closeStream) { try { chatState.closeStream(); } catch {} }
    chatState = { id: p.id, draft: '', busy: false, reqId: 0, closeStream: null, extraIds: [], editingMi: null };
    closeChatMentionPicker(); // 切论文时关 @ 浮层（避免 stale textarea 引用）
    toggleChatOutline(false); // 切论文时关大纲浮窗（条目已失效）
  }
  if (!Array.isArray(chatState.extraIds)) chatState.extraIds = [];
  const msgs = Array.isArray(p.chat) ? p.chat.slice() : [];
  // 流式进行中（busy）时，把「正在生成的 assistant 占位」追加到消息列表末尾，
  // 这样定时 refresh() 重建 #chat-list 时不会丢失占位（占位不在 p.chat 里，是 doSend 直接 append 的）。
  // chatState.streaming 记录 { content, reasoning }，重建时还原。
  if (chatState.busy && chatState.streaming) {
    msgs.push({ role: 'assistant', _streaming: true, content: chatState.streaming.content || '', reasoning: chatState.streaming.reasoning || '' });
  }
  const listHtml = msgs.length
    ? msgs.map((m, i) => {
        if (m._streaming) {
          // 流式占位：思考中（skeleton shimmer）或已收到部分 token（streaming 光标）
          const c = (m.content || '').trim();
          const reasoning = (m.reasoning || '').trim();
          const rsHtml = reasoning ? `<div class="chat-reasoning streaming"><details open><summary>思考中…</summary><div class="chat-reasoning-body">${escapeHtml(reasoning)}</div></details></div>` : '';
          if (c) {
            const node = `<div class="chat-msg assistant" data-mi="${i}" data-streaming="1"><div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">AI</span></div><div class="chat-body"><div class="chat-bubble streaming"><div class="chat-content streaming">${renderChatMd(m.content, { final: false })}</div></div></div></div>`;
            return rsHtml ? node.replace('<div class="chat-body">', '<div class="chat-body">' + rsHtml) : node;
          }
          // skeleton：三行 shimmer 占位
          const skNode = `<div class="chat-msg assistant" data-mi="${i}" data-streaming="1"><div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">AI</span></div><div class="chat-body">${rsHtml}<div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div></div></div>`;
          return skNode;
        }
        // 仅最后一条非流式 assistant 显示「重新生成」
        const isLastAssistant = i === msgs.length - 1 && m.role === 'assistant';
        return chatMsgHtml(m, i, { regenerable: isLastAssistant });
      }).join('')
    : chatEmptyHtml();
  // 预置快捷提问（折叠到 popover，避免常年占用一行）
  const presets = getChatPresets();
  // 参数浮层：每参数卡片（启用开关 + 滑块/数字 + 值 badge）
  const paramCardsHtml = CHAT_PARAM_FIELDS.map((f) => {
    const inputHtml = f.kind === 'range'
      ? `<input type="range" class="pp-in" min="${f.min}" max="${f.max}" step="${f.step}" disabled />`
      : `<input type="number" class="pp-in" min="${f.min}" step="${f.step}" placeholder="不限" disabled />`;
    return `<div class="pp-card" data-key="${f.key}">
      <div class="pp-card-head"><span class="pp-label">${f.label}</span><b class="pp-val">默认</b><label class="pp-switch-wrap"><input type="checkbox" class="pp-switch" /><span class="pp-track"></span></label></div>
      ${inputHtml}
    </div>`;
  }).join('');
  // 预置浮层（折叠式：点按钮展开列表）
  const presetsPopoverHtml = `<div class="chat-presets-pop" id="chat-presets-pop" hidden>${presets.map((pr) => `<button class="chat-preset-item" data-prompt="${escapeHtml(pr.prompt)}" title="${escapeHtml(pr.prompt)}"><span>${escapeHtml(pr.label)}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`).join('')}</div>`;
  // 当前选中模型（Phase 2：getSelectedModel 优先，否则默认）
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  const currentModel = selModel || (state.aiModels && state.aiModels.default) || '默认模型';
  body.innerHTML = `<div class="chat-tab">
    <div class="chat-list" id="chat-list">${listHtml}<button class="scroll-bottom-btn" id="chat-scroll-bottom" title="滚动到底部" aria-label="滚动到底部"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button></div>
    <div class="chat-input-shell">
      <div class="chat-composer" id="chat-composer">
        <div class="chat-composer-context" id="chat-mentions-row"></div>
        <textarea id="chat-input" rows="1" placeholder="问问 AI 关于这篇论文…  @ 引用其它论文">${escapeHtml(chatState.draft || '')}</textarea>
        <div class="chat-composer-footer">
          <div class="chat-composer-left">
            <button class="chat-tool-btn" id="chat-presets-btn" type="button" title="快捷提问">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>
              <span>快捷</span>
            </button>
            <button class="chat-tool-btn icon-only" id="chat-params-btn" type="button" title="模型参数">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
              <span class="cp-badge"></span>
            </button>
            ${msgs.length ? '<button class="chat-tool-btn icon-only" id="chat-outline" title="问答大纲"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg></button>' : ''}
            ${msgs.length ? '<button class="chat-tool-btn" id="chat-clear" type="button" title="清空聊天记录"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg><span>清空</span></button>' : ''}
          </div>
          <div class="chat-composer-right">
            <button class="chat-model-btn" id="chat-model-btn" type="button" title="切换模型" aria-expanded="false">
              <span class="cm-name">${escapeHtml(currentModel)}</span>
              <svg class="cm-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="chat-send-btn" id="chat-send" type="button" ${chatState.busy ? 'disabled' : ''} title="${chatState.busy ? '生成中' : '发送（Enter）'}" aria-label="${chatState.busy ? '停止生成' : '发送'}">
              ${chatState.busy ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>'}
            </button>
          </div>
        </div>
        <div class="chat-params-pop" id="chat-params-pop" hidden><div class="pp-title">模型参数 <span class="pp-hint">仅启用的参数随请求发送</span></div>${paramCardsHtml}</div>
        ${presetsPopoverHtml}
      </div>
    </div>
  </div>`;
  const list = $('chat-list');
  if (list) list.scrollTop = list.scrollHeight;
  const input = $('chat-input'), sendBtn = $('chat-send');
  if (chatState.busy) { input.disabled = true; sendBtn.classList.add('sending'); }
  // 实时同步 draft 到 chatState（任何 input 变化即存），renderDetail 重建后由上方回填，杜绝「打字被清空」
  input.oninput = () => { chatState.draft = input.value; autoResizeInput(input); handleMentionTrigger(input, p); updateSendEnabled(); };
  autoResizeInput(input);
  updateSendEnabled();
  // 渲染当前 @ 引用 chip 行
  renderExtraIdsRow();
  // 模型参数浮层：接线 + 徽章计数
  wireChatParamsShell('chat-params-pop', 'chat-params-btn');
  wireParamsToggle('chat-params-btn', 'chat-params-pop');
  // 预置浮层切换 + 项点击
  wireParamsToggle('chat-presets-btn', 'chat-presets-pop');
  body.querySelectorAll('.chat-preset-item').forEach((btn) => {
    btn.onclick = () => { input.value = btn.dataset.prompt || ''; chatState.draft = input.value; autoResizeInput(input); $('chat-presets-pop').hidden = true; updateSendEnabled(); doSend(); };
  });
  // 模型切换按钮（Phase 1 仅占位 toast，Phase 2 接入实际下拉）
  const modelBtn = $('chat-model-btn');
  if (modelBtn) modelBtn.onclick = (e) => { e.stopPropagation(); if (typeof window.toggleModelSwitcher === 'function') window.toggleModelSwitcher(modelBtn); else toast('模型切换即将上线（Phase 2）', 'info'); };
  /** 渲染当前 chatState.extraIds 的可移除 chip 行（输入框上方）。 */
  function renderExtraIdsRow() {
    const row = document.getElementById('chat-mentions-row');
    if (!row) return;
    row.hidden = !chatState.extraIds.length;
    if (!chatState.extraIds.length) { row.innerHTML = ''; return; }
    row.innerHTML = chatState.extraIds.map((id) => {
      const pp = (state.papers || []).find((x) => x.id === id);
      const title = (pp && pp.title) || id;
      return `<span class="extra-chip" data-eid="${escapeHtml(id)}" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escapeHtml(truncateChatTitle(title, 20))}<button class="extra-chip-x" data-eid="${escapeHtml(id)}" type="button" aria-label="移除引用">×</button></span>`;
    }).join('');
    row.querySelectorAll('.extra-chip-x').forEach((x) => {
      x.onclick = () => {
        const eid = x.dataset.eid;
        chatState.extraIds = chatState.extraIds.filter((i) => i !== eid);
        renderExtraIdsRow();
      };
    });
  }
  /** @ 触发器：检测光标前最近的 @，弹论文选择浮层（v2.7 共享版）。 */
  function handleMentionTrigger(inputEl, paper) {
    const val = inputEl.value;
    const pos = inputEl.selectionStart != null ? inputEl.selectionStart : val.length;
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) { closeChatMentionPicker(); return; }
    const charBefore = atIdx > 0 ? before[atIdx - 1] : ' ';
    if (charBefore && !/\s/.test(charBefore)) { closeChatMentionPicker(); return; }
    const query = before.slice(atIdx + 1);
    if (query.includes('\n') || query.length > 40) { closeChatMentionPicker(); return; }
    openChatMentionPicker(inputEl, {
      excludeId: paper.id,
      selectedIds: chatState.extraIds,
      onPick: (id) => {
        if (!chatState.extraIds.includes(id)) chatState.extraIds.push(id);
        renderExtraIdsRow();
        chatState.draft = inputEl.value;
        autoResizeInput(inputEl);
        updateSendEnabled();
      },
    }, query, atIdx);
  }
  /** 发送（支持 normal / regenerate / edit）。opts.regenerate=true 走重新生成；opts.skipUserMsg=true 不追加 user 气泡；
   *  opts.editMi=数字 走编辑重发（截断该 user 之后的历史）。 */
  const doSend = async (opts) => {
    opts = opts || {};
    if (chatState.busy) return; // 停止由独立按钮处理
    const regenerate = !!opts.regenerate;
    const editMi = opts.editMi != null ? Number(opts.editMi) : null;
    const message = regenerate ? '' : (input.value || '').trim();
    if (!message && !regenerate) return;
    // 当前引用（编辑重发时沿用被编辑 user 的 extraIds）
    const extraIds = regenerate ? [] : (editMi != null ? (extractExtraIdsFromMsg(editMi) || chatState.extraIds.slice()) : chatState.extraIds.slice());
    // 乐观入位：先存草稿=空、busy=true，再清输入框（顺序关键：状态先于 UI，避免刷新间隙丢消息）
    if (!regenerate) { chatState.draft = ''; input.value = ''; autoResizeInput(input); }
    if (!regenerate && editMi == null) { chatState.extraIds = []; renderExtraIdsRow(); } // 正常发送后清引用
    chatState.editingMi = null;
    chatState.busy = true;
    const myReqId = ++chatState.reqId;
    const reasoningStart = Date.now();
    // 关闭上一个 EventSource（若有），再开新的。closeStream 是 streamChatFetch 返回的中止函数。
    if (chatState.closeStream) { try { chatState.closeStream(); } catch {} }
    let myClose = null;
    // 编辑重发：截断被编辑 user 之后的历史（DOM + p.chat）
    if (editMi != null && !opts.skipTruncate) {
      const cutCount = (p.chat || []).length - editMi;
      if (cutCount > 0) {
        p.chat = (p.chat || []).slice(0, editMi);
        const liveList = document.getElementById('chat-list');
        if (liveList) { [...liveList.querySelectorAll('.chat-msg')].slice(-cutCount).forEach((n) => n.remove()); }
      }
    }
    // 乐观追加 user 消息（重新生成跳过——DOM 已移除最后一轮，用服务端历史）
    if (!opts.skipUserMsg) {
      const userMsg = { role: 'user', content: message };
      if (extraIds.length) userMsg.extraIds = extraIds;
      p.chat = [...(p.chat || []), userMsg];
      appendChatMsgById('chat-list', userMsg);
    }
    // 流式占位 assistant 消息：先 skeleton shimmer，首个 token 后逐字 renderChatMd 重渲 + 气泡发光。
    // 标记 data-streaming="1"，让 lastAssistantNode 精确定位（不被已有历史 assistant 干扰）。
    appendChatMsgById('chat-list', { role: 'assistant', content: '' });
    {
      // 找刚追加的占位（最后一个 .chat-msg.assistant），重写为 skeleton 结构 + data-streaming 标记
      const accList2 = document.getElementById('chat-list');
      const allAsst = accList2 ? [...accList2.querySelectorAll('.chat-msg.assistant')] : [];
      const accNode2 = allAsst.length ? allAsst[allAsst.length - 1] : null;
      if (accNode2) {
        accNode2.setAttribute('data-streaming', '1');
        const body2 = accNode2.querySelector('.chat-body');
        if (body2) body2.innerHTML = '<div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div>';
      }
      if (accList2) accList2.scrollTop = accList2.scrollHeight;
    }
    // morphing 发送键：圆→红方块停止
    setBusyUI(true);
    let accumulated = '';
    let accumulatedReasoning = '';
    chatState.streaming = { content: '', reasoning: '' };  // 流式状态：供 renderChatTab 重建时保留占位
    const lastAssistantNode = () => {
      const liveList = document.getElementById('chat-list');
      // 优先取流式占位（data-streaming），其次末条 assistant
      const streaming = liveList && liveList.querySelector('.chat-msg.assistant[data-streaming="1"]');
      if (streaming) return streaming;
      const all = liveList ? [...liveList.querySelectorAll('.chat-msg.assistant')] : [];
      return all.length ? all[all.length - 1] : null;
    };
    /** 把占位切换到 streaming 气泡态（首 token 到达时调用一次）。 */
    const ensureStreamingBubble = () => {
      const liveNode = lastAssistantNode();
      if (!liveNode) return;
      const bubble = liveNode.querySelector('.chat-bubble');
      if (!bubble) return;
      bubble.classList.remove('thinking-skeleton');
      bubble.classList.add('streaming');
      // skeleton 的 .thinking 内容替换为空 .streaming 容器
      const content = bubble.querySelector('.chat-content');
      if (content) { content.classList.remove('thinking'); content.classList.add('streaming'); content.innerHTML = ''; }
    };
    const renderAccumulated = () => {
      const liveNode = lastAssistantNode();
      if (!liveNode) return;
      let bubble = liveNode.querySelector('.chat-bubble');
      if (!bubble) {                // 兜底：占位结构异常时重建
        const body = liveNode.querySelector('.chat-body');
        if (!body) return;
        body.innerHTML = '<div class="chat-bubble streaming"><div class="chat-content streaming"></div></div>';
        bubble = body.querySelector('.chat-bubble');
      }
      ensureStreamingBubble();
      const content = bubble.querySelector('.chat-content');
      if (content) {
        content.innerHTML = renderChatMd(accumulated, { final: false });  // markdown 增量重渲（流式不折叠代码块）
      }
      const ll = document.getElementById('chat-list'); if (ll) ll.scrollTop = ll.scrollHeight;
    };
    const renderReasoning = () => {
      const body = lastAssistantNode() ? lastAssistantNode().querySelector('.chat-body') : null;
      if (!body) return;
      let el = body.querySelector('.chat-reasoning');
      if (!el) { el = document.createElement('div'); el.className = 'chat-reasoning streaming'; body.insertBefore(el, body.firstChild); }
      el.innerHTML = '<details open><summary>思考中…</summary><div class="chat-reasoning-body"></div></details>';
      const rb = el.querySelector('.chat-reasoning-body');
      if (rb) rb.textContent = accumulatedReasoning;
      const ll = document.getElementById('chat-list'); if (ll) ll.scrollTop = ll.scrollHeight;
    };
    myClose = streamChatFetch(p.id, message, {
      regenerate,
      extraIds: extraIds.length ? extraIds : undefined,
      onToken: (t, kind) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) { try { myClose(); } catch {} return; }
        if (kind === 'reasoning') {
          accumulatedReasoning += t;
          chatState.streaming = { content: accumulated, reasoning: accumulatedReasoning };
          renderReasoning();
          return;
        }
        accumulated += t;
        chatState.streaming = { content: accumulated, reasoning: accumulatedReasoning };  // 同步到 chatState，renderChatTab 重建时还原占位
        renderAccumulated();
      },
      onDone: (data) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) return;
        chatState.busy = false;
        chatState.closeStream = null;
        chatState.streaming = null;   // 流式结束，清除占位状态
        setBusyUI(false);
        // 用服务端权威 chat 数组替换（含完整回复 + ts）；重渲整条 assistant（补时间戳/操作按钮/重新生成）
        if (data && data.reply != null) {
          accumulated = data.reply;
          p.chat = Array.isArray(data.chat) ? data.chat : [...(p.chat || []), { role: 'assistant', content: data.reply }];
          // 重渲最后一条 assistant 为定型结构（含时间戳 + 操作工具栏）
          const liveNode = lastAssistantNode();
          if (liveNode && p.chat.length) {
            const lastMsg = p.chat[p.chat.length - 1];
            const tmp = document.createElement('div');
            tmp.innerHTML = chatMsgHtml(lastMsg, Number(liveNode.dataset.mi || 0), { regenerable: true });
            if (tmp.firstElementChild) {
              liveNode.replaceWith(tmp.firstElementChild);
              const newNode = tmp.firstElementChild;
              // reasoning：完成后自动收起 + 显示「思考了 X 秒」（1s 延时，NewAPI 同款）
              if (accumulatedReasoning.trim()) {
                const newBody = newNode.querySelector('.chat-body');
                if (newBody) {
                  const dur = Math.max(1, Math.round((Date.now() - reasoningStart) / 1000));
                  const rEl = document.createElement('div');
                  rEl.className = 'chat-reasoning';
                  rEl.innerHTML = `<details><summary><span class="rs-label">思考过程</span><span class="rs-duration">思考了 ${dur} 秒</span></summary><div class="chat-reasoning-body"></div></details>`;
                  rEl.querySelector('.chat-reasoning-body').textContent = accumulatedReasoning;
                  newBody.insertBefore(rEl, newBody.firstChild);
                }
              }
            }
          }
        }
        try { if (input) input.focus(); } catch {}
      },
      onFail: (err) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) return;
        chatState.busy = false;
        chatState.closeStream = null;
        chatState.streaming = null;   // 流式结束（失败），清除占位状态
        setBusyUI(false);
        // 占位若仍空（无 token 到达）→ 改错误文案；否则保留已收到部分
        if (!accumulated) {
          const liveNode = lastAssistantNode();
          const bubble = liveNode && liveNode.querySelector('.chat-bubble');
          if (bubble) {
            bubble.classList.remove('thinking-skeleton', 'streaming');
            let content = bubble.querySelector('.chat-content');
            if (!content) { content = document.createElement('div'); content.className = 'chat-content'; bubble.appendChild(content); }
            content.classList.remove('thinking', 'streaming');
            content.textContent = '（' + (err || 'AI 回答失败') + '）';
          }
        } else {
          toast(err || 'AI 回答失败', 'error');
        }
        try { input.focus(); } catch {}
      },
    });
    chatState.closeStream = myClose;
  };
  /** 切换 busy 态 UI：morphing 发送键（圆→红方块停止）+ 输入锁。renderDetail 重建后仍能用 getElementById 重查。 */
  function setBusyUI(busy) {
    const sb = document.getElementById('chat-send');
    const ip = document.getElementById('chat-input');
    if (sb) {
      sb.disabled = false;                  // 停止键可点；非 busy 时由 updateSendEnabled 控制空输入禁用
      sb.classList.toggle('sending', !!busy);
      sb.title = busy ? '停止生成' : '发送（Enter）';
      sb.setAttribute('aria-label', busy ? '停止生成' : '发送');
      sb.innerHTML = busy
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    }
    if (ip) ip.disabled = busy;
  }
  /** 发送键空输入禁用（非 busy 时）。busy 时由 setBusyUI 控制（保持可点 = 停止）。 */
  function updateSendEnabled() {
    const sb = document.getElementById('chat-send');
    const ip = document.getElementById('chat-input');
    if (!sb || chatState.busy) return;
    const empty = !(ip && (ip.value || '').trim());
    sb.disabled = empty;
  }
  /** 从 p.chat[mi] 取 extraIds（编辑重发沿用引用）。 */
  function extractExtraIdsFromMsg(mi) {
    const m = (p.chat || [])[mi];
    return m && Array.isArray(m.extraIds) ? m.extraIds.slice() : null;
  }
  doSendFromInput = doSend; // 供建议卡片 / 重新生成 / 编辑调用
  renderExtraIdsRowSafe = renderExtraIdsRow; // 编辑 user 时刷新 @ 引用 chip 行
  // 发送键 = morphing：非 busy 时发送；busy 时变停止键，点击中止流式
  sendBtn.onclick = () => {
    if (chatState.busy) {
      if (chatState.closeStream) { try { chatState.closeStream(); } catch {} }
      chatState.busy = false; chatState.streaming = null; setBusyUI(false); updateSendEnabled();
      return;
    }
    doSend();
  };
  // stopPropagation：防止 Enter 冒泡到全局键盘处理器（disabled 后 activeElement 变 body → 触发 openReader）
  input.onkeydown = (e) => {
    // @ 引用浮层打开时：↑↓ 导航 / Enter 选中 / Esc 关闭（共享 handleMentionKeydown）
    if (handleMentionKeydown(e, input)) { e.stopPropagation(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); closeChatMentionPicker(); doSend(); }
  };
  // 注：点击外部关闭浮层由 picker 内部的全局 mousedown 监听器统一处理（detail tab / reader 抽屉共用）
  const clearBtn = $('chat-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('清空这篇论文的聊天记录？')) return;
    p.chat = [];
    await PATCH('/api/papers/' + p.id, { chat: [] });
    renderDetail();
  };
  const outlineBtn = $('chat-outline');
  if (outlineBtn) outlineBtn.onclick = () => toggleChatOutline();
  // 新增控件接线：建议卡片、滚动到底部、消息操作（复制/重新生成/编辑/删除/显示原文/代码块复制/展开）
  wireChatExtras(p, list, input, doSend);
}
/** 参数浮层显隐切换（按钮点击 → toggle；点外部关闭）。 */
function wireParamsToggle(btnId, popId) {
  const btn = document.getElementById(btnId);
  const pop = document.getElementById(popId);
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.hidden = true;
  });
}
/** textarea 自适应高度（min 38 / max 142）。 */
function autoResizeInput(el) {
  if (!el) return;
  el.style.height = '38px';
  el.style.height = Math.min(142, el.scrollHeight) + 'px';
}
/** 接线：空状态建议卡片（点即发）、滚动到底部 FAB（滚动检测+点击）、消息操作（复制/重新生成/编辑/删除/显示原文）、代码块复制/展开。
 *  全部用事件委托（消息 DOM 会被流式/重建替换，委托到 list 最稳）。doSend 透传 renderChatTab 的闭包。 */
function wireChatExtras(p, list, input, doSend) {
  if (!list) return;
  // 建议卡片（空状态）
  list.querySelectorAll('.chat-suggest').forEach((chip) => {
    chip.onclick = () => { input.value = chip.dataset.q || ''; chatState.draft = input.value; autoResizeInput(input); doSend && doSend(); };
  });
  // 滚动到底部 FAB：滚动时检测距底，点击滚到底
  const fabEl = list.querySelector('.scroll-bottom-btn');
  if (fabEl) {
    const updateFab = () => {
      const near = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
      fabEl.classList.toggle('show', !near && list.scrollHeight > list.clientHeight + 50);
    };
    list.addEventListener('scroll', updateFab, { passive: true });
    updateFab();
    fabEl.onclick = () => { list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); };
  }
  // 消息操作 + 代码块操作（事件委托，适应流式重建）
  list.addEventListener('click', (e) => {
    // —— 代码块复制 / 展开 ——
    const cbCopy = e.target.closest('.cb-copy');
    if (cbCopy) {
      const card = cbCopy.closest('.cb-card');
      const pre = card && card.querySelector('pre');
      const text = pre ? pre.textContent : '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { cbCopy.classList.add('copied'); const sp = cbCopy.querySelector('span'); if (sp) sp.textContent = '已复制'; setTimeout(() => { cbCopy.classList.remove('copied'); const sp2 = cbCopy.querySelector('span'); if (sp2) sp2.textContent = '复制'; }, 1200); }).catch(() => toast('复制失败', 'error'));
      return;
    }
    const cbExp = e.target.closest('.cb-expand');
    if (cbExp) { const card = cbExp.closest('.cb-card'); if (card) card.classList.remove('collapsed'); return; }
    // —— 消息操作 ——
    const act = e.target.closest('.chat-act');
    if (!act) return;
    const mi = Number(act.dataset.mi);
    if (act.dataset.act === 'copy') {
      const msg = (p.chat || [])[mi];
      const text = msg ? (msg.content || '') : '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败', 'error'));
      else toast('剪贴板不可用', 'error');
    } else if (act.dataset.act === 'regen') {
      doRegenerate();
    } else if (act.dataset.act === 'source') {
      // 切换显示原文 ⇄ 渲染态
      const node = act.closest('.chat-msg');
      if (!node) return;
      const isRaw = node.getAttribute('data-show-source') === '1';
      node.setAttribute('data-show-source', isRaw ? '0' : '1');
      act.title = isRaw ? '显示原文' : '显示渲染';
    } else if (act.dataset.act === 'edit') {
      // 编辑用户消息并重发：内容填回输入框，标记 editingMi，发送时截断其后历史
      const msg = (p.chat || [])[mi];
      if (!msg) return;
      if (chatState && chatState.busy) { toast('请等当前回答完成', 'error'); return; }
      input.value = msg.content || '';
      chatState.draft = input.value;
      chatState.editingMi = mi;
      // 沿用该 user 的 extraIds（编辑后重发保持引用）
      chatState.extraIds = Array.isArray(msg.extraIds) ? msg.extraIds.slice() : [];
      autoResizeInput(input);
      if (typeof renderExtraIdsRowSafe === 'function') renderExtraIdsRowSafe();
      input.focus();
      toast('编辑后按发送将重新回答（后续消息会被替换）', 'info');
    } else if (act.dataset.act === 'delete') {
      const msg = (p.chat || [])[mi];
      if (!msg) return;
      if (chatState && chatState.busy) { toast('请等当前回答完成', 'error'); return; }
      // user：删该 user + 紧随的 assistant；assistant：删该 assistant
      const cut = [mi];
      if (msg.role === 'user' && (p.chat || [])[mi + 1] && (p.chat || [])[mi + 1].role === 'assistant') cut.push(mi + 1);
      if (!confirm('删除这条消息？' + (cut.length > 1 ? '（及其回复也会删除）' : ''))) return;
      p.chat = (p.chat || []).filter((_, idx) => !cut.includes(idx));
      PATCH('/api/papers/' + p.id, { chat: p.chat }).then(() => { state.detail.chat = p.chat; renderDetail(); });
    }
  });
}
/** 从输入框发送（建议卡片 / 预置 / 重新生成 / 编辑用）。供外部引用 doSend 闭包——这里转发到模块级。
 *  注意：doSend 是 renderChatTab 内的闭包，无法外部调用；外部直接走独立的 doSendFromInput。 */
let doSendFromInput = null; // renderChatTab 内赋值
let renderExtraIdsRowSafe = null; // renderChatTab 内赋值（编辑 user 时刷新 chip 行）
/** 重新生成最后一条 assistant 回答：前端移除最后一轮 DOM + 调 doSend({regenerate})。 */
function doRegenerate() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  if (chatState && chatState.busy) { toast('请等当前回答完成', 'error'); return; }
  // 移除 DOM 最后两条（user+assistant）
  const msgs = [...list.querySelectorAll('.chat-msg')];
  const lastUser = [...msgs].reverse().find((m) => m.classList.contains('user'));
  const lastAssistant = [...msgs].reverse().find((m) => m.classList.contains('assistant'));
  if (lastAssistant) lastAssistant.remove();
  if (lastUser) lastUser.remove();
  // 触发 regenerate 发送（skipUserMsg：不重复追加 user，服务端从历史取）
  doSendFromInput && doSendFromInput({ regenerate: true, skipUserMsg: true });
}
/** 追加一条聊天消息到列表 DOM：用 elementId 实时重查目标节点（绝不用 stale 闭包引用），
 *  这样即便 renderDetail 重建了 #chat-list，仍能正确追加到当前可见节点。
 *  data-mi 标记当前条索引，供问答大纲点击跳转实时重查定位。全宽扁平结构。 */
function appendChatMsgById(elementId, m) {
  const list = document.getElementById(elementId);
  if (!list) return;
  // 清空态提示存在则移除（首条消息出现时）
  const empty = list.querySelector('.chat-empty');
  if (empty) empty.remove();
  const idx = list.querySelectorAll('.chat-msg').length;
  const html = chatMsgHtml(m, idx);
  // insertAdjacentHTML：保留 FAB（scroll-bottom-btn，是 .chat-list 直接子元素，在 .chat-msg 之后）
  const fab = list.querySelector('.scroll-bottom-btn');
  if (fab) fab.insertAdjacentHTML('beforebegin', html);
  else list.insertAdjacentHTML('beforeend', html);
  list.scrollTop = list.scrollHeight;
}

/** 详情 AI tab 的「问答大纲」浮窗：列出每个用户提问（Q1/Q2…），点击实时重查 #chat-list 跳转到对应消息。
 *  条目数据从当前详情 p.chat 过滤 role==='user'；不持有 stale 节点引用——点击时 getElementById 重查。
 *  open 不传则切换显隐；传 true 强制开。
 *  v2.7 修复：浮窗 position:fixed 挂 body，锚定视口右上——不再随 detail-pane 滚动消失/跟随。 */
function toggleChatOutline(open) {
  const existing = document.querySelector('body > .chat-outline-pop');
  const mask = document.querySelector('body > .co-mask');
  // open === false（显式关）：无条件关闭，不创建。open === true（显式开）：仅在已关时创建。
  // open == null（toggle，按钮点击）：已开则关、未开则开。
  if (open === false) { if (existing) existing.remove(); if (mask) mask.remove(); return; }
  if (existing) {
    // 已开：除非显式 open === true，否则视为 toggle 的「关」分支
    if (open !== true) { existing.remove(); if (mask) mask.remove(); }
    return;
  }
  const p = state.detail;
  if (!p || !Array.isArray(p.chat)) return;
  // 条目：所有 user 消息（每对 Q&A 的「问题」），记录其在 chat 数组中的索引用于跳转
  const items = [];
  p.chat.forEach((m, i) => { if (m.role === 'user') items.push({ mi: i, q: (m.content || '').trim() }); });
  if (!items.length) { toast('还没有对话'); return; }

  // 浮窗结构
  const pop = document.createElement('div');
  pop.className = 'chat-outline-pop fixed';
  pop.innerHTML = `<div class="co-head">
    <span>问答大纲<span class="co-count"> · ${items.length} 个问题</span></span>
    <button class="co-close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg></button>
  </div><div class="co-list"></div>`;
  const coList = pop.querySelector('.co-list');
  items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'co-item';
    row.innerHTML = `<span class="co-q">Q${idx + 1}</span><span class="co-title"></span>`;
    row.querySelector('.co-title').textContent = truncateChatTitle(it.q); // textContent 防 XSS
    row.onclick = () => {
      // 实时重查列表与目标节点（renderDetail 可能已重建 #chat-list，绝不用 stale 引用）
      const list = document.getElementById('chat-list');
      const target = list && list.querySelector('.chat-msg[data-mi="' + it.mi + '"]');
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); // 重启动画
        setTimeout(() => target.classList.remove('flash'), 800);
      }
      toggleChatOutline(false); // 跳转后关浮窗
    };
    coList.appendChild(row);
  });
  pop.querySelector('.co-close').onclick = () => toggleChatOutline(false);
  // 全屏透明遮罩：点外部关闭（独立于 mask 点击，避免点浮窗自身时关掉）
  const m = document.createElement('div');
  m.className = 'co-mask';
  m.onclick = () => toggleChatOutline(false);

  document.body.appendChild(m);
  document.body.appendChild(pop);
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
    // 重新拉取详情视图（含 conceptIds），让信息 tab 的概念数量实时更新（refresh 拉的是 summaryView 无 conceptIds）
    try {
      const { data: fresh } = await jget('/api/papers/' + encodeURIComponent(p.id));
      if (fresh) { state.detail = fresh; renderDetail(); }
    } catch { /* ignore */ }
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
  // 概念 Markdown 下载链接带当前空间（静态 <a href> 不经 sp()，这里手动注入）
  const dl = document.querySelector('a[href="/api/concepts.md"]');
  if (dl) dl.href = sp('/api/concepts.md');
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
function syncPickUI() {
  const n = state.selected.size;
  const total = state.papers.length;
  $('sel-count').textContent = '已选 ' + n + ' 篇';
  // 全选按钮：全选/取消全选随当前选中态切换文案
  const allBtn = $('btn-pick-all');
  if (allBtn) {
    const allOn = total > 0 && n === total;
    allBtn.textContent = allOn ? '取消全选' : '全选';
    allBtn.classList.toggle('active', allOn);
  }
}
function togglePick(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  syncPickUI();
  renderList();
}
function togglePickMode(on) {
  state.pickMode = on;
  $('bulk-bar').classList.toggle('active', on);
  if (!on) state.selected.clear();
  syncPickUI();
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
    // ---- 聊天预置 Prompt（输入框上方快捷提问按钮，store.settings.chatPresets 覆盖内置默认）----
    chatPresetsOverride = Array.isArray(data.chatPresets) ? data.chatPresets : null;
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
    // ---- 划线翻译 ----
    if ($('translate-engine')) {
      $('translate-engine').value = data.translate.engine || 'google';
      $('translate-lang').value = data.translate.targetLang || 'zh-CN';
      $('translate-engine-hint').textContent = `config 默认：${data.configTranslate.engine || 'google'} · Google 免费端点秒回（推荐），AI 流式保留术语，Bing 走外链`;
      $('translate-lang-hint').textContent = `config 默认：${data.configTranslate.targetLang || 'zh-CN'}`;
      $('translate-hint').textContent = '';
    }
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
  // 划线翻译
  const tr = ov.translate || [];
  show('ovr-translate-engine', tr.includes('engine'));
  show('ovr-translate-lang', tr.includes('targetLang'));
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
  // 透传表单当前值（含未保存的改动），让用户改完不保存也能测。apiKey 掩码不传（后端用已存的）。
  const testPayload = {
    baseURL: $('ai-baseurl').value.trim(),
    model: $('ai-model').value.trim(),
  };
  const keyVal = $('ai-apikey').value;
  if (keyVal !== APIKEY_MASK) testPayload.apiKey = keyVal;
  hint.textContent = '正在用表单当前值发送测试请求…';
  try {
    const r = await POST('/api/settings/test', testPayload);
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
async function saveTranslate() {
  const btn = $('btn-translate-save');
  const hint = $('translate-hint');
  const payload = {
    engine: $('translate-engine').value,
    targetLang: $('translate-lang').value,
  };
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/translate', payload);
    setBusy(btn, false);
    if (r.ok) { hint.textContent = '已保存，划线翻译立即生效'; hint.className = 'save-hint good'; await loadSettingsData(); toast('划线翻译配置已保存'); }
    else { hint.textContent = r.error || '保存失败'; hint.className = 'save-hint bad'; }
  } catch (e) { setBusy(btn, false); hint.textContent = '保存失败：' + (e.message || e); hint.className = 'save-hint bad'; }
}

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
    // 同步到全局 state：首页「全部标签/全部主题」筛选下拉用同一份数据，避免编辑后不一致。
    state.tags = taxState.data.tag;
    state.topics = taxState.data.topic;
    renderFilters();
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

/** 点计数/名称跳回主列表并按该标签/主题筛选（设为单元素多选）。 */
function taxJumpToLibrary(kind, name) {
  if (kind === 'tag') state.filter.tags = [name];
  else state.filter.topics = [name];
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
  const tagTrig = $('filter-tag-trigger');
  if (tagTrig) tagTrig.onclick = () => openFilterPop('tag');
  const topicTrig = $('filter-topic-trigger');
  if (topicTrig) topicTrig.onclick = () => openFilterPop('topic');
  $('filter-starred').onchange = (e) => { state.filter.starred = e.target.checked; refresh(); };
  $('sort').onchange = (e) => { state.filter.sort = e.target.value; refresh(); };

  // 侧栏视图项
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => {
    el.onclick = () => {
      const m = el.dataset.mode;
      if (m === 'all') state.filter = { ...state.filter, mode: '', starred: false, folder: '', readStatus: '', status: '', tags: [], topics: [] };
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
    const es = new EventSource(sp('/api/discover/stream?topic=' + encodeURIComponent(topic)));
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
  $('btn-translate-save').onclick = saveTranslate;
  $('btn-translate-reset').onclick = () => resetSection('translate', '划线翻译');
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
  // 视图密度分段：紧凑 / 舒适 两个独立按钮（localStorage 记忆）
  const setDensity = (compact) => {
    state.compact = compact;
    localStorage.setItem('pw-compact', compact ? '1' : '0');
    renderList();
  };
  const vc2 = $('view-compact'), vf2 = $('view-comfort');
  if (vc2) vc2.onclick = () => setDensity(true);
  if (vf2) vf2.onclick = () => setDensity(false);

  // 侧栏收起 / 展开（记忆到 localStorage）
  $('btn-collapse').onclick = () => setSidebarCollapsed(true);
  $('btn-expand').onclick = () => setSidebarCollapsed(false);
  bindListSplitter();
  window.addEventListener('resize', () => applyListWidth(state.listWidth));
  $('btn-pick-cancel').onclick = () => togglePickMode(false);
  // 全选/取消全选当前列表
  $('btn-pick-all').onclick = () => {
    const total = state.papers.length;
    if (!total) return;
    if (state.selected.size === total) state.selected.clear();
    else state.papers.forEach((p) => state.selected.add(p.id));
    syncPickUI();
    renderList();
  };
  $('btn-pick-concepts').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    const btn = $('btn-pick-concepts');
    // 进度展示：抽取是逐篇 AI 调用，可能较久。显示不确定进度条 + 「抽取中 N 篇…」。
    const bp = $('bulk-progress'), bpText = $('bp-text'), bpFill = $('bp-fill');
    if (bp) { bp.hidden = false; bpFill.style.width = '100%'; bpFill.classList.add('indeterminate'); }
    if (bpText) bpText.textContent = `抽取中（${ids.length} 篇）…`;
    setBusy(btn, true, '抽取中…');
    $('btn-pick-cancel').disabled = true;
    $('btn-pick-all').disabled = true;
    $('btn-pick-delete').disabled = true;
    $('btn-pick-retag').disabled = true;
    $('btn-pick-resume').disabled = true;
    const r = await POST('/api/papers/concepts', { ids });
    setBusy(btn, false);
    $('btn-pick-cancel').disabled = false;
    $('btn-pick-all').disabled = false;
    $('btn-pick-delete').disabled = false;
    $('btn-pick-retag').disabled = false;
    $('btn-pick-resume').disabled = false;
    if (bp) { bp.hidden = true; bpFill.classList.remove('indeterminate'); }
    if (r.data) toast(`完成：处理 ${r.data.processed} 篇，新增 ${r.data.added} 个概念`);
    else toast(r.error || '抽取失败', 'error');
    if (r.ok) togglePickMode(false);
    refresh();
  };
  // 批量删除：确认后调 bulk-delete（后端会删文件 + 清理空 tags/topics/概念）
  $('btn-pick-delete').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    if (!confirm(`删除已选的 ${ids.length} 篇论文？\n将同时删除本地 PDF 与全文文本，并清理仅被这些论文使用的标签/主题/概念。此操作不可恢复。`)) return;
    const btn = $('btn-pick-delete');
    setBusy(btn, true, '删除中…');
    $('btn-pick-cancel').disabled = true;
    $('btn-pick-all').disabled = true;
    $('btn-pick-concepts').disabled = true;
    $('btn-pick-retag').disabled = true;
    $('btn-pick-resume').disabled = true;
    const r = await POST('/api/papers/bulk-delete', { ids });
    setBusy(btn, false);
    if (r.ok) { toast(`已删除 ${r.data.deleted} 篇`); togglePickMode(false); }
    else toast(r.error || '删除失败', 'error');
    refresh();
  };
  // 批量重新打标：用当前标签提示词重新生成标签/主题（标签库联动增删）
  $('btn-pick-retag').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    const btn = $('btn-pick-retag');
    const bp = $('bulk-progress'), bpText = $('bp-text'), bpFill = $('bp-fill');
    if (bp) { bp.hidden = false; bpFill.style.width = '100%'; bpFill.classList.add('indeterminate'); }
    if (bpText) bpText.textContent = `打标中（${ids.length} 篇）…`;
    setBusy(btn, true, '打标中…');
    $('btn-pick-cancel').disabled = true;
    $('btn-pick-all').disabled = true;
    $('btn-pick-concepts').disabled = true;
    $('btn-pick-delete').disabled = true;
    $('btn-pick-resume').disabled = true;
    const r = await POST('/api/papers/retag', { ids });
    setBusy(btn, false);
    $('btn-pick-cancel').disabled = false;
    $('btn-pick-all').disabled = false;
    $('btn-pick-concepts').disabled = false;
    $('btn-pick-delete').disabled = false;
    $('btn-pick-resume').disabled = false;
    if (bp) { bp.hidden = true; bpFill.classList.remove('indeterminate'); }
    if (r.ok) { toast(`已重新打标 ${r.data.processed} 篇`); togglePickMode(false); }
    else toast(r.error || '重新打标失败', 'error');
    refresh();
  };
  // 批量重新总结：逐篇加入串行队列（processOne 会重做解析/元数据/总结/打标）
  $('btn-pick-resume').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    const btn = $('btn-pick-resume');
    setBusy(btn, true, '排队中…');
    $('btn-pick-cancel').disabled = true;
    $('btn-pick-all').disabled = true;
    $('btn-pick-concepts').disabled = true;
    $('btn-pick-delete').disabled = true;
    $('btn-pick-retag').disabled = true;
    // 逐篇入队（POST summarize 每篇独立入队，串行 pipeline 处理）
    let okN = 0;
    for (const id of ids) {
      const r = await POST('/api/papers/' + id + '/summarize');
      if (r.ok) okN++;
    }
    setBusy(btn, false);
    $('btn-pick-cancel').disabled = false;
    $('btn-pick-all').disabled = false;
    $('btn-pick-concepts').disabled = false;
    $('btn-pick-delete').disabled = false;
    $('btn-pick-retag').disabled = false;
    if (okN) { toast(`已把 ${okN} 篇加入重新总结队列`); togglePickMode(false); }
    else toast('重新总结失败', 'error');
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

// ==================== 空间管理 ====================
// 每个空间绑定独立的论文文件夹，论文/标签/主题/概念/收藏夹/设置 完全隔离。
// state.space = 当前激活空间 id（localStorage 持久化）；所有 /api/ /papers/ 请求经 sp() 注入 ?space=。

/** 拉取空间列表，校验 state.space 仍存在（被删则回 active），渲染切换器。启动 + 切换后调用。 */
async function loadSpaces() {
  const r = await jget('/api/spaces');
  if (!r || !r.ok) return;
  const view = r.data || {};
  state.spaces = Array.isArray(view.spaces) ? view.spaces : [];
  // 校验本地记忆的空间仍存在；不存在则回 active
  const active = view.activeSpaceId;
  const stillExists = state.spaces.find((s) => s.id === state.space);
  if (!stillExists) {
    state.space = active || (state.spaces[0] && state.spaces[0].id) || '';
    localStorage.setItem('pw-space', state.space);
  }
  renderSpaceSwitcher();
}

/** 渲染顶部空间切换器（当前名 + 下拉列表）。 */
function renderSpaceSwitcher() {
  const cur = state.spaces.find((s) => s.id === state.space) || state.spaces[0];
  $('space-name').textContent = cur ? cur.name : '默认';
  const list = $('space-list');
  list.innerHTML = '';
  for (const s of state.spaces) {
    const btn = document.createElement('button');
    btn.className = 'space-opt' + (s.id === state.space ? ' active' : '');
    btn.type = 'button';
    btn.innerHTML = `<span class="space-opt-name">${escapeHtml(s.name)}</span>`
      + (s.id === state.space ? '<span class="space-opt-check">✓</span>' : '')
      + `<span class="space-opt-dir">${escapeHtml(s.papersDir || 'papers')}</span>`;
    btn.onclick = () => { switchSpace(s.id); closeSpaceMenu(); };
    list.appendChild(btn);
  }
}

function openSpaceMenu() {
  $('space-menu').hidden = false;
  $('space-switcher').classList.add('open');
}
function closeSpaceMenu() {
  $('space-menu').hidden = true;
  $('space-switcher').classList.remove('open');
}
function toggleSpaceMenu() {
  if ($('space-menu').hidden) openSpaceMenu(); else closeSpaceMenu();
}

/** 切换空间：激活 → teardown 流式状态 → 清空选中/筛选 → refresh + 重渲染详情。
 *  沿用 chat 切论文的 teardown 模式：关闭 EventSource、flush notes，避免旧流串入新空间。 */
async function switchSpace(id) {
  if (id === state.space) return;
  // teardown：关闭进行中的聊天流 + 落盘笔记
  if (chatState && typeof chatState.closeStream === 'function') { try { chatState.closeStream(); } catch {} }
  chatState = null;
  try { await flushPendingNotes(); } catch {}
  // 关阅读器（若开着）
  if (reader && typeof reader.close === 'function') { try { reader.close(); } catch {} }
  // 切换
  state.space = id;
  localStorage.setItem('pw-space', id);
  try { await POST('/api/spaces/' + encodeURIComponent(id) + '/activate'); } catch {}
  // 清空选中/筛选/详情（隔离：新空间的论文/标签不同）
  state.current = null;
  state.detail = null;
  state.selected = new Set();
  state.pickMode = false;
  state.filter = { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: state.filter.sort };
  $('search').value = '';
  renderSpaceSwitcher();
  await refresh();
  renderDetail();
  toast('已切换到空间：' + ((state.spaces.find((s) => s.id === id) || {}).name || ''), 'info');
}

// ---- 空间管理模态（展示优先 + 行内编辑）----
function openSpaceModal() {
  closeSpaceMenu();
  resetSpaceCreateForm();
  renderSpaceAdmin();
  $('space-modal').classList.add('active');
}
function closeSpaceModal() {
  $('space-modal').classList.remove('active');
}

/** 把 s.scanIntervalMinutes 渲染成「每 N 分钟扫描」/「已关闭」的副文案。 */
function scanIntervalText(min) {
  if (!min || min <= 0) return '定时扫描已关闭';
  return `每 ${min} 分钟扫描`;
}

/** 渲染空间管理列表：默认展示态卡片（点名/文件夹/论文数/活跃标记），点编辑就地展开输入框。 */
function renderSpaceAdmin() {
  const root = $('space-admin-list');
  root.innerHTML = '';
  for (const s of state.spaces) {
    const isDefault = s.id === 'default';
    const isActive = s.id === state.space;
    const card = document.createElement('div');
    card.className = 'sa-card' + (isActive ? ' is-active' : '');
    card.dataset.id = s.id;
    card.innerHTML = `
      <span class="sa-dot"></span>
      <div class="sa-card-main">
        <span class="sa-card-name">${escapeHtml(s.name)}</span>
        <span class="sa-card-dir" title="${escapeHtml(s.papersDir || 'papers')}">${escapeHtml(s.papersDir || 'papers')}</span>
      </div>
      <div class="sa-card-meta">
        <span class="sa-count" title="${escapeHtml(scanIntervalText(s.scanIntervalMinutes))}">${s.paperCount != null ? s.paperCount : 0} 篇</span>
        ${isActive ? '<span class="sa-badge">当前</span>' : ''}
        <div class="sa-card-actions">
          ${isActive ? '' : `<button class="sa-btn" data-act="switch">切换</button>`}
          <button class="sa-btn" data-act="edit">编辑</button>
        </div>
      </div>`;
    const switchBtn = card.querySelector('[data-act="switch"]');
    if (switchBtn) switchBtn.onclick = async () => { closeSpaceModal(); await switchSpace(s.id); };
    card.querySelector('[data-act="edit"]').onclick = () => renderSpaceAdminEdit(card, s, isDefault);
    root.appendChild(card);
  }
}

/** 把某张展示卡片就地替换为编辑态输入框（名称 + 文件夹 + 保存/取消/删除）。 */
function renderSpaceAdminEdit(card, s, isDefault) {
  card.className = 'sa-edit';
  card.innerHTML = `
    <div class="sa-edit-field">
      <span class="lbl">名称</span>
      <input type="text" data-k="name" value="${escapeHtml(s.name)}" />
    </div>
    <div class="sa-edit-field dir">
      <span class="lbl">文件夹</span>
      <input type="text" data-k="dir" value="${escapeHtml(s.papersDir || 'papers')}" title="绑定的论文文件夹（相对项目根或绝对路径）" />
    </div>
    <div class="sa-edit-actions">
      ${isDefault ? '' : '<button class="sa-btn danger" data-act="del">删除</button>'}
      <button class="sa-btn" data-act="cancel">取消</button>
      <button class="sa-btn" data-act="save">保存</button>
    </div>`;
  const nameInput = card.querySelector('[data-k="name"]');
  const dirInput = card.querySelector('[data-k="dir"]');
  const saveBtn = card.querySelector('[data-act="save"]');
  const cancelBtn = card.querySelector('[data-act="cancel"]');
  const delBtn = card.querySelector('[data-act="del"]');

  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    const dir = dirInput.value.trim();
    if (!name) { toast('空间名不能为空', 'error'); return; }
    if (!dir) { toast('文件夹路径不能为空', 'error'); return; }
    saveBtn.disabled = true;
    try {
      const r = await PATCH('/api/spaces/' + encodeURIComponent(s.id), { name, papersDir: dir });
      if (r && r.ok) {
        toast('已保存', 'success');
        await loadSpaces();
        renderSpaceAdmin();
      } else {
        toast((r && r.error) || '保存失败', 'error');
      }
    } catch (e) { toast(e.message || '保存失败', 'error'); }
    saveBtn.disabled = false;
  };
  cancelBtn.onclick = () => renderSpaceAdmin();
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm(`确认删除空间「${s.name}」？\n\n仅删除该空间的论文/标签/概念等数据，保留物理 PDF 文件夹（${s.papersDir}）。此操作不可撤销。`)) return;
      try {
        const r = await DEL('/api/spaces/' + encodeURIComponent(s.id));
        if (r && r.ok) {
          toast('已删除空间（物理 PDF 已保留）', 'success');
          await loadSpaces();
          if (state.space === s.id) { state.space = ''; await loadSpaces(); await refresh(); }
          renderSpaceAdmin();
        } else {
          toast((r && r.error) || '删除失败', 'error');
        }
      } catch (e) { toast(e.message || '删除失败', 'error'); }
    };
  }
  // 自动聚焦名称输入框并全选，便于快速改名
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 20);
  // 回车保存、Esc 取消
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
  };
  nameInput.addEventListener('keydown', onKey);
  dirInput.addEventListener('keydown', onKey);
}

/** 折叠新建表单（回到「+ 新建空间」按钮态）。 */
function resetSpaceCreateForm() {
  $('space-create-form').hidden = true;
  $('space-create-toggle').hidden = false;
  $('space-create-name').value = '';
  $('space-create-dir').value = '';
}

/** 新建空间（内联表单替代原双 prompt()）：名称 + 可选文件夹 → 创建 → 刷新列表。 */
async function createSpaceInline() {
  const name = $('space-create-name').value.trim();
  const dir = $('space-create-dir').value.trim();
  if (!name) { toast('空间名不能为空', 'error'); return; }
  const submitBtn = $('space-create-submit');
  submitBtn.disabled = true;
  try {
    const body = { name };
    if (dir) body.papersDir = dir;
    const r = await POST('/api/spaces', body);
    if (r && r.ok) {
      toast('已创建空间：' + name, 'success');
      await loadSpaces();
      resetSpaceCreateForm();
      renderSpaceAdmin();
    } else {
      toast((r && r.error) || '创建失败', 'error');
    }
  } catch (e) { toast(e.message || '创建失败', 'error'); }
  submitBtn.disabled = false;
}

/** 展开新建表单（点「+ 新建空间」按钮 → 显出名称/文件夹输入框）。 */
function openSpaceCreateForm() {
  $('space-create-toggle').hidden = true;
  $('space-create-form').hidden = false;
  // 预填默认文件夹名（留空也可，后端会自动生成）
  $('space-create-dir').value = '';
  setTimeout(() => $('space-create-name').focus(), 20);
}

function bindSpaceSwitcher() {
  $('space-current').onclick = (e) => { e.stopPropagation(); toggleSpaceMenu(); };
  // 下拉菜单里的「+ 新建空间」：打开管理弹窗并聚焦新建表单
  $('space-new').onclick = () => { closeSpaceMenu(); openSpaceModal(); openSpaceCreateForm(); };
  $('space-manage').onclick = () => { openSpaceModal(); };
  $('space-modal-done').onclick = closeSpaceModal;
  // 新建表单交互
  $('space-create-toggle').onclick = openSpaceCreateForm;
  $('space-create-submit').onclick = createSpaceInline;
  const createName = $('space-create-name');
  const createDir = $('space-create-dir');
  const onCreateKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); createSpaceInline(); } };
  createName.addEventListener('keydown', onCreateKey);
  createDir.addEventListener('keydown', onCreateKey);
  // 点外部关下拉
  document.addEventListener('click', (e) => {
    if (!$('space-switcher').contains(e.target)) closeSpaceMenu();
  });
  // 点遮罩关模态
  $('space-modal').onclick = (e) => { if (e.target === $('space-modal')) closeSpaceModal(); };
}

bindSpaceSwitcher();

bind();
applyListWidth(state.listWidth);
setSidebarCollapsed(state.sidebarCollapsed); // 应用上次记忆的侧栏状态
// 启动：先加载空间（确定 state.space），再 refresh（基于当前空间拉数据）
(async () => {
  await loadSpaces();
  refresh();
  // 后台拉取聊天预置覆盖（store.settings.chatPresets），失败静默用内置默认
  loadSettingsData().catch(() => {});
  // 后台拉取可用模型列表（Phase 2 模型切换器），失败静默用默认占位
  loadAiModels().catch(() => {});
})();
setInterval(() => { if (!$('reader-view').classList.contains('active')) refresh(); }, 10000);

// 全局兜底：任何未被 try/catch 接住的 Promise rejection（如按钮回调里的 await 网络错误）
// 都给出一次性 toast，而不是静默留在控制台里让用户毫无感知。
window.addEventListener('unhandledrejection', (e) => {
  const err = e && e.reason;
  const msg = err && err.message ? err.message : '未知错误';
  toast(msg, 'error');
});
