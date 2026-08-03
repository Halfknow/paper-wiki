// PaperWiki 前端入口（v3.15 模块化重构后）。
//
// 这里只保留三件事：路由接线（视图 enter/leave 处理器）、URL ↔ 筛选同步、启动序列。
// 全部视图逻辑已按领域拆到 public/js/** —— 见 AGENTS.md「前端模块结构」。

import { createAppRouter, filterToQuery, queryToFilter, LIB_QUERY_DEFAULTS } from './js/core/routes.js';
import { buildPath } from './js/core/router.js';
import { bind } from './js/bind.js';
import { $ } from './js/core/dom.js';
import { router } from './js/core/nav.js';
import { state } from './js/core/state.js';
import { toast } from './js/core/ui-kit.js';
import { loadAiModels } from './js/detail/chat-view.js';
import { refresh } from './js/library/refresh.js';
import { loadSettingsData } from './js/settings/settings.js';
import { loadSpaces } from './js/spaces/spaces.js';
import { applyListWidth, setSidebarCollapsed } from './js/views/layout.js';

bind();

applyListWidth(state.listWidth);

setSidebarCollapsed(state.sidebarCollapsed); // 应用上次记忆的侧栏状态

// 启动：先加载空间（确定 state.space；URL 的 ?space= 优先于 localStorage），
// 再由路由器解析当前 URL 渲染对应视图（取代过去无条件 refresh() 进库视图）。
(async () => {
  const urlSpace = new URLSearchParams(window.location.search).get('space');
  if (urlSpace) state.space = urlSpace;
  await loadSpaces();
  await router.start();
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
