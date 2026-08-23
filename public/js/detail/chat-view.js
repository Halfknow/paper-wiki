// 聊天消息渲染 / 预置 / 模型选择 / @ 提及
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { api, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml, statusDot } from '../core/format.js';
import { renderChatMd, truncateChatTitle } from '../core/markdown.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { saveQaCardToNotes } from './detail.js';
import { NotesPanel } from './notes-panel.js';
import { showFormulas } from '../formulas/formulas.js';
import { refresh } from '../library/refresh.js';

/** 格式化消息时间戳：今天显 HH:mm，昨天显「昨天 HH:mm」，更早显 MM-DD HH:mm。 */
function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hh + ':' + mm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hh + ':' + mm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hh + ':' + mm;
}

/** AI 图标（角色标识用）+ 你/AI label。统一线性 SVG 风格。 */
export const CHAT_ROLE_ICO = {
  user: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  assistant: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
};

/** 操作按钮图标（线性 SVG，统一风格）：复制 / 重新生成 / 显示原文 / 编辑 / 删除。 */
const CHAT_COPY_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

const CHAT_REGEN_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';

const CHAT_SOURCE_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';

const CHAT_EDIT_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

const CHAT_DELETE_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const CHAT_NOTE_ICO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

/** 把引用论文 id 渲染成只读 chip 行（历史消息回显：显示「这条问题引用了哪些论文」）。
 *  titles 从 state.papers 查；查不到的用 id 兜底。只读（无 ×），区别于输入框的可移除 chip。 */
function extraChipsReadonlyHtml(extraIds) {
  const ids = Array.isArray(extraIds) ? extraIds : [];
  if (!ids.length) return '';
  const chips = ids.map((id) => {
    const pp = (state.papers || []).find((x) => x.id === id);
    const title = (pp && pp.title) || id;
    return `<span class="extra-chip readonly" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escapeHtml(truncateChatTitle(title, 18))}</span>`;
  }).join('');
  return `<div class="chat-extra-row">${chips}</div>`;
}

/** 单条聊天消息 HTML（现代气泡风格：头像 + 气泡 + meta 行 + 内联操作条）。
 *  - user 右对齐（accent-soft 气泡）/ assistant 左对齐（白底卡片气泡 + 渐变圆形头像）。
 *  - assistant 内容走 renderChatMd（markdown/公式 + 代码块强化），user 走 escapeHtml + 换行保留。
 *  - 内联操作条（hover 显示，气泡下方）：assistant = 复制 / 重新生成(末条) / 显示原文 / 删除；user = 编辑 / 删除。
 *  - assistant 支持显示原文切换：data-show-source 标记。
 *  - user 若带 extraIds（@ 引用）或 images（Phase 3 附图），在气泡内顶部渲染。
 *  - meta 行：时间戳 + 模型徽章（assistant，可选 m.model）。 */
export function chatMsgHtml(m, i, opts) {
  opts = opts || {};
  const role = m.role || 'assistant';
  const rawContent = m.content || '';
  const content = role === 'assistant' ? renderChatMd(rawContent, { final: true }) : escapeHtml(rawContent).replace(/\n/g, '<br/>');
  // 原始 Markdown（显示原文态用）：等宽 <pre>，转义防渲染
  const rawHtml = role === 'assistant' ? '<pre class="chat-raw">' + escapeHtml(rawContent) + '</pre>' : '';
  // 附图缩略图（Phase 3 视觉问答；user 消息回显）
  const imagesHtml = role === 'user' && Array.isArray(m.images) && m.images.length
    ? '<div class="chat-images">' + m.images.map((src) => `<img class="chat-image-thumb" src="${escapeHtml(src)}" alt="附图" loading="lazy" />`).join('') + '</div>'
    : '';
  // 内联操作条（气泡下方，hover 显示）
  let actionsHtml = '';
  if (role === 'assistant') {
    const acts = [`<button class="chat-act" data-act="copy" data-mi="${i}" title="复制">${CHAT_COPY_ICO}</button>`];
    acts.push(`<button class="chat-act" data-act="note" data-mi="${i}" title="存入笔记">${CHAT_NOTE_ICO}</button>`);
    if (opts.regenerable) acts.push(`<button class="chat-act" data-act="regen" data-mi="${i}" title="重新生成">${CHAT_REGEN_ICO}</button>`);
    acts.push(`<button class="chat-act" data-act="source" data-mi="${i}" title="显示原文">${CHAT_SOURCE_ICO}</button>`);
    acts.push(`<button class="chat-act danger" data-act="delete" data-mi="${i}" title="删除">${CHAT_DELETE_ICO}</button>`);
    actionsHtml = `<div class="chat-actions">${acts.join('')}</div>`;
  } else {
    actionsHtml = `<div class="chat-actions"><button class="chat-act" data-act="edit" data-mi="${i}" title="编辑并重发">${CHAT_EDIT_ICO}</button><button class="chat-act danger" data-act="delete" data-mi="${i}" title="删除">${CHAT_DELETE_ICO}</button></div>`;
  }
  // meta 行（时间戳 + 模型徽章）
  const showMeta = m.ts || (role === 'assistant' && m.model);
  const metaHtml = showMeta
    ? `${m.ts ? `<span class="chat-time">${formatChatTime(m.ts)}</span>` : ''}${role === 'assistant' && m.model ? `<span class="chat-model-badge" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>` : ''}`
    : '';
  // 气泡 + 底部行外面套一层 .chat-stack（收缩包裹）：底部行 width:100% 撑的是这一层，
  // 而这一层的宽度等于气泡宽度，于是时间戳的左缘 = 气泡左缘。
  // 没有这层时 .chat-foot 会撑满整个 .chat-body，我方（右对齐）消息的时间戳就被甩到最左。
  // 底部行：时间戳/徽章 在左，操作按钮 在右同行（旧实现把二者分两行堆叠，占纵向空间且按钮不易发现）。
  // 始终渲染该行（即便无 meta，user 也要靠它放 edit/delete 按钮）。
  const footHtml = `<div class="chat-foot">${metaHtml}<span class="chat-foot-spacer"></span>${actionsHtml}</div>`;
  const extraRow = role === 'user' && m.extraIds && m.extraIds.length ? extraChipsReadonlyHtml(m.extraIds) : '';
  return `<div class="chat-msg ${role}" data-mi="${i}">
    <div class="chat-role"><span class="chat-role-ico">${CHAT_ROLE_ICO[role] || CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">${role === 'user' ? '你' : 'AI'}</span></div>
    <div class="chat-body">${extraRow}<div class="chat-stack"><div class="chat-bubble">${imagesHtml}<div class="chat-content">${content}</div></div>${rawHtml ? `<div class="chat-raw-wrap" hidden>${rawHtml}</div>` : ''}${footHtml}</div></div>
  </div>`;
}

/** 空状态：大渐变图标 + 标题 + 副标题 + 2×2 建议卡片网格 + 快捷键提示。
 *  CHAT_SUGGESTIONS 取自 DEFAULT_CHAT_PRESETS 的 prompt（下方预置段定义）。 */
export function chatEmptyHtml() {
  const presets = getChatPresets();
  const chips = presets.slice(0, 4).map((pr) => `<button class="chat-suggest" data-q="${escapeHtml(pr.prompt)}"><span class="chat-suggest-text">${escapeHtml(pr.label)}</span><svg class="chat-suggest-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`).join('');
  return `<div class="chat-empty">
    <div class="chat-empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>
    <div class="chat-empty-title">开始与 AI 探讨这篇论文</div>
    <div class="chat-empty-hint">基于全文的多轮问答 · 支持公式 / 代码 / 思考过程</div>
    <div class="chat-empty-grid">${chips}</div>
    <div class="chat-empty-tip">输入 <kbd>@</kbd> 可引用其它论文联合提问</div>
  </div>`;
}

/** 聊天预置快捷提问（输入框上方按钮）。结构 {label, prompt}。
 *  内置默认 4 条；store.settings.chatPresets（用户自定义）覆盖。getChatPresets() 合并两者。
 *  CHAT_SUGGESTIONS 保留为向后兼容（reader.js 旧引用），现取自预置的 prompt。 */
const DEFAULT_CHAT_PRESETS = [
  { label: '核心方法', prompt: '这篇论文的核心方法是什么？' },
  { label: '创新点', prompt: '这篇论文有什么创新点和贡献？' },
  { label: '实验结果', prompt: '实验结果如何？相比 baseline 提升多少？' },
  { label: '一句话总结', prompt: '请用一句话总结这篇论文。' },
];

export let chatPresetsOverride = null; // 由 GET /api/settings 拉取的 store.settings.chatPresets（null=未拉取用默认）

export function getChatPresets() {
  return (Array.isArray(chatPresetsOverride) && chatPresetsOverride.length) ? chatPresetsOverride : DEFAULT_CHAT_PRESETS;
}

/** Phase 2 模型切换器：可用模型列表（GET /api/ai/models 缓存）。
 *  state.aiModels = { models: [{id,owned_by}], default, current, source }
 *  用户选择存 localStorage('pw-chat-model')，空串/不存在=用默认。
 *  getSelectedModel() 返回当前选中（默认时返回 ''，后端回退 config.ai.model）。 */
export async function loadAiModels() {
  try {
    const r = await fetch(sp('/api/ai/models')).then((r) => r.json());
    // 后端 ok() 包装为 {ok:true, data:{models,default,current,source}}；兼容裸返回
    const d = r && r.ok && r.data ? r.data : r;
    if (d && Array.isArray(d.models)) {
      state.aiModels = { models: d.models, default: d.default, current: d.current, source: d.source };
    } else {
      state.aiModels = { models: [], default: (d && d.default) || '默认模型', current: (d && d.current) || '', source: 'config' };
    }
  } catch {
    state.aiModels = state.aiModels || { models: [], default: '默认模型', current: '', source: 'config' };
  }
  // 同步刷新所有可见的模型按钮文案 + reader 抽屉徽章
  const def = (state.aiModels && state.aiModels.default) || '默认模型';
  const shown = getSelectedModel() || def;
  document.querySelectorAll('.chat-model-btn .cm-name').forEach((el) => { el.textContent = shown; });
  document.querySelectorAll('.rcd-model-pill').forEach((el) => { el.textContent = shown; el.title = shown; });
}

export function getSelectedModel() {
  const m = localStorage.getItem('pw-chat-model') || '';
  // 校验仍在可用列表中（用户切换空间/配置后可能失效），失效则清空回默认
  if (m && state.aiModels && Array.isArray(state.aiModels.models)) {
    if (!state.aiModels.models.some((x) => x.id === m)) {
      localStorage.removeItem('pw-chat-model');
      return '';
    }
  }
  return m;
}

/** token 数 → 紧凑显示（128000→128K、1000000→1M、32000→32K）。供模型切换器展示上下文窗口。 */
function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1000000) {
    const m = v / 1000000;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M';
  }
  return Math.round(v / 1000) + 'K';
}

/** 模型切换下拉（详情 tab + reader 抽屉共用，锚定到触发按钮上方）。
 *  window.toggleModelSwitcher 暴露给 reader.js 复用。 */
export function toggleModelSwitcher(btn) {
  if (!btn) return;
  const existing = document.querySelector('.chat-model-pop');
  if (existing) { existing.remove(); return; } // 再次点击 = 关闭
  const models = (state.aiModels && state.aiModels.models) || [];
  const selected = getSelectedModel();
  const def = (state.aiModels && state.aiModels.default) || '';
  if (!models.length) { toast('暂无可用模型列表（检查 AI 接口配置）', 'info'); return; }
  const pop = document.createElement('div');
  pop.className = 'chat-model-pop';
  pop.innerHTML = '<div class="cmp-head"><span>选择模型</span><button class="cmp-close" type="button" aria-label="关闭">×</button></div>' +
    '<div class="cmp-list">' +
    models.map((m) => {
      const isSel = (m.id === selected) || (!selected && m.id === def);
      const tag = m.id === def ? '<span class="cmp-tag">默认</span>' : '';
      // contextLength 徽标（网关返回才显示，OpenAI 原生 /v1/models 不返回此字段）
      const ctx = m.contextLength ? `<span class="cmp-ctx" title="${m.contextLength} tokens 上下文">${formatTokens(m.contextLength)}</span>` : '';
      return `<button class="cmp-item${isSel ? ' active' : ''}" data-model="${escapeHtml(m.id)}" type="button"><span class="cmp-id"></span>${tag}${ctx}</button>`;
    }).join('') +
    '</div>';
  document.body.appendChild(pop);
  // 文本注入（防 XSS：用 textContent 而非 innerHTML）
  pop.querySelectorAll('.cmp-item').forEach((it) => { const id = it.dataset.model; const span = it.querySelector('.cmp-id'); if (span) span.textContent = id; });
  // 定位：锚定到按钮上方
  const rect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.top - popRect.height - 6;
  if (top < 8) top = rect.bottom + 6; // 上方空间不足放下方
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.left)) + 'px';
  // 选项点击：写入 localStorage + 刷新所有按钮文案 + 关闭
  pop.querySelectorAll('.cmp-item').forEach((it) => {
    it.onclick = (e) => {
      e.stopPropagation();
      const id = it.dataset.model;
      if (id === def) localStorage.removeItem('pw-chat-model'); // 选默认 = 清空覆盖
      else localStorage.setItem('pw-chat-model', id);
      document.querySelectorAll('.chat-model-btn .cm-name').forEach((el) => {
        el.textContent = getSelectedModel() || def || '默认模型';
      });
      // reader 抽屉头部模型徽章同步
      document.querySelectorAll('.rcd-model-pill').forEach((el) => {
        const m = getSelectedModel() || def || '';
        el.textContent = m; el.title = m;
      });
      pop.remove();
      toast(id === def ? '已切回默认模型' : `已切换到 ${id}`, 'info');
    };
  });
  pop.querySelector('.cmp-close').onclick = () => pop.remove();
  // 点外部关闭
  setTimeout(() => {
    const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { pop.remove(); document.removeEventListener('click', onDoc); } };
    document.addEventListener('click', onDoc);
  }, 0);
}

// v3.16：reader.js 改为直接 import 本模块的 toggleModelSwitcher/getSelectedModel/
// loadAiModels，window 桥暴露块已退役删除。（app.js 走 import；state 经 reader import）

// 向后兼容：旧 CHAT_SUGGESTIONS（reader.js 空状态卡片用）改为从预置取 prompt
const CHAT_SUGGESTIONS = DEFAULT_CHAT_PRESETS.map((x) => x.prompt);

/** 模型参数定义（浮层用）：key / 显示名 / 类型（range滑块 / number数字 / toggle开关）/ 默认值。
 *  thinking（GLM 协议，对象 {type:enabled|disabled}）：纯开关，不传时 GLM-5.2/5/4.6 默认开启思考，
 *  故必须显式发 disabled 才能真正停思考——开关「关」即发 disabled。
 *  def='enabled' 让首次使用默认开启（与 GLM 官方默认一致，思考过程对论文问答有价值）。 */
export const CHAT_PARAM_FIELDS = [
  { key: 'thinking', label: '深度思考', kind: 'toggle', def: 'enabled' },
  { key: 'temperature', label: '温度', kind: 'range', min: 0, max: 2, step: 0.1, def: '' },
  { key: 'topP', label: 'Top-P', kind: 'range', min: 0, max: 1, step: 0.05, def: '' },
  { key: 'maxTokens', label: '最大 token', kind: 'number', min: 0, step: 256, def: '' },
];

/** morphing 发送键：busy 时变为红色方块停止按钮，否则圆角发送箭头（SVG/title/aria 全同）。
 *  详情 tab（setBusyUI）与 reader 抽屉（setSending）共用——历史两份逐字重复。只改 btn，
 *  input 的禁用由调用方各自处理（detail 在此禁；reader 在 sendChat 单独管）。 */
export function applySendingUi(btn, busy) {
  if (!btn) return;
  btn.disabled = false;
  btn.classList.toggle('sending', !!busy);
  btn.title = busy ? '停止生成' : '发送（Enter）';
  btn.setAttribute('aria-label', busy ? '停止生成' : '发送');
  btn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
}

/** textarea 自适应高度。minH/maxH 参数化（detail: 38/142；reader: 按行 1~8 行≈21~186）。
 *  disabled 时跳过；onResize 回调在重排后触发（reader 用它联动 updateSendEnabled）。 */
export function autoResizeInput(el, { minH = 38, maxH = 142, onResize } = {}) {
  if (!el || el.disabled) return;
  el.style.height = minH + 'px';
  el.style.height = Math.min(maxH, el.scrollHeight) + 'px';
  if (typeof onResize === 'function') onResize();
}

/** 发送键启用判定：输入空（且无 allowSend 旁路）时禁用。
 *  allowSend 用于 reader 的「有引用 badge / 附图时空输入也允许发送」。 */
export function updateSendEnabled(sb, ip, { busy, allowSend } = {}) {
  if (!sb || busy) return;
  const empty = !(ip && (ip.value || '').trim()) && !allowSend;
  sb.disabled = empty;
}

/** dataURL 图片长边 > maxEdge 时按比例缩到 maxEdge（PNG 重编码），否则原样返回。
 *  防系统截图分辨率过高导致 base64 撑大 papers.json（对齐 OpenAI 视觉建议 1568px）。
 *  v3.16：reader 抽屉与详情 tab 视觉问答共用——原 reader.js 独有，现抽到此。 */
export function compressImageDataUrl(dataURL, maxEdge) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) <= maxEdge) return resolve(dataURL); // 无需压缩
      const k = maxEdge / Math.max(w, h);
      const outW = Math.round(w * k), outH = Math.round(h * k);
      const c = document.createElement('canvas');
      c.width = outW; c.height = outH;
      c.getContext('2d').drawImage(img, 0, 0, outW, outH);
      try { resolve(c.toDataURL('image/png')); } catch { resolve(dataURL); }
    };
    img.onerror = () => resolve(dataURL); // 解码失败原样返回
    img.src = dataURL;
  });
}

/** 把 File/Blob 转 dataURL（长边限 1568 压缩）。视觉问答图片入口共用。 */
export function fileToCompressedDataURL(file, maxEdge = 1568) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataURL = String(fr.result || '');
      if (!dataURL) return resolve('');
      compressImageDataUrl(dataURL, maxEdge).then(resolve);
    };
    fr.onerror = () => resolve('');
    fr.readAsDataURL(file);
  });
}

/** 读取聊天模型参数（从 localStorage）。仅返回 enabled=true 且有值的字段（后端只收启用的）。
 *  存储结构 chatParams = { thinking:{enabled,val}, temperature:{...}, ... }；向后兼容旧扁平结构。 */
export function getChatParams() {
  const raw = {};
  try { Object.assign(raw, JSON.parse(localStorage.getItem('chatParams') || '{}')); } catch {}
  const p = {};
  for (const f of CHAT_PARAM_FIELDS) {
    // toggle（如 thinking）：开关开=enabled，关=disabled，始终返回（GLM 默认开启，必须显式 disabled 才停）
    if (f.kind === 'toggle') {
      const cell = raw[f.key];
      const enabled = cell && typeof cell === 'object' ? !!cell.enabled : cell != null && cell !== '';
      p[f.key] = enabled ? 'enabled' : 'disabled';
      continue;
    }
    const cell = raw[f.key];
    // 兼容旧扁平：raw.temperature 是值字符串 → 视为启用
    const enabled = cell && typeof cell === 'object' ? !!cell.enabled : cell != null && cell !== '';
    const val = cell && typeof cell === 'object' ? cell.val : cell;
    if (!enabled) continue;
    // val 为空但有 def → 启用即用默认值发送，无需手动拨滑块
    const resolved = (val == null || val === '') ? (f.def !== '' && f.def != null ? f.def : '') : val;
    if (resolved === '' || resolved == null) continue;
    const num = f.kind === 'number' ? parseInt(resolved, 10) : Number(resolved);
    if (!Number.isFinite(num)) continue;
    if (f.key === 'maxTokens' && num <= 0) continue;
    p[f.key] = num;
  }
  return p;
}

/** 统计已启用的参数数量（浮层按钮徽章用）。toggle 类型（如 thinking）始终有值，不计入——
 *  否则徽章会永远显示。徽章只反映「用户主动启用的可调参数」（温度/Top-P/maxTokens）。 */
function countChatParams() {
  const p = getChatParams();
  let n = 0;
  for (const f of CHAT_PARAM_FIELDS) if (f.kind !== 'toggle' && p[f.key] != null) n++;
  return n;
}

/** 接线参数浮层（按钮徽章 + 浮层内每参数：启用开关 + 滑块/数字 + 值 badge）。
 *  shellId 参数浮层根 id；btnId 触发按钮 id。reader.js 复用时传不同 id。 */
export function wireChatParamsShell(shellId, btnId) {
  const shell = document.getElementById(shellId);
  const btn = document.getElementById(btnId);
  if (!shell || !btn) return;
  const raw = {};
  try { Object.assign(raw, JSON.parse(localStorage.getItem('chatParams') || '{}')); } catch {}
  // 兼容旧扁平 → 规整为 {enabled,val}。toggle（thinking）特殊：def='enabled' 作 enabled 默认
  const norm = {};
  for (const f of CHAT_PARAM_FIELDS) {
    const cell = raw[f.key];
    if (f.kind === 'toggle') {
      // toggle：enabled 即取值（开/关），无独立 val。旧数据若是数值型 thinking（0–1），>0 视为开
      let en;
      if (cell && typeof cell === 'object') en = !!cell.enabled;
      else if (cell != null && cell !== '') en = !(cell === 0 || cell === '0' || cell === 'disabled');
      else en = f.def === 'enabled';
      norm[f.key] = { enabled: en, val: f.def };
    } else if (cell && typeof cell === 'object') {
      norm[f.key] = { enabled: !!cell.enabled, val: cell.val != null ? cell.val : f.def };
    } else {
      norm[f.key] = { enabled: cell != null && cell !== '', val: cell != null && cell !== '' ? cell : f.def };
    }
  }
  const updateBadge = () => {
    const b = btn.querySelector('.cp-badge');
    const n = countChatParams();
    if (b) { b.textContent = n || ''; b.style.display = n ? '' : 'none'; }
  };
  const saveAll = () => {
    const out = {};
    for (const f of CHAT_PARAM_FIELDS) out[f.key] = norm[f.key];
    localStorage.setItem('chatParams', JSON.stringify(out));
    updateBadge();
  };
  // 浮层内渲染每参数卡片
  for (const f of CHAT_PARAM_FIELDS) {
    const card = shell.querySelector('[data-key="' + f.key + '"]');
    if (!card) continue;
    const sw = card.querySelector('.pp-switch');
    const inp = card.querySelector('.pp-in');
    const valEl = card.querySelector('.pp-val');
    const refresh = () => {
      const en = norm[f.key].enabled;
      card.classList.toggle('on', en);
      if (sw) sw.checked = en;
      if (f.kind === 'toggle') {
        // toggle：只显示「开启/关闭」状态文案
        if (valEl) valEl.textContent = en ? '开启' : '关闭';
        return;
      }
      if (inp) inp.value = norm[f.key].val != null ? norm[f.key].val : f.def;
      if (valEl) {
        const v = norm[f.key].val != null && norm[f.key].val !== '' ? norm[f.key].val : f.def;
        valEl.textContent = (v != null && v !== '') ? v : '默认';
      }
      if (inp) inp.disabled = !en;
    };
    refresh();
    if (sw) sw.onchange = () => { norm[f.key].enabled = sw.checked; refresh(); saveAll(); };
    if (inp) inp.oninput = () => {
      norm[f.key].val = inp.value;
      if (valEl) valEl.textContent = inp.value || '默认';
      saveAll();
    };
  }
  updateBadge();
}

/** @ 引用论文搜索：基于 state.papers（summaryView 列表）客户端多字段匹配。
 *  - 匹配维度：标题（最高分）/ 作者 / 年份 / 标签 / 主题；token 级「每个 query 词都命中」加权。
 *  - excludeId 排除当前论文（不@自己）；已选 ids 排重（避免重复 @）。
 *  - 空 query：返回最近添加的论文（按 addedAt 倒序），让用户开 @ 就能看到候选。
 *  - 限 10 条。返回 {id,title,authors,year,status,tags,topics} 供浮层渲染。
 *  供输入框 @ 触发器 + reader.js（经 window 桥）复用。 */
export function searchPapersForMention(query, excludeId, selectedIds) {
  const q = String(query || '').trim().toLowerCase();
  const sel = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
  const list = (state.papers || []).filter((x) => x.id !== excludeId && !(sel && sel.has(x.id)));
  const proj = (x) => ({
    id: x.id,
    // title 兜底链与主列表一致：无元数据的论文用文件名（去 .pdf），绝不落到裸 id
    title: x.title || String(x.filename || '').replace(/\.pdf$/i, ''),
    authors: Array.isArray(x.authors) ? x.authors.join(', ') : (x.authors || ''),
    year: x.year,
    status: x.status, tags: Array.isArray(x.tags) ? x.tags.slice(0, 3) : [], topics: x.topics,
  });
  // 空 query：最近添加（addedAt 倒序），让用户开 @ 就有候选
  if (!q) {
    return list
      .slice()
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, 10)
      .map(proj);
  }
  // 拆 token：每个 token 都须在任一字段命中（AND 语义，更精准）
  const tokens = q.split(/\s+/).filter(Boolean);
  const fieldOf = (x) => {
    const t = String(x.title || x.filename || '').toLowerCase(); // 无标题论文按文件名搜
    const a = String(x.authors || '').toLowerCase();
    const y = String(x.year || '');
    const tags = (Array.isArray(x.tags) ? x.tags : []).join(' ').toLowerCase();
    const topics = (Array.isArray(x.topics) ? x.topics : []).join(' ').toLowerCase();
    return { t, a, y, tags, topics };
  };
  const scored = list
    .map((x) => {
      const f = fieldOf(x);
      let score = 0;
      for (const tk of tokens) {
        let hit = false;
        if (f.t.includes(tk)) { score += f.t.startsWith(tk) ? 10 : 6; hit = true; }
        if (f.a.includes(tk)) { score += 3; hit = true; }
        if (f.tags.includes(tk)) { score += 2; hit = true; }
        if (f.topics.includes(tk)) { score += 2; hit = true; }
        if (f.y.includes(tk)) { score += 1; hit = true; }
        if (!hit) return { x, score: -1 }; // 该 token 未命中 → 整体淘汰
      }
      return { x, score };
    })
    .filter((r) => r.score >= 0)
    .sort((m, n) => n.score - m.score)
    .slice(0, 10)
    .map((r) => proj(r.x));
  return scored;
}

/** ===== @ 引用论文选择浮层（详情 tab + reader 抽屉共用）=====
 *  现代化版（v2.7）：body 级 position:fixed 浮层，锚定到 textarea 上方；
 *  实时随输入筛选（每次 input 触发重建列表）；↑↓ 键盘导航 + Enter 选中 + Esc 关闭；
 *  匹配标题高亮；状态点 + 标签 chip；空结果提示。
 *
 *  单例：全局只有一个 .chat-mention-pop（挂在 body）。openChatMentionPicker 再次调用 = 刷新内容。
 *  closeChatMentionPicker() 关闭。reader.js 经 window 桥复用。
 *
 *  参数：
 *    inputEl   —— 触发的 textarea（用于定位 + 读光标位置 + 选中后删 @query 文本）
 *    ctx       —— { excludeId, selectedIds, onPick(id) }
 *    query     —— @ 后已输入的筛选词（空 = 显示最近）
 *    atIdx     —— @ 在输入框文本中的索引（选中后从这里截断到光标） */
let _mentionPop = null;     // 当前浮层 DOM

let _mentionItems = [];     // 当前列表项数据 [{id,title,...}]

let _mentionActive = 0;     // 当前高亮项下标

let _mentionCtx = null;     // 当前 onPick 回调等上下文

function highlightMatch(text, query) {
  const esc = escapeHtml(text || '');
  const q = String(query || '').trim();
  if (!q) return esc;
  // 转义 query 后按 token 拆，逐个用 <mark> 包裹（大小写不敏感）
  const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!tokens.length) return esc;
  const re = new RegExp('(' + tokens.join('|') + ')', 'gi');
  // 先在原文上标记，再整体转义（避免转义后字串被当成正则）
  return esc.replace(re, '<mark>$1</mark>');
}

function mentionItemHtml(r, idx, active, query) {
  const cls = 'cm-item' + (active ? ' active' : '');
  const dotCls = r.status ? statusDot(r) : '';
  const dotHtml = r.status ? `<span class="cm-dot ${dotCls}" title="${escapeHtml(r.status)}"></span>` : '';
  const meta = [];
  if (r.authors) meta.push(escapeHtml(truncateChatTitle(r.authors, 22)));
  if (r.year) meta.push(escapeHtml(String(r.year)));
  const metaHtml = meta.length ? `<span class="cm-meta">${meta.join(' · ')}</span>` : '';
  const tagsHtml = (r.tags && r.tags.length)
    ? `<span class="cm-tags">${r.tags.slice(0, 3).map((t) => `<span class="cm-tag">${escapeHtml(t)}</span>`).join('')}</span>`
    : '';
  return `<div class="${cls}" data-idx="${idx}" role="option"><div class="cm-row1">${dotHtml}<span class="cm-title">${highlightMatch(r.title || r.id, query)}</span></div><div class="cm-row2">${metaHtml}${tagsHtml}</div></div>`;
}

function renderMentionList(query) {
  if (!_mentionPop) return;
  const list = _mentionPop.querySelector('.cm-list');
  if (!list) return;
  if (!_mentionItems.length) {
    list.innerHTML = '<div class="cm-empty">' + (query ? '没有匹配的论文' : '没有可引用的论文') + '</div>';
    const f = _mentionPop.querySelector('.cm-foot'); if (f) f.style.display = 'none';
    return;
  }
  list.innerHTML = _mentionItems.map((r, i) => mentionItemHtml(r, i, i === _mentionActive, query)).join('');
  const f = _mentionPop.querySelector('.cm-foot'); if (f) { f.style.display = ''; const c = f.querySelector('.cm-count'); if (c) c.textContent = _mentionItems.length; }
  // 滚动让 active 可见
  const activeEl = list.children[_mentionActive];
  if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
}

function positionMentionPop(inputEl) {
  if (!_mentionPop) return;
  const r = inputEl.getBoundingClientRect();
  const popH = _mentionPop.offsetHeight || 320;
  const gap = 6;
  let top = r.top - popH - gap;
  if (top < 8) top = r.bottom + gap; // 上方空间不足 → 放下方
  _mentionPop.style.top = top + 'px';
  // 左对齐 textarea，但不超过视口右边界
  const w = Math.min(380, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  _mentionPop.style.left = left + 'px';
  _mentionPop.style.width = Math.max(280, Math.min(w, r.width + 40)) + 'px';
}

/** @ 引用触发检测：从光标位置向前找最近的 @，满足触发条件则打开浮层，否则关闭。
 *  详情 tab（chat-tab.js）与 reader 抽屉（reader.js）共用——历史两边各写一份 5 步检测，
 *  仅 onPick 主体（写哪个 state）不同，故抽到此处参数化。ctx = { excludeId, selectedIds, onPick }。
 *  触发条件：光标前存在 @，且 @ 前一字符为空白/行首；@ 后到光标的 query 无换行且 ≤40 字符。 */
export function handleMentionTrigger(inputEl, ctx) {
  if (!inputEl) { closeChatMentionPicker(); return; }
  const val = inputEl.value;
  const pos = inputEl.selectionStart != null ? inputEl.selectionStart : val.length;
  const before = val.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx < 0) { closeChatMentionPicker(); return; }
  const charBefore = atIdx > 0 ? before[atIdx - 1] : ' ';
  if (charBefore && !/\s/.test(charBefore)) { closeChatMentionPicker(); return; }
  const query = before.slice(atIdx + 1);
  if (query.includes('\n') || query.length > 40) { closeChatMentionPicker(); return; }
  openChatMentionPicker(inputEl, ctx || {}, query, atIdx);
}

/** 接线聊天消息列表的操作（代码块复制/展开 + 消息 copy/note/regen/source/edit/delete）。
 *  详情 tab 与 reader 抽屉共用——历史上两边各写一份 ~65 行 click 委托，仅数据源/提示组件/重渲入口不同，
 *  故抽到此参数化。完全相同的 cb-copy/cb-expand/source 直接合一；其余走回调解耦：
 *    getMsg(mi)              同步取消息对象（detail: p.chat[mi]; reader: this.paper.chat[mi]）
 *    getFreshChat()          async 取鲜活 chat 数组（note 用——detail 同步返 p.chat; reader 多 GET 一次防滞后）
 *    getCopyText(mi, act)    同步取复制文本（默认 getMsg(mi).content；reader 走 DOM textContent 防 this.paper.chat 为空）
 *    notify(msg, isError)    提示（detail: toast; reader: this.setStatus）
 *    isBusy()                是否流式中（detail: chatState.busy; reader: this._chatBusy）
 *    onRegenerate()          重新生成末条（各自调自己的 send 闭包）
 *    onEdit(msg, mi)         编辑 user 重发（各自设 editingMi 标记 + 截断）
 *    onDelete(nextChat)      async 持久化 + 重渲（detail: PATCH+renderDetail; reader: fetch+renderChatList）
 *    paperId                 论文 id（note/delete 拼 URL）
 *  注意：调用方负责守卫「只绑定一次」（reader 用 dataset.wired；detail 的 list 每次 renderChatTab 重建天然单次）。 */
export function wireChatActions(list, opts) {
  const {
    getMsg, getFreshChat, getCopyText, notify, isBusy,
    onRegenerate, onEdit, onDelete, onNoteResult, paperId,
  } = opts || {};
  const notifyFn = notify || ((m, isErr) => toast(m, isErr ? 'error' : undefined));
  const isBusyFn = isBusy || (() => false);
  list.addEventListener('click', async (e) => {
    // —— 代码块复制 / 展开 ——（两入口完全一致）
    const cbCopy = e.target.closest('.cb-copy');
    if (cbCopy) {
      const card = cbCopy.closest('.cb-card');
      const pre = card && card.querySelector('pre');
      const text = pre ? pre.textContent : '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => {
        cbCopy.classList.add('copied');
        const sp = cbCopy.querySelector('span'); if (sp) sp.textContent = '已复制';
        setTimeout(() => { cbCopy.classList.remove('copied'); const sp2 = cbCopy.querySelector('span'); if (sp2) sp2.textContent = '复制'; }, 1200);
      }).catch(() => notifyFn('复制失败', true));
      return;
    }
    const cbExp = e.target.closest('.cb-expand');
    if (cbExp) { const card = cbExp.closest('.cb-card'); if (card) card.classList.remove('collapsed'); return; }
    // —— 消息操作 ——
    const act = e.target.closest('.chat-act');
    if (!act) return;
    const mi = Number(act.dataset.mi);
    if (act.dataset.act === 'copy') {
      const text = typeof getCopyText === 'function'
        ? getCopyText(mi, act)
        : (() => { const m = getMsg ? getMsg(mi) : null; return m ? (m.content || '') : ''; })();
      if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(() => notifyFn('已复制')).catch(() => notifyFn('复制失败', true));
      else if (!navigator.clipboard) notifyFn('剪贴板不可用', true);
    } else if (act.dataset.act === 'note') {
      // 存入笔记：该回答 + 前溯最近 user 作问题 → 问答卡（拷贝语义，删聊天不删卡）。
      // saveQaCardToNotes 内部已弹 toast（成功/失败），detail 侧无需再 notify；
      // reader 侧若想额外更新抽屉状态栏，经 onNoteResult 回调（可选）。
      try {
        const chat = getFreshChat ? await getFreshChat() : null;
        const msg = chat && chat[mi];
        if (!msg) { notifyFn('消息不存在', true); return; }
        let q = '';
        for (let k = mi - 1; k >= 0; k--) {
          if (chat[k] && chat[k].role === 'user') { q = chat[k].content || ''; break; }
        }
        const ok = paperId ? await saveQaCardToNotes(paperId, { question: q, answer: msg.content || '', mi }) : false;
        if (typeof onNoteResult === 'function') onNoteResult(ok);
      } catch { notifyFn('存入笔记失败', true); }
    } else if (act.dataset.act === 'regen') {
      if (isBusyFn()) { notifyFn('请等当前回答完成', true); return; }
      if (typeof onRegenerate === 'function') onRegenerate();
    } else if (act.dataset.act === 'source') {
      // 切换显示原文 ⇄ 渲染态（两入口完全一致）
      const node = act.closest('.chat-msg');
      if (!node) return;
      const isRaw = node.getAttribute('data-show-source') === '1';
      node.setAttribute('data-show-source', isRaw ? '0' : '1');
      act.title = isRaw ? '显示原文' : '显示渲染';
    } else if (act.dataset.act === 'edit') {
      const msg = getMsg ? getMsg(mi) : null;
      if (!msg) return;
      if (isBusyFn()) { notifyFn('请等当前回答完成', true); return; }
      if (typeof onEdit === 'function') onEdit(msg, mi);
    } else if (act.dataset.act === 'delete') {
      const msg = getMsg ? getMsg(mi) : null;
      if (!msg) return;
      if (isBusyFn()) { notifyFn('请等当前回答完成', true); return; }
      // 取当前 chat 数组：detail 同步返 p.chat（零成本）；reader 本就 GET 鲜活
      const cur = getFreshChat ? await getFreshChat() : [];
      const cut = [mi];
      if (msg.role === 'user' && cur[mi + 1] && cur[mi + 1].role === 'assistant') cut.push(mi + 1);
      if (!(await PWDialog.confirm('删除这条消息？' + (cut.length > 1 ? '（及其回复也会删除）' : ''), { title: '删除消息', danger: true, okText: '删除' }))) return;
      const next = cur.filter((_, idx) => !cut.includes(idx));
      if (typeof onDelete === 'function') await onDelete(next);
    }
  });
}

export function openChatMentionPicker(inputEl, ctx, query, atIdx) {
  _mentionCtx = ctx || {};
  const results = searchPapersForMention(query, ctx.excludeId, ctx.selectedIds);
  _mentionItems = results;
  _mentionActive = 0;
  if (!_mentionPop) {
    _mentionPop = document.createElement('div');
    _mentionPop.className = 'chat-mention-pop fixed';
    _mentionPop.innerHTML =
      '<div class="cm-head"><span class="cm-title-label">引用论文</span><span class="cm-foot-hint">↑↓ 选择 · Enter 确认 · Esc 取消</span></div>' +
      '<div class="cm-list"></div>' +
      '<div class="cm-foot"><span>共 <b class="cm-count">0</b> 篇</span><span class="cm-foot-tip">输入关键词筛选</span></div>';
    document.body.appendChild(_mentionPop);
    // 委托：点击/mouseover
    _mentionPop.addEventListener('click', (e) => {
      const it = e.target.closest('.cm-item');
      if (!it) return;
      const idx = Number(it.dataset.idx);
      confirmMention(idx, inputEl, atIdx);
    });
    _mentionPop.addEventListener('mouseover', (e) => {
      const it = e.target.closest('.cm-item');
      if (!it) return;
      const idx = Number(it.dataset.idx);
      if (idx !== _mentionActive) { _mentionActive = idx; renderMentionList(_mentionQuery); }
    });
    // 全局点击外部关闭（持久绑定一次；浮层单例）
    document.addEventListener('mousedown', (e) => {
      if (!_mentionPop || _mentionPop.hidden || _mentionPop.style.display === 'none') return;
      if (!_mentionPop.contains(e.target)) closeChatMentionPicker();
    }, true);
  }
  _mentionQuery = query || '';
  _mentionAtIdx = atIdx != null ? atIdx : 0;
  renderMentionList(_mentionQuery);
  _mentionPop.style.display = 'flex';
  _mentionPop.hidden = false;
  positionMentionPop(inputEl);
}

let _mentionQuery = '';

let _mentionAtIdx = 0;

function confirmMention(idx, inputEl, atIdx) {
  const r = _mentionItems[idx];
  if (!r) return;
  // 先把回调/id 切到本地变量：dispatchEvent('input') 会触发 oninput → handleMentionTrigger →
  // closeChatMentionPicker()，那会把 _mentionCtx 置 null。若放在 dispatchEvent 之后读 _mentionCtx
  // 就丢了 onPick（历史 bug：选了论文但 chip 不出现）。先捕获再触发。
  const onPick = _mentionCtx && typeof _mentionCtx.onPick === 'function' ? _mentionCtx.onPick : null;
  const pickedId = r.id;
  // 从输入框移除 @query 文本（从 atIdx 到当前光标）
  const v = inputEl.value;
  const cursor = inputEl.selectionStart != null ? inputEl.selectionStart : v.length;
  const a = atIdx != null ? atIdx : _mentionAtIdx;
  inputEl.value = v.slice(0, a) + v.slice(cursor);
  closeChatMentionPicker();           // 先关浮层（清状态）
  // 触发 input 事件让 oninput 处理 draft 同步（reader/app 各自的 handler 会接管；此时浮层已关，不会再触发 open）
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  if (onPick) onPick(pickedId);       // 最后回调：push extraIds + 渲染 chip
  try { inputEl.focus(); } catch {}
}

function moveMentionActive(delta) {
  if (!_mentionItems.length) return;
  _mentionActive = (_mentionActive + delta + _mentionItems.length) % _mentionItems.length;
  renderMentionList(_mentionQuery);
}

export function closeChatMentionPicker() {
  if (_mentionPop) { _mentionPop.style.display = 'none'; _mentionPop.hidden = true; }
  _mentionItems = []; _mentionActive = 0; _mentionCtx = null; _mentionQuery = '';
}

export function isChatMentionPickerOpen() {
  return !!(_mentionPop && !_mentionPop.hidden && _mentionPop.style.display && _mentionPop.style.display !== 'none');
}

/** 全局键盘路由：当浮层打开时，↑↓/Enter/Esc 走浮层；返回 true 表示已消费。 */
export function handleMentionKeydown(e, inputEl) {
  if (!isChatMentionPickerOpen()) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionActive(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionActive(-1); return true; }
  if (e.key === 'Enter') { e.preventDefault(); confirmMention(_mentionActive, inputEl, _mentionAtIdx); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeChatMentionPicker(); return true; }
  return false;
}

// 暴露给 reader.js（ESM，无法 import 本文件）：抽屉 AI 对话复用同一份全宽扁平渲染 + 辅助函数。
// v3.16：reader.js 改为直接 import 本模块，以上 window 桥暴露块已退役删除。
// （原暴露 chatMsgHtml/chatEmptyHtml/CHAT_ROLE_ICO/getChatParams/.../NotesPanel/saveQaCardToNotes
//   等 ~20 个符号给 reader 用，现 reader 经 import 取用，无其他消费者）

// 跨模块可变绑定的写出口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_chatPresetsOverride(v) {
  chatPresetsOverride = v;
}
