// 全局单例状态与笔记/聊天状态句柄
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

export const state = {
  papers: [], tags: [], topics: [], folders: [], concepts: [], formulas: [],
  stats: null, // 全局统计（total/starred/unread 等），不随筛选变，供侧栏徽标
  globalCounts: null, // 兜底：旧后端 stats 无 starred/unread 时，前端独立算的全局计数
  current: null, detail: null, tab: 'summary',
  ft: null, // 全文检索模式：{ query, results:[{id,title,snippets,matches,...}] }；null=普通列表
  aiModels: null, // Phase 2 模型切换器：{ models, default, current, source }（GET /api/ai/models 缓存）
  // 当前空间：localStorage 持久化用户选择；启动时从 /api/spaces 拉 active 校验
  space: localStorage.getItem('pw-space') || '',
  spaces: [], // 所有空间列表（GET /api/spaces）
  filter: { q: '', status: '', readStatus: '', tags: [], topics: [], tagOp: 'or', topicOp: 'or', starred: false, folder: '', mode: '', sort: 'addedDesc' },
  pickMode: false,
  selected: new Set(),
  compact: localStorage.getItem('pw-compact') === '1',
  sidebarCollapsed: localStorage.getItem('pw-sidebar') === 'collapsed',
  listWidth: Number(localStorage.getItem('pw-list-width')) || 410,
};

// 笔记的单一状态（模块级）：{ id, panel }。panel 是 NotesPanel 实例（见下方「AI 笔记卡片」节），
// 每次进入笔记 tab 重建。renderDetail/轮询重建前用 panel.hasOpenEditor() 判定跳过；
// flushPendingNotes 提交未完成的内联编辑，避免切论文/切 tab 丢输入（与旧 textarea 版语义一致）。
export let notesState = null;

/** 立即提交笔记 tab 里未完成的内联编辑（切论文/切 tab/重建前调用）。
 *  空的新卡草稿直接丢弃（discardEmptyNew），防止空草稿卡死笔记 tab。 */
export async function flushPendingNotes() {
  const ns = notesState;
  if (!ns || !ns.panel) return;
  try { await ns.panel.commitOpenEditor({ discardEmptyNew: true }); } catch { /* ignore */ }
}

// AI 聊天的单一状态（模块级）。与 notesState 同理：定时 refresh() 会调 renderDetail 全量重建
// 详情面板（含 AI 聊天 tab），若不保存草稿/忙碌态，用户正打的字会被清空、回复会追加到已被
// 重建掉的「孤儿」旧 DOM 节点（stale list 引用）→ 表现为「发送无回复 + 输入被清空」。
// 结构：{ id, draft, busy, reqId }
//   draft  —— textarea 当前未发送文本（renderDetail 重建后回填，杜绝「打字被清空」）
//   busy   —— 是否有进行中的请求（true 时禁用发送键 + 锁定 textarea，防双发）
//   reqId  —— 当前请求 id（递增），响应只处理「id 匹配且当前 tab 仍是 chat」的那次，
//             且追加目标用实时 document.getElementById 重查（绝不用 stale 闭包引用）
// 参考：现代 LLM 对话 UI 最佳实践——optimistic append、请求级 id 定位、发送期禁用。
export let chatState = null;

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_notesState(v) {
  notesState = v;
}
export function set_chatState(v) {
  chatState = v;
}
