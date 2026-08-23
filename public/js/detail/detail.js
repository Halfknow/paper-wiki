// 详情面板（选中 / 渲染 / tab 头）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, starSvg, statusDot } from '../core/format.js';
import { truncateChatTitle } from '../core/markdown.js';
import { gotoPaperRoute, router } from '../core/nav.js';
import { buildPath } from '../core/router.js';
import { PAPER_TABS } from '../core/routes.js';
import { chatState, flushPendingNotes, notesState, state } from '../core/state.js';
import { chipList, progressPercent, readStatusLabel, setBusy, statusLabel, toast } from '../core/ui-kit.js';
import { patch, reader } from './info-tab.js';
import { renderTabBody } from './tab-body.js';
import { renderList } from '../library/list.js';
import { refresh } from '../library/refresh.js';

// ---- 详情 ----
export async function select(id, tab) {
  await flushPendingNotes(); // 切论文前，先把旧论文的待存笔记落盘，避免丢失最后 800ms 输入
  state.current = id;
  // 切换论文的加载反馈（R7）：详情 fetch 期间旧内容一直挂着且无指示——先出与
  // renderDetail 同构的骨架（标题/元数据/tab 条/正文行），数据到达后整体替换。
  if (state.detail && state.detail.id !== id) {
    $('detail').innerHTML = `
      <div class="detail-skel" aria-busy="true" aria-label="正在加载论文详情">
        <div class="skel ds-title"></div>
        <div class="skel ds-meta"></div>
        <div class="ds-tabs"><i class="skel"></i><i class="skel"></i><i class="skel"></i><i class="skel"></i></div>
        <div class="skel ds-line"></div>
        <div class="skel ds-line" style="width:92%"></div>
        <div class="skel ds-line" style="width:86%"></div>
        <div class="skel ds-line" style="width:64%"></div>
      </div>`;
  }
  const { data: p } = await jget('/api/papers/' + encodeURIComponent(id));
  state.detail = p;
  // tab 由路由决定（/paper/:id/:tab）；直接调用时仍默认总结页
  state.tab = PAPER_TABS.includes(tab) ? tab : 'summary';
  renderList();
  renderDetail();
}

export function renderDetail() {
  flushPendingNotes(); // 轮询刷新也会重建详情面板，先把待存笔记落盘（不 await：值已先从 DOM 读出）
  const p = state.detail;
  const d = $('detail');
  // 聊天 tab 激活时去掉面板底 padding（.chat-active）：sticky composer 无法越过容器
  // content edge 下移，唯有归零底 padding 才能让聊天框真正贴底
  d.classList.toggle('chat-active', !!p && state.tab === 'chat');
  if (!p) { d.innerHTML = '<div class="empty"><span class="big"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a1 1 0 0 1 1-1h9l6 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M14 4v6h6"/><path d="M8 13h6"/><path d="M8 16h4"/></svg></span>从左侧选择一篇论文</div>'; return; }
  // chat tab 特殊保护：流式中(busy) 或 用户正在输入框打字时，整体跳过重建（d.innerHTML 会销毁 textarea → 失焦 + 打断流式）。
  // 定时 refresh 触发的重建在此被拦截，保留当前 DOM + 焦点 + 草稿。切论文/切 tab 等主动操作不受影响（那时 chatState 已失效）。
  if (state.tab === 'chat' && chatState && chatState.id === p.id) {
    const chatInput = document.getElementById('chat-input');
    const typing = chatInput && (document.activeElement === chatInput || chatState.draft);
    if (chatState.busy || typing) return; // 不重建
  }
  // notes tab 同理：用户正在内联编辑卡片时跳过重建（d.innerHTML 会销毁编辑中的 textarea → 失焦 + 内容丢失）。
  if (state.tab === 'notes' && notesState && notesState.id === p.id && notesState.panel && notesState.panel.hasOpenEditor()) {
    return; // 不重建，保留编辑态 + 焦点
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
          <!-- v3.59：卡片顶部只留「评分 + 打开 PDF」。这里是「这篇论文是什么」的身份区，
               不该堆 6 个动作；重新总结/打标/BibTeX/删除已下沉到「信息」tab 分区组织，
               「标记已读」在信息 tab 有更完整的三态控件（未读/在读/已读）。 -->
          <button class="btn sm" id="b-open-pdf" title="在新视图打开 PDF 阅读器">打开 PDF</button>
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
  $('b-open-pdf').onclick = () => router.navigate(buildPath('/reader/:id', { id: p.id }), { keepQuery: true });
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
  // tab 切换走路由（/paper/:id/:tab），使「刷新停在聊天页」「后退回总结页」成立。
  // 落盘 + state.tab + renderDetail 由 enterPaper 统一处理。
  d.querySelectorAll('.tab').forEach((t) => t.onclick = () => gotoPaperRoute(p.id, t.dataset.tab));
  renderTabBody();
}

export const NOTE_CARD_TYPES = {
  qa: { icon: '💬', label: '问答' },
  skeleton: { icon: '✨', label: '骨架' },
  manual: { icon: '📝', label: '笔记' },
};

export const NC_ACT_SVGS = {
  edit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  delete: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
};

export function newNoteCardId() {
  return 'nc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 前端镜像：旧 notes TEXT → 按 ^## 拆成 manual 卡（与 src/core/notes.splitMarkdownToCards 同规则，改动要同步）。 */
export function splitLegacyNotesToCards(md) {
  const text = String(md || '').trim();
  if (!text) return [];
  const now = Date.now();
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1], bodyLines: [] };
    } else if (cur) cur.bodyLines.push(line);
    else preamble.push(line);
  }
  if (cur) sections.push(cur);
  const pre = preamble.join('\n').trim();
  const mk = (title, body) => ({ id: newNoteCardId(), type: 'manual', title, body, createdAt: now, updatedAt: now });
  if (!sections.length) return [mk('笔记', text)];
  return sections.map((s, i) => mk(s.title, (i === 0 && pre ? pre + '\n\n' : '') + s.bodyLines.join('\n').trim()));
}

/** 跨面板同步（详情 tab 与阅读器抽屉可能同时开同篇论文的笔记）；origin 面板除外（它自己会渲染）。 */
export function syncNotePanels(pid, cards, origin) {
  if (notesState && notesState.id === pid && notesState.panel && notesState.panel !== origin) {
    notesState.panel.setCards(cards);
  }
  const rp = window._readerNotesPanel;
  if (rp && rp !== origin && rp.paperId === pid) rp.setCards(cards);
}

/** 把一轮聊天问答存为问答卡（详情 tab + 阅读器抽屉共用，经 window 桥暴露给 reader.js）。
 *  question 取被回答的最近 user 消息；title = 「Q: 问题截断」，meta 记录来源。 */
export async function saveQaCardToNotes(paperId, { question, answer, mi }) {
  let cards;
  if (state.detail && state.detail.id === paperId && Array.isArray(state.detail.noteCards)) {
    cards = state.detail.noteCards.slice();
  } else {
    const r = await jget('/api/papers/' + encodeURIComponent(paperId));
    cards = r.data && Array.isArray(r.data.noteCards) ? r.data.noteCards.slice() : [];
  }
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  const now = Date.now();
  cards.push({
    id: newNoteCardId(),
    type: 'qa',
    title: q ? 'Q: ' + truncateChatTitle(q, 60) : '问答笔记',
    body: String(answer || ''),
    meta: { ...(q ? { question: q } : {}), ...(mi != null ? { mi } : {}) },
    createdAt: now,
    updatedAt: now,
  });
  const r2 = await PATCH('/api/papers/' + encodeURIComponent(paperId), { noteCards: cards });
  if (!r2 || !r2.ok) { toast((r2 && r2.error) || '存入笔记失败', 'error'); return false; }
  const next = Array.isArray(r2.data.noteCards) ? r2.data.noteCards : cards;
  if (state.detail && state.detail.id === paperId) state.detail.noteCards = next;
  syncNotePanels(paperId, next, null);
  toast('已存入笔记');
  return true;
}
