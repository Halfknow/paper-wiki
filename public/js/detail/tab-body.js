// tab 内容分派
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { renderMd } from '../core/markdown.js';
import { chatState, notesState, set_notesState, state } from '../core/state.js';
import { renderChatTab } from './chat-tab.js';
import { renderInfoTab } from './info-tab.js';
import { NotesPanel } from './notes-panel.js';

export function renderTabBody() {  const p = state.detail;
  const body = $('tab-body');
  // chat tab 特殊保护：流式中（busy）或用户正在输入框打字时，不重建（避免打断流式 + 抢焦点失焦）。
  const chatInput = document.getElementById('chat-input');
  const chatActive = state.tab === 'chat' && chatInput && document.body.contains(chatInput);
  const isTypingInChat = chatActive && (document.activeElement === chatInput || (chatState && chatState.draft));
  if (chatActive && ((chatState && chatState.busy) || isTypingInChat)) {
    // 流式中：确保 sendBtn 是「停止」
    if (chatState && chatState.busy) {
      const sb = document.getElementById('chat-send');
      if (sb && sb.textContent !== '停止') { sb.classList.add('danger'); sb.textContent = '停止'; sb.disabled = false; }
    }
    return; // 不重建，保留当前 DOM + 焦点 + 草稿
  }
  if (state.tab === 'summary') {
    body.innerHTML = `<div class="md">${renderMd(p.summary || '*（尚无总结，处理中或点击「重新总结」）*')}</div>
      <p class="save-hint" style="margin-top:18px;">由 ${escapeHtml(p.summaryModel || 'AI')} 生成${p.summaryAt ? ' · ' + new Date(p.summaryAt).toLocaleString() : ''}</p>`;
  } else if (state.tab === 'notes') {
    // AI 笔记卡片视图（NotesPanel）：qa/skeleton/manual 卡片流，数据存 papers.noteCards
    body.innerHTML = '<div class="notes-panel-host" id="notes-panel-host"></div>';
    const panel = new NotesPanel($('notes-panel-host'), { showGenerate: true });
    set_notesState({ id: p.id, panel });
    panel.load(p.id);
  } else if (state.tab === 'chat') {
    renderChatTab(body, p);
  } else if (state.tab === 'info') {
    renderInfoTab(body, p);
  }
}
