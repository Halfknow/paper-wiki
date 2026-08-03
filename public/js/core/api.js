// HTTP 客户端与空间上下文注入（sp/jget/POST/PUT/PATCH/DEL/safeGet）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from './dom.js';
import { state } from './state.js';

export const api = async (p, opt) => {
  const r = await fetch(sp(p), opt);
  if (r.headers.get('content-type', '').includes('application/json')) return r.json();
  return r;
};

export const jget = (p) => fetch(sp(p)).then((r) => r.json());

const jsend = (method) => (p, body) => fetch(sp(p), {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

export const PATCH = jsend('PATCH');

export const POST = jsend('POST');

export const PUT = jsend('PUT');

export const DEL = (p) => fetch(sp(p), { method: 'DELETE' }).then((r) => r.json());

/** 网络安全版 jget：fetch 层错误（离线/DNS/拒绝连接/超时）返回 {ok:false,error} 而非抛出，
 *  供 refresh() 的 Promise.allSettled 用——单个接口失败时不至于整页卡死或清空列表。 */
export async function safeGet(p) {
  try {
    const r = await fetch(sp(p));
    const body = await r.json().catch(() => null);
    if (body && typeof body === 'object') return body;
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '网络错误' };
  }
}

/** 空间上下文注入器：把 ?space=<activeSpaceId> 自动加到所有 /api/ 和 /papers/ 请求 URL。
 *  - 已有 ?space= 的不动（允许显式覆盖）。
 *  - 纯路径（无 query）追加；有 query 的合并。
 *  - state.space 为空（启动初期未拉到空间列表）时不注入，后端回退 active 空间。
 *  EventSource（chat/discover）无法设 header，统一走 query，后端按 ?space= 路由。 */
export function sp(url) {
  if (!state || !state.space) return url;
  const s = String(url || '');
  if (!s.startsWith('/api/') && !s.startsWith('/papers/')) return s; // 只接管后端路由
  const i = s.indexOf('?');
  if (i === -1) return s + '?space=' + encodeURIComponent(state.space);
  if (/[?&]space=/.test(s)) return s; // 已带 space，不覆盖
  return s + '&space=' + encodeURIComponent(state.space);
}
