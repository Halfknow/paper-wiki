// 应用路由表（v3.15）。定义「URL ↔ 视图」的全部映射，以及库视图筛选状态在 query 里的往返编码。
//
// 依赖方向：本模块只依赖 ./router.js，不 import 任何视图模块——视图侧的动作由 app.js 以
// handlers 对象注入（createAppRouter(h)）。这样路由表既没有循环依赖，也能被单测直接驱动。

import { createRouter } from './router.js';

/** 详情面板 tab（/paper/:id/:tab）。非法值回退 summary。 */
export const PAPER_TABS = ['summary', 'notes', 'chat', 'info'];

/** 设置中心 tab（/settings/:tab）。与 index.html 的 .settings-nav-item[data-tab] 一一对应。 */
export const SETTINGS_TABS = [
  'overview', 'ai', 'summary', 'tags', 'concept', 'concept-map', 'formula',
  'scan', 'arxiv', 'discover', 'translate', 'formula-engine', 'taxonomy', 'system',
];

/** 库视图筛选在 URL 里的默认值——等于默认的键不写进 URL，避免
 *  /library?status=&sort=addedDesc&starred=0 这种噪声。 */
export const LIB_QUERY_DEFAULTS = {
  q: '', status: '', read: '', tags: '', topics: '',
  tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: 'addedDesc',
};

/** state.filter → URL query 对象（纯函数）。 */
export function filterToQuery(f) {
  return {
    q: f.q || '',
    status: f.status || '',
    read: f.readStatus || '',
    tags: Array.isArray(f.tags) ? f.tags : [],
    topics: Array.isArray(f.topics) ? f.topics : [],
    tagOp: f.tagOp || 'or',
    topicOp: f.topicOp || 'or',
    starred: !!f.starred,
    folder: f.folder || '',
    mode: f.mode || '',
    sort: f.sort || 'addedDesc',
  };
}

/** URL query → state.filter 补丁（纯函数）。缺失的键一律取默认，保证
 *  「同一 URL 永远还原同一筛选」——否则前进后退会残留上一次的筛选。 */
export function queryToFilter(query) {
  const q = query || {};
  const list = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  return {
    q: q.q || '',
    status: q.status || '',
    readStatus: q.read || '',
    tags: list(q.tags),
    topics: list(q.topics),
    tagOp: q.tagOp === 'and' ? 'and' : 'or',
    topicOp: q.topicOp === 'and' ? 'and' : 'or',
    starred: q.starred === '1',
    folder: q.folder || '',
    mode: q.mode || '',
    sort: q.sort || 'addedDesc',
  };
}

/** 创建应用路由器。h 是 app.js 注入的视图动作集合。 */
export function createAppRouter(h) {
  const routes = [
    {
      name: 'library',
      pattern: '/library',
      enter: ({ query }) => h.enterLibrary({ query }),
    },
    // /paper/:id 是「选中这篇论文」——总是重新拉详情（点列表项、深链、跨空间返回都要拿最新数据）。
    // /paper/:id/:tab 是「切到某个 tab」——同一篇论文不重拉，否则会打断进行中的聊天流与笔记编辑。
    {
      name: 'paper',
      pattern: '/paper/:id',
      enter: ({ params, query }) => h.enterPaper({ id: params.id, tab: 'summary', query, fresh: true }),
    },
    {
      name: 'paper-tab',
      pattern: '/paper/:id/:tab',
      enter: ({ params, query }) =>
        h.enterPaper({
          id: params.id,
          tab: PAPER_TABS.includes(params.tab) ? params.tab : 'summary',
          query,
          fresh: false,
        }),
    },
    {
      name: 'reader',
      pattern: '/reader/:id',
      enter: ({ params, query }) => h.enterReader({ id: params.id, query }),
      leave: () => h.leaveReader(),
    },
    {
      name: 'concepts',
      pattern: '/concepts',
      enter: () => h.enterConcepts({ view: 'list' }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'concept-maps',
      pattern: '/concepts/maps',
      enter: () => h.enterConcepts({ view: 'maps' }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'concept-map',
      pattern: '/concepts/maps/:id',
      enter: ({ params }) => h.enterConcepts({ view: 'maps', mapId: params.id }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'formulas',
      pattern: '/formulas',
      enter: () => h.enterFormulas(),
    },
    {
      name: 'settings',
      pattern: '/settings',
      enter: () => h.redirect('/settings/overview'),
    },
    {
      name: 'settings-tab',
      pattern: '/settings/:tab',
      enter: ({ params }) =>
        h.enterSettings({ tab: SETTINGS_TABS.includes(params.tab) ? params.tab : 'overview' }),
    },
  ];

  return createRouter({
    routes,
    fallback: '/library',
    keepParams: ['space'], // 空间是全局作用域，跨所有导航自动携带
    onError: h.onError,
  });
}
