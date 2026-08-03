// 聊天 tab 主体（composer / 大纲 / 重新生成）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, api, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { renderChatMd, truncateChatTitle } from '../core/markdown.js';
import { chatState, set_chatState, state } from '../core/state.js';
import { streamChatFetch } from '../core/stream.js';
import { toast } from '../core/ui-kit.js';
import { CHAT_PARAM_FIELDS, CHAT_ROLE_ICO, chatEmptyHtml, chatMsgHtml, closeChatMentionPicker, getChatPresets, getSelectedModel, handleMentionKeydown, handleMentionTrigger, openChatMentionPicker, wireChatActions, wireChatParamsShell, toggleModelSwitcher, applySendingUi as sharedApplySendingUi, autoResizeInput as sharedAutoResizeInput, updateSendEnabled as sharedUpdateSendEnabled } from './chat-view.js';
import { renderDetail, saveQaCardToNotes } from './detail.js';

/** 详情「AI 聊天」tab：消息列表（user 右 / assistant 左）+ 输入框 + 发送 + 清空。
 *  数据源 p.chat（detailView 回传）。发送走 POST /api/papers/:id/chat，回复追加到 state.detail.chat。
 *
 *  竞态防护（核心）：定时 refresh() 每 10s 调 renderDetail 全量重建本 tab，会导致
 *    ① 用户未发送的输入被清空 ② 进行中的请求把回复 append 到「已被重建掉的旧 list 节点」
 *    （stale 闭包引用）→ 用户永远看不到回复。两症状同源。
 *  解法（参考现代 LLM 对话 UI 最佳实践）：
 *    - chatState（模块级）保存 draft/busy，renderDetail 重建后回填，杜绝「打字被清空」
 *    - 追加目标用 document.getElementById 实时重查，绝不用 stale 闭包引用
 *    - 发送期间 busy=true 禁用发送键 + 锁 textarea，防双发；切论文时 chatState 失效（id 不符即忽略响应） */
export function renderChatTab(body, p) {
  // 切论文时 chatState 归零（旧论文的 draft/busy/extraIds 不带到新论文）。
  // 关键：若旧论文有进行中的流式请求，必须先关闭 EventSource（否则旧流继续往新 tab 灌 token → 串论文 + 重连）。
  if (!chatState || chatState.id !== p.id) {
    if (chatState && chatState.closeStream) { try { chatState.closeStream(); } catch {} }
    set_chatState({ id: p.id, draft: '', busy: false, reqId: 0, closeStream: null, extraIds: [], editingMi: null });
    closeChatMentionPicker(); // 切论文时关 @ 浮层（避免 stale textarea 引用）
    toggleChatOutline(false); // 切论文时关大纲浮窗（条目已失效）
  }
  if (!Array.isArray(chatState.extraIds)) chatState.extraIds = [];
  const msgs = Array.isArray(p.chat) ? p.chat.slice() : [];
  // 流式进行中（busy）时，把「正在生成的 assistant 占位」追加到消息列表末尾，
  // 这样定时 refresh() 重建 #chat-list 时不会丢失占位（占位不在 p.chat 里，是 doSend 直接 append 的）。
  // chatState.streaming 记录 { content, reasoning }，重建时还原。
  if (chatState.busy && chatState.streaming) {
    msgs.push({ role: 'assistant', _streaming: true, content: chatState.streaming.content || '', reasoning: chatState.streaming.reasoning || '' });
  }
  const listHtml = msgs.length
    ? msgs.map((m, i) => {
        if (m._streaming) {
          // 流式占位：思考中（skeleton shimmer）或已收到部分 token（streaming 光标）
          const c = (m.content || '').trim();
          const reasoning = (m.reasoning || '').trim();
                  const rsHtml = reasoning ? `<div class="chat-reasoning streaming"><details open><summary>思考中…</summary><div class="chat-reasoning-body">${renderChatMd(reasoning, { final: false })}</div></details></div>` : '';
          if (c) {
            const node = `<div class="chat-msg assistant" data-mi="${i}" data-streaming="1"><div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">AI</span></div><div class="chat-body"><div class="chat-bubble streaming"><div class="chat-content streaming">${renderChatMd(m.content, { final: false })}</div></div></div></div>`;
            return rsHtml ? node.replace('<div class="chat-body">', '<div class="chat-body">' + rsHtml) : node;
          }
          // skeleton：三行 shimmer 占位
          const skNode = `<div class="chat-msg assistant" data-mi="${i}" data-streaming="1"><div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">AI</span></div><div class="chat-body">${rsHtml}<div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div></div></div>`;
          return skNode;
        }
        // 仅最后一条非流式 assistant 显示「重新生成」
        const isLastAssistant = i === msgs.length - 1 && m.role === 'assistant';
        return chatMsgHtml(m, i, { regenerable: isLastAssistant });
      }).join('')
    : chatEmptyHtml();
  // 预置快捷提问（折叠到 popover，避免常年占用一行）
  const presets = getChatPresets();
  // 参数浮层：每参数卡片（启用开关 + 滑块/数字 + 值 badge）。toggle 类型无滑块，只有开关。
  const paramCardsHtml = CHAT_PARAM_FIELDS.map((f) => {
    if (f.kind === 'toggle') {
      // toggle（如 thinking）：只有开关 + 状态文案，无滑块/数字输入
      return `<div class="pp-card toggle" data-key="${f.key}">
        <div class="pp-card-head"><span class="pp-label">${f.label}</span><b class="pp-val">开启</b><label class="pp-switch-wrap"><input type="checkbox" class="pp-switch" /><span class="pp-track"></span></label></div>
      </div>`;
    }
    const inputHtml = f.kind === 'range'
      ? `<input type="range" class="pp-in" min="${f.min}" max="${f.max}" step="${f.step}" disabled />`
      : `<input type="number" class="pp-in" min="${f.min}" step="${f.step}" placeholder="不限" disabled />`;
    return `<div class="pp-card" data-key="${f.key}">
      <div class="pp-card-head"><span class="pp-label">${f.label}</span><b class="pp-val">默认</b><label class="pp-switch-wrap"><input type="checkbox" class="pp-switch" /><span class="pp-track"></span></label></div>
      ${inputHtml}
    </div>`;
  }).join('');
  // 预置浮层（折叠式：点按钮展开列表）
  const presetsPopoverHtml = `<div class="chat-presets-pop" id="chat-presets-pop" hidden>${presets.map((pr) => `<button class="chat-preset-item" data-prompt="${escapeHtml(pr.prompt)}" title="${escapeHtml(pr.prompt)}"><span>${escapeHtml(pr.label)}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`).join('')}</div>`;
  // 当前选中模型（Phase 2：getSelectedModel 优先，否则默认）
  const selModel = typeof getSelectedModel === 'function' ? getSelectedModel() : '';
  const currentModel = selModel || (state.aiModels && state.aiModels.default) || '默认模型';
  body.innerHTML = `<div class="chat-tab">
    <div class="chat-list" id="chat-list">${listHtml}</div>
    <div class="chat-input-shell">
      <!-- 滚动到底部 FAB：作为 .chat-input-shell（position:sticky → 含定位上下文）子元素，
           position:absolute; bottom:100% 整颗浮在输入框正上方（留 6px 缝），与阅读器抽屉一致。
           滚动容器是外层 .detail-pane（.chat-list 自身不滚），见 wireChatExtras。 -->
      <button class="scroll-bottom-btn" id="chat-scroll-bottom" title="滚动到底部" aria-label="滚动到底部"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>
      <div class="chat-composer" id="chat-composer">
        <div class="chat-composer-context" id="chat-mentions-row"></div>
        <textarea id="chat-input" rows="1" placeholder="问问 AI 关于这篇论文…  @ 引用其它论文">${escapeHtml(chatState.draft || '')}</textarea>
        <div class="chat-composer-footer">
          <div class="chat-composer-left">
            <button class="chat-tool-btn" id="chat-presets-btn" type="button" title="快捷提问">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>
              <span>快捷</span>
            </button>
            <button class="chat-tool-btn icon-only" id="chat-params-btn" type="button" title="模型参数">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
              <span class="cp-badge"></span>
            </button>
            ${msgs.length ? '<button class="chat-tool-btn icon-only" id="chat-outline" title="问答大纲"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg></button>' : ''}
            ${msgs.length ? '<button class="chat-tool-btn" id="chat-clear" type="button" title="清空聊天记录"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg><span>清空</span></button>' : ''}
          </div>
          <div class="chat-composer-right">
            <button class="chat-model-btn" id="chat-model-btn" type="button" title="切换模型" aria-expanded="false">
              <span class="cm-name">${escapeHtml(currentModel)}</span>
              <svg class="cm-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="chat-send-btn" id="chat-send" type="button" ${chatState.busy ? 'disabled' : ''} title="${chatState.busy ? '生成中' : '发送（Enter）'}" aria-label="${chatState.busy ? '停止生成' : '发送'}">
              ${chatState.busy ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>'}
            </button>
          </div>
        </div>
        <div class="chat-params-pop" id="chat-params-pop" hidden><div class="pp-title">模型参数 <span class="pp-hint">仅启用的参数随请求发送</span></div>${paramCardsHtml}</div>
        ${presetsPopoverHtml}
      </div>
    </div>
  </div>`;
  const list = $('chat-list');
  // 滚动容器是外层 .detail-pane（.chat-list 自身不滚），进 tab 即贴底
  scrollChatListToBottom();
  const input = $('chat-input'), sendBtn = $('chat-send');
  if (chatState.busy) { input.disabled = true; sendBtn.classList.add('sending'); }
  // 实时同步 draft 到 chatState（任何 input 变化即存），renderDetail 重建后由上方回填，杜绝「打字被清空」
  input.oninput = () => { chatState.draft = input.value; autoResizeInput(input); triggerMention(input, p); updateSendEnabled(); };
  autoResizeInput(input);
  updateSendEnabled();
  // 渲染当前 @ 引用 chip 行
  renderExtraIdsRow();
  // 模型参数浮层：接线 + 徽章计数
  wireChatParamsShell('chat-params-pop', 'chat-params-btn');
  wireParamsToggle('chat-params-btn', 'chat-params-pop');
  // 预置浮层切换 + 项点击
  wireParamsToggle('chat-presets-btn', 'chat-presets-pop');
  body.querySelectorAll('.chat-preset-item').forEach((btn) => {
    btn.onclick = () => { input.value = btn.dataset.prompt || ''; chatState.draft = input.value; autoResizeInput(input); $('chat-presets-pop').hidden = true; updateSendEnabled(); doSend(); };
  });
  // 模型切换按钮（Phase 1 仅占位 toast，Phase 2 接入实际下拉）
  const modelBtn = $('chat-model-btn');
  if (modelBtn) modelBtn.onclick = (e) => { e.stopPropagation(); toggleModelSwitcher(modelBtn); };
  /** 渲染当前 chatState.extraIds 的可移除 chip 行（输入框上方）。 */
  function renderExtraIdsRow() {
    const row = document.getElementById('chat-mentions-row');
    if (!row) return;
    row.hidden = !chatState.extraIds.length;
    if (!chatState.extraIds.length) { row.innerHTML = ''; return; }
    row.innerHTML = chatState.extraIds.map((id) => {
      const pp = (state.papers || []).find((x) => x.id === id);
      const title = (pp && pp.title) || id;
      return `<span class="extra-chip" data-eid="${escapeHtml(id)}" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escapeHtml(truncateChatTitle(title, 20))}<button class="extra-chip-x" data-eid="${escapeHtml(id)}" type="button" aria-label="移除引用">×</button></span>`;
    }).join('');
    row.querySelectorAll('.extra-chip-x').forEach((x) => {
      x.onclick = () => {
        const eid = x.dataset.eid;
        chatState.extraIds = chatState.extraIds.filter((i) => i !== eid);
        renderExtraIdsRow();
      };
    });
  }
  // @ 触发器：5 步检测逻辑已抽到 chat-view.js 的 handleMentionTrigger（与 reader 共用），
  // 此处只传 ctx（excludeId / selectedIds / onPick 写 chatState）。
  function triggerMention(inputEl, paper) {
    handleMentionTrigger(inputEl, {
      excludeId: paper.id,
      selectedIds: chatState.extraIds,
      onPick: (id) => {
        if (!chatState.extraIds.includes(id)) chatState.extraIds.push(id);
        renderExtraIdsRow();
        chatState.draft = inputEl.value;
        autoResizeInput(inputEl);
        updateSendEnabled();
      },
    });
  }
  /** 发送（支持 normal / regenerate / edit）。opts.regenerate=true 走重新生成；opts.skipUserMsg=true 不追加 user 气泡；
   *  opts.editMi=数字 走编辑重发（截断该 user 之后的历史）。 */
  const doSend = async (opts) => {
    opts = opts || {};
    if (chatState.busy) return; // 停止由独立按钮处理
    const regenerate = !!opts.regenerate;
    const editMi = opts.editMi != null ? Number(opts.editMi) : null;
    const message = regenerate ? '' : (input.value || '').trim();
    if (!message && !regenerate) return;
    // 当前引用（编辑重发时沿用被编辑 user 的 extraIds）
    const extraIds = regenerate ? [] : (editMi != null ? (extractExtraIdsFromMsg(editMi) || chatState.extraIds.slice()) : chatState.extraIds.slice());
    // 乐观入位：先存草稿=空、busy=true，再清输入框（顺序关键：状态先于 UI，避免刷新间隙丢消息）
    if (!regenerate) { chatState.draft = ''; input.value = ''; autoResizeInput(input); }
    if (!regenerate && editMi == null) { chatState.extraIds = []; renderExtraIdsRow(); } // 正常发送后清引用
    chatState.editingMi = null;
    chatState.busy = true;
    const myReqId = ++chatState.reqId;
    const reasoningStart = Date.now();
    // 关闭上一个 EventSource（若有），再开新的。closeStream 是 streamChatFetch 返回的中止函数。
    if (chatState.closeStream) { try { chatState.closeStream(); } catch {} }
    let myClose = null;
    // 编辑重发：截断被编辑 user 之后的历史（DOM + p.chat）
    if (editMi != null && !opts.skipTruncate) {
      const cutCount = (p.chat || []).length - editMi;
      if (cutCount > 0) {
        p.chat = (p.chat || []).slice(0, editMi);
        const liveList = document.getElementById('chat-list');
        if (liveList) { [...liveList.querySelectorAll('.chat-msg')].slice(-cutCount).forEach((n) => n.remove()); }
      }
    }
    // 乐观追加 user 消息（重新生成跳过——DOM 已移除最后一轮，用服务端历史）
    if (!opts.skipUserMsg) {
      const userMsg = { role: 'user', content: message };
      if (extraIds.length) userMsg.extraIds = extraIds;
      p.chat = [...(p.chat || []), userMsg];
      appendChatMsgById('chat-list', userMsg);
    }
    // 流式占位 assistant 消息：先 skeleton shimmer，首个 token 后逐字 renderChatMd 重渲 + 气泡发光。
    // 标记 data-streaming="1"，让 lastAssistantNode 精确定位（不被已有历史 assistant 干扰）。
    appendChatMsgById('chat-list', { role: 'assistant', content: '' });
    {
      // 找刚追加的占位（最后一个 .chat-msg.assistant），重写为 skeleton 结构 + data-streaming 标记
      const accList2 = document.getElementById('chat-list');
      const allAsst = accList2 ? [...accList2.querySelectorAll('.chat-msg.assistant')] : [];
      const accNode2 = allAsst.length ? allAsst[allAsst.length - 1] : null;
      if (accNode2) {
        accNode2.setAttribute('data-streaming', '1');
        const body2 = accNode2.querySelector('.chat-body');
        if (body2) body2.innerHTML = '<div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div>';
      }
      scrollChatListToBottom();
    }
    // morphing 发送键：圆→红方块停止
    setBusyUI(true);
    let accumulated = '';
    let accumulatedReasoning = '';
    chatState.streaming = { content: '', reasoning: '' };  // 流式状态：供 renderChatTab 重建时保留占位
    const lastAssistantNode = () => {
      const liveList = document.getElementById('chat-list');
      // 优先取流式占位（data-streaming），其次末条 assistant
      const streaming = liveList && liveList.querySelector('.chat-msg.assistant[data-streaming="1"]');
      if (streaming) return streaming;
      const all = liveList ? [...liveList.querySelectorAll('.chat-msg.assistant')] : [];
      return all.length ? all[all.length - 1] : null;
    };
    /** 把占位切换到 streaming 气泡态（首 token 到达时调用一次）。 */
    const ensureStreamingBubble = () => {
      const liveNode = lastAssistantNode();
      if (!liveNode) return;
      const bubble = liveNode.querySelector('.chat-bubble');
      if (!bubble) return;
      bubble.classList.remove('thinking-skeleton');
      bubble.classList.add('streaming');
      // skeleton 的 .thinking 内容替换为空 .streaming 容器
      const content = bubble.querySelector('.chat-content');
      if (content) { content.classList.remove('thinking'); content.classList.add('streaming'); content.innerHTML = ''; }
    };
    const renderAccumulated = () => {
      const liveNode = lastAssistantNode();
      if (!liveNode) return;
      let bubble = liveNode.querySelector('.chat-bubble');
      if (!bubble) {                // 兜底：占位结构异常时重建
        const body = liveNode.querySelector('.chat-body');
        if (!body) return;
        body.innerHTML = '<div class="chat-bubble streaming"><div class="chat-content streaming"></div></div>';
        bubble = body.querySelector('.chat-bubble');
      }
      ensureStreamingBubble();
      const content = bubble.querySelector('.chat-content');
      if (content) {
        content.innerHTML = renderChatMd(accumulated, { final: false });  // markdown 增量重渲（流式不折叠代码块）
      }
      scrollChatListToBottom();
    };
    const renderReasoning = () => {
      const body = lastAssistantNode() ? lastAssistantNode().querySelector('.chat-body') : null;
      if (!body) return;
      let el = body.querySelector('.chat-reasoning');
      if (!el) { el = document.createElement('div'); el.className = 'chat-reasoning streaming'; body.insertBefore(el, body.firstChild); }
      // 仅在 details 首次创建时定结构；后续 token 增量只刷新 body，避免重建打断用户手动折叠
      if (!el.querySelector('.chat-reasoning-body')) {
        el.innerHTML = '<details open><summary>思考中…</summary><div class="chat-reasoning-body"></div></details>';
      }
      const rb = el.querySelector('.chat-reasoning-body');
      if (rb) {
        rb.innerHTML = renderChatMd(accumulatedReasoning, { final: false }); // 思考内容也渲染 markdown
        // 思考体有独立的 max-height+overflow，必须滚它自己，否则超长时新 token 不可见（像卡住）
        rb.scrollTop = rb.scrollHeight;
      }
      scrollChatListToBottom();
    };
    myClose = streamChatFetch(p.id, message, {
      regenerate,
      extraIds: extraIds.length ? extraIds : undefined,
      onToken: (t, kind) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) { try { myClose(); } catch {} return; }
        if (kind === 'reasoning') {
          accumulatedReasoning += t;
          chatState.streaming = { content: accumulated, reasoning: accumulatedReasoning };
          renderReasoning();
          return;
        }
        accumulated += t;
        chatState.streaming = { content: accumulated, reasoning: accumulatedReasoning };  // 同步到 chatState，renderChatTab 重建时还原占位
        renderAccumulated();
      },
      onDone: (data) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) return;
        chatState.busy = false;
        chatState.closeStream = null;
        chatState.streaming = null;   // 流式结束，清除占位状态
        setBusyUI(false);
        // 用服务端权威 chat 数组替换（含完整回复 + ts）；重渲整条 assistant（补时间戳/操作按钮/重新生成）
        if (data && data.reply != null) {
          accumulated = data.reply;
          p.chat = Array.isArray(data.chat) ? data.chat : [...(p.chat || []), { role: 'assistant', content: data.reply }];
          // 重渲最后一条 assistant 为定型结构（含时间戳 + 操作工具栏）
          const liveNode = lastAssistantNode();
          if (liveNode && p.chat.length) {
            const lastMsg = p.chat[p.chat.length - 1];
            const tmp = document.createElement('div');
            tmp.innerHTML = chatMsgHtml(lastMsg, Number(liveNode.dataset.mi || 0), { regenerable: true });
            if (tmp.firstElementChild) {
              liveNode.replaceWith(tmp.firstElementChild);
              const newNode = tmp.firstElementChild;
              // reasoning：完成后自动收起 + 显示「思考了 X 秒」（1s 延时，NewAPI 同款）
              if (accumulatedReasoning.trim()) {
                const newBody = newNode.querySelector('.chat-body');
                if (newBody) {
                  const dur = Math.max(1, Math.round((Date.now() - reasoningStart) / 1000));
                  const rEl = document.createElement('div');
                  rEl.className = 'chat-reasoning';
                  rEl.innerHTML = `<details><summary><span class="rs-label">思考过程</span><span class="rs-duration">思考了 ${dur} 秒</span></summary><div class="chat-reasoning-body"></div></details>`;
                  rEl.querySelector('.chat-reasoning-body').innerHTML = renderChatMd(accumulatedReasoning, { final: true });
                  newBody.insertBefore(rEl, newBody.firstChild);
                }
              }
            }
          }
        }
        try { if (input) input.focus(); } catch {}
      },
      onFail: (err) => {
        const stale = !chatState || chatState.id !== p.id || chatState.reqId !== myReqId;
        if (stale) return;
        chatState.busy = false;
        chatState.closeStream = null;
        chatState.streaming = null;   // 流式结束（失败），清除占位状态
        setBusyUI(false);
        // 占位若仍空（无 token 到达）→ 改错误文案；否则保留已收到部分
        if (!accumulated) {
          const liveNode = lastAssistantNode();
          const bubble = liveNode && liveNode.querySelector('.chat-bubble');
          if (bubble) {
            bubble.classList.remove('thinking-skeleton', 'streaming');
            let content = bubble.querySelector('.chat-content');
            if (!content) { content = document.createElement('div'); content.className = 'chat-content'; bubble.appendChild(content); }
            content.classList.remove('thinking', 'streaming');
            content.textContent = '（' + (err || 'AI 回答失败') + '）';
          }
        } else {
          toast(err || 'AI 回答失败', 'error');
        }
        try { input.focus(); } catch {}
      },
    });
    chatState.closeStream = myClose;
  };
  /** 切换 busy 态 UI：morphing 发送键（圆→红方块停止）+ 输入锁。renderDetail 重建后仍能用 getElementById 重查。
   *  v3.16：发送键 SVG/title 逻辑复用 chat-view.js 的 applySendingUi（与 reader 共用），detail 在此额外禁用输入框。 */
  function setBusyUI(busy) {
    sharedApplySendingUi(document.getElementById('chat-send'), busy);
    const ip = document.getElementById('chat-input');
    if (ip) ip.disabled = busy;
  }
  /** 发送键空输入禁用（非 busy 时）。busy 时由 setBusyUI 控制（保持可点 = 停止）。 */
  function updateSendEnabled() {
    sharedUpdateSendEnabled(document.getElementById('chat-send'), document.getElementById('chat-input'), { busy: chatState && chatState.busy });
  }
  /** 从 p.chat[mi] 取 extraIds（编辑重发沿用引用）。 */
  function extractExtraIdsFromMsg(mi) {
    const m = (p.chat || [])[mi];
    return m && Array.isArray(m.extraIds) ? m.extraIds.slice() : null;
  }
  doSendFromInput = doSend; // 供建议卡片 / 重新生成 / 编辑调用
  renderExtraIdsRowSafe = renderExtraIdsRow; // 编辑 user 时刷新 @ 引用 chip 行
  // 发送键 = morphing：非 busy 时发送；busy 时变停止键，点击中止流式
  sendBtn.onclick = () => {
    if (chatState.busy) {
      if (chatState.closeStream) { try { chatState.closeStream(); } catch {} }
      chatState.busy = false; chatState.streaming = null; setBusyUI(false); updateSendEnabled();
      return;
    }
    doSend();
  };
  // stopPropagation：防止 Enter 冒泡到全局键盘处理器（disabled 后 activeElement 变 body → 触发 openReader）
  input.onkeydown = (e) => {
    // @ 引用浮层打开时：↑↓ 导航 / Enter 选中 / Esc 关闭（共享 handleMentionKeydown）
    if (handleMentionKeydown(e, input)) { e.stopPropagation(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); closeChatMentionPicker(); doSend(); }
  };
  // 注：点击外部关闭浮层由 picker 内部的全局 mousedown 监听器统一处理（detail tab / reader 抽屉共用）
  const clearBtn = $('chat-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!(await PWDialog.confirm('清空这篇论文的聊天记录？', { title: '清空聊天记录', danger: true, okText: '清空' }))) return;
    p.chat = [];
    await PATCH('/api/papers/' + p.id, { chat: [] });
    renderDetail();
  };
  const outlineBtn = $('chat-outline');
  if (outlineBtn) outlineBtn.onclick = () => toggleChatOutline();
  // 新增控件接线：建议卡片、滚动到底部、消息操作（复制/重新生成/编辑/删除/显示原文/代码块复制/展开）
  wireChatExtras(p, list, input, doSend);
}

/** 参数浮层显隐切换（按钮点击 → toggle；点外部关闭）。 */
function wireParamsToggle(btnId, popId) {
  const btn = document.getElementById(btnId);
  const pop = document.getElementById(popId);
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.hidden = true;
  });
}

/** textarea 自适应高度（min 38 / max 142）。v3.16：复用 chat-view.js 的 autoResizeInput（与 reader 共用）。 */
function autoResizeInput(el) {
  sharedAutoResizeInput(el, { minH: 38, maxH: 142 });
}

/** 把外部聊天（详情 AI tab）滚动到底部。滚动容器是 .detail-pane（.chat-list 自身不滚，
 *  详见 styles.css 滚动模型注释）；找不到时回退 #chat-list 兜底。 */
function scrollChatListToBottom() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  const sc = list.closest('.detail-pane') || list;
  sc.scrollTop = sc.scrollHeight;
}

/** 接线：空状态建议卡片（点即发）、滚动到底部 FAB（滚动检测+点击）、消息操作（复制/重新生成/编辑/删除/显示原文）、代码块复制/展开。
 *  全部用事件委托（消息 DOM 会被流式/重建替换，委托到 list 最稳）。doSend 透传 renderChatTab 的闭包。 */
function wireChatExtras(p, list, input, doSend) {
  if (!list) return;
  // 建议卡片（空状态）
  list.querySelectorAll('.chat-suggest').forEach((chip) => {
    chip.onclick = () => { input.value = chip.dataset.q || ''; chatState.draft = input.value; autoResizeInput(input); doSend && doSend(); };
  });
  // 滚动到底部 FAB：滚动容器是外层 .detail-pane（#detail，持久元素；.chat-list 自身不滚，详见 styles.css 滚动模型注释）。
  // FAB 现挂在 .chat-input-shell 下（浮在输入框上方）。#detail 在每次 renderDetail 全量重建其子树时本身不变，
  // 故 scroll 监听用 dataset 守卫一次性绑定，handler 内 getElementById 实时重查 FAB（避免闭包持有 stale 引用 + 监听器堆积）。
  const scrollCt = list.closest('.detail-pane') || list.parentElement;
  const fabEl = document.getElementById('chat-scroll-bottom');
  if (scrollCt && !scrollCt.dataset.chatScrollWired) {
    scrollCt.dataset.chatScrollWired = '1';
    const updateFab = () => {
      const fab = document.getElementById('chat-scroll-bottom');
      if (!fab) return;
      const near = scrollCt.scrollHeight - scrollCt.scrollTop - scrollCt.clientHeight < 200;
      fab.classList.toggle('show', !near && scrollCt.scrollHeight > scrollCt.clientHeight + 50);
    };
    scrollCt.addEventListener('scroll', updateFab, { passive: true });
    window.addEventListener('resize', updateFab, { passive: true });
    scrollCt._updateChatScrollFab = updateFab;
  }
  if (fabEl && scrollCt) {
    fabEl.onclick = () => { scrollCt.scrollTo({ top: scrollCt.scrollHeight, behavior: 'smooth' }); };
    if (typeof scrollCt._updateChatScrollFab === 'function') scrollCt._updateChatScrollFab();
  }
  // 消息操作 + 代码块操作（事件委托，适应流式重建）。
  // v3.16：6 操作 + 代码块复制/展开抽到 chat-view.js 的 wireChatActions（与 reader 抽屉共用），
  // 此处只注入 detail 侧的数据源/提示/重渲回调。
  wireChatActions(list, {
    paperId: p.id,
    getMsg: (mi) => (p.chat || [])[mi],
    getFreshChat: async () => p.chat || [],   // detail 直接读内存（reader 才需 GET 防滞后）
    notify: (m, isErr) => toast(m, isErr ? 'error' : undefined),
    isBusy: () => !!(chatState && chatState.busy),
    onRegenerate: () => doRegenerate(),
    onEdit: (msg, mi) => {
      // 编辑用户消息并重发：内容填回输入框，标记 editingMi，发送时截断其后历史
      input.value = msg.content || '';
      chatState.draft = input.value;
      chatState.editingMi = mi;
      // 沿用该 user 的 extraIds（编辑后重发保持引用）
      chatState.extraIds = Array.isArray(msg.extraIds) ? msg.extraIds.slice() : [];
      autoResizeInput(input);
      if (typeof renderExtraIdsRowSafe === 'function') renderExtraIdsRowSafe();
      input.focus();
      toast('编辑后按发送将重新回答（后续消息会被替换）', 'info');
    },
    onDelete: async (next) => {
      p.chat = next;
      await PATCH('/api/papers/' + p.id, { chat: p.chat });
      state.detail.chat = p.chat;
      renderDetail();
    },
  });
}

/** 从输入框发送（建议卡片 / 预置 / 重新生成 / 编辑用）。供外部引用 doSend 闭包——这里转发到模块级。
 *  注意：doSend 是 renderChatTab 内的闭包，无法外部调用；外部直接走独立的 doSendFromInput。 */
let doSendFromInput = null; // renderChatTab 内赋值

let renderExtraIdsRowSafe = null; // renderChatTab 内赋值（编辑 user 时刷新 chip 行）

/** 重新生成最后一条 assistant 回答：前端移除最后一轮 DOM + 调 doSend({regenerate})。 */
function doRegenerate() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  if (chatState && chatState.busy) { toast('请等当前回答完成', 'error'); return; }
  // 只移除 DOM 最后一条 assistant（保留 user 问题可见：重新生成期间用户仍看得到自己的问题；
  // 服务端会弹整轮重推 user+assistant，onDone 用权威 chat 替换 assistant 后索引自然对齐）。
  // 历史版本连 user 一起移除，但 onDone 只补 assistant → 问题从视图里消失直到下次全量刷新（bug）。
  const msgs = [...list.querySelectorAll('.chat-msg')];
  const lastAssistant = [...msgs].reverse().find((m) => m.classList.contains('assistant'));
  if (lastAssistant) lastAssistant.remove();
  // 触发 regenerate 发送（skipUserMsg：不重复追加 user，服务端从历史取）
  doSendFromInput && doSendFromInput({ regenerate: true, skipUserMsg: true });
}

/** 追加一条聊天消息到列表 DOM：用 elementId 实时重查目标节点（绝不用 stale 闭包引用），
 *  这样即便 renderDetail 重建了 #chat-list，仍能正确追加到当前可见节点。
 *  data-mi 标记当前条索引，供问答大纲点击跳转实时重查定位。全宽扁平结构。 */
function appendChatMsgById(elementId, m) {
  const list = document.getElementById(elementId);
  if (!list) return;
  // 清空态提示存在则移除（首条消息出现时）
  const empty = list.querySelector('.chat-empty');
  if (empty) empty.remove();
  const idx = list.querySelectorAll('.chat-msg').length;
  const html = chatMsgHtml(m, idx);
  list.insertAdjacentHTML('beforeend', html);
  // 滚动容器是外层 .detail-pane（.chat-list 自身不滚）。FAB 已移出 .chat-list，无需保留。
  scrollChatListToBottom();
}

/** 详情 AI tab 的「问答大纲」浮窗：列出每个用户提问（Q1/Q2…），点击实时重查 #chat-list 跳转到对应消息。
 *  条目数据从当前详情 p.chat 过滤 role==='user'；不持有 stale 节点引用——点击时 getElementById 重查。
 *  open 不传则切换显隐；传 true 强制开。
 *  v2.7 修复：浮窗 position:fixed 挂 body，锚定视口右上——不再随 detail-pane 滚动消失/跟随。 */
function toggleChatOutline(open) {
  const existing = document.querySelector('body > .chat-outline-pop');
  const mask = document.querySelector('body > .co-mask');
  // open === false（显式关）：无条件关闭，不创建。open === true（显式开）：仅在已关时创建。
  // open == null（toggle，按钮点击）：已开则关、未开则开。
  if (open === false) { if (existing) existing.remove(); if (mask) mask.remove(); return; }
  if (existing) {
    // 已开：除非显式 open === true，否则视为 toggle 的「关」分支
    if (open !== true) { existing.remove(); if (mask) mask.remove(); }
    return;
  }
  const p = state.detail;
  if (!p || !Array.isArray(p.chat)) return;
  // 条目：所有 user 消息（每对 Q&A 的「问题」），记录其在 chat 数组中的索引用于跳转
  const items = [];
  p.chat.forEach((m, i) => { if (m.role === 'user') items.push({ mi: i, q: (m.content || '').trim() }); });
  if (!items.length) { toast('还没有对话'); return; }

  // 浮窗结构
  const pop = document.createElement('div');
  pop.className = 'chat-outline-pop fixed';
  pop.innerHTML = `<div class="co-head">
    <span>问答大纲<span class="co-count"> · ${items.length} 个问题</span></span>
    <button class="co-close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg></button>
  </div><div class="co-list"></div>`;
  const coList = pop.querySelector('.co-list');
  items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'co-item';
    row.innerHTML = `<span class="co-q">Q${idx + 1}</span><span class="co-title"></span>`;
    row.querySelector('.co-title').textContent = truncateChatTitle(it.q); // textContent 防 XSS
    row.onclick = () => {
      // 实时重查列表与目标节点（renderDetail 可能已重建 #chat-list，绝不用 stale 引用）
      const list = document.getElementById('chat-list');
      const target = list && list.querySelector('.chat-msg[data-mi="' + it.mi + '"]');
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); // 重启动画
        setTimeout(() => target.classList.remove('flash'), 800);
      }
      toggleChatOutline(false); // 跳转后关浮窗
    };
    coList.appendChild(row);
  });
  pop.querySelector('.co-close').onclick = () => toggleChatOutline(false);
  // 全屏透明遮罩：点外部关闭（独立于 mask 点击，避免点浮窗自身时关掉）
  const m = document.createElement('div');
  m.className = 'co-mask';
  m.onclick = () => toggleChatOutline(false);

  document.body.appendChild(m);
  document.body.appendChild(pop);
}
