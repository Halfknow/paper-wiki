// 应用路由表（v3.15）。定义「URL ↔ 视图」的全部映射，以及库视图筛选状态在 query 里的往返编码。
//
// 依赖方向：本模块只依赖 ./router.js，不 import 任何视图模块——视图侧的动作由 app.js 以
// handlers 对象注入（createAppRouter(h)）。这样路由表既没有循环依赖，也能被单测直接驱动。

import { createRouter } from './router.js';

/** 详情面板 tab（/paper/:id/:tab）。非法值回退 summary。 */
export const PAPER_TABS = ['summary', 'notes', 'chat', 'info'];

/** 设置中心导航项（/settings/:tab）。与 index.html 的 .settings-nav-item[data-tab] 一一对应。
 *  v3.56 起从 14 项收敛为 8 项：5 个提示词合并进 `prompts`（行列表 + 就地编辑），
 *  scan/arxiv/formula-engine 合并进 `ingest`（一条「进来 → 解析」的流水线）。 */
export const SETTINGS_NAV_TABS = [
  'overview', 'ai', 'prompts', 'ingest', 'discover', 'translate', 'taxonomy', 'system',
];

/** 旧 tab → 新导航项的深链别名。老 URL / 老书签仍然可用，并且会自动展开到对应子项：
 *  `/settings/summary` 落在 prompts 页且直接打开总结提示词的编辑态。
 *  值形如 `新tab` 或 `新tab#子项`（子项语义由 settingsSwitchTab 解释）。 */
export const SETTINGS_TAB_ALIASES = {
  summary: 'prompts#summary',
  tags: 'prompts#tags',
  formula: 'prompts#formula',
  concept: 'prompts#concept',
  'concept-map': 'prompts#conceptMap',
  scan: 'ingest#scan',
  arxiv: 'ingest#arxiv',
  'formula-engine': 'ingest#formulas',
};

/** 合法的 /settings/:tab 取值 = 新导航项 + 全部历史别名（非法值回退 overview）。 */
export const SETTINGS_TABS = [...SETTINGS_NAV_TABS, ...Object.keys(SETTINGS_TAB_ALIASES)];

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
    // 概念/公式页的 ?q= 与论文页的 ?q= 对称（v3.17）：三个平级页面都该能深链到某个查询词，
    // 切走再切回来查询词还在。三者共用顶栏那个上下文搜索框。
    {
      name: 'concepts',
      pattern: '/concepts',
      enter: ({ query }) => h.enterConcepts({ view: 'list', query }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'concept-maps',
      pattern: '/concepts/maps',
      enter: ({ query }) => h.enterConcepts({ view: 'maps', query }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'concept-map',
      pattern: '/concepts/maps/:id',
      enter: ({ params, query }) => h.enterConcepts({ view: 'maps', mapId: params.id, query }),
      leave: () => h.leaveConcepts(),
    },
    {
      name: 'formulas',
      pattern: '/formulas',
      enter: ({ query }) => h.enterFormulas({ query }),
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
