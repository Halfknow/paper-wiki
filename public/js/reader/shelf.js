// 阅读架状态（v3.21 多论文阅读抽屉）——浏览器多标签的学术版。
//
// 职责：持有有序论文 id 栈 + 当前阅读项，per-space 从 GET/PUT /api/reader-shelf 加载与持久化，
// 状态变化后通知订阅者（阅读器内的抽屉 UI / FAB 徽章）重渲。本模块不依赖 pdf.js——
// 常驻侧 reader-host.js（打开论文时上架）与惰性加载的 reader.js（抽屉 UI）共享同一实例。
//
// 顺序语义：数组顺序即阅读顺序，完全由用户手动维护（抽屉拖拽）；打开/切换不重排。

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

/** 打开论文时上架：已在不重复加（不重排），并设为当前阅读项。
 *  paper 传 detail/summary 均可（顺手富化 items，省一次 GET）。 */
export async function shelfAddAndActivate(paper) {
  if (!paper || !paper.id) return;
  await ensureShelfLoaded();
  const id = paper.id;
  if (!shelfState.ids.includes(id)) {
    shelfState.ids.push(id);
    persistShelf();
  }
  shelfState.items[id] = itemFromPaper(paper);
  shelfState.activeId = id;
  emit();
}

/** 移除一篇。返回是否仍在架上（false = 已被移除）。 */
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

/** 移除 id 后应切换到的邻居：优先右侧（下一篇），否则左侧，都没有则 null（架子空了）。 */
export function shelfNeighborAfter(id) {
  const i = shelfState.ids.indexOf(id);
  if (i === -1) return shelfState.ids[0] || null;
  return shelfState.ids[i + 1] || shelfState.ids[i - 1] || null;
}

/** [/] 快捷键：相对 activeId 的上/下一篇（dir=-1|+1，环形回绕）。无可切换返回 null。 */
export function shelfStepId(dir) {
  const n = shelfState.ids.length;
  if (n < 2) return null;
  const i = Math.max(0, shelfState.ids.indexOf(shelfState.activeId));
  return shelfState.ids[(i + (dir > 0 ? 1 : n - 1)) % n];
}

/** 清空阅读架（不移除论文本身）。 */
export function shelfClear() {
  shelfState.ids = [];
  shelfState.items = {};
  shelfState.activeId = '';
  persistShelf();
  emit();
}
