// 聊天 SSE 流式请求
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。
// v3.16 起 streamVisionFetch（原 reader.js 独有）迁入，GET /chat 与 POST /chat/vision
// 共用同一套模型参数组装 + SSE 协议，两入口（详情 tab / reader 抽屉）统一复用。

import { api, sp } from './api.js';
import { getChatParams, getSelectedModel } from '../detail/chat-view.js';

/** 把 getChatParams() 返回的「UI 调节值」组装成 GET query（thinking/temperature/topP/maxTokens/model）。
 *  供 streamChatFetch（GET 拼 URLSearchParams）复用；POST /chat/vision 走 buildChatParamsBody。 */
function appendChatParams(params, cp) {
  cp = cp || {};
  for (const k of ['thinking', 'temperature', 'topP', 'maxTokens']) {
    const v = cp[k];
    if (v == null || v === '') continue;
    // thinking 是字符串（enabled/disabled），其余是数值
    if (k === 'thinking') { if (v === 'enabled' || v === 'disabled') params.set(k, v); continue; }
    if (!Number.isNaN(v)) params.set(k, String(v));
  }
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  if (selModel) params.set('model', selModel);
}

/** 把 getChatParams() 返回值组装成 POST /chat/vision 的 chatParams 对象（数值化）。
 *  与 appendChatParams 同源数据，只是 POST body 要对象而非 query 字符串。 */
function buildChatParamsBody(cp) {
  cp = cp || {};
  const chatParams = {};
  // thinking 透传字符串（router 转对象），其余为数值
  if (cp.thinking === 'enabled' || cp.thinking === 'disabled') chatParams.thinking = cp.thinking;
  for (const k of ['temperature', 'topP']) {
    if (cp[k] != null && cp[k] !== '' && !Number.isNaN(cp[k])) chatParams[k] = Number(cp[k]);
  }
  if (cp.maxTokens != null && cp.maxTokens !== '' && !Number.isNaN(cp.maxTokens)) chatParams.maxTokens = parseInt(cp.maxTokens, 10);
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  if (selModel) chatParams.model = selModel;
  return chatParams;
}

/** 流式读取 AI 对话：GET /api/papers/:id/chat?message=（EventSource，discover 同款模式）。
 *  - 用 EventSource 而非 fetch+ReadableStream：POST+fetch SSE 在浏览器有挂起/缓冲问题（实测 await fetch
 *    promise 不 resolve），EventSource 是 SSE 原生可靠通道。
 *  - 携带图片（images 非空）时改走 streamVisionFetch（POST /chat/vision，fetch+ReadableStream），
 *    EventSource 无法带 body（图片 base64）。
 *  - onToken(text, kind)：每个增量 token（kind=content|reasoning）；onDone({reply,chat})：完成；onFail(err)：失败。
 *  - 返回一个 close() 函数，调用即中止（切论文/关抽屉时调，防止 EventSource 自动重连重跑）。
 *  事件名 token/done/fail（避免 error 防 EventSource 原生 error 误判 + 自动重连，沿用 discover 约定）。 */
export function streamChatFetch(paperId, message, { onToken, onDone, onFail, regenerate, chatParams, extraIds, images } = {}) {
  // Phase 3 视觉问答：带图片走 POST /chat/vision（fetch + ReadableStream，EventSource 无法带 body）
  if (Array.isArray(images) && images.length) {
    return streamVisionFetch(paperId, message, { onToken, onDone, onFail, regenerate, extraIds, images, chatParams });
  }
  const params = new URLSearchParams();
  if (message) params.set('message', message);
  if (regenerate) params.set('regenerate', '1');
  // @ 引用论文（逗号分隔透传）
  if (Array.isArray(extraIds) && extraIds.length) params.set('extraIds', extraIds.join(','));
  // 透传模型参数（thinking=enabled/disabled 字符串；其余为数值）。chatParams 显式注入优先，否则读 UI 当前值。
  appendChatParams(params, chatParams || (typeof getChatParams === 'function' ? getChatParams() : {}));
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

/** Phase 3 视觉问答流式：POST /api/papers/:id/chat/vision（fetch + ReadableStream 解析 SSE）。
 *  EventSource 无法携带 body（图片 base64），故视觉问答走 fetch 流。
 *  事件协议与 GET /chat 一致（token/done/fail），手动按 \n\n 分块解析。
 *  返回 close() 中止函数（AbortController.abort）。
 *  v3.16 自 reader.js 迁入——详情 tab 视觉问答（图片粘贴/拖拽）也复用此实现。 */
export function streamVisionFetch(paperId, message, { onToken, onDone, onFail, regenerate, extraIds, images, chatParams } = {}) {
  const cpBody = buildChatParamsBody(chatParams || (typeof getChatParams === 'function' ? getChatParams() : {}));
  const body = JSON.stringify({
    message: message || '',
    regenerate: !!regenerate,
    extraIds: Array.isArray(extraIds) && extraIds.length ? extraIds : undefined,
    images: Array.isArray(images) ? images : [],
    chatParams: cpBody,
  });
  const url = sp('/api/papers/' + encodeURIComponent(paperId) + '/chat/vision');
  const ctrl = new AbortController();
  let finished = false;
  const close = () => { finished = true; try { ctrl.abort(); } catch {} };
  (async () => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (!finished && typeof onFail === 'function') onFail('连接中断，请重试');
      return;
    }
    if (!res.ok) {
      // 视觉模型不可用 / 鉴权失败等：读错误信息
      let msg = '视觉问答失败（HTTP ' + res.status + '）';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      // 常见：当前模型不支持图片输入
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        msg = msg + '。当前模型可能不支持图片输入，请在右下角切换到视觉模型（如 gpt-4o / glm-4.5v）。';
      }
      if (typeof onFail === 'function') onFail(msg);
      return;
    }
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) { if (typeof onFail === 'function') onFail('浏览器不支持流式读取'); return; }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // 简易 SSE 解析：块间 \n\n 分隔，每块形如 `event: xx\ndata: {...}`
    const dispatch = (block) => {
      const lines = block.split('\n');
      let event = 'message', dataStr = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) event = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
      }
      if (!dataStr) return;
      let obj = null; try { obj = JSON.parse(dataStr); } catch { return; }
      if (event === 'token' && obj && obj.t && typeof onToken === 'function') onToken(obj.t, obj.kind || 'content');
      else if (event === 'done') { finished = true; if (typeof onDone === 'function') onDone(obj); }
      else if (event === 'fail') { finished = true; if (typeof onFail === 'function') onFail((obj && obj.error) || 'AI 回答失败'); }
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          dispatch(block);
          if (finished) break;
        }
        if (finished) break;
      }
    } catch (e) {
      if (!finished && typeof onFail === 'function') onFail('连接中断，请重试');
    }
  })();
  return close;
}

// 暴露给 reader.js（独立 ESM，P2 改造前仍走 window 桥）。streamChatFetch 已内置 images
// 分发到 streamVisionFetch，reader 调用方无需感知视觉问答分支。
if (typeof window !== 'undefined') {
  window.streamChatFetch = streamChatFetch;
  window.streamVisionFetch = streamVisionFetch;
}
