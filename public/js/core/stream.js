// 聊天 SSE 流式请求
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { api, sp } from './api.js';
import { getChatParams, getSelectedModel } from '../detail/chat-view.js';

/** 流式读取 AI 对话：GET /api/papers/:id/chat?message=（EventSource，discover 同款模式）。
 *  - 用 EventSource 而非 fetch+ReadableStream：POST+fetch SSE 在浏览器有挂起/缓冲问题（实测 await fetch
 *    promise 不 resolve），EventSource 是 SSE 原生可靠通道。
 *  - onToken(text)：每个增量 token；onDone({reply,chat})：完成；onFail(err)：失败。
 *  - 返回一个 close() 函数，调用即中止（切论文/关抽屉时调，防止 EventSource 自动重连重跑）。
 *  事件名 token/done/fail（避免 error 防 EventSource 原生 error 误判 + 自动重连，沿用 discover 约定）。 */
export function streamChatFetch(paperId, message, { onToken, onDone, onFail, regenerate, chatParams, extraIds } = {}) {
  const params = new URLSearchParams();
  if (message) params.set('message', message);
  if (regenerate) params.set('regenerate', '1');
  // @ 引用论文（逗号分隔透传）
  if (Array.isArray(extraIds) && extraIds.length) params.set('extraIds', extraIds.join(','));
  // 透传模型参数（thinking=enabled/disabled 字符串；其余为数值）
  const cp = chatParams || getChatParams();
  for (const k of ['thinking', 'temperature', 'topP', 'maxTokens']) {
    const v = cp[k];
    if (v == null || v === '') continue;
    // thinking 是字符串（enabled/disabled），其余是数值
    if (k === 'thinking') { if (v === 'enabled' || v === 'disabled') params.set(k, v); continue; }
    if (!Number.isNaN(v)) params.set(k, String(v));
  }
  // Phase 2 模型切换：透传选中模型（空=默认）
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  if (selModel) params.set('model', selModel);
  const url = sp('/api/papers/' + encodeURIComponent(paperId) + '/chat?' + params.toString());
  const es = new EventSource(url);
  let finished = false; // 收到 done/fail 后置位，避免连接关闭触发的原生 error 被误判为失败
  es.addEventListener('token', (e) => {
    let obj = null;
    try { obj = JSON.parse(e.data); } catch { return; }
    if (obj && obj.t && typeof onToken === 'function') onToken(obj.t, obj.kind || 'content');
  });
  es.addEventListener('done', (e) => {
    finished = true;
    try { es.close(); } catch {}
    let obj = {};
    try { obj = JSON.parse(e.data); } catch {}
    if (typeof onDone === 'function') onDone(obj);
  });
  es.addEventListener('fail', (e) => {
    finished = true;
    try { es.close(); } catch {}
    let msg = 'AI 回答失败';
    try { msg = JSON.parse(e.data).error || msg; } catch {}
    if (typeof onFail === 'function') onFail(msg);
  });
  es.onerror = () => {
    if (finished) return; // 正常结束后的关闭
    finished = true;
    try { es.close(); } catch {}
    if (typeof onFail === 'function') onFail('连接中断，请重试');
  };
  return () => { finished = true; try { es.close(); } catch {} }; // 返回中止函数
}
