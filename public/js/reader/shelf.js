// 阅读架状态（v3.21 多论文阅读抽屉；v3.23 改为显式策展语义）——浏览器书签 + 待读清单。
//
// 职责：持有有序论文 id 栈 + 当前阅读项，per-space 从 GET/PUT /api/reader-shelf 加载与持久化，
// 状态变化后通知订阅者（阅读器内的抽屉 UI / FAB 徽章 / 工具栏书签按钮）重渲。本模块不依赖
// pdf.js——常驻侧 reader-host.js 与惰性加载的 reader.js（抽屉 UI）共享同一实例。
//
// 语义（v3.23）：
//   · 上架是显式动作（工具栏 🔖 / Ctrl+D / 抽屉搜索），打开论文**不再自动上架**；
//   · 顺序完全由用户手动维护（抽屉拖拽），切换/打开不重排；
//   · 从架上移除永不切换论文、不关阅读器——架子是清单，不是「开着的东西」；
//   · activeId = 当前打开的论文 id，**仅当它在架上**时有效（否则 ''，[/] 切换随之失效）。

import { PUT, jget } from '../core/api.js';
import { state } from '../core/state.js';

/** 全局单例状态。items 是 id → 富化条目（title/year/readProgress…）的映射，渲染用。 */
export const shelfState = {
  ids: [], // 有序论文 id（渲染顺序、[/] 切换顺序都看它）
  items: {}, // id → { id,title,year,status,readStatus,starred,readProgress }
  activeId: '', // 当前正在读的论文 id（切换即更新；不落库——刷新时由 /reader/:id URL 决定）
  loadedFor: null, // 已为哪个空间加载过（null 哨兵防与空串 space 撞值；切空间后首次使用自动重拉）
};

// ---- 订阅（drawer / FAB 徽章重渲）----
const listeners = new Set();
/** 订阅阅读架变化（增删/重排/加载/激活）。返回取消订阅函数。 */
export function subscribeShelf(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) {
    try { fn(shelfState); } catch { /* 单个订阅者出错不拖垮其它 */ }
  }
}

/** 从论文对象（detailView/summaryView 均可）提取抽屉卡片所需字段。 */
function itemFromPaper(p) {
  return {
    id: p.id,
    title: p.title || p.filename || p.id,
    year: p.year || '',
    status: p.status || '',
    readStatus: p.readStatus || 'unread',
    starred: !!p.starred,
    readProgress:
      p.readProgress && typeof p.readProgress === 'object'
        ? { page: p.readProgress.page || 1, total: p.readProgress.total || 0 }
        : null,
  };
}

/** 按服务端响应同步本地（ids + items），emit 一次。 */
function applyResponse(data) {
  if (!data || !Array.isArray(data.ids)) return;
  shelfState.ids = data.ids.slice();
  shelfState.items = {};
  for (const it of data.items || []) shelfState.items[it.id] = it;
  emit();
}

/** 加载当前空间的阅读架（每空间一次；切空间后自动失效重拉）。失败静默回空架。 */
export async function ensureShelfLoaded() {
  if (shelfState.loadedFor === state.space) return;
  try {
    const r = await jget('/api/reader-shelf');
    if (r && r.ok && r.data) applyResponse(r.data);
    else { shelfState.ids = []; shelfState.items = {}; }
  } catch {
    shelfState.ids = []; shelfState.items = {};
  }
  shelfState.loadedFor = state.space;
  emit();
}

/** 重新拉取（打开抽屉时刷新进度显示用；加载态不变直接覆盖）。 */
export async function refreshShelf() {
  try {
    const r = await jget('/api/reader-shelf');
    if (r && r.ok && r.data) applyResponse(r.data);
  } catch { /* 离线等场景保留本地视图 */ }
  shelfState.loadedFor = state.space;
}

// ---- 持久化 ----
// 串行链保证多次快速变更（连续移除/拖拽）按序到达服务端，last-write-wins 不乱序。
// seq 守卫：只有「链尾那次」的响应才回同步服务端规整结果（如滤掉死 id），
// 过期响应到达时本地已有更新数据，直接丢弃防回滚。
let putChain = Promise.resolve();
let putSeq = 0;
function persistShelf() {
  const seq = ++putSeq;
  const ids = shelfState.ids.slice();
  putChain = putChain
    .then(() => PUT('/api/reader-shelf', { ids }))
    .then((r) => {
      if (seq !== putSeq) return; // 已有更新的本地状态，忽略过期响应
      if (r && r.ok && r.data && Array.isArray(r.data.ids)) applyResponse(r.data);
    })
    .catch(() => { /* 落库失败保留本地视图（下次任一变更会整体重发） */ });
  return putChain;
}

// ---- 变更操作（本地立即生效 + emit + 异步落库）----

/** 打开论文时标记当前篇：在架上 → activeId=id；不在 → activeId=''（不上架，[/] 随之失效）。 */
export async function shelfActivate(id) {
  if (!id) return;
  await ensureShelfLoaded();
  shelfState.activeId = shelfState.ids.includes(id) ? id : '';
  emit();
}

/** 上架一篇（不改变当前阅读项——抽屉搜索「只上架不跳转」用）。已在架上幂等。 */
export async function shelfAdd(paper) {
  if (!paper || !paper.id) return;
  await ensureShelfLoaded();
  if (!shelfState.ids.includes(paper.id)) {
    shelfState.ids.push(paper.id);
    persistShelf();
  }
  shelfState.items[paper.id] = itemFromPaper(paper);
  emit();
}

/** 切换当前论文的在架状态（工具栏 🔖 / Ctrl+D）。返回切换后是否在架上。 */
export async function shelfToggle(paper) {
  if (!paper || !paper.id) return false;
  await ensureShelfLoaded();
  const id = paper.id;
  if (shelfState.ids.includes(id)) {
    shelfState.ids.splice(shelfState.ids.indexOf(id), 1);
    delete shelfState.items[id];
    if (shelfState.activeId === id) shelfState.activeId = '';
    persistShelf();
    emit();
    return false;
  }
  shelfState.ids.push(id);
  shelfState.items[id] = itemFromPaper(paper);
  shelfState.activeId = id;
  persistShelf();
  emit();
  return true;
}

/** 移除一篇（永不切换论文/关阅读器——正在读的论文被移出后继续读）。返回是否原本在架上。 */
export function shelfRemove(id) {
  const i = shelfState.ids.indexOf(id);
  if (i === -1) return false;
  shelfState.ids.splice(i, 1);
  delete shelfState.items[id];
  if (shelfState.activeId === id) shelfState.activeId = '';
  persistShelf();
  emit();
  return true;
}

/**
 * 移除一篇并返回撤销函数（v3.65 P2，设计系统 §7.1「可恢复的破坏性操作 → 执行 + 撤销 toast」）。
 * 不在架上返回 null。撤销把条目放回原位置（架子期间变短则放到末尾），恢复卡片元数据与「当前篇」标记。
 */
export function shelfRemoveUndoable(id) {
  const i = shelfState.ids.indexOf(id);
  if (i === -1) return null;
  const item = shelfState.items[id];
  const wasActive = shelfState.activeId === id;
  shelfRemove(id);
  return () => {
    if (shelfState.ids.includes(id)) return;
    shelfState.ids.splice(Math.min(i, shelfState.ids.length), 0, id);
    if (item) shelfState.items[id] = item;
    if (wasActive) shelfState.activeId = id;
    persistShelf();
    emit();
  };
}

/** 拖拽重排：把 from 位置的条目移动到 to 位置（to 按「移除 from 后的语义」计算，
 *  与 HTML5 DnD 的 drop 目标一致）。越界静默忽略。 */
export function shelfMove(from, to) {
  const n = shelfState.ids.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
  const [id] = shelfState.ids.splice(from, 1);
  shelfState.ids.splice(to, 0, id);
  persistShelf();
  emit();
  return true;
}

/** [/] 快捷键：相对 activeId 的上/下一篇（dir=-1|+1，环形回绕）。
 *  当前篇不在架上（activeId 无效）时返回 null——架子是清单，没上架就没有「上下篇」。 */
export function shelfStepId(dir) {
  const n = shelfState.ids.length;
  if (n < 2) return null;
  const i = shelfState.ids.indexOf(shelfState.activeId);
  if (i === -1) return null;
  return shelfState.ids[(i + (dir > 0 ? 1 : n - 1)) % n];
}

/** 清空阅读架（不移除论文本身，也不关阅读器）。 */
export function shelfClear() {
  shelfState.ids = [];
  shelfState.items = {};
  shelfState.activeId = '';
  persistShelf();
  emit();
}
