// 状态/标签/主题筛选与浮层
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';
import { chipClass, escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { renderList } from './list.js';
import { refresh } from './refresh.js';

// 「全部状态」自定义下拉：触发器文案 + active 态 + 菜单项高亮。
// status（ready/error/pending 处理状态）与 readStatus（unread/reading/done 阅读状态）分属两个字段，
// 菜单项的 data-field 标记写入哪个字段；renderStatusMenu 读两个字段综合判定当前选中。
// 触发器默认文案「状态」（列表列宽按字符计预算，「全部状态」放不下）；菜单项仍是「全部状态」。
const STATUS_LABELS = { '': '状态', ready: '已就绪', unread: '未读', reading: '在读', done: '已读', error: '出错', pending: '处理中' };

function statusCurrentValue() {
  if (state.filter.status) return state.filter.status;
  if (state.filter.readStatus) return state.filter.readStatus;
  return '';
}

export function renderStatusMenu() {
  const val = statusCurrentValue();
  const trig = $('filter-status-trigger');
  if (trig) trig.classList.toggle('active', !!val);
  const label = $('ft-status-label');
  if (label) label.textContent = STATUS_LABELS[val] || '状态';
  // 高亮当前项：item 的 data-value 匹配（status 与 readStatus 值不重叠，故按值匹配即可）
  document.querySelectorAll('#filter-status-menu .fsm-item').forEach((it) => {
    it.classList.toggle('active', it.dataset.value === val);
  });
}

function openStatusMenu() { const m = $('filter-status-menu'); if (m) { m.hidden = false; $('filter-status-wrap').classList.add('open'); } }

export function closeStatusMenu() { const m = $('filter-status-menu'); if (m) { m.hidden = true; $('filter-status-wrap').classList.remove('open'); } }

export function toggleStatusMenu() { const m = $('filter-status-menu'); if (!m) return; m.hidden ? openStatusMenu() : closeStatusMenu(); }

export function renderFilters() {
  // 「全部状态」改为自定义按钮下拉：回填触发器文案 + active 态 + 菜单项高亮
  renderStatusMenu();
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
export function openFilterPop(kind) {
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
      const cc = chipClass(it.name);
      html += `<div class="check-row${on ? ' on' : ''}" data-name="${escapeHtml(it.name)}"><span class="fp-check">${on ? CHECK_SVG : UNCHECK_SVG}</span><span class="fp-name ${cc}">${escapeHtml(it.name)}</span><span class="fp-count">${it.count}</span></div>`;
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
      const cc = chipClass(it.name);
      html += `<div class="check-row${on ? ' on' : ''}" data-name="${escapeHtml(it.name)}"><span class="fp-check">${on ? CHECK_SVG : UNCHECK_SVG}</span><span class="fp-name ${cc}">${escapeHtml(it.name)}</span><span class="fp-count">${it.count}</span></div>`;
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
