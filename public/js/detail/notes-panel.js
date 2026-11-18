// AI 笔记卡片面板
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, POST, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
import { renderMd } from '../core/markdown.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { NC_ACT_SVGS, NOTE_CARD_TYPES, newNoteCardId, splitLegacyNotesToCards, syncNotePanels } from './detail.js';

/** 笔记卡片面板：卡片列表渲染 + 内联编辑/删除/排序/新增 + AI 骨架生成 + 旧笔记迁移。
 *  用法：const panel = new NotesPanel(containerEl, { showGenerate }); await panel.load(paperId)。 */
export function NotesPanel(container, opts = {}) {
  const showGenerate = opts.showGenerate !== false;
  let paperId = null;
  let cards = [];
  let editingId = null; // 内联编辑中的卡 id；'__new__' = 顶部新建卡
  let newDraft = null;  // 新建卡草稿 { title, body }
  let busyGen = false;

  const panel = {
    load,
    setCards,
    hasOpenEditor: () => editingId != null,
    commitOpenEditor,
    get paperId() {
      return paperId;
    },
  };

  container.addEventListener('click', onAction);

  function hint(t) {
    const el = container.querySelector('.notes-hint');
    if (el) el.textContent = t || '';
  }
  function typeMeta(c) {
    return NOTE_CARD_TYPES[c.type] || NOTE_CARD_TYPES.manual;
  }
  function displayTitle(c) {
    return c.title || '(无标题)';
  }

  async function load(pid) {
    paperId = pid;
    editingId = null;
    newDraft = null;
    container.innerHTML = '<div class="notes-empty">加载笔记…</div>';
    let data = null;
    try {
      data = (await jget('/api/papers/' + encodeURIComponent(pid))).data;
    } catch {
      /* ignore */
    }
    cards = data && Array.isArray(data.noteCards) ? data.noteCards : [];
    // 旧 notes TEXT 自动迁移：noteCards 为空且 notes 非空 → 按 ## 拆卡 PATCH（幂等，只发生一次）
    const legacy = data && typeof data.notes === 'string' ? data.notes.trim() : '';
    if (!cards.length && legacy) {
      const converted = splitLegacyNotesToCards(data.notes);
      if (converted.length) {
        const r = await PATCH('/api/papers/' + encodeURIComponent(pid), { noteCards: converted });
        if (r && r.ok) {
          cards = Array.isArray(r.data.noteCards) ? r.data.noteCards : converted;
          if (state.detail && state.detail.id === pid) state.detail.noteCards = cards;
          syncNotePanels(pid, cards, panel);
          toast(`已将旧笔记转换为 ${cards.length} 张卡片`);
        }
      }
    }
    render();
  }

  /** 外部同步入口（其它面板/聊天存卡改了同篇笔记）：更新数据；非编辑态下重渲染。 */
  function setCards(next) {
    cards = Array.isArray(next) ? next : [];
    if (editingId == null) render();
  }

  function render() {
    const anchors =
      cards.length >= 4
        ? `<div class="notes-anchors">${cards
            .map((c) => `<button type="button" class="notes-anchor" data-nact="jump" data-nc="${c.id}">${typeMeta(c).icon} ${escapeHtml(displayTitle(c))}</button>`)
            .join('')}</div>`
        : '';
    // 新建卡：草稿不在 cards 数组里，编辑卡片要单独渲染到列表顶部（否则点「添加卡片」看似无反应）
    const isNew = editingId === '__new__';
    const newCardHtml = isNew
      ? editHtml({ id: '__new__', type: 'manual', title: (newDraft && newDraft.title) || '', body: (newDraft && newDraft.body) || '' })
      : '';
    const listHtml = cards.length
      ? cards.map(cardHtml).join('')
      : isNew
        ? ''
        : '<div class="notes-empty">还没有笔记卡片。<br/>在 AI 聊天里点回答下的「存入笔记」，或点上方「AI 生成骨架」一键生成论文结构笔记。</div>';
    container.innerHTML = `<div class="notes-toolbar">
        ${showGenerate ? `<button type="button" class="btn sm notes-tb-btn" data-nact="generate" ${busyGen ? 'disabled' : ''}>${icon('sparkles', { size: 14 })}${busyGen ? '生成中…' : 'AI 生成骨架'}</button>` : ''}
        <button type="button" class="btn secondary sm notes-tb-btn" data-nact="add">${icon('plus', { size: 14 })}添加卡片</button>
        <span class="notes-count">${cards.length ? cards.length + ' 张卡片' : ''}</span>
        <span class="save-hint notes-hint"></span>
      </div>
      ${anchors}
      <div class="notes-cards">${newCardHtml + listHtml}</div>`;
    container.classList.toggle('editing', editingId != null);
  }

  function cardHtml(c) {
    if (editingId === c.id) return editHtml(c);
    const t = typeMeta(c);
    return `<div class="note-card nc-${c.type}" data-nc="${c.id}">
      <div class="nc-head">
        <span class="nc-type" title="${t.label}卡">${t.icon}</span>
        <span class="nc-title" title="${escapeHtml(displayTitle(c))}">${escapeHtml(displayTitle(c))}</span>
        <span class="nc-acts">
          <button type="button" data-nact="edit" data-nc="${c.id}" title="编辑">${NC_ACT_SVGS.edit}</button>
          <button type="button" data-nact="copy" data-nc="${c.id}" title="复制 Markdown">${NC_ACT_SVGS.copy}</button>
          <button type="button" data-nact="up" data-nc="${c.id}" title="上移">${NC_ACT_SVGS.up}</button>
          <button type="button" data-nact="down" data-nc="${c.id}" title="下移">${NC_ACT_SVGS.down}</button>
          <button type="button" class="danger" data-nact="delete" data-nc="${c.id}" title="删除">${NC_ACT_SVGS.delete}</button>
        </span>
      </div>
      <div class="nc-body md">${renderMd(c.body || '')}</div>
    </div>`;
  }

  function editHtml(c) {
    const isNew = c.id === '__new__';
    return `<div class="note-card nc-${c.type} nc-editing" data-nc="${c.id}">
      <div class="nc-edit">
        <input type="text" class="nc-edit-title" placeholder="卡片标题…" value="${escapeHtml(c.title || '')}" />
        <textarea class="nc-edit-body" placeholder="Markdown 正文（支持 $公式$）…">${escapeHtml(c.body || '')}</textarea>
        <div class="nc-edit-acts">
          <button type="button" class="btn sm notes-tb-btn" data-nact="save-edit" data-nc="${c.id}">${isNew ? '添加' : '保存'}</button>
          <button type="button" class="btn secondary sm notes-tb-btn" data-nact="cancel-edit">取消</button>
        </div>
      </div>
    </div>`;
  }

  /** 落盘当前 cards（PATCH 全量），同步 state.detail 与其它面板。 */
  async function save() {
    hint('保存中…');
    const r = await PATCH('/api/papers/' + encodeURIComponent(paperId), { noteCards: cards });
    if (!r || !r.ok) {
      hint('保存失败');
      toast((r && r.error) || '笔记保存失败', 'error');
      return false;
    }
    cards = Array.isArray(r.data.noteCards) ? r.data.noteCards : cards;
    if (state.detail && state.detail.id === paperId) state.detail.noteCards = cards;
    syncNotePanels(paperId, cards, panel);
    hint('已保存 · ' + new Date().toLocaleTimeString());
    render();
    return true;
  }

  /** 读取编辑态 DOM 并提交（保存/添加）；无编辑态时 no-op。供 save-edit 按钮与 flushPendingNotes 共用。
   *  opts.discardEmptyNew：离开笔记 tab 的自动提交场景——空的新卡草稿直接丢弃（无内容可丢），
   *  否则空草稿会保持编辑态 → renderDetail 守卫永远跳过重建 → 笔记 tab 被卡死（真 bug）。 */
  async function commitOpenEditor(opts = {}) {
    if (editingId == null) return true;
    const host = container.querySelector('.note-card.nc-editing');
    if (!host) {
      editingId = null;
      newDraft = null;
      render();
      return true;
    }
    const title = (host.querySelector('.nc-edit-title') || {}).value || '';
    const body = (host.querySelector('.nc-edit-body') || {}).value || '';
    if (!title.trim() && !body.trim()) {
      if (editingId === '__new__' && opts.discardEmptyNew) {
        editingId = null;
        newDraft = null;
        render();
        return true;
      }
      toast('卡片标题和正文不能都为空', 'error');
      return false;
    }
    const now = Date.now();
    if (editingId === '__new__') {
      cards.unshift({ id: newNoteCardId(), type: 'manual', title: title.trim(), body, createdAt: now, updatedAt: now });
    } else {
      const c = cards.find((x) => x.id === editingId);
      if (c) {
        c.title = title.trim();
        c.body = body;
        c.updatedAt = now;
      }
    }
    editingId = null;
    newDraft = null;
    return save();
  }

  async function onAction(e) {
    const btn = e.target.closest('[data-nact]');
    if (!btn || !container.contains(btn)) return;
    const act = btn.dataset.nact;
    const id = btn.dataset.nc;
    const idx = cards.findIndex((c) => c.id === id);
    if (act === 'jump') {
      const el = container.querySelector('.note-card[data-nc="' + id + '"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.remove('flash');
        void el.offsetWidth; // 重启动画
        el.classList.add('flash');
      }
      return;
    }
    if (act === 'add') {
      if (editingId != null) return;
      editingId = '__new__';
      newDraft = { title: '', body: '' };
      render();
      const t = container.querySelector('.nc-edit-title');
      if (t) t.focus();
      return;
    }
    if (act === 'generate') {
      if (busyGen) return;
      if (cards.length && !(await PWDialog.confirm('基于全文生成六段式笔记骨架（研究问题/贡献/方法/实验/局限/可复用），插入到现有笔记开头？', { title: '生成笔记骨架', okText: '生成' }))) return;
      busyGen = true;
      render();
      try {
        const r = await POST('/api/papers/' + encodeURIComponent(paperId) + '/notes/generate');
        if (r && r.ok && r.data && Array.isArray(r.data.cards) && r.data.cards.length) {
          cards = r.data.cards.concat(cards);
          await save();
          toast(`已生成 ${r.data.cards.length} 张骨架卡`);
        } else {
          toast((r && r.error) || '骨架生成失败', 'error');
        }
      } catch (e2) {
        toast('骨架生成失败：' + (e2 && e2.message), 'error');
      }
      busyGen = false;
      render();
      return;
    }
    if (act === 'edit' && idx >= 0) {
      editingId = id;
      render();
      const ta = container.querySelector('.nc-edit-body');
      if (ta) ta.focus();
      return;
    }
    if (act === 'cancel-edit') {
      editingId = null;
      newDraft = null;
      render();
      return;
    }
    if (act === 'save-edit') {
      await commitOpenEditor();
      return;
    }
    if (editingId != null) return; // 编辑态下锁定其它卡操作（防重建丢输入）
    if (act === 'delete' && idx >= 0) {
      if (!(await PWDialog.confirm('删除这张卡片？', { title: '删除笔记卡', danger: true, okText: '删除' }))) return;
      cards.splice(idx, 1);
      await save();
      return;
    }
    if ((act === 'up' || act === 'down') && idx >= 0) {
      const j = act === 'up' ? idx - 1 : idx + 1;
      if (j < 0 || j >= cards.length) return;
      const tmp = cards[idx];
      cards[idx] = cards[j];
      cards[j] = tmp;
      await save();
      return;
    }
    if (act === 'copy' && idx >= 0) {
      const c = cards[idx];
      try {
        await navigator.clipboard.writeText('## ' + displayTitle(c) + '\n\n' + (c.body || ''));
        toast('已复制卡片 Markdown');
      } catch {
        toast('复制失败', 'error');
      }
    }
  }

  return panel;
}
