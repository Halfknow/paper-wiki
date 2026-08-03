// 信息 tab 与字段 patch
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, POST, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { chipOf, escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { setBusy, toast } from '../core/ui-kit.js';
import { renderDetail } from './detail.js';
import { refresh } from '../library/refresh.js';

export function renderInfoTab(body, p) {
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
        <label>公式贡献</label>
        <div class="v save-hint">本篇涉及 ${(p.formulaIds || []).length} 个公式。</div>
        <button class="btn ghost sm field-action" id="b-formulas-this">重新抽取并追加</button>
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
  // 对本篇抽取公式（同概念：抽完重拉详情刷新计数）
  const bf = $('b-formulas-this');
  if (bf) bf.onclick = async () => {
    setBusy(bf, true, '抽取中…');
    const r = await POST('/api/papers/formulas', { ids: [p.id] });
    setBusy(bf, false);
    if (r.data && r.data.added != null) toast(`完成：处理 ${r.data.processed} 篇，新增 ${r.data.added} 个公式`);
    else toast(r.error || '抽取失败', 'error');
    try {
      const { data: fresh } = await jget('/api/papers/' + encodeURIComponent(p.id));
      if (fresh) { state.detail = fresh; renderDetail(); }
    } catch { /* ignore */ }
    refresh();
  };
}

export async function patch(id, fields, silent) {
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
export let reader = null;

export function syncLocalAnnotations(id, annotations, extra) {
  if (state.detail && state.detail.id === id) {
    state.detail = { ...state.detail, ...(extra || {}), annotations };
  }
  const row = state.papers.find((p) => p.id === id);
  if (row) row.annotations = annotations;
  if (reader && reader.paper && reader.paper.id === id) reader.paper.annotations = annotations;
}

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_reader(v) {
  reader = v;
}
