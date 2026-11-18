// 库/概念/公式/设置 视图显隐 + 顶栏 chrome 的上下文态（v3.17）
//
// 显隐从 inline style 改成 .view-hidden 类：inline style 的恢复靠 `style.display=''`，
// 依赖各视图在 CSS 里的默认 display（.layout 是 grid、.page-view 是 flex）——首帧内联脚本
// 若要选对视图就得复制这套默认值，脆弱。改用类后，首帧规则与运行时切换互不耦合。

import { $ } from '../core/dom.js';
import { holdLayer, releaseLayer } from '../core/layers.js';

/** 设置覆盖层的 Esc 行为（bind.js 注入：提示词编辑态先退回列表，再关覆盖层）。 */
let _settingsEscape = null;
export function setSettingsEscape(fn) {
  _settingsEscape = fn;
}

/** 三个平级内容视图。设置不在其列——它是覆盖层，见下方 showView。 */
const CONTENT_VIEWS = ['library', 'concepts', 'formulas'];

/** 各视图下顶栏搜索框的语义。advanced 决定帮助/高级搜索按钮是否显示（v3.20：概念/公式页也支持）。 */
const SEARCH_CONTEXT = {
  library: { placeholder: '搜索论文…', advanced: true },
  concepts: { placeholder: '搜索术语或解释…', advanced: true },
  formulas: { placeholder: '搜索公式名、LaTeX 或解读…', advanced: true },
};

/** 当前内容视图名（顶栏搜索/筛选按它分派）。设置覆盖层打开时仍返回底下那个内容视图——
 *  覆盖层关掉后不该丢失上下文。首帧尚未 showView 时回退 library。 */
export function currentView() {
  return document.body.dataset.contentView || 'library';
}

// ---- 视图切换：library / concepts / formulas（+ settings 覆盖层）----
export function showView(name) {
  // 交出首帧控制权：#library-view 在 boot 规则下被 display:none 压着，
  // 不清掉这个属性，后续 showView('library') 去掉 .view-hidden 也不会显示。
  document.documentElement.removeAttribute('data-boot-path');

  // 设置是覆盖层：只控制自己的显隐，不动底下的内容视图与侧栏——
  // 关掉后要回到打开它之前的那个页面，底层状态不能被清掉。
  const overlay = name === 'settings';
  const sv = $('settings-view');
  sv.classList.toggle('view-hidden', !overlay);
  document.body.dataset.view = name;
  // 设置覆盖层登记为 sheet 层：背景 inert、焦点陷阱、Esc 分层退出、关闭后焦点还给入口按钮
  if (overlay) {
    holdLayer(sv, { el: sv, kind: 'sheet', onEscape: () => (_settingsEscape ? _settingsEscape() : false) });
    return;
  }
  releaseLayer(sv);

  document.body.dataset.contentView = name;
  for (const v of CONTENT_VIEWS) $(v + '-view').classList.toggle('view-hidden', v !== name);
  // 侧栏上下文区块与内容区同步切换（骨架不动，只换里面那份）
  document.querySelectorAll('#sidebar .side-ctx').forEach((el) => {
    el.classList.toggle('view-hidden', el.dataset.ctx !== name);
  });
  // 收起态 rail 同样按视图切上下文（v3.19：此前 rail 恒为论文页内容，概念/公式页收起后
  // 仍挂着星标/未读/收藏夹——点了改的是看不见的论文筛选）
  document.querySelectorAll('#sidebar-rail .rail-ctx').forEach((el) => {
    el.classList.toggle('view-hidden', el.dataset.ctx !== name);
  });

  // 一级导航 active 态 + aria-current（R4 a11y：屏幕阅读器需要知道「当前页」）
  document.querySelectorAll('#view-nav .vn-item').forEach((a) => {
    const on = a.dataset.view === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  // 顶栏搜索上下文：placeholder + 论文页专属附属控件。切页不清空输入框——
  // 查询词随路由 query 走，由路由 enter 负责还原（见 core/nav.js）。
  const ctx = SEARCH_CONTEXT[name] || SEARCH_CONTEXT.library;
  const search = $('search');
  if (search) search.placeholder = ctx.placeholder;
  // 语法帮助与高级搜索都是 DSL（title:/tag:/year:）专属，只在论文页有意义。
  // Ctrl K 提示保留——它在任何视图下都能聚焦搜索框。
  toggleHidden($('search-help'), !ctx.advanced);
  toggleHidden($('search-advanced-toggle'), !ctx.advanced);
  // 论文页专属筛选条已沉进库视图的列表工具条（v3.18），随 #library-view 整体显隐，无需单独切换。
  // 高级搜索面板/保存的搜索是 fixed 浮层，离开论文页必须一并收起，否则会浮在概念页上
  if (name !== 'library') {
    const adv = $('advanced-search');
    if (adv) adv.hidden = true;
    const saved = $('saved-searches');
    if (saved) saved.hidden = true;
  }
}

function toggleHidden(el, hidden) {
  if (!el) return;
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}
