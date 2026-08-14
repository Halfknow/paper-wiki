// 列表数据刷新（接口级降级）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { api, safeGet } from '../core/api.js';
import { $, selectionWithin } from '../core/dom.js';
import { syncFilterToUrl } from '../core/nav.js';
import { state } from '../core/state.js';
import { renderStats, toast } from '../core/ui-kit.js';
import { renderDetail } from '../detail/detail.js';
import { renderFilters } from './filters.js';
import { renderList } from './list.js';
import { renderSidebar } from './sidebar.js';

// ---- 刷新数据 ----
export async function refresh() {
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

  // 筛选状态回写 URL（v3.15）：所有筛选变更最终都汇到 refresh()，在此一处收口，
  // 避免在十几个筛选控件里各写一遍。refresh 尾部有多个 early return，故放在这里。
  syncFilterToUrl();

  // 接口级降级：每个请求独立成功/失败，单个接口（尤其 papers 列表）失败时保留旧数据，
  // 而不是整页清空或卡死。safeGet 把网络错误吞成 {ok:false}，这里再据分派。
  const results = await Promise.all([
    safeGet('/api/papers?' + params), safeGet('/api/tags'), safeGet('/api/topics'),
    safeGet('/api/folders'), safeGet('/api/stats'),
  ]);
  const [papers, tags, topics, folders, stats] = results;
  const failed = results.filter((x) => !x.ok);
  // 仅在各自成功时更新对应 state；失败的保留旧值，UI 不清空
  const listPane = document.querySelector('.list-pane');
  if (papers.ok) {
    state.papers = papers.data || [];
    if (!selectionWithin(listPane)) renderList();
  }
  if (tags.ok) state.tags = tags.data || [];
  if (topics.ok) state.topics = topics.data || [];
  if (folders.ok) state.folders = folders.data || [];
  if (stats.ok) renderStats(stats.data || { ready: 0, total: 0, processing: 0, error: 0, concepts: 0, formulas: 0 });
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
        if (!selectionWithin($('sidebar'))) renderSidebar();
      }
    } catch { /* ignore */ }
  }
  // 至少 papers 成功时才重渲染依赖它的侧栏/筛选器，避免半失败态下清空
  if (papers.ok) {
    if (!selectionWithin($('sidebar'))) renderSidebar();
    if (!selectionWithin(listPane)) renderFilters();
  }
  if (failed.length) toast(`刷新部分失败：${failed.length} 个接口（已保留旧数据）`, 'error');
  if (state.current && !state.detail) ; // 列表选中后由 select 拉详情
  if (state.current) {
    // 列表里刷新当前项的概要
    const fresh = state.papers.find((p) => p.id === state.current);
    if (fresh && state.detail) {
      const prevUpdatedAt = state.detail.updatedAt;
      // chat / notes tab：定时刷新不重建详情面板。renderDetail 会 innerHTML 全量重建，
      // 销毁 #chat-list / 笔记 textarea —— 每 10s 打断阅读（重置滚动 / 闪烁流式占位 / 抢焦点）。
      // 这两个 tab 的数据由专属 handler 维护（聊天：清空/编辑/重新生成 + 流式增量；笔记：本地编辑+防抖落盘），
      // 无需定时全量刷新；detail-head 的状态变化（如总结完成）会在切 tab / 重开论文时自然反映（state.detail 已更新）。
      if (state.tab === 'chat' || state.tab === 'notes') {
        state.detail = { ...state.detail, ...fresh };
        return;
      }
      // summary/info tab：数据没变就不重建。每 10s 的 innerHTML 全量重建会摧毁用户正在进行的
      // 文本选择（标题/总结「无法选中复制」的根因）——updatedAt 不变说明服务端无变化，跳过重建。
      if (fresh.updatedAt === prevUpdatedAt) return;
      // 数据变了但用户正拖着选择文本：本轮不合并也不重建（下轮 updatedAt 仍不同会重试），
      // 优先保住选择。注意勿在守卫前合并 state.detail——否则下轮 prevUpdatedAt 已等于新值，
      // 被推迟的重建永远补不上，视图静默变旧。
      if (selectionWithin($('detail'))) return;
      state.detail = { ...state.detail, ...fresh };
      renderDetail();
    }
  }
}
