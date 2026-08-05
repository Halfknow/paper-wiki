// 路由实例与导航助手（视图 enter/leave 处理器、URL ↔ 筛选同步）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { _stopConceptMapPolling, showConcepts, viewConceptMap } from '../concepts/concepts.js';
import { $ } from './dom.js';
import { buildPath } from './router.js';
import { LIB_QUERY_DEFAULTS, createAppRouter, filterToQuery, queryToFilter } from './routes.js';
import { flushPendingNotes, state } from './state.js';
import { toast } from './ui-kit.js';
import { renderDetail, select } from '../detail/detail.js';
import { reader } from '../detail/info-tab.js';
import { openReader } from '../detail/reader-host.js';
import { showFormulas } from '../formulas/formulas.js';
import { showLibrary } from '../library/folders.js';
import { renderList } from '../library/list.js';
import { refresh } from '../library/refresh.js';
import { openSettings } from '../settings/settings.js';

let _routerSyncing = false;

/** 把当前 state.filter 回写到 URL query（仅库/详情路由；同址时 setQuery 自身早退）。 */
export function syncFilterToUrl() {
  if (_routerSyncing || !router) return;
  const cur = router.current();
  if (!cur || !['library', 'paper', 'paper-tab'].includes(cur.name)) return;
  router.setQuery(filterToQuery(state.filter), { defaults: LIB_QUERY_DEFAULTS });
}

/** 概念/公式页入场：把路由 ?q= 还原到顶栏搜索框（渲染函数从那里读查询词）。
 *  在 _routerSyncing 窗口内写，避免立刻又被回写一次 URL。 */
function setSearchBox(query) {
  const s = $('search');
  if (s) s.value = (query && query.q) || '';
}

/** 概念/公式页的查询词回写 URL（与库视图的 syncFilterToUrl 对称）。 */
export function syncPageQueryToUrl() {
  if (_routerSyncing || !router) return;
  const cur = router.current();
  if (!cur || !['concepts', 'concept-maps', 'concept-map', 'formulas'].includes(cur.name)) return;
  router.setQuery({ q: ($('search') || {}).value || '' }, { defaults: { q: '' } });
}

/** 库视图公共入场：query → state.filter → 拉数据。paper 路由复用它。 */
async function enterLibraryShell(query) {
  _routerSyncing = true;
  state.filter = { ...state.filter, ...queryToFilter(query) };
  const s = $('search');
  if (s) s.value = state.filter.q || '';
  if (!state.filter.q) state.ft = null; // 退出全文检索模式
  showLibrary();
  try {
    await refresh();
  } finally {
    _routerSyncing = false;
  }
}

const routeHandlers = {
  onError: (e) => toast((e && e.message) || '页面加载失败', 'error'),
  redirect: (p) => router.navigate(p, { replace: true }),

  enterLibrary: async ({ query }) => {
    await enterLibraryShell(query);
    if (state.current) {
      await flushPendingNotes();
      state.current = null;
      state.detail = null;
      renderList();
    }
    renderDetail();
  },

  enterPaper: async ({ id, tab, query, fresh }) => {
    await enterLibraryShell(query);
    if (fresh || state.current !== id || !state.detail) {
      await select(id, tab);
    } else if (state.tab !== tab) {
      await flushPendingNotes();
      state.tab = tab;
      renderDetail();
    }
  },

  // 深链 /reader/:id：先把库视图数据拉起来（关阅读器后底下不是空列表），再开阅读器。
  // openReader 内部会 GET 完整论文，故列表里没有时传 { id } 占位即可。
  enterReader: async ({ id, query }) => {
    await enterLibraryShell(query);
    if (state.current !== id) await select(id, 'summary');
    await openReader(state.papers.find((p) => p.id === id) || state.detail || { id });
  },
  leaveReader: () => {
    if (reader && $('reader-view').classList.contains('active')) reader.close();
  },

  enterConcepts: async ({ view, mapId, query }) => {
    setSearchBox(query);
    await showConcepts(view);
    if (mapId) await viewConceptMap(mapId);
  },
  leaveConcepts: () => _stopConceptMapPolling(),

  enterFormulas: async ({ query }) => {
    setSearchBox(query);
    await showFormulas();
  },

  enterSettings: ({ tab }) => openSettings(tab),
};

export const router = createAppRouter(routeHandlers);

/** 导航到某篇论文（保留当前筛选 query，便于返回列表时状态不丢）。 */
export function gotoPaperRoute(id, tab) {
  router.navigate(tab ? buildPath('/paper/:id/:tab', { id, tab }) : buildPath('/paper/:id', { id }), {
    keepQuery: true,
  });
}

/** 回到库视图，并把 state.filter 写进 URL（侧栏/标签跳转用）。 */
export function gotoLibraryRoute() {
  router.navigate('/library', { query: filterToQuery(state.filter) });
}
