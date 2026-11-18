// 主题与标签管理
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, api, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { chipOf } from '../core/format.js';
import { gotoLibraryRoute } from '../core/nav.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { select } from '../detail/detail.js';
import { renderFilters } from '../library/filters.js';

// ---- 主题与标签管理（分段单栏 + 搜索/排序/内联重命名/合并/批量，全部复用 PATCH {merge,into}/{delete}）----
export const taxState = { kind: 'tag', data: { tag: [], topic: [] }, q: '', sort: 'countDesc', selectMode: false, selected: new Set() };

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

export async function loadTaxonomy() {
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

export function taxSwitchKind(kind) {
  if (taxState.kind === kind) return;
  taxState.kind = kind;
  taxState.selected.clear();
  document.querySelectorAll('.tax-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  $('tax-search').placeholder = '搜索' + taxLabel(kind) + '…';
  renderTaxonomy();
}

export function taxToggleSelectMode(on) {
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

export function renderTaxonomy() {
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
  no.className = 'btn secondary sm';
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
  no.className = 'btn secondary sm';
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

export async function taxBatchDelete() {
  const names = [...taxState.selected];
  if (!names.length) return toast('未选择任何项');
  if (!(await PWDialog.confirm('删除选中的 ' + names.length + ' 个' + taxLabel(taxState.kind) + '？将从相关论文移除。', { title: '批量删除', danger: true, okText: '删除' }))) return;
  for (const n of names) await taxPatch(taxState.kind, { delete: n });
  toast('已删除 ' + names.length + ' 个' + taxLabel(taxState.kind));
  taxState.selected.clear();
  loadTaxonomy();
}

export function taxBatchMerge() {
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
  no.className = 'btn secondary sm';
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
  gotoLibraryRoute(); // 筛选写进 URL：/library?tags=xxx，可分享可后退
  toast('已按' + taxLabel(kind) + '「' + name + '」筛选');
}
