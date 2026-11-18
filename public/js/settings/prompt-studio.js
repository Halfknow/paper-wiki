// 提示词工作台（v3.55）：Claude Memory 式编辑——默认只读视图 + 底部「向 AI 提需求」composer，
// AI 流式产出完整修改稿，预览后「采用并保存」；「手动编辑」切换到传统 textarea。
//
// 每个提示词面板在 index.html 里只放一个 <div class="ps" data-ps="summary"> 容器，
// 本模块在 bind() 时挂载全部 studio。文本与保存仍复用旧元素 id（textarea/save 按钮/hint/default pre
// 全部由 studio 以原 id 生成），因此 loadSettingsData 的回显与 prompts.js/collect.js 的保存函数零改动。
// 保存语义不变：空串 = 恢复内置默认（后端既有约定）。

import { PUT, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { toast } from '../core/ui-kit.js';
import { streamPostSse } from '../core/stream.js';
import { gotoSettingsTab, loadSettingsData } from './settings.js';
import { saveMineruNamingPrompt } from './collect.js';
import {
  saveChatPrompt,
  saveConceptMapPrompt,
  saveConceptPrompt,
  saveFormulaPrompt,
  saveNotesPrompt,
  saveSummaryPrompt,
  saveTagsPrompt,
  saveTranslatePrompt,
} from './prompts.js';

// 每个 studio 的定义：key 对应后端 /api/settings/prompt-refine 的 key；
// badge 是设置头里的「自定义」徽标 id（采用 AI 修改稿后即时点亮，不必等整页重载）。
const DEFS = {
  summary: {
    key: 'summary',
    ta: 'summary-prompt-edit',
    pre: 'summary-prompt-default-pre',
    hint: 'summary-prompt-hint',
    saveBtn: 'btn-summary-prompt-save',
    resetBtn: 'btn-summary-prompt-default',
    badge: 'ovr-summary',
    save: saveSummaryPrompt,
    reset: () => PUT('/api/settings/summary-prompt', { value: '' }),
    label: '总结提示词',
    desc: '生成论文总结正文（Markdown）',
  },
  tags: {
    key: 'tags',
    ta: 'tags-prompt-edit',
    pre: 'tags-prompt-default-pre',
    hint: 'tags-prompt-hint',
    saveBtn: 'btn-tags-prompt-save',
    resetBtn: 'btn-tags-prompt-default',
    badge: 'ovr-tags',
    save: saveTagsPrompt,
    reset: () => PUT('/api/settings/tags-prompt', { value: '' }),
    label: '标签 / 主题提示词',
    desc: '抽取英文标签与中文主题（JSON）',
  },
  formula: {
    key: 'formula',
    ta: 'formula-prompt-edit',
    pre: 'formula-prompt-default-pre',
    hint: 'formula-prompt-hint',
    saveBtn: 'btn-formula-prompt-save',
    resetBtn: 'btn-formula-prompt-default',
    badge: 'ovr-formula',
    save: saveFormulaPrompt,
    reset: () => PUT('/api/settings/formula-prompt', { value: '' }),
    label: '公式抽取提示词',
    desc: '抽取核心公式并归一化，canonicalName 决定跨论文合并',
  },
  concept: {
    key: 'concept',
    ta: 'concept-prompt-edit',
    pre: 'concept-prompt-default-pre',
    hint: 'concept-prompt-hint',
    saveBtn: 'btn-concept-prompt-save',
    resetBtn: 'btn-concept-prompt-default',
    badge: 'ovr-concept',
    save: saveConceptPrompt,
    reset: () => PUT('/api/settings/concept-prompt', { value: '' }),
    label: '概念抽取提示词',
    desc: '抽取关键概念并分类，驱动概念地图分组',
  },
  conceptMap: {
    key: 'conceptMap',
    ta: 'concept-map-prompt-edit',
    pre: 'concept-map-prompt-default-pre',
    hint: 'concept-map-prompt-hint',
    saveBtn: 'btn-concept-map-prompt-save',
    resetBtn: 'btn-concept-map-prompt-default',
    badge: 'ovr-concept-map',
    save: saveConceptMapPrompt,
    reset: () => PUT('/api/settings/concept-map-prompt', { value: '' }),
    label: '概念地图提示词',
    desc: '生成单文件 HTML 概念地图的设计与交互约束',
  },
  notes: {
    key: 'notes',
    ta: 'notes-prompt-edit',
    pre: 'notes-prompt-default-pre',
    hint: 'notes-prompt-hint',
    saveBtn: 'btn-notes-prompt-save',
    resetBtn: 'btn-notes-prompt-default',
    badge: 'ovr-notes',
    save: saveNotesPrompt,
    reset: () => PUT('/api/settings/notes-prompt', { value: '' }),
    label: '笔记骨架提示词',
    desc: '生成读书笔记的六段式骨架',
  },
  chat: {
    key: 'chat',
    ta: 'chat-prompt-edit',
    pre: 'chat-prompt-default-pre',
    hint: 'chat-prompt-hint',
    saveBtn: 'btn-chat-prompt-save',
    resetBtn: 'btn-chat-prompt-default',
    badge: 'ovr-chat',
    save: saveChatPrompt,
    reset: () => PUT('/api/settings/chat-prompt', { value: '' }),
    label: '论文聊天提示词',
    desc: '论文对话的 system 角色设定',
  },
  translate: {
    key: 'translate',
    ta: 'translate-prompt-edit',
    pre: 'translate-prompt-default-pre',
    hint: 'translate-prompt-hint',
    saveBtn: 'btn-translate-prompt-save',
    resetBtn: 'btn-translate-prompt-default',
    badge: 'ovr-translate-prompt',
    save: saveTranslatePrompt,
    reset: () => PUT('/api/settings/translate-prompt', { value: '' }),
    label: '划线翻译提示词',
    desc: 'PDF 划线的 AI 翻译（engine=ai 时生效）',
  },
  mineruNaming: {
    key: 'mineruNaming',
    ta: 'mineru-naming-prompt-edit',
    pre: 'mineru-naming-default-pre',
    hint: 'mineru-naming-hint',
    saveBtn: 'btn-mineru-naming-save',
    resetBtn: 'btn-mineru-naming-default',
    badge: 'ovr-mineru-naming',
    save: saveMineruNamingPrompt,
    reset: () => PUT('/api/settings/formulas', { namingPrompt: '' }),
    label: 'MinerU 命名提示词',
    desc: '给 MinerU 产出的 LaTeX 命名与解读（仅 MinerU 引擎生效）',
  },
};

/** 提示词页的展示顺序（= 列表行顺序）。 */
const ORDER = ['summary', 'tags', 'notes', 'concept', 'conceptMap', 'formula', 'chat', 'translate', 'mineruNaming'];

const _st = {}; // key → { draft, busy, close, editing, savedValue }

const SEND_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const EDIT_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';

/** 当前生效提示词正文：覆盖值（textarea 非空）> 内置默认（default pre）。 */
function effectiveText(def) {
  const ta = $(def.ta);
  const pre = $(def.pre);
  const v = ta && ta.value.trim() ? ta.value : '';
  return v || (pre ? pre.textContent || '' : '');
}

/** 只读视图重渲（textarea 内容 = 覆盖值；空则展示内置默认 + 「内置默认」角标）。 */
export function refreshStudio(key) {
  const def = DEFS[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  if (!def || !box) return;
  const view = box.querySelector('.ps-view');
  const ta = $(def.ta);
  const custom = !!(ta && ta.value.trim());
  view.textContent = effectiveText(def) || '（空）';
  const tag = box.querySelector('.ps-src');
  if (tag) {
    tag.textContent = custom ? '自定义' : '内置默认';
    tag.classList.toggle('custom', custom);
  }
}

export function refreshAllStudios() {
  for (const key of Object.keys(DEFS)) refreshStudio(key);
}

// ---------------------------------------------------------------------------
// 列表 ↔ 编辑两态（v3.56）
//
// 提示词从 5 个平级 tab 收成一页：默认只看「哪几条 prompt、哪些被改过」，点行才进编辑。
// 这样左导航短了 5 项，也不再让一屏 300 行的 prompt 正文成为设置页的默认视觉主体。
// ---------------------------------------------------------------------------

/** 当前展开的提示词 key（null = 停在列表）。 */
let openedPane = null;

/** 渲染提示词列表行。每行：名称 + 一句说明 + 「自定义 / 默认」状态 + 「编辑」。 */
export function renderPromptIndex() {
  const rows = document.getElementById('prompt-rows');
  if (!rows) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  rows.innerHTML = ORDER.filter((k) => DEFS[k])
    .map((k) => {
      const def = DEFS[k];
      const ta = $(def.ta);
      const custom = !!(ta && ta.value.trim());
      return (
        `<div class="set-row set-row-jump" data-prompt-open="${k}" tabindex="0" role="button" title="编辑${esc(def.label)}">` +
        `<div class="sr-main"><div class="sr-label">${esc(def.label)}` +
        (custom ? '<span class="ovr-badge">自定义</span>' : '') +
        `</div><div class="sr-hint">${esc(def.desc || '')}</div></div>` +
        `<div class="sr-ctl"><span class="sr-val muted">${custom ? '已自定义' : '内置默认'}</span>` +
        `<svg class="sr-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></div></div>`
      );
    })
    .join('');
  rows.querySelectorAll('[data-prompt-open]').forEach((el) => {
    const go = () => openPromptPane(el.dataset.promptOpen);
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
}

/** 回到列表态。 */
export function showPromptIndex() {
  openedPane = null;
  const idx = document.getElementById('prompt-index');
  if (idx) idx.hidden = false;
  document.querySelectorAll('.prompt-pane').forEach((p) => { p.hidden = true; });
  renderPromptIndex();
}

/** 展开某条提示词的编辑工作台。key 非法时回退列表。 */
export function openPromptPane(key) {
  const pane = document.querySelector(`.prompt-pane[data-prompt-pane="${key}"]`);
  if (!pane) { showPromptIndex(); return; }
  openedPane = key;
  const idx = document.getElementById('prompt-index');
  if (idx) idx.hidden = true;
  document.querySelectorAll('.prompt-pane').forEach((p) => { p.hidden = p !== pane; });
  refreshStudio(key);
}

/** 当前是否停在某条提示词的编辑态（Esc 优先返回列表而非关闭整个设置）。 */
export function currentPromptPane() {
  return openedPane;
}

function setComposerEnabled(box, on) {
  box.querySelector('.ps-input').disabled = !on;
  box.querySelector('.ps-send').disabled = !on;
  box.querySelector('.ps-manual').disabled = !on;
}

function showDraft(box, on) {
  box.querySelector('.ps-draft').hidden = !on;
}

/** 发送修改需求 → SSE 流式生成修改稿。多轮：有未采用的修改稿时以其为 base 继续改。 */
function sendRefine(key) {
  const def = DEFS[key];
  const st = _st[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  if (!def || !st || !box || st.busy) return;
  const input = box.querySelector('.ps-input');
  const request = input.value.trim();
  if (!request) return;
  const base = st.draft != null ? st.draft : effectiveText(def);
  const draftBody = box.querySelector('.ps-draft-body');
  const status = box.querySelector('.ps-draft-status');
  st.busy = true;
  st.draft = '';
  input.value = '';
  setComposerEnabled(box, false);
  showDraft(box, true);
  box.querySelector('.ps-apply').disabled = true;
  status.textContent = '生成中…';
  status.className = 'ps-draft-status busy';
  draftBody.textContent = '';
  st.close = streamPostSse(
    sp('/api/settings/prompt-refine'),
    { key: def.key, request, base },
    {
      onToken: (obj) => {
        st.draft += (obj && obj.tok) || '';
        draftBody.textContent = st.draft;
        draftBody.scrollTop = draftBody.scrollHeight;
      },
      onDone: () => {
        st.busy = false;
        setComposerEnabled(box, true);
        box.querySelector('.ps-apply').disabled = !st.draft.trim();
        status.textContent = '未保存 · 可采用、放弃或继续提修改';
        status.className = 'ps-draft-status done';
        input.focus();
      },
      onFail: (msg) => {
        st.busy = false;
        setComposerEnabled(box, true);
        status.textContent = '生成失败：' + (msg || '');
        status.className = 'ps-draft-status bad';
        if (!st.draft.trim()) showDraft(box, false);
        toast(msg || 'AI 改写失败', 'error');
      },
    },
  );
}

/** 采用修改稿：写入 textarea 并走既有保存函数（PUT + toast + hint）。 */
async function applyDraft(key) {
  const def = DEFS[key];
  const st = _st[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  if (!def || !st || st.draft == null || !st.draft.trim()) return;
  $(def.ta).value = st.draft;
  const okSave = await def.save();
  if (okSave === false) return; // 保存失败：hint 已提示，修改稿保留待重试
  st.draft = null;
  showDraft(box, false);
  const badge = $(def.badge);
  if (badge) badge.hidden = false; // 非空修改稿落地即成为自定义覆盖
  refreshStudio(key);
  renderPromptIndex();
}

function discardDraft(key) {
  const st = _st[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  if (!st || !box) return;
  if (st.busy && st.close) st.close();
  st.busy = false;
  st.draft = null;
  setComposerEnabled(box, true);
  showDraft(box, false);
}

/** 手动编辑：进入时快照原值（取消可回滚）；覆盖为空时预填内置默认便于在其基础上改。 */
function enterEdit(key) {
  const def = DEFS[key];
  const st = _st[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  const ta = $(def.ta);
  if (!def || !st || !box || !ta) return;
  st.savedValue = ta.value;
  if (!ta.value.trim()) ta.value = effectiveText(def);
  st.editing = true;
  box.classList.add('editing');
  box.querySelector('.ps-edit').hidden = false;
  box.querySelector('.ps-viewwrap').hidden = true;
  // 头部整行保留（只收起「编辑」钮）：它撑着 28px，一起藏掉的话编辑框会整体上跳 38px，
  // 正好抵消了「同尺寸原地互换」想要的稳定感。
  box.querySelector('.ps-manual').hidden = true;
  box.querySelector('.ps-composer').hidden = true;
  showDraft(box, false);
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

function exitEdit(key, { restore }) {
  const def = DEFS[key];
  const st = _st[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  const ta = $(def.ta);
  if (!def || !st || !box || !ta) return;
  if (restore) ta.value = st.savedValue != null ? st.savedValue : ta.value;
  st.editing = false;
  box.classList.remove('editing');
  box.querySelector('.ps-edit').hidden = true;
  box.querySelector('.ps-viewwrap').hidden = false;
  box.querySelector('.ps-manual').hidden = false;
  box.querySelector('.ps-composer').hidden = false;
  const h = $(def.hint);
  if (h) { h.textContent = ''; h.className = 'save-hint'; }
  refreshStudio(key);
  renderPromptIndex();
}

async function saveManual(key) {
  const def = DEFS[key];
  const st = _st[key];
  if (!def || !st) return;
  const okSave = await def.save();
  if (okSave === false) return; // 失败：停留在编辑态，hint 已给出原因
  st.savedValue = $(def.ta).value;
  exitEdit(key, { restore: false });
}

/** 恢复内置默认：直接 PUT 空串（后端语义：空=恢复默认），再整页重载设置数据。 */
async function resetToDefault(key) {
  const def = DEFS[key];
  if (!def) return;
  const yes = await PWDialog.confirm(`将「${def.label}」恢复为内置默认？当前的自定义内容会被清除。`, {
    title: '恢复默认',
    okText: '恢复默认',
  });
  if (!yes) return;
  try {
    const r = await def.reset();
    if (r && r.ok === false) {
      toast(r.error || '操作失败', 'error');
      return;
    }
    discardDraft(key);
    await loadSettingsData(); // 重填 textarea/徽标/概览（末尾会 refreshAllStudios）
    toast(`「${def.label}」已恢复内置默认`);
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

function mount(key) {
  const def = DEFS[key];
  const box = document.querySelector(`.ps[data-ps="${key}"]`);
  if (!def || !box || box.dataset.mounted) return;
  box.dataset.mounted = '1';
  _st[key] = { draft: null, busy: false, close: null, editing: false, savedValue: null };
  // v3.56：「手动编辑」从 composer 胶囊里搬到只读视图上方的工具行。
  // 原来把它塞在 AI 输入框左端，等于把两条互斥的编辑通道挤进同一个控件——用户想直接改
  // 正文时要先在一个「跟 AI 说话」的框上找按钮。现在读/改的入口在内容自己的头上，
  // 而 composer 只负责「让 AI 改」这一件事。
  // 编辑态的 textarea 与只读视图同尺寸同字体同内边距，原地互换，切换时版面不跳。
  box.innerHTML =
    `<div class="ps-head">` +
    `<span class="ps-src" title="当前生效的是自定义内容还是内置默认"></span>` +
    `<button class="btn ghost sm ps-manual" type="button" title="直接编辑提示词原文">${EDIT_SVG}编辑</button>` +
    `</div>` +
    `<div class="ps-viewwrap"><div class="ps-view" tabindex="0" aria-label="当前${def.label}"></div></div>` +
    `<div class="ps-edit" hidden>` +
    `<textarea id="${def.ta}" placeholder="正在加载…" spellcheck="false" aria-label="编辑${def.label}"></textarea>` +
    `<div class="ps-edit-actions"><span class="save-hint" id="${def.hint}"></span>` +
    `<button class="btn secondary sm ps-cancel" type="button">取消</button>` +
    `<button class="btn sm" id="${def.saveBtn}" type="button">保存</button></div></div>` +
    `<div class="ps-draft" hidden>` +
    `<div class="ps-draft-head"><span class="ps-draft-title">AI 修改稿 <span class="ps-draft-status"></span></span>` +
    `<span class="ps-draft-acts"><button class="btn secondary sm ps-discard" type="button">放弃</button>` +
    `<button class="btn sm ps-apply" type="button">采用并保存</button></span></div>` +
    `<div class="ps-draft-body" tabindex="0"></div></div>` +
    `<div class="ps-composer">` +
    `<input class="ps-input" type="text" autocomplete="off" placeholder="让 AI 改这条提示词，如「加一节局限性与未来工作」" />` +
    `<button class="ps-send" type="button" title="发送修改需求" aria-label="发送修改需求">${SEND_SVG}</button></div>`;
  box.querySelector('.ps-send').onclick = () => sendRefine(key);
  box.querySelector('.ps-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      sendRefine(key);
    }
    e.stopPropagation(); // 与阅读器抽屉同理：全局快捷键让位输入态
  };
  box.querySelector('.ps-apply').onclick = () => applyDraft(key);
  box.querySelector('.ps-discard').onclick = () => discardDraft(key);
  box.querySelector('.ps-manual').onclick = () => enterEdit(key);
  box.querySelector('.ps-cancel').onclick = () => exitEdit(key, { restore: true });
  $(def.saveBtn).onclick = () => saveManual(key);
  const resetBtn = $(def.resetBtn);
  if (resetBtn) resetBtn.onclick = () => resetToDefault(key);
  refreshStudio(key);
}

/** bind() 时调用一次：挂载全部提示词工作台（容器缺省时静默跳过）+ 列表/编辑两态的返回钮。 */
export function initPromptStudios() {
  for (const key of Object.keys(DEFS)) mount(key);
  document.querySelectorAll('[data-prompt-back]').forEach((b) => { b.onclick = () => showPromptIndex(); });
  // 「入库与解析」页里指向 MinerU 命名提示词的入口
  document.querySelectorAll('[data-goto-prompt]').forEach((b) => {
    b.onclick = async () => {
      await gotoSettingsTab('prompts');
      openPromptPane(b.dataset.gotoPrompt);
    };
  });
  renderPromptIndex();
}
