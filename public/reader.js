// PDF 阅读器：基于 pdfjs-dist 官方 PDFViewer，自带文本层/批注编辑层。
// 暴露全局 window.PaperReader，供 app.js 调用。
//
// 加载顺序（零构建）：先 import build（注册 globalThis.pdfjsLib），
// 再 import viewer（注册 globalThis.pdfjsViewer，依赖 pdfjsLib）。
import '/vendor/pdfjs.js';
import '/vendor/pdfjs-viewer.js';

(function () {
  const pdfjsLib = globalThis.pdfjsLib;
  const pdfjsViewer = globalThis.pdfjsViewer;

  /** 空间注入器：把 ?space=<active> 加到 /api/ 和 /papers/ URL。
   *  app.js 在加载后会设 window.sp；这里取引用（调用时读取，避免加载顺序问题）。
   *  reader 直接 fetch /api/papers/:id 与打开 /papers/<file>，必须带 space 避免串空间。 */
  const sp = (url) => (typeof window !== 'undefined' && typeof window.sp === 'function' ? window.sp(url) : url);

  // 配置 worker（只配一次）
  try { pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs.worker.js'; } catch {}

  // 供 app.js 复用的文件夹/主题调色板
  window.READER_PALETTE = ['#4f46e5', '#7c3aed', '#0891b2', '#d97706', '#db2777', '#2563eb', '#16a34a', '#475569'];

  const { AnnotationEditorType, AnnotationEditorParamsType, PixelsPerInch } = pdfjsLib;
  const { PDFViewer, SimpleLinkService, EventBus, SpreadMode } = pdfjsViewer;

  // PDF 点 → CSS 像素换算（96/72≈1.333）。pdf.js 渲染时按 currentScale * R 计算实际像素，
  // fit 计算必须乘上它，否则双页会比窗口宽约 1.333 倍（即旧版"131%、超出窗口"的根因）。
  const PDF_TO_CSS = (PixelsPerInch && PixelsPerInch.PDF_TO_CSS_UNITS) || (96 / 72);

  // 每页两侧外边距（px）。须与 styles.css 里 .pdfViewer .page 的 margin-inline 一致，
  // 用于 fit 时精确扣除水平外边距，避免触发横向滚动条。
  const PAGE_MARGIN = 6;

  // 选区快捷高亮的色板（与工具栏 #reader-colors 同色）
  const HL_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#ddd6fe', '#fbcfe8', '#fecdd3', '#a5f3fc'];

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    note: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v11l-4 4H4z"/><path d="M8 9h8M8 13h4"/></svg>',
    ai: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    translate: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7"/><path d="M9 3v2c0 4-2 7-5 8"/><path d="M5 9c0 3 3 5 6 6"/><path d="M13 19l4-9 4 9"/><path d="M14 16h6"/></svg>',
    // pin 图标：未钉住时斜放（可被清除），钉住时竖直 + 高亮（fill 实心）
    pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  };

  function isDenseArrayLike(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (!keys.length) return false;
    for (let i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, String(i))) return false;
    }
    return true;
  }

  function repairAnnotationValue(value) {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return Array.from(value).map(repairAnnotationValue);
    }
    if (Array.isArray(value)) return value.map(repairAnnotationValue);
    if (!value || typeof value !== 'object') return value;
    if (isDenseArrayLike(value)) {
      const arr = new Array(Object.keys(value).length);
      for (let i = 0; i < arr.length; i++) arr[i] = repairAnnotationValue(value[i]);
      return arr;
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = repairAnnotationValue(value[key]);
    return out;
  }

  function repairAnnotationPayload(annotations) {
    if (!annotations || typeof annotations !== 'object') return annotations;
    const fixed = repairAnnotationValue(annotations);
    if (fixed && Array.isArray(fixed.items)) {
      fixed.items = fixed.items.map((item) => {
        if (item && typeof item.id === 'string' && item.id.startsWith('pdfjs_internal_editor_')) {
          return { ...item, id: null };
        }
        return item;
      });
    }
    return fixed;
  }

  // 初始编辑器模式用 NONE：保证 UIManager 被创建（isValidAnnotationEditorMode 要求单一值，
  // 组合位掩码如 FREETEXT|HIGHLIGHT|INK=27 会被判为非法导致 UIManager 不建）。
  // 具体工具由运行时 setTool 切换；高亮/便签/手写三类都在 UIManager 就绪后可用。
  const ANNOT_EDITOR_INIT_MODE = AnnotationEditorType.NONE;

  class PaperReader {
    constructor(opts) {
      Object.assign(this, opts);
      // 统一把 opts 里的 DOM 引用映射成 this.el* 命名（app.js 传的字段名无 el 前缀）
      this.elBack = opts.back; this.elPrev = opts.prev; this.elNext = opts.next;
      this.elPageInput = opts.pageInput; this.elPageTotal = opts.pageTotal;
      this.elZoomIn = opts.zoomIn; this.elZoomOut = opts.zoomOut; this.elZoomLabel = opts.zoomLabel;
      this.zoomFit = opts.zoomFit;
      this.elSpread = opts.spread;
      this.elTitle = opts.title; this.elSaved = opts.saved;
      this.wrap = opts.canvasWrap;                  // 滚动容器（#reader-canvas-wrap）
      this.viewerEl = this.wrap.querySelector('#viewer'); // PDFViewer 挂载点
      this.doc = null;
      this.viewer = null;
      this.linkService = null;
      this.eventBus = null;
      this.uiManager = null;                        // AnnotationEditorUIManager（经事件拿到）
      this.paper = null;
      this._chatOpen = false;
      this._chatBusy = false;
      this.spread = true;                           // 默认双页（配合 2x 过采样 + CSS 锐化降采样保证清晰，见 open()/styles.css）
      this.curTool = 'cursor';
      this._selectMode = true;                      // 用户侧“选择”工具：底层借用 pdf.js 可选中模式
      this.curColor = '#fde68a';
      this._fitMode = true;                         // 默认开启"适应宽度"，窗口缩放自动重排
      this.savingTimer = null;
      this.lastSavedAt = 0;
      this.savingAnnotTimer = null;
      this.lastSavedAnnotAt = 0;
      this._annotationsDirty = false;
      this._suppressAnnotationDirty = false;
      this.restorePending = null;
      this._pendingAnnotations = null;
      this._pop = null;                             // 选区浮窗
      this._statusTimer = null;
      this.bind();
    }

    bind() {
      this.elBack.onclick = () => this.close();
      this.elPrev.onclick = () => this.scrollToPage(this.page - 1);
      this.elNext.onclick = () => this.scrollToPage(this.page + 1);
      this.elPageInput.onchange = () => {
        const n = Math.max(1, Math.min(this.total, parseInt(this.elPageInput.value, 10) || 1));
        this.scrollToPage(n);
      };
      this.elZoomIn.onclick = () => this.zoomBy(+0.15);
      this.elZoomOut.onclick = () => this.zoomBy(-0.15);
      if (this.zoomFit) this.zoomFit.onclick = () => this.fitToWidth();
      // 点击百分比文字也触发"适应宽度"，是常见的现代快捷交互
      if (this.elZoomLabel) { this.elZoomLabel.style.cursor = 'pointer'; this.elZoomLabel.onclick = () => this.fitToWidth(); }
      this.elSpread.onclick = () => { this.spread = !this.spread; this.applySpread(); };
      // 键盘：只在“选择”工具下删除选中的批注，避免在高亮/便签/手写模式里误删。
      this._onKey = (e) => {
        if (!this.view.classList.contains('active')) return;
        // Ctrl+L / Cmd+L：划线时把选中文本作为引用 badge 加入对话框；无划线则切换 AI 边栏
        if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const sel = document.getSelection();
          const txt = sel ? sel.toString().trim() : '';
          if (txt && sel && !sel.isCollapsed && this.viewerEl.contains(sel.anchorNode)) {
            // 有划线：添加引用 badge（不塞进 textarea 纯文本）
            this.addChatQuote(txt);
            this.toggleChat(true);
            this.hideSelectionPopup();
          } else {
            // 无划线：切换边栏开合
            this.toggleChat();
          }
          return;
        }
        // Esc 分层关闭（必须放在 typing 提前 return 之前）：
        // 框选截图 → @ 引用浮层（输入框自己关）→ 聊天抽屉 → 批注选中/文本浮层 → 阅读器（app.js 兜底）
        if (e.key === 'Escape') {
          // 框选截图模式最优先：取消选区（框选正是从抽屉里发起的，抽屉此时必开着）
          if (this._visionOverlay) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.endVisionSelect();
            return;
          }
          const typing = this.isTypingTarget(e.target || document.activeElement);
          // 焦点在输入框且 @ 浮层开着：交给输入框的 handleMentionKeydown 关浮层；
          // 它会 preventDefault，app.js 全局处理器据此跳过，不会误关阅读器。
          if (typing && window.isChatMentionPickerOpen && window.isChatMentionPickerOpen()) return;
          // 笔记卡编辑态：先提交编辑（ Esc 分层：卡片编辑器 > 抽屉 > 阅读器），不关抽屉
          if (this._notesPanel && this._notesPanel.hasOpenEditor && this._notesPanel.hasOpenEditor()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this._notesPanel.commitOpenEditor();
            return;
          }
          // 聊天抽屉开着：先关抽屉（连带关大纲/@浮层/参数浮层），不波及阅读器
          if (this._chatOpen) {
            this.toggleChat(false);
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          if (typing) return;
          const hadAnnotationSelection = !!(this.uiManager && this.uiManager.hasSelection);
          const hadTextPopup = !!(this._pop && !this._pop.hidden);
          this.hideSelectionPopup();
          if (hadTextPopup) {
            try { document.getSelection().removeAllRanges(); } catch {}
          }
          const cleared = this.clearAnnotationSelection();
          if (hadAnnotationSelection || hadTextPopup || cleared) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
          return;
        }
        if (this.isTypingTarget(e.target || document.activeElement)) return;
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();                              // 吞掉，避免 Backspace 触发浏览器后退
        if (this.curTool !== 'cursor') {
          this.setStatus('请先切到「选择」模式，点选批注后再删除', true);
          return;
        }
        this.deleteSelectedEditors();
      };
      document.addEventListener('keydown', this._onKey, true);
      // 批注工具
      const tools = { cursor: this.toolCursor, highlight: this.toolHighlight, note: this.toolNote, ink: this.toolInk };
      Object.entries(tools).forEach(([mode, btn]) => {
        if (btn) btn.onclick = () => this.setTool(mode);
      });
      // 删除选中批注（工具栏垃圾桶）。与键盘 Delete 同一入口。
      if (this.toolDelete) this.toolDelete.onclick = () => this.deleteSelectedEditors();
      // 颜色选择：真正应用到 pdf.js（旧版只存 curColor 不生效）
      if (this.colorsEl) {
        this.colorsEl.querySelectorAll('.reader-color').forEach((el) => {
          el.onclick = () => {
            this.applyColor(el.dataset.color);
            this.colorsEl.querySelectorAll('.reader-color').forEach((n) => n.classList.toggle('active', n === el));
          };
        });
      }
      // AI 对话抽屉绑定（按钮/关闭/发送），仅当 DOM 存在时
      this.bindChat();
    }

    // ---- AI 对话抽屉 ----
    /** 绑定聊天按钮/关闭/发送（DOM 不存在则跳过）。reader.js 直接 fetch /api/papers/:id/chat。 */
    bindChat() {
      this.elChatBtn = document.getElementById('reader-chat');
      this.elChatDrawer = document.getElementById('reader-chat-drawer');
      this.elChatClose = document.getElementById('reader-chat-close');
      this.elChatList = document.getElementById('reader-chat-list');
      this.elChatInput = document.getElementById('reader-chat-input');
      this.elChatSend = document.getElementById('reader-chat-send');
      if (!this.elChatBtn || !this.elChatDrawer) return;
      // pdf.js UIManager 的 KeyboardManager（window 冒泡阶段注册）只豁免 <input type=text|number>，
      // 不豁免 textarea：当有批注编辑器处于选中/编辑态时，会抢走抽屉里 textarea 的
      // Ctrl+A（变成「全选 PDF 高亮」）/ Delete / Backspace / 方向键并 stopEvent 吞掉默认行为，
      // 表现为「聊天输入框无法删除、Ctrl+A 选中 PDF 高亮」。
      // 在抽屉冒泡阶段统一 stopPropagation：textarea 默认行为（输入/删除/全选/移动光标）不受影响；
      // Esc 分层由 document capture 阶段的 _onKey 先行处理，也不受影响。
      this.elChatDrawer.addEventListener('keydown', (e) => { e.stopPropagation(); });
      // 点击与拖动共用一按钮：拖动过则吞掉随后的 click（见 wireFabDrag），否则切抽屉。
      this.elChatBtn.onclick = () => {
        if (this._fabJustDragged) { this._fabJustDragged = false; return; }
        this.toggleChat();
      };
      if (this.elChatClose) this.elChatClose.onclick = () => this.toggleChat(false);
      if (this.elChatSend) this.elChatSend.onclick = () => this.sendChat();
      // 大纲按钮：注入到 rcd-actions 容器（关闭键之前），与详情 tab 一致。
      if (!this.elOutlineBtn) {
        const actions = this.elChatDrawer.querySelector('.rcd-actions');
        const closeBtn = this.elChatDrawer.querySelector('#reader-chat-close');
        if (actions && closeBtn) {
          const btn = document.createElement('button');
          btn.className = 'chat-outline-btn';
          btn.id = 'reader-chat-outline';
          btn.title = '问答大纲';
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>大纲';
          // 插到关闭键之前（顺序：大纲 清空 关闭）
          actions.insertBefore(btn, closeBtn);
          this.elOutlineBtn = btn;
        }
      }
      if (this.elOutlineBtn) this.elOutlineBtn.onclick = () => this.toggleChatOutline();
      // 清空按钮：注入到 rcd-actions 容器（关闭键之前，大纲按钮之后）。
      if (!this.elClearBtn) {
        const actions = this.elChatDrawer.querySelector('.rcd-actions');
        const closeBtn = this.elChatDrawer.querySelector('#reader-chat-close');
        if (actions && closeBtn) {
          const btn = document.createElement('button');
          btn.className = 'chat-outline-btn';
          btn.id = 'reader-chat-clear';
          btn.title = '清空聊天记录';
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>清空';
          actions.insertBefore(btn, closeBtn);
          this.elClearBtn = btn;
        }
      }
      if (this.elClearBtn) this.elClearBtn.onclick = async () => {
        if (!confirm('清空这篇论文的聊天记录？')) return;
        try {
          await fetch(sp('/api/papers/' + encodeURIComponent(this.paper.id)), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: [] }),
          }).then((r) => r.json());
          if (this.paper) this.paper.chat = [];
          this.renderChatList([]);
        } catch { /* ignore */ }
      };
      // 建议卡片（事件委托）：点即填入并发送
      if (this.elChatList && !this.elChatList.dataset.suggestWired) {
        this.elChatList.dataset.suggestWired = '1';
        this.elChatList.addEventListener('click', (e) => {
          const chip = e.target.closest('.chat-suggest');
          if (!chip) return;
          if (this.elChatInput) { this.elChatInput.value = chip.dataset.q || ''; }
          this.sendChat();
        });
      }
      if (this.elChatInput) {
        this.elChatInput.onkeydown = (e) => {
          const W = window;
          // @ 引用浮层打开时：↑↓ 导航 / Enter 选中 / Esc 关闭（共享 handleMentionKeydown）
          if (W.handleMentionKeydown && W.handleMentionKeydown(e, this.elChatInput)) { e.preventDefault(); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.closeMentionPop(); this.sendChat(); }
        };
        // 输入框自动增高（1~8 行）+ 发送键空输入禁用 + @ 触发器（实时筛选）
        this.elChatInput.addEventListener('input', () => { this.autoResizeInput(); this.handleMentionTrigger(); });
        this.updateSendEnabled();
      }
      // 注入预置按钮行 + @ 引用 chip 行（输入框上方）
      this.injectPresetAndMentionRows();
      // 注入参数浮层按钮（rcd-actions 里，与大纲/清空并列）+ 浮层
      this.injectParamsButton();
      // 模型切换按钮 + 头部徽章同步（Phase 2）
      this.wireModelSwitcher();
      // 图表框选提问按钮（Phase 3）
      this.wireAttachButton();
      // 抽屉拖拽拉宽 splitter
      this.wireDrawerSplitter();
      // FAB 纵向拖动 + 位置持久化
      this.wireFabDrag();
      // 「聊天 | 笔记」segmented + 笔记侧栏（AI 笔记，复用 app.js NotesPanel）
      this.wireDrawerSeg();
      // pin 按钮（钉住抽屉）+ 点击 PDF 关闭未钉住的抽屉
      this.injectPinButton();
      this.wirePdfClickClose();
    }
    /** pin 按钮：钉住后点击 PDF 不再关闭抽屉（Esc/关闭键/关阅读器仍可关）。
     *  状态持久化 localStorage('pw-reader-chat-pin')。 */
    injectPinButton() {
      if (this.elPinBtn || !this.elChatDrawer) return;
      const actions = this.elChatDrawer.querySelector('.rcd-actions');
      const closeBtn = this.elChatDrawer.querySelector('#reader-chat-close');
      if (!actions || !closeBtn) return;
      const btn = document.createElement('button');
      btn.className = 'chat-outline-btn rcd-pin-btn';
      btn.id = 'rcd-pin-btn';
      btn.type = 'button';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z"/></svg><span>钉住</span>';
      actions.insertBefore(btn, closeBtn);
      this.elPinBtn = btn;
      this._chatPinned = localStorage.getItem('pw-reader-chat-pin') === '1';
      this._updatePinBtn();
      btn.onclick = () => {
        this._chatPinned = !this._chatPinned;
        localStorage.setItem('pw-reader-chat-pin', this._chatPinned ? '1' : '0');
        this._updatePinBtn();
        this.setStatus(this._chatPinned ? '已钉住：点击 PDF 不再关闭抽屉' : '已取消钉住');
      };
    }
    _updatePinBtn() {
      if (!this.elPinBtn) return;
      this.elPinBtn.classList.toggle('pinned', !!this._chatPinned);
      this.elPinBtn.title = this._chatPinned ? '已钉住（点 PDF 不关闭），点击取消钉住' : '钉住抽屉（点 PDF 不再关闭）';
    }
    /** 点击 PDF 区域关闭未钉住的抽屉。
     *  排除：划词选区浮窗/翻译面板/框选遮罩（它们有自己的交互），以及刚完成文本选择的 click
     *  （划线准备提问/批注时不关）。钉住（pin）时整段不生效。 */
    wirePdfClickClose() {
      if (this._pdfClickCloseWired || !this.wrap) return;
      this._pdfClickCloseWired = true;
      this.wrap.addEventListener('click', (e) => {
        if (!this._chatOpen || this._chatPinned) return;
        if (e.target.closest('.vision-select-overlay, .reader-sel-pop, .reader-tr-panel')) return;
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed && this.viewerEl && this.viewerEl.contains(sel.anchorNode)) return;
        this.toggleChat(false);
      });
    }
    /** 「聊天 | 笔记」切换行 + 笔记视图容器（注入 rcd-head 之后）。
     *  显隐走 CSS（.notes-mode 类）：聊天区（list/quotes/composer）隐藏，笔记视图显示。
     *  笔记面板复用 app.js 暴露的 NotesPanel（与详情 tab 笔记页同一实现，数据经 syncNotePanels 双向同步）。 */
    wireDrawerSeg() {
      if (this.elSegRow || !this.elChatDrawer) return;
      const head = this.elChatDrawer.querySelector('.rcd-head');
      if (!head) return;
      const segRow = document.createElement('div');
      segRow.className = 'rcd-seg-row';
      segRow.innerHTML = '<div class="rcd-seg"><button type="button" data-seg="chat" class="active">聊天</button><button type="button" data-seg="notes">笔记</button></div>';
      head.insertAdjacentElement('afterend', segRow);
      this.elSegRow = segRow;
      segRow.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-seg]');
        if (b) this.setDrawerSeg(b.dataset.seg);
      });
      const notesView = document.createElement('div');
      notesView.className = 'rcd-notes-view';
      segRow.insertAdjacentElement('afterend', notesView);
      this.elNotesView = notesView;
      const W = window;
      if (W.NotesPanel) {
        this._notesPanel = new W.NotesPanel(notesView, { showGenerate: true });
        W._readerNotesPanel = this._notesPanel; // 供 app.js syncNotePanels 跨面板同步
      }
      this._drawerSeg = 'chat';
    }
    setDrawerSeg(seg) {
      this._drawerSeg = seg === 'notes' ? 'notes' : 'chat';
      this.elChatDrawer.classList.toggle('notes-mode', this._drawerSeg === 'notes');
      if (this.elSegRow) {
        this.elSegRow.querySelectorAll('button[data-seg]').forEach((b) => b.classList.toggle('active', b.dataset.seg === this._drawerSeg));
      }
      // 切到笔记页：仅在论文变了（或首次）时拉取；之后的新鲜度靠 syncNotePanels 同步
      if (this._drawerSeg === 'notes' && this._notesPanel && this.paper && this._notesPanel.paperId !== this.paper.id) {
        this._notesPanel.load(this.paper.id);
      }
    }
    /** 接线模型切换：composer 按钮 + 头部徽章，复用 app.js 暴露的 toggleModelSwitcher。 */
    wireModelSwitcher() {
      this.elModelBtn = document.getElementById('rcd-model-btn');
      this.elModelPill = document.getElementById('rcd-model-pill');
      const W = window;
      const refresh = () => {
        const sel = W.getSelectedModel ? W.getSelectedModel() : '';
        const def = (W.pwState && W.pwState.aiModels && W.pwState.aiModels.default) || '默认模型';
        const m = sel || def;
        if (this.elModelBtn) { const n = this.elModelBtn.querySelector('.cm-name'); if (n) n.textContent = m; }
        if (this.elModelPill) { this.elModelPill.textContent = m; this.elModelPill.title = m; }
      };
      refresh();
      if (this.elModelBtn) {
        this.elModelBtn.onclick = (e) => {
          e.stopPropagation();
          if (W.toggleModelSwitcher) W.toggleModelSwitcher(this.elModelBtn);
          // 切换后稍延迟刷新（toggleModelSwitcher 内部 localStorage 写入是同步的，但为保险起见）
          setTimeout(refresh, 0);
          setTimeout(refresh, 300); // 用户选择后
        };
      }
      // 暴露刷新方法供 app.js loadAiModels 完成后调用（state 已注入 window）
      this._refreshModelUI = refresh;
    }
    /** Phase 3：接线「图表」框选提问按钮。
     *  点击进入框选模式：在 #reader-canvas-wrap 上叠加半透明遮罩 + 拖拽矩形选区，
     *  松开后从对应 page.canvas 截取该区域为 PNG dataURL，作为附图 chip 塞进 composer。 */
    wireAttachButton() {
      this.elAttachBtn = document.getElementById('rcd-attach-btn');
      this._chatImages = []; // 附图 dataURL 数组（随请求发送）
      if (!this.elAttachBtn) return;
      this.elAttachBtn.onclick = () => this.startVisionSelect();
    }
    /** 进入框选模式：叠加遮罩 + 监听拖拽。Esc/点遮罩取消。 */
    startVisionSelect() {
      if (this._visionOverlay) return; // 已在框选
      const wrap = this.wrap; // #reader-canvas-wrap
      if (!wrap) return;
      const overlay = document.createElement('div');
      overlay.className = 'vision-select-overlay';
      overlay.innerHTML = '<div class="vs-hint">在图表上拖拽框选区域 · Esc 取消</div><div class="vs-rect" hidden></div>';
      wrap.appendChild(overlay);
      this._visionOverlay = overlay;
      const rect = overlay.querySelector('.vs-rect');
      const hint = overlay.querySelector('.vs-hint');
      let startX = 0, startY = 0, dragging = false;
      overlay.setPointerCapture && overlay.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
        try { overlay.setPointerCapture(e.pointerId); } catch {}
        const wrapRect = wrap.getBoundingClientRect();
        startX = e.clientX - wrapRect.left;
        startY = e.clientY - wrapRect.top;
        rect.style.left = startX + 'px';
        rect.style.top = startY + 'px';
        rect.style.width = '0px';
        rect.style.height = '0px';
        rect.hidden = false;
        if (hint) hint.style.display = 'none';
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const wrapRect = wrap.getBoundingClientRect();
        const curX = Math.max(0, Math.min(wrapRect.width, e.clientX - wrapRect.left));
        const curY = Math.max(0, Math.min(wrapRect.height, e.clientY - wrapRect.top));
        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        rect.style.left = left + 'px';
        rect.style.top = top + 'px';
        rect.style.width = Math.abs(curX - startX) + 'px';
        rect.style.height = Math.abs(curY - startY) + 'px';
      });
      overlay.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        try { overlay.releasePointerCapture(e.pointerId); } catch {}
        const wrapRect = wrap.getBoundingClientRect();
        const curX = Math.max(0, Math.min(wrapRect.width, e.clientX - wrapRect.left));
        const curY = Math.max(0, Math.min(wrapRect.height, e.clientY - wrapRect.top));
        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        // 太小的选区视为误触，取消
        if (w < 20 || h < 20) { this.endVisionSelect(); return; }
        try { this.cropRegionToImage(left, top, w, h); } catch (err) { this.setStatus('截图失败：' + (err && err.message), true); }
        this.endVisionSelect();
      });
      // 点遮罩空白处（非拖拽）取消
      overlay.addEventListener('click', (e) => { if (e.target === overlay) this.endVisionSelect(); });
      // Esc 取消（吞掉事件，避免冒泡到 app.js 连带关掉阅读器）
      this._visionKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.endVisionSelect(); } };
      document.addEventListener('keydown', this._visionKey, true);
    }
    endVisionSelect() {
      if (this._visionOverlay) { this._visionOverlay.remove(); this._visionOverlay = null; }
      if (this._visionKey) { document.removeEventListener('keydown', this._visionKey, true); this._visionKey = null; }
    }
    /** 从 PDF page.canvas 截取屏幕坐标 [left,top,w,h]（相对 canvas-wrap）的区域为 PNG dataURL。
     *  定位选区下覆盖的 page：遍历 viewerEl 的 .page，取与选区中心相交的那个。
     *  canvas 内部分辨率 != CSS 像素（pdf.js 按 devicePixelRatio 过采样），需按比例换算裁剪坐标。 */
    cropRegionToImage(left, top, w, h) {
      const pages = this.viewerEl.querySelectorAll('.page');
      if (!pages.length) throw new Error('PDF 未渲染');
      const wrapRect = this.wrap.getBoundingClientRect();
      const cx = left + w / 2;
      const cy = top + h / 2;
      // 选区中心所在的 page
      let targetPage = null;
      for (const pg of pages) {
        const r = pg.getBoundingClientRect();
        const localX = r.left - wrapRect.left;
        const localY = r.top - wrapRect.top;
        if (cx >= localX && cx <= localX + r.width && cy >= localY && cy <= localY + r.height) { targetPage = pg; break; }
      }
      if (!targetPage) throw new Error('请框选在页面范围内');
      const canvas = targetPage.querySelector('canvas');
      if (!canvas) throw new Error('页面未渲染（请等待加载完成）');
      const pageRect = targetPage.getBoundingClientRect();
      // 选区相对 page 的 CSS 坐标
      const selLeftInPage = left - (pageRect.left - wrapRect.left);
      const selTopInPage = top - (pageRect.top - wrapRect.top);
      // CSS → canvas 内部像素（pdf.js canvas.width 可能远大于 CSS 宽度）
      const scaleX = canvas.width / pageRect.width;
      const scaleY = canvas.height / pageRect.height;
      const sx = Math.max(0, Math.floor(selLeftInPage * scaleX));
      const sy = Math.max(0, Math.floor(selTopInPage * scaleY));
      const sw = Math.min(canvas.width - sx, Math.max(1, Math.floor(w * scaleX)));
      const sh = Math.min(canvas.height - sy, Math.max(1, Math.floor(h * scaleY)));
      // 限制输出尺寸（避免巨图撑爆 base64 / 请求体）；长边 ≤ 1568（OpenAI 视觉建议）
      const MAX_EDGE = 1568;
      let outW = sw, outH = sh;
      if (Math.max(sw, sh) > MAX_EDGE) {
        const k = MAX_EDGE / Math.max(sw, sh);
        outW = Math.round(sw * k); outH = Math.round(sh * k);
      }
      const out = document.createElement('canvas');
      out.width = outW; out.height = outH;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
      const dataURL = out.toDataURL('image/png');
      this._chatImages = this._chatImages || [];
      this._chatImages.push(dataURL);
      this.renderAttachChips();
      this.setStatus('已截图，输入问题后发送（视觉问答）');
      this.toggleChat(true);
    }
    /** 渲染附图 chip 行（composer context 容器内，可移除）。 */
    renderAttachChips() {
      const ctx = document.getElementById('rcd-mentions-row');
      if (!ctx) return;
      const imgs = this._chatImages || [];
      // 先移除旧附图 chip，保留 @ 引用 chip
      ctx.querySelectorAll('.chat-attach-chip').forEach((n) => n.remove());
      if (!imgs.length) return;
      const esc = (s) => String(s || '').replace(/"/g, '&quot;');
      ctx.insertAdjacentHTML('beforeend', imgs.map((src, i) => `<span class="chat-attach-chip"><img src="${esc(src)}" alt="附图 ${i + 1}"/><button class="ca-x" data-idx="${i}" type="button" aria-label="移除附图">×</button></span>`).join(''));
      ctx.querySelectorAll('.ca-x').forEach((b) => {
        b.onclick = () => {
          const idx = Number(b.dataset.idx);
          this._chatImages.splice(idx, 1);
          this.renderAttachChips();
          this.updateSendEnabled();
        };
      });
      this.updateSendEnabled();
    }
    /** 注入预置浮层 + 接线 @ 引用 chip 行（HTML 已含 .chat-composer-context 容器）。
     *  旧版向 .rcd-input-row 注入 presetsRow/mentionsRow；新版复用 #rcd-mentions-row 容器 + 快捷浮层。 */
    injectPresetAndMentionRows() {
      const composer = this.elChatDrawer.querySelector('#reader-chat-composer');
      if (!composer || composer.dataset.injected === '1') return;
      composer.dataset.injected = '1';
      const W = window;
      // 预置浮层（折叠式，点 #rcd-presets-btn 展开）
      const presets = (W.getChatPresets && W.getChatPresets()) || [];
      const pop = document.createElement('div');
      pop.className = 'chat-presets-pop rcd-presets-pop';
      pop.id = 'rcd-presets-pop';
      pop.hidden = true;
      pop.innerHTML = presets.map((pr) => `<button class="chat-preset-item" data-prompt="${(pr.prompt || '').replace(/"/g, '&quot;')}"><span>${(pr.label || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`).join('');
      composer.appendChild(pop);
      this.elPresetsPop = pop;
      const presetsBtn = this.elChatDrawer.querySelector('#rcd-presets-btn');
      if (presetsBtn) {
        presetsBtn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
        document.addEventListener('click', (e) => {
          if (!pop.hidden && !pop.contains(e.target) && e.target !== presetsBtn && !presetsBtn.contains(e.target)) pop.hidden = true;
        });
      }
      // 预置项点击 = 填入并发送
      pop.addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-preset-item');
        if (!btn) return;
        if (this.elChatInput) this.elChatInput.value = btn.dataset.prompt || '';
        pop.hidden = true;
        this.autoResizeInput();
        this.sendChat();
      });
      // @ 引用 chip 行容器（HTML 已建 #rcd-mentions-row）
      this.elMentionsRow = this.elChatDrawer.querySelector('#rcd-mentions-row');
      if (this.elMentionsRow) {
        this.elMentionsRow.addEventListener('click', (e) => {
          const x = e.target.closest('.extra-chip-x');
          if (!x) return;
          const eid = x.dataset.eid;
          this._chatExtraIds = (this._chatExtraIds || []).filter((i) => i !== eid);
          this.renderExtraIdsRow();
        });
      }
      this._chatExtraIds = this._chatExtraIds || [];
      this.renderExtraIdsRow();
    }
    /** 渲染当前 _chatExtraIds 的 chip 行（composer context 容器内）。 */
    renderExtraIdsRow() {
      const row = this.elMentionsRow;
      if (!row) return;
      const ids = this._chatExtraIds || [];
      if (!ids.length) { row.innerHTML = ''; return; }
      const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      row.innerHTML = ids.map((id) => {
        const W = window;
        // 标题从 window 查（reader 无 state.papers），查不到用 id
        let title = id;
        const found = W.searchPapersForMention && W.searchPapersForMention('', this.paper && this.paper.id);
        if (found) { const m = found.find((x) => x.id === id); if (m && m.title) title = m.title; }
        const tc = W.truncateChatTitle ? W.truncateChatTitle(title, 20) : title.slice(0, 20);
        return `<span class="extra-chip" title="${esc(title)}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${esc(tc)}<button class="extra-chip-x" data-eid="${esc(id)}" type="button" aria-label="移除引用">×</button></span>`;
      }).join('');
    }
    /** @ 触发器：检测输入框光标前最近的 @，弹论文选择浮层（v2.7 共享版，经 window 桥）。 */
    handleMentionTrigger() {
      const input = this.elChatInput;
      if (!input || !this.paper) return;
      const W = window;
      if (!W.openChatMentionPicker) return;
      const val = input.value;
      const pos = input.selectionStart != null ? input.selectionStart : val.length;
      const before = val.slice(0, pos);
      const atIdx = before.lastIndexOf('@');
      if (atIdx < 0) { if (W.closeChatMentionPicker) W.closeChatMentionPicker(); return; }
      const charBefore = atIdx > 0 ? before[atIdx - 1] : ' ';
      if (charBefore && !/\s/.test(charBefore)) { if (W.closeChatMentionPicker) W.closeChatMentionPicker(); return; }
      const query = before.slice(atIdx + 1);
      if (query.includes('\n') || query.length > 40) { if (W.closeChatMentionPicker) W.closeChatMentionPicker(); return; }
      W.openChatMentionPicker(input, {
        excludeId: this.paper.id,
        selectedIds: this._chatExtraIds || [],
        onPick: (id) => {
          this._chatExtraIds = this._chatExtraIds || [];
          if (!this._chatExtraIds.includes(id)) this._chatExtraIds.push(id);
          this.renderExtraIdsRow();
          this.autoResizeInput();
          this.updateSendEnabled();
        },
      }, query, atIdx);
    }
    closeMentionPop() { const W = window; if (W.closeChatMentionPicker) W.closeChatMentionPicker(); }
    /** 注入参数浮层按钮（rcd-actions）+ 浮层（复用 app.js 的 wireChatParamsShell / CHAT_PARAM_FIELDS）。 */
    injectParamsButton() {
      if (this.elParamsBtn || !this.elChatDrawer) return;
      const W = window;
      if (!W.CHAT_PARAM_FIELDS || !W.getChatParams) return; // app.js 未就绪则跳过
      const actions = this.elChatDrawer.querySelector('.rcd-actions');
      const closeBtn = this.elChatDrawer.querySelector('#reader-chat-close');
      if (!actions || !closeBtn) return;
      const btn = document.createElement('button');
      btn.className = 'chat-params-btn rcd-params-btn';
      btn.id = 'rcd-params-btn';
      btn.type = 'button';
      btn.title = '模型参数';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg><span class="cp-badge"></span>';
      actions.insertBefore(btn, closeBtn);
      this.elParamsBtn = btn;
      // 浮层
      const pop = document.createElement('div');
      pop.className = 'chat-params-pop rcd-params-pop';
      pop.id = 'rcd-params-pop';
      pop.hidden = true;
      const cards = W.CHAT_PARAM_FIELDS.map((f) => {
        const inputHtml = f.kind === 'range'
          ? `<input type="range" class="pp-in" min="${f.min}" max="${f.max}" step="${f.step}" disabled />`
          : `<input type="number" class="pp-in" min="${f.min}" step="${f.step}" placeholder="不限" disabled />`;
        return `<div class="pp-card" data-key="${f.key}"><div class="pp-card-head"><span class="pp-label">${f.label}</span><b class="pp-val">默认</b><label class="pp-switch-wrap"><input type="checkbox" class="pp-switch" /><span class="pp-track"></span></label></div>${inputHtml}</div>`;
      }).join('');
      pop.innerHTML = '<div class="pp-title">模型参数 <span class="pp-hint">仅启用的参数随请求发送</span></div>' + cards;
      this.elChatDrawer.appendChild(pop);
      this.elParamsPop = pop;
      // 接线（复用 app.js 暴露的浮层接线逻辑）
      if (W.wireChatParamsShell) W.wireChatParamsShell('rcd-params-pop', 'rcd-params-btn');
      btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
      document.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.hidden = true;
      });
    }
    /** 输入框自动增高：按内容撑高，限制 1~8 行（超出滚动）。流式期间不动。 */
    autoResizeInput() {
      const ta = this.elChatInput;
      if (!ta || ta.disabled) return;
      ta.style.height = 'auto';                       // 先重置再测 scrollHeight，否则缩不回
      const lineH = 21;                                // ≈ 13.5px * 1.55 line-height
      const maxH = lineH * 8 + 18;                     // 8 行 + 上下 padding
      ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
      this.updateSendEnabled();
    }
    /** 发送键空输入禁用（流式中由 setSending 控制 morphing，此处跳过）。 */
    updateSendEnabled() {
      if (!this.elChatSend || this._chatBusy) return;
      const empty = !(this.elChatInput && (this.elChatInput.value || '').trim()) && !this.hasChatQuotes() && !this.hasChatImages();
      this.elChatSend.disabled = empty;
    }
    hasChatQuotes() { return Array.isArray(this._chatQuotes) && this._chatQuotes.length > 0; }
    hasChatImages() { return Array.isArray(this._chatImages) && this._chatImages.length > 0; }
    /** morphing 发送键：busy=true 变红方块停止图标；false 恢复箭头。 */
    setSending(busy) {
      const btn = this.elChatSend;
      if (!btn) return;
      btn.disabled = false;                            // 停止键始终可点
      btn.classList.toggle('sending', !!busy);
      btn.title = busy ? '停止生成' : '发送（Enter）';
      btn.setAttribute('aria-label', busy ? '停止生成' : '发送');
      btn.innerHTML = busy
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    }
    /** FAB（#reader-chat）纵向拖动：贴右侧、可拖到任意纵向位置，不随页面滚动变化。
     *  与点击共用一按钮：位移 > 4px 才进入拖动，拖动过的本次指针序列会吞掉随后的 click。
     *  位置持久化到 localStorage:reader-chat-fab-top；resize 时 clamp 进界防跑到屏外。
     *  机制仿 wireDrawerSplitter（setPointerCapture + body 类禁选文本）。 */
    wireFabDrag() {
      const fab = this.elChatBtn;
      if (!fab || fab.dataset.wired === '1') return;
      fab.dataset.wired = '1';
      const FAB_H = 44;                  // 按钮高度（须与 styles.css .reader-chat-fab 一致）
      const MARGIN = 8;                  // 离视口上下边的最小留白
      const BAR_H = 54;                  // 顶栏高度（= --rdr-bar-h），FAB 不能盖到顶栏上
      const KEY = 'reader-chat-fab-top';
      // clamp：top 合法区间 [顶栏下+留白, 视口高-按钮高-留白]
      const clampTop = (t) => Math.max(BAR_H + MARGIN, Math.min(window.innerHeight - FAB_H - MARGIN, t));
      // 恢复上次位置：有持久化值就用（先 clamp），否则保持 CSS 默认居中（不写内联样式）
      const saved = Number(localStorage.getItem(KEY));
      if (Number.isFinite(saved) && saved > 0) fab.style.top = clampTop(saved) + 'px';
      this._fabJustDragged = false;
      let startY = 0, startTop = 0, moved = false;
      fab.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;   // 仅左键
        e.preventDefault();
        fab.setPointerCapture(e.pointerId);
        document.body.classList.add('fab-dragging');
        startY = e.clientY;
        // 起点取当前实际渲染的 top（px），优先用内联，回退 getBoundingClientRect（相对视口）
        const inlineTop = parseFloat(fab.style.top);
        startTop = Number.isFinite(inlineTop) ? inlineTop : fab.getBoundingClientRect().top;
        moved = false;
        const move = (ev) => {
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dy) < 4) return;          // 4px 阈值后才算拖动
          moved = true;
          fab.classList.add('dragging');
          fab.style.top = clampTop(startTop + dy) + 'px';
        };
        const up = (ev) => {
          try { fab.releasePointerCapture(ev.pointerId); } catch {}
          document.body.classList.remove('fab-dragging');
          fab.classList.remove('dragging');
          if (moved) {
            // 持久化最终 top（取内联值，已 clamp）
            const finalTop = parseFloat(fab.style.top);
            if (Number.isFinite(finalTop)) localStorage.setItem(KEY, String(Math.round(finalTop)));
          }
          this._fabJustDragged = moved;                    // 供 onclick 守卫判断
          fab.removeEventListener('pointermove', move);
          fab.removeEventListener('pointerup', up);
          fab.removeEventListener('pointercancel', up);
        };
        fab.addEventListener('pointermove', move);
        fab.addEventListener('pointerup', up);
        fab.addEventListener('pointercancel', up);
      });
      // 缩窗时把当前 top 重新 clamp 进新视口高度，防按钮跑到屏外
      this._onFabResize = () => {
        const cur = parseFloat(fab.style.top);
        if (Number.isFinite(cur)) fab.style.top = clampTop(cur) + 'px';
      };
      window.addEventListener('resize', this._onFabResize);
    }
    /** 抽屉左侧 splitter：拖拽改变抽屉宽度（持久化 localStorage:reader-drawer-width）。 */
    wireDrawerSplitter() {
      const sp = document.getElementById('reader-drawer-splitter');
      const drawer = this.elChatDrawer;
      if (!sp || !drawer || sp.dataset.wired === '1') return;
      sp.dataset.wired = '1';
      // 恢复上次宽度
      const saved = Number(localStorage.getItem('reader-drawer-width'));
      if (saved && saved > 280) drawer.style.width = saved + 'px';
      const applyW = (w) => {
        const min = 300, max = Math.floor(window.innerWidth * 0.7);
        drawer.style.width = Math.max(min, Math.min(max, w)) + 'px';
      };
      sp.onpointerdown = (e) => {
        e.preventDefault();
        sp.setPointerCapture(e.pointerId);
        document.body.classList.add('is-resizing');
        const move = (ev) => {
          // 抽屉贴右，宽度 = 视口右边界 - 鼠标 x
          applyW(window.innerWidth - ev.clientX);
        };
        const up = (ev) => {
          const w = window.innerWidth - ev.clientX;
          applyW(w);
          localStorage.setItem('reader-drawer-width', String(Math.round(drawer.getBoundingClientRect().width)));
          document.body.classList.remove('is-resizing');
          sp.removeEventListener('pointermove', move);
          sp.removeEventListener('pointerup', up);
          sp.removeEventListener('pointercancel', up);
        };
        sp.addEventListener('pointermove', move);
        sp.addEventListener('pointerup', up);
        sp.addEventListener('pointercancel', up);
      };
      sp.onkeydown = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const cur = drawer.getBoundingClientRect().width;
        applyW(cur + (e.key === 'ArrowLeft' ? 32 : -32));
        localStorage.setItem('reader-drawer-width', String(Math.round(drawer.getBoundingClientRect().width)));
      };
    }
    /** 打开/关闭抽屉；首次打开时拉取已有聊天历史渲染。 */
    async toggleChat(force) {
      const open = force != null ? force : !this._chatOpen;
      this._chatOpen = open;
      this.elChatDrawer.hidden = !open;
      this.elChatBtn.classList.toggle('active', open);
      this.view.classList.toggle('chat-open', open);   // 抽屉开时隐藏 FAB（避免重叠）
      if (!open) {
        this.toggleChatOutline(false);             // 关抽屉时一并关大纲浮窗
        this.closeMentionPop();                    // 关 @ 引用浮层
        if (this.elParamsPop) this.elParamsPop.hidden = true; // 关参数浮层
        if (this._chatClose) { try { this._chatClose(); } catch {} this._chatClose = null; this._chatBusy = false; } // 关闭 EventSource 流
      }
      if (open && this.elChatList && this.elChatList.dataset.loaded !== '1') {
        this.elChatList.dataset.loaded = '1';
        await this.loadChatHistory();
      }
      if (open) {
        // 打开时校准输入框高度 + 发送键状态（草稿可能已存在）
        this.autoResizeInput();
        this.updateSendEnabled();
      }
    }
    /** 抽屉的「问答大纲」浮窗：列出每个用户提问（Q1/Q2…），点击实时重查 #reader-chat-list 跳转。
     *  与 app.js 的 toggleChatOutline 同构；条目从 this.paper 的 chat（或已渲染 DOM 的 user 消息）取。
     *  open 不传则切换；点 mask/关闭/跳转后关闭。
     *  v2.7 修复：浮窗 position:fixed 挂 body，锚定视口右上——不再随抽屉滚动消失/跟随。 */
    toggleChatOutline(open) {
      const existing = document.querySelector('body > .chat-outline-pop');
      const mask = document.querySelector('body > .co-mask');
      // open === false（显式关）：无条件关闭。open === true（显式开）：仅已关时创建。
      // open == null（toggle）：已开则关、未开则开。
      if (open === false) { if (existing) existing.remove(); if (mask) mask.remove(); return; }
      if (existing) {
        if (open !== true) { existing.remove(); if (mask) mask.remove(); }
        return;
      }
      // 条目来源：优先 DOM 里已渲染的 user 消息（索引=其在 .chat-msg 序列中的位置），与 data-mi 对齐
      const list = document.getElementById('reader-chat-list');
      if (!list) return;
      const rows = [...list.querySelectorAll('.chat-msg')];
      const items = [];
      rows.forEach((el) => {
        if (el.classList.contains('user')) {
          items.push({ mi: Number(el.getAttribute('data-mi')), q: (el.textContent || '').trim() });
        }
      });
      if (!items.length) { this.setStatus('还没有对话'); return; }

      const pop = document.createElement('div');
      pop.className = 'chat-outline-pop fixed';
      pop.innerHTML = `<div class="co-head">
        <span>问答大纲<span class="co-count"> · ${items.length} 个问题</span></span>
        <button class="co-close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg></button>
      </div><div class="co-list"></div>`;
      const coList = pop.querySelector('.co-list');
      const trunc = (s, max = 24) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max) + '…' : (t || '（空问题）'); };
      items.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = 'co-item';
        row.innerHTML = `<span class="co-q">Q${idx + 1}</span><span class="co-title"></span>`;
        row.querySelector('.co-title').textContent = trunc(it.q);
        row.onclick = () => {
          // 实时重查目标节点（renderChatList/切论文可能已重建 list）
          const liveList = document.getElementById('reader-chat-list');
          const target = liveList && liveList.querySelector('.chat-msg[data-mi="' + it.mi + '"]');
          if (target) {
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
            setTimeout(() => target.classList.remove('flash'), 800);
          }
          this.toggleChatOutline(false);
        };
        coList.appendChild(row);
      });
      pop.querySelector('.co-close').onclick = () => this.toggleChatOutline(false);
      const m = document.createElement('div');
      m.className = 'co-mask';
      m.onclick = () => this.toggleChatOutline(false);
      document.body.appendChild(m);
      document.body.appendChild(pop);
    }
    async loadChatHistory() {
      if (!this.paper) return;
      try {
        const r = await fetch(sp('/api/papers/' + encodeURIComponent(this.paper.id))).then((x) => x.json());
        this.renderChatList((r.data && r.data.chat) || []);
      } catch { /* ignore */ }
    }
    /** 切换论文时重置聊天抽屉：中止流式、清空消息列表/草稿/划线引用/@chips/附图 chips，
     *  并清掉 dataset.loaded 一次性标记（否则新论文历史永不加载）。
     *  抽屉当前开着则立即拉取新论文历史（此时 this.paper 已是新论文）。 */
    _resetChatState() {
      if (this._chatClose) { try { this._chatClose(); } catch {} this._chatClose = null; }
      this._chatBusy = false;
      this._chatQuotes = []; this.renderQuotes();
      this._chatExtraIds = []; this.renderExtraIdsRow();
      this._chatImages = []; this.renderAttachChips();
      this.setSending(false);
      if (this.elChatInput) { this.elChatInput.value = ''; this.elChatInput.disabled = false; this.autoResizeInput(); }
      this.updateSendEnabled();
      if (this.elChatList) {
        delete this.elChatList.dataset.loaded;
        this.elChatList.innerHTML = this.chatEmptyHtml();
        if (this._chatOpen) {
          this.elChatList.dataset.loaded = '1';
          this.loadChatHistory();
        }
      }
      // 笔记侧栏：换论文后若正停在笔记页则立即重载（停在聊天页则下次切笔记页时按 paperId 不匹配自动重载）
      if (this._notesPanel && this.paper && this._drawerSeg === 'notes') this._notesPanel.load(this.paper.id);
    }
    renderChatList(msgs) {
      if (!this.elChatList) return;
      if (!msgs.length) {
        this.elChatList.innerHTML = this.chatEmptyHtml();
        return;
      }
      // 用 app.js 暴露的全宽扁平消息渲染（含 markdown/公式/时间戳/操作按钮）
      const W = window;
      const html = msgs.map((m, i) => {
        const regenerable = i === msgs.length - 1 && m.role === 'assistant';
        return W.chatMsgHtml ? W.chatMsgHtml(m, i, { regenerable }) : this.chatMsgHtml(m, i);
      }).join('');
      // 加滚动到底部 FAB
      const fab = '<button class="scroll-bottom-btn" id="reader-chat-scroll-bottom" title="滚动到底部" aria-label="滚动到底部"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>';
      this.elChatList.innerHTML = html + fab;
      this.elChatList.scrollTop = this.elChatList.scrollHeight;
      this.wireDrawerExtras();
    }
    /** 空状态：提示 + 建议卡片（复用 app.js 的 chatEmptyHtml，或本地兜底） */
    chatEmptyHtml() {
      const W = window;
      if (W.chatEmptyHtml) return W.chatEmptyHtml();
      return '<div class="rcd-empty">向 AI 提问关于这篇论文的问题</div>';
    }
    /** 兜底渲染（app.js 未加载时）：纯文本。正常走 window.chatMsgHtml。 */
    chatMsgHtml(m, i) {
      const content = (m.content || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br/>');
      const mi = i != null ? ` data-mi="${i}"` : '';
      return `<div class="chat-msg ${m.role}"${mi}><div class="chat-bubble">${content}</div></div>`;
    }
    /** 接线抽屉的滚动FAB + 消息操作（复制/重新生成/编辑/删除/显示原文）+ 代码块复制/展开 */
    async wireDrawerExtras() {
      const list = this.elChatList;
      if (!list) return;
      const fab = list.querySelector('#reader-chat-scroll-bottom');
      if (fab) {
        const update = () => {
          const near = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
          fab.classList.toggle('show', !near && list.scrollHeight > list.clientHeight + 50);
        };
        list.addEventListener('scroll', update, { passive: true });
        update();
        fab.onclick = () => list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
      }
      // 消息操作 + 代码块操作（事件委托）
      if (!list.dataset.wired) {
        list.dataset.wired = '1';
        list.addEventListener('click', async (e) => {
          // —— 代码块复制 / 展开 ——
          const cbCopy = e.target.closest('.cb-copy');
          if (cbCopy) {
            const card = cbCopy.closest('.cb-card');
            const pre = card && card.querySelector('pre');
            const text = pre ? pre.textContent : '';
            if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(() => { cbCopy.classList.add('copied'); const sp = cbCopy.querySelector('span'); if (sp) sp.textContent = '已复制'; setTimeout(() => { cbCopy.classList.remove('copied'); const sp2 = cbCopy.querySelector('span'); if (sp2) sp2.textContent = '复制'; }, 1200); }).catch(() => {});
            return;
          }
          const cbExp = e.target.closest('.cb-expand');
          if (cbExp) { const card = cbExp.closest('.cb-card'); if (card) card.classList.remove('collapsed'); return; }
          // —— 消息操作 ——
          const act = e.target.closest('.chat-act');
          if (!act) return;
          const mi = Number(act.dataset.mi);
          if (act.dataset.act === 'copy') {
            // 从 DOM 取正文（不依赖 this.paper.chat——首次发送前它为空，历史消息复制会失败）。
            const msg = act.closest('.chat-msg');
            const content = msg ? msg.querySelector('.chat-content') : null;
            const text = content ? content.textContent : '';
            if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(() => this.setStatus('已复制')).catch(() => {});
          } else if (act.dataset.act === 'regen') {
            this.regenerate();
          } else if (act.dataset.act === 'note') {
            // 存入笔记：GET 最新 chat（this.paper.chat 可能滞后，沿用 copy 的 freshness 考量），
            // 取该回答 + 前溯最近 user 作问题 → 问答卡（拷贝语义）。走 app.js 的 window 桥。
            if (!this.paper) return;
            try {
              const r = await fetch(sp('/api/papers/' + encodeURIComponent(this.paper.id))).then((x) => x.json());
              const chat = (r.data && r.data.chat) || [];
              const msg = chat[mi];
              if (!msg) { this.setStatus('消息不存在', true); return; }
              let q = '';
              for (let k = mi - 1; k >= 0; k--) {
                if (chat[k] && chat[k].role === 'user') { q = chat[k].content || ''; break; }
              }
              const W = window;
              const okSave = W.saveQaCardToNotes
                ? await W.saveQaCardToNotes(this.paper.id, { question: q, answer: msg.content || '', mi })
                : false;
              this.setStatus(okSave ? '已存入笔记' : '存入笔记失败', !okSave);
            } catch { this.setStatus('存入笔记失败', true); }
          } else if (act.dataset.act === 'source') {
            // 切换显示原文 ⇄ 渲染态
            const node = act.closest('.chat-msg');
            if (!node) return;
            const isRaw = node.getAttribute('data-show-source') === '1';
            node.setAttribute('data-show-source', isRaw ? '0' : '1');
            act.title = isRaw ? '显示原文' : '显示渲染';
          } else if (act.dataset.act === 'edit') {
            // 编辑：把 user 消息内容填回输入框（reader 用简化版：不截断历史，用户改完手动重新提问）
            const msg = (this.paper && this.paper.chat && this.paper.chat[mi]) || null;
            if (!msg) return;
            if (this._chatBusy) { this.setStatus('请等当前回答完成'); return; }
            if (this.elChatInput) this.elChatInput.value = msg.content || '';
            this.autoResizeInput();
            this.setStatus('已载入，修改后按发送');
          } else if (act.dataset.act === 'delete') {
            if (this._chatBusy) { this.setStatus('请等当前回答完成'); return; }
            const chat = (this.paper && this.paper.chat) || [];
            const msg = chat[mi];
            if (!msg) return;
            const cut = [mi];
            if (msg.role === 'user' && chat[mi + 1] && chat[mi + 1].role === 'assistant') cut.push(mi + 1);
            if (!confirm('删除这条消息？' + (cut.length > 1 ? '（及其回复也会删除）' : ''))) return;
            const next = chat.filter((_, idx) => !cut.includes(idx));
            try {
              await fetch(sp('/api/papers/' + encodeURIComponent(this.paper.id)), {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: next }),
              }).then((r) => r.json());
              if (this.paper) this.paper.chat = next;
              this.renderChatList(next);
            } catch { /* ignore */ }
          }
        });
      }
    }
    async sendChat(opts) {
      opts = opts || {};
      if (!this.paper || !this.elChatInput) return;
      // 流式中点发送键（已 morphing 为停止键）= 中止生成
      if (this._chatBusy) {
        if (this._chatClose) { try { this._chatClose(); } catch {} }
        this._chatBusy = false;
        this._chatClose = null;
        this.setSending(false);
        this.updateSendEnabled();
        this.elChatInput.disabled = false;
        return;
      }
      const regenerate = !!opts.regenerate;
      const userText = regenerate ? '' : (this.elChatInput.value || '').trim();
      if (!userText && !regenerate) return;
      // 合并引用 badge 文本作为上下文（划线 Ctrl+L 添加的），拼到问题前发给 AI
      const message = regenerate ? '' : (this.getChatQuotesBlock() + userText);
      // @ 引用论文（输入框 @ 添加的其它论文，联合问答）
      const extraIds = regenerate ? [] : (this._chatExtraIds || []).slice();
      // Phase 3 附图（框选截图）：本次发送携带，发送后清空 chip
      const sendImages = regenerate ? [] : (this._chatImages || []).slice();
      const useVision = sendImages.length > 0;
      this._chatBusy = true;
      const myPaperId = this.paper.id;                 // 锁定本次请求所属论文，切换后响应作废
      const reasoningStart = Date.now();
      // 关闭上一个 EventSource（若有），再开新的。_chatClose 是 streamChatFetch 返回的中止函数。
      if (this._chatClose) { try { this._chatClose(); } catch {} }
      let myClose = null;
      // 立即清输入 + 锁定（状态先于 UI）+ 清空引用 badge / 附图（已发送）
      if (!regenerate) {
        this.elChatInput.value = '';
        this._chatQuotes = []; this.renderQuotes();   // 引用已并入消息发送，清空 badge
        this._chatExtraIds = []; this.renderExtraIdsRow(); // @ 引用已发送，清空 chip
        this._chatImages = []; this.renderAttachChips();   // 附图已发送，清空 chip
      }
      // 发送键 morphing：变红方块停止
      this.setSending(true);
      this.elChatInput.disabled = true;
      // 乐观追加 user 消息（重新生成跳过）。视觉问答时回显附图缩略图。
      if (!opts.skipUserMsg) {
        const userMsg = { role: 'user', content: message };
        if (extraIds.length) userMsg.extraIds = extraIds;
        if (sendImages.length) userMsg.images = sendImages;
        this.appendChatById('reader-chat-list', userMsg);
      }
      // 占位 assistant 消息：skeleton shimmer（带 req 标记，首 token 后逐字 renderMd 重渲）
      const W = window;
      const placeholder = document.createElement('div');
      placeholder.className = 'chat-msg assistant';
      placeholder.dataset.req = '1';
      const roleHtml = W.CHAT_ROLE_ICO
        ? `<div class="chat-role"><span class="chat-role-ico">${W.CHAT_ROLE_ICO.assistant}</span><span class="chat-role-label">AI</span></div><div class="chat-body"><div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div></div>`
        : '<div class="chat-body"><div class="chat-bubble thinking-skeleton"><div class="chat-content thinking"><span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span></div></div></div>';
      placeholder.innerHTML = roleHtml;
      const phList = document.getElementById('reader-chat-list');
      if (phList) { phList.appendChild(placeholder); phList.scrollTop = phList.scrollHeight; }

      // 流式渲染：用 renderMd（markdown/公式），与详情 tab 一致
      let accumulated = '';
      let accumulatedReasoning = '';  // 思考过程（reasoning_content）
      const getBubble = () => {
        const livePh = document.querySelector('#reader-chat-list .chat-msg.assistant[data-req="1"]');
        return livePh ? livePh.querySelector('.chat-bubble') : null;
      };
      const renderMdSafe = (md) => (W.renderMd ? W.renderMd(md) : (md || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br/>'));
      // 智能「跟随底部」：用户向上滚阅读时，新 token 不再把视图拽到底；滚回底部附近则恢复跟随。
      const listEl = document.getElementById('reader-chat-list');
      let stickBottom = true;
      const onStreamScroll = () => {
        if (!listEl) return;
        const near = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
        stickBottom = near;
      };
      if (listEl) listEl.addEventListener('scroll', onStreamScroll, { passive: true });
      // 仅在 stickBottom 时滚到底；发给 UI 的状态由 scroll 监听维护
      const scrollIfStuck = () => { if (listEl && stickBottom) listEl.scrollTop = listEl.scrollHeight; };
      const renderAccumulated = () => {
        const bubble = getBubble();
        if (!bubble) return;
        // 首 token：skeleton → streaming 气泡
        bubble.classList.remove('thinking-skeleton');
        bubble.classList.add('streaming');
        let content = bubble.querySelector('.chat-content');
        if (!content) { content = document.createElement('div'); content.className = 'chat-content streaming'; bubble.appendChild(content); }
        content.classList.remove('thinking');
        content.classList.add('streaming');
        content.innerHTML = renderMdSafe(accumulated);
        scrollIfStuck();
      };
      // 思考过程渲染：在正文上方显示可折叠的思考区
      const renderReasoning = () => {
        const livePh = document.querySelector('#reader-chat-list .chat-msg.assistant[data-req="1"]');
        if (!livePh) return;
        const body = livePh.querySelector('.chat-body');
        if (!body) return;
        let reasoningEl = body.querySelector('.chat-reasoning');
        if (!reasoningEl) {
          reasoningEl = document.createElement('div');
          reasoningEl.className = 'chat-reasoning';
          body.insertBefore(reasoningEl, body.firstChild);
        }
        reasoningEl.innerHTML = '<details open><summary>思考中…</summary><div class="chat-reasoning-body"></div></details>';
        const rb = reasoningEl.querySelector('.chat-reasoning-body');
        if (rb) { rb.textContent = accumulatedReasoning; }
        scrollIfStuck();
      };
      const finish = (restore) => {
        const stale = !(this.paper && this.paper.id === myPaperId);
        const ph = document.querySelector('#reader-chat-list .chat-msg.assistant[data-req="1"]');
        if (ph) ph.removeAttribute('data-req');
        if (listEl) listEl.removeEventListener('scroll', onStreamScroll);
        if (!stale) {
          this._chatBusy = false;
          this._chatClose = null;
          this.setSending(false);
          this.updateSendEnabled();
          this.elChatInput.disabled = false;
          if (restore) { try { this.elChatInput.focus(); } catch {} }
        }
      };

      myClose = this.streamChatFetch(myPaperId, message, {
        regenerate,
        extraIds: extraIds.length ? extraIds : undefined,
        images: useVision ? sendImages : undefined,
        onToken: (t, kind) => {
          if (!(this.paper && this.paper.id === myPaperId)) { try { myClose(); } catch {} return; }
          if (kind === 'reasoning') {
            // 思考过程：实时显示在可折叠思考区，不计入正式回答
            accumulatedReasoning += t;
            renderReasoning();
            return;
          }
          accumulated += t;
          renderAccumulated();
        },
        onDone: (data) => {
          if (!(this.paper && this.paper.id === myPaperId)) return;
          // 用服务端权威 chat 更新本地（供复制/重新生成读取）
          if (data && Array.isArray(data.chat)) this.paper.chat = data.chat;
          // 重渲最后一条 assistant 为定型结构（含时间戳 + 复制 + 重新生成按钮），补全流式占位缺失的字段
          if (data && data.reply != null) {
            accumulated = data.reply;
            const W = window;
            const livePh = document.querySelector('#reader-chat-list .chat-msg.assistant[data-req="1"]');
            if (livePh && W.chatMsgHtml && this.paper.chat && this.paper.chat.length) {
              const lastMsg = this.paper.chat[this.paper.chat.length - 1];
              const mi = Number(livePh.dataset.mi || 0);
              const hadReasoning = !!accumulatedReasoning;
              const tmp = document.createElement('div');
              tmp.innerHTML = W.chatMsgHtml(lastMsg, mi, { regenerable: true });
              if (tmp.firstElementChild) {
                livePh.replaceWith(tmp.firstElementChild);
                // 思考过程：完成后自动收起 + 显示「思考了 X 秒」
                if (hadReasoning) {
                  const newBody = tmp.firstElementChild.querySelector('.chat-body');
                  if (newBody) {
                    const dur = Math.max(1, Math.round((Date.now() - reasoningStart) / 1000));
                    const rEl = document.createElement('div');
                    rEl.className = 'chat-reasoning';
                    rEl.innerHTML = `<details><summary><span class="rs-label">思考过程</span><span class="rs-duration">思考了 ${dur} 秒</span></summary><div class="chat-reasoning-body"></div></details>`;
                    rEl.querySelector('.chat-reasoning-body').textContent = accumulatedReasoning;
                    newBody.insertBefore(rEl, newBody.firstChild);
                  }
                }
              }
            } else {
              renderAccumulated();
            }
          }
          if (!accumulated) {
            const bubble = getBubble();
            if (bubble) {
              bubble.classList.remove('thinking-skeleton', 'streaming');
              let cc = bubble.querySelector('.chat-content');
              if (!cc) { cc = document.createElement('div'); cc.className = 'chat-content'; bubble.appendChild(cc); }
              cc.classList.remove('thinking', 'streaming');
              cc.textContent = '（无回复）';
            }
          }
          finish(true);
        },
        onFail: (err) => {
          if (!(this.paper && this.paper.id === myPaperId)) return;
          if (!accumulated) {
            const bubble = getBubble();
            if (bubble) {
              bubble.classList.remove('thinking-skeleton', 'streaming');
              let cc = bubble.querySelector('.chat-content');
              if (!cc) { cc = document.createElement('div'); cc.className = 'chat-content'; bubble.appendChild(cc); }
              cc.classList.remove('thinking', 'streaming');
              cc.textContent = '（' + (err || 'AI 回答失败') + '）';
            }
          }
          finish(true);
        },
      });
      this._chatClose = myClose;
    }
    /** 重新生成最后一条 assistant 回答 */
    regenerate() {
      if (this._chatBusy) { this.setStatus('请等当前回答完成'); return; }
      const list = this.elChatList;
      if (!list) return;
      const msgs = [...list.querySelectorAll('.chat-msg')];
      const lastUser = [...msgs].reverse().find((m) => m.classList.contains('user'));
      const lastAssistant = [...msgs].reverse().find((m) => m.classList.contains('assistant'));
      if (lastAssistant) lastAssistant.remove();
      if (lastUser) lastUser.remove();
      this.sendChat({ regenerate: true, skipUserMsg: true });
    }
    /** 流式读取 AI 对话（抽屉版）：GET /api/papers/:id/chat?message=（EventSource，discover 同款）。
     *  与 app.js streamChatFetch 同构（reader.js 是独立 ESM，无法 import app.js，故复制一份）。
     *  返回 close() 中止函数。POST+fetch SSE 在浏览器有挂起问题，故统一用 EventSource。
     *  事件 token/done/fail（避免 error 防 EventSource 原生 error 误判 + 自动重连）。 */
    streamChatFetch(paperId, message, { onToken, onDone, onFail, regenerate, extraIds, images } = {}) {
      const W = window;
      // Phase 3 视觉问答：带图片走 POST /chat/vision（fetch + ReadableStream，EventSource 无法带 body）
      if (Array.isArray(images) && images.length) {
        return this.streamVisionFetch(paperId, message, { onToken, onDone, onFail, regenerate, extraIds, images });
      }
      const params = new URLSearchParams();
      if (message) params.set('message', message);
      if (regenerate) params.set('regenerate', '1');
      // @ 引用论文（逗号分隔透传）
      if (Array.isArray(extraIds) && extraIds.length) params.set('extraIds', extraIds.join(','));
      // 透传模型参数（复用 app.js 暴露的 getChatParams）
      const cp = (W.getChatParams && W.getChatParams()) || {};
      for (const k of ['thinking', 'temperature', 'topP', 'maxTokens']) {
        const v = cp[k];
        if (v == null || v === '') continue;
        // thinking 是字符串（enabled/disabled），其余是数值
        if (k === 'thinking') { if (v === 'enabled' || v === 'disabled') params.set(k, v); continue; }
        if (!Number.isNaN(v)) params.set(k, String(v));
      }
      // Phase 2 模型切换：透传选中模型（复用 app.js 暴露的 getSelectedModel）
      const selModel = W.getSelectedModel ? W.getSelectedModel() : '';
      if (selModel) params.set('model', selModel);
      const url = sp('/api/papers/' + encodeURIComponent(paperId) + '/chat?' + params.toString());
      const es = new EventSource(url);
      let finished = false;
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
        if (finished) return;
        finished = true;
        try { es.close(); } catch {}
        if (typeof onFail === 'function') onFail('连接中断，请重试');
      };
      return () => { finished = true; try { es.close(); } catch {} };
    }
    /** Phase 3 视觉问答流式：POST /api/papers/:id/chat/vision（fetch + ReadableStream 解析 SSE）。
     *  EventSource 无法携带 body（图片 base64），故视觉问答走 fetch 流。
     *  事件协议与 GET /chat 一致（token/done/fail），手动按 \n\n 分块解析。
     *  返回 close() 中止函数（AbortController.abort）。 */
    streamVisionFetch(paperId, message, { onToken, onDone, onFail, regenerate, extraIds, images } = {}) {
      const W = window;
      const cp = (W.getChatParams && W.getChatParams()) || {};
      const chatParams = {};
      // thinking 透传字符串（router 转对象），其余为数值
      if (cp.thinking === 'enabled' || cp.thinking === 'disabled') chatParams.thinking = cp.thinking;
      for (const k of ['temperature', 'topP']) {
        if (cp[k] != null && cp[k] !== '' && !Number.isNaN(cp[k])) chatParams[k] = Number(cp[k]);
      }
      if (cp.maxTokens != null && cp.maxTokens !== '' && !Number.isNaN(cp.maxTokens)) chatParams.maxTokens = parseInt(cp.maxTokens, 10);
      const selModel = W.getSelectedModel ? W.getSelectedModel() : '';
      if (selModel) chatParams.model = selModel;
      const body = JSON.stringify({
        message: message || '',
        regenerate: !!regenerate,
        extraIds: Array.isArray(extraIds) && extraIds.length ? extraIds : undefined,
        images: Array.isArray(images) ? images : [],
        chatParams,
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
    /** 按 elementId 实时重查目标节点追加消息（绝不用 stale 闭包引用）。
     *  reader 抽屉虽无 10s 定时刷新，但切换论文/重开抽屉会清空 list，故同样用实时重查保稳健。
     *  全宽扁平结构：优先用 app.js 暴露的 window.chatMsgHtml（含 markdown/角色/时间戳），兜底本地纯文本。 */
    appendChatById(elementId, m) {
      const list = document.getElementById(elementId);
      if (!list) return;
      const empty = list.querySelector('.rcd-empty, .chat-empty');
      if (empty) empty.remove();
      const mi = list.querySelectorAll('.chat-msg').length;
      const W = window;
      const html = W.chatMsgHtml ? W.chatMsgHtml(m, mi) : this.chatMsgHtml(m, mi);
      // 保留 FAB（若存在）
      const fab = list.querySelector('.scroll-bottom-btn');
      if (fab) fab.insertAdjacentHTML('beforebegin', html);
      else list.insertAdjacentHTML('beforeend', html);
      list.scrollTop = list.scrollHeight;
    }
    appendChat(m) { this.appendChatById('reader-chat-list', m); }

    async open(paper, readProgress, annotations) {
      // 换论文：重置聊天抽屉。reader 是单例（app.js 只 new 一次），#reader-chat-list 等
      // DOM 跨论文复用——不重置会残留上一篇的消息/草稿/chips，且 dataset.loaded 一次性
      // 标记会让新论文的聊天历史永不加载（表现为「chat 没有历史记录/串台」）。
      const switchingPaper = !this.paper || this.paper.id !== paper.id;
      this.paper = paper;
      if (switchingPaper) this._resetChatState();
      // 文字清晰度（综合 SO 高赞方案的完整技术，核心是「过采样 + 高质量降采样」缺一不可）：
      //   ① pdf.js 的 OutputScale 直接读 window.devicePixelRatio 决定 canvas 内部分辨率。
      //     双页模式每页 CSS 显示仅 ~675px，论文密集小字若 canvas 也只 675px(1:1) 会发糊。
      //     需让 canvas 渲染到更高分辨率(2x=1350px)，再由浏览器缩小到 675px 显示。
      //   ② 但仅过采样不够——浏览器默认 bilinear(平滑)缩小会把文字边缘糊化(之前 2x 仍糊的根因)。
      //     必须配合 CSS image-rendering/text-rendering(见 styles.css .page canvas) 用高质量算法降采样。
      //   ③ 取 max(真实 dpr, 2)：dpr=1 普通屏→2x 过采样刚好不锯齿；dpr≥2 高清屏→用真实值不浪费不过锐。
      //     (固定 3x 在 dpr=1 屏会过度缩小失真出锯齿。)
      this._origDpr = window.devicePixelRatio;
      const targetDpr = Math.max(window.devicePixelRatio, 2);
      if (window.devicePixelRatio !== targetDpr) {
        try { Object.defineProperty(window, 'devicePixelRatio', { value: targetDpr, configurable: true }); }
        catch { /* 部分浏览器不可写，忽略 */ }
      }
      readProgress = readProgress || {};
      this._pendingAnnotations = annotations || null;
      this._annotationsDirty = false;
      this._suppressAnnotationDirty = false;
      this._initialFitDone = false;   // 每次打开重置（实例跨多次打开复用），保证 pagesinit/afterReady 的 fit 守卫正确
      this.elTitle.textContent = paper.title || paper.filename;
      this.view.classList.add('active');
      document.body.style.overflow = 'hidden';
      // 重开前彻底拆除上一篇：清空旧画布(避免闪现上一篇PDF)+ 移除上次的监听器(避免叠加泄漏)
      // await：teardown 现在是 async（save=false 时内部只 await 一个已 resolve 的 promise，开销可忽略），
      // 确保 viewer/doc 销毁完成后再加载新 PDF。
      await this._teardown(false);
      this.setStatus('加载中…', true);
      // 显示加载遮罩（旧画布已清，期间只见底色+spinner，不再有旧PDF）
      const loadingEl = this.wrap.querySelector('#reader-loading');
      if (loadingEl) loadingEl.classList.remove('done');

      // PDF 原文：必须带 ?space= 让 server.js 从该空间绑定的文件夹解析（filename 跨空间可能重复）
      const url = sp('/papers/' + encodeURIComponent(paper.filename));
      try {
        const task = pdfjsLib.getDocument({ url, isEvalSupported: false, disableAutoFetch: false });
        this.doc = await task.promise;
      } catch (e) {
        this.setStatus('PDF 加载失败', true);
        return;
      }
      this.elPageTotal.textContent = '/ ' + this.total;   // total 由 get total() 从 doc 读取

      this.eventBus = new EventBus();
      this.linkService = new SimpleLinkService({ eventBus: this.eventBus, externalLinkTarget: 2 });
      this.viewer = new PDFViewer({
        container: this.wrap,
        viewer: this.viewerEl,
        eventBus: this.eventBus,
        linkService: this.linkService,
        textLayerMode: 1,                  // ENABLE：文字可选
        annotationMode: 2,                 // ENABLE_FORMS
        annotationEditorMode: ANNOT_EDITOR_INIT_MODE,
        // 高亮色用更浅更通透的色值（pdf.js 高亮默认 opacity=1 无法改运行时，靠选浅色呈现半透明感）
        annotationEditorHighlightColors: 'yellow=#fde68a,green=#bbf7d0,blue=#bfdbfe,purple=#ddd6fe,pink=#fbcfe8,red=#fecdd3,cyan=#a5f3fc',
        // 关掉原生浮动高亮按钮：它点击时会丢失选区且样式简陋，改用自建选区浮窗（见 setupSelectionPopup）
        enableHighlightFloatingButton: false,
        // 清晰度：放开 canvas 像素上限（默认 5242880，超过则 onlyCssZoom 低清 CSS 缩放→发糊）。
        // 设为很大的值（≈1亿）使常见论文页不会触发限制，pdf.js 按当前缩放×devicePixelRatio
        // 全分辨率渲染，文字锐利。（注意：设 0 反而强制 onlyCssZoom，故用大数而非 0。）
        maxCanvasPixels: 100000000,
        removePageBorders: false,          // 保留 pdf.js 默认页边框计算（hPadding≠0），避免 spread 模式下 getVisibleElements 水平裁剪误判右页不可见导致空白
        imageResourcesPath: '/vendor/images/',
        l10n: undefined,
        enableScripting: false,
      });
      this.linkService.setViewer(this.viewer);

      // UI manager 就绪时缓存引用 + 挂批注变更监听
      this.eventBus.on('annotationeditoruimanager', ({ uiManager }) => {
        this.uiManager = uiManager;
        // 新增/修改 → 防抖保存。回灌历史批注时会临时 suppress，避免打开即覆盖。
        if (this.doc && this.doc.annotationStorage) {
          this.doc.annotationStorage.onSetModified = () => {
            if (!this._suppressAnnotationDirty) this.scheduleSaveAnnotations();
          };
        }
      });
      // 编辑器状态变化只同步 UI。保存只由真实新增/修改/删除触发，避免打开或选中时写空批注。
      this.eventBus.on('annotationeditorstateschanged', () => {
        if (this.curTool === 'highlight' && this.uiManager && this.uiManager.hasSelection) {
          setTimeout(() => {
            if (this.curTool !== 'highlight' || !this.uiManager || !this.uiManager.hasSelection) return;
            this.clearAnnotationSelection();
          }, 0);
        }
        this.updateDeleteButton();
      });
      // 首屏渲染前：先把跨页+缩放定好，让页面一开始就按全宽尺寸渲染。
      // 避免"先按默认100%渲染显示、pagesloaded 再跳到fit"造成的打开闪烁；
      // 也从源头消除"渲染中途改缩放"导致的空白页竞态。这是 pdf.js 官方 viewer 的标准时机。
      this.eventBus.on('pagesinit', () => {
        this.applySpread(true);
        this.fitToWidth();
        this._initialFitDone = true;
        this.updateZoomLabel();
      });
      // 页面全部就绪
      this.eventBus.on('pagesloaded', () => this.afterReady(readProgress));
      // 批注编辑模式变化（切工具）→ 仅更新按钮态
      this.eventBus.on('annotationeditormodechanged', ({ mode }) => this.onEditorModeChanged(mode));
      // 关键桥接：独立使用 PDFViewer（无完整 PDFViewerApplication）时，pdf.js 内部 switchToMode
      // 只会 dispatch 'showannotationeditorui' 等待外层把模式落到 viewer 上。没有这个监听器，
      // uiManager.highlightSelection() 在浏览(NONE)模式下切 HIGHLIGHT 的回调永不触发 → 选区高亮失败。
      // 这正是"选区浮窗/原生浮动按钮点击不高亮"的根因。
      this.eventBus.on('showannotationeditorui', ({ mode }) => {
        try { this.viewer.annotationEditorMode = { mode }; } catch {}
      });
      // 缩放变化（含 pdf.js 内部触发）→ 同步百分比标签
      this.eventBus.on('scalechanging', () => this.updateZoomLabel());
      // 页面渲染完成：①兜底推进渲染链（spread 第二页空白修复）②回显该页已存批注
      this.eventBus.on('pagerendered', ({ pageNumber }) => {
        this._ensureRender(0);
        this.restorePageAnnotations(pageNumber - 1);
      });
      // 页码变化 → 更新输入框 + 防抖存进度 + 防抖存批注
      this.eventBus.on('pagechanging', ({ pageNumber }) => {
        this.elPageInput.value = pageNumber;
        this.scheduleSaveProgress();
      });
      this._onScroll = () => {
        this.scheduleSaveProgress();
        this.hideSelectionPopup();      // 滚动时收起浮窗
        this.clearAnnotationSelection();
      };
      this.wrap.addEventListener('scroll', this._onScroll, { passive: true });
      // Ctrl/Cmd + 滚轮缩放；窗口大小变化时若在 fit 状态重新自适应
      this._onWheel = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? +0.15 : -0.15);
      };
      this.wrap.addEventListener('wheel', this._onWheel, { passive: false });
      // 触控双指缩放（PDFViewer 无内置 pinch，需手算距离比值 → currentScale）
      this._pinchStartDist = 0;
      this._pinchStartScale = 1;
      this._onTouchStart = (e) => {
        if (e.touches.length !== 2) return;
        this._pinchStartDist = this._touchDist(e);
        this._pinchStartScale = this.viewer ? this.viewer.currentScale : 1;
        this._fitMode = false;
      };
      this._onTouchMove = (e) => {
        if (e.touches.length !== 2 || !this._pinchStartDist || !this.viewer) return;
        e.preventDefault();              // 阻止浏览器原生双指缩放，与手算叠加会抖动
        const ratio = this._touchDist(e) / this._pinchStartDist;
        const next = Math.max(0.5, Math.min(4, +(this._pinchStartScale * ratio).toFixed(3)));
        this.viewer.currentScaleValue = String(next);
        this.updateZoomLabel();
      };
      this._onTouchEnd = (e) => { if (e.touches.length < 2) this._pinchStartDist = 0; };
      this.wrap.addEventListener('touchstart', this._onTouchStart, { passive: true });
      this.wrap.addEventListener('touchmove', this._onTouchMove, { passive: false });
      this.wrap.addEventListener('touchend', this._onTouchEnd, { passive: true });
      // 窗口尺寸变化 → fit 状态下防抖重排
      this._onResize = () => {
        if (!this._fitMode) return;
        if (this._resizeTimer) clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this.fitToWidth(), 120);
      };
      window.addEventListener('resize', this._onResize);

      this.setupSelectionPopup();
      this.setupAnnotationPointerGuards();
      this.loadTranslateConfig();   // 拉划线翻译设置（显隐翻译按钮）

      this.linkService.setDocument(this.doc);
      await this.viewer.setDocument(this.doc);
      // 加载遮罩在 afterReady（页面已渲染）才隐藏，避免过早露出空白画布
    }

    afterReady(readProgress) {
      // 跨页+缩放通常已在 pagesinit 完成（避免闪烁）。这里仅兜底：万一 pagesinit 没跑或未拿到页宽，补一次。
      if (!this._initialFitDone) {
        this.applySpread(true);
        this.fitToWidth();
      }
      this.updateZoomLabel();
      const startPage = (readProgress && readProgress.page) || 1;
      this.viewer.scrollPageIntoView({ pageNumber: startPage });
      // 灌回批注（pagesloaded 后 annotationStorage 已就绪）
      this.loadAnnotations(this._pendingAnnotations);
      this._pendingAnnotations = null;
      // drawLayer/layer 异步就绪，延迟重试扫描未回显的页（解决 layer 尚未就绪的竞态）
      this._annotRetry = setTimeout(() => this.retryPendingAnnotations(), 800);
      this._annotRetry2 = setTimeout(() => this.retryPendingAnnotations(), 2000);
      // 默认光标模式（浏览，非批注）
      this.setTool('cursor');
      // 恢复页内偏移
      if (readProgress && readProgress.scrollTop) {
        setTimeout(() => {
          const pv = this.viewer.getPageView(startPage - 1);
          if (pv && pv.div) {
            const top = pv.div.offsetTop - this.wrap.offsetTop;
            this.wrap.scrollTop = top + readProgress.scrollTop;
          }
        }, 80);
      }
      this.setStatus('已就绪');
      // 隐藏(而非移除)加载遮罩：保留元素，重开时复用（移除后重开就没遮罩了）
      const loading = this.wrap.querySelector('#reader-loading');
      if (loading) loading.classList.add('done');
      // 兜底：spread 模式下第二页常因初始渲染链未推进而空白，延迟强制再渲一轮可见页
      this._ensureRender(120);
      this._ensureRender(400);
    }

    /** 修复 spread/初始加载时的空白页。
     *  根因：pdf.js 在"初始渲染进行中遇到 fitToWidth 缩放变更"时，偶发把页标记为
     *  RenderingStates.FINISHED(3) 却没有 canvas（见 PDFPageView #finishRenderTask / update 的取消路径）。
     *  渲染队列只渲染 INITIAL 页，FINISHED 页被永久跳过 → 该页一直空白，必须滚动触发 reset 才重渲。
     *  这里主动找出"可见 + FINISHED + 无 canvas"的坏状态页，reset() 使其回到 INITIAL 重新入队，再 update()。 */
    _ensureRender(delay = 0) {
      if (!this.viewer) return;
      const run = () => {
        const v = this.viewer;
        if (!v || !v._pages) return;
        try {
          const visible = typeof v._getVisiblePages === 'function' ? v._getVisiblePages() : null;
          const ids = visible && visible.views ? new Set(visible.views.map((x) => x.id)) : null;
          for (const pv of v._pages) {
            if (!pv) continue;
            if (ids && !ids.has(pv.id)) continue;             // 只管可见页
            const hasCanvas = !!(pv.canvas || (pv.div && pv.div.querySelector('canvas')));
            // renderingState: INITIAL=0 RUNNING=1 PAUSED=2 FINISHED=3。只 reset "已完成却无 canvas"的坏页，
            // 不动 RUNNING(渲染中)/INITIAL(将自然渲染)，避免误伤正常页。
            // 关键：reset 保留批注/文本/编辑层，只重建 canvas，绝不删除已有高亮/便签（否则会"高亮失败/消失"）。
            if (pv.renderingState === 3 && !hasCanvas) {
              try { pv.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepXfaLayer: true, keepTextLayer: true }); } catch {}
            }
          }
        } catch {}
        try {
          if (typeof v.update === 'function') v.update();
          else if (v.renderingQueue) v.renderingQueue.renderHighestPriority(v._getVisiblePages && v._getVisiblePages());
        } catch {}
      };
      if (delay > 0) setTimeout(run, delay); else run();
    }

    /** 适应宽度：让 N 列页面恰好铺满容器内容区。
     *  关键修复：pdf.js 实际渲染宽 = pageW_pt × scale × PDF_TO_CSS，所以 scale 必须用
     *  CSS 像素宽（pageW_pt × PDF_TO_CSS）做分母；旧版用 pt 宽，scale 偏大 1.333 倍导致溢出。
     *  容器宽用 clientWidth（已排除滚动条），配合 CSS scrollbar-gutter:stable 始终稳定，无需再猜滚动条宽。 */
    fitToWidth() {
      if (!this.viewer || !this.doc) return;
      this.hideSelectionPopup();
      this.clearAnnotationSelection();
      const pv = this.viewer.getPageView(0);
      if (!pv || !pv.pdfPage) { this.viewer.currentScaleValue = 'page-width'; this._fitMode = true; return; }
      const containerW = this.wrap.clientWidth;
      if (!containerW) { requestAnimationFrame(() => this.fitToWidth()); return; }
      const cols = this.spread ? 2 : 1;
      // 取首个 spread 内最宽页（论文一般等宽，仍兜底取两页最大值）
      let maxPt = pv.pdfPage.getViewport({ scale: 1 }).width;
      if (cols > 1) {
        const pv2 = this.viewer.getPageView(1);
        if (pv2 && pv2.pdfPage) maxPt = Math.max(maxPt, pv2.pdfPage.getViewport({ scale: 1 }).width);
      }
      const pageWcss = maxPt * PDF_TO_CSS;
      const margins = cols * 2 * PAGE_MARGIN;   // 每页两侧 margin-inline 合计
      const padding = 12;                        // #viewer 左右 padding 各 6px（见 styles.css）
      const avail = containerW - margins - padding;
      const scale = Math.max(0.25, Math.min(5, avail / (cols * pageWcss)));
      this.viewer.currentScaleValue = String(+scale.toFixed(4));
      this._fitMode = true;
      this.updateZoomLabel();
    }

    // 兼容旧调用名
    fitSpread() { this.fitToWidth(); }

    /** 计算两指间欧氏距离（pinch 缩放用） */
    _touchDist(e) {
      const t = e.touches;
      if (!t || t.length < 2) return 0;
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    }

    isTypingTarget(target) {
      if (!target) return false;
      if (target.isContentEditable) return true;
      return !!(target.closest && target.closest('input, textarea, select, [contenteditable]'));
    }

    /** 切批注工具。cursor 是用户侧“选择”模式，底层借用 FREETEXT 让已有批注可点选。 */
    setTool(mode) {
      this.curTool = mode;
      this._selectMode = mode === 'cursor';
      this.hideSelectionPopup();
      if (!this.viewer) return;
      const map = {
        cursor: AnnotationEditorType.FREETEXT,
        highlight: AnnotationEditorType.HIGHLIGHT,
        note: AnnotationEditorType.FREETEXT,
        ink: AnnotationEditorType.INK,
      };
      const target = map[mode] != null ? map[mode] : AnnotationEditorType.NONE;
      if (this.uiManager) {
        if (this._selectMode) {
          try { this.uiManager.commitOrRemove(); } catch {}
        } else {
          this.clearAnnotationSelection();
        }
      }
      try {
        this.viewer.annotationEditorMode = { mode: target };
      } catch {}  // UIManager 未就绪时静默（afterReady 会再调一次）
      this.syncToolButtons(mode);
      this.syncToolModeClasses();
      // 调色板仅在高亮/手写时显示，并把当前色应用到对应参数
      if (this.colorsEl) this.colorsEl.classList.toggle('show', mode === 'highlight' || mode === 'ink');
      if (mode === 'highlight' || mode === 'ink') this.applyColor(this.curColor);
      this.updateDeleteButton();
      // 点击工具直接切换，不再弹右侧文字说明（按用户要求精简交互）
    }

    onEditorModeChanged(mode) {
      // 同步按钮态（如用户用 ESC 退出编辑）
      const reverse = {};
      reverse[AnnotationEditorType.NONE] = 'cursor';
      reverse[AnnotationEditorType.HIGHLIGHT] = 'highlight';
      reverse[AnnotationEditorType.FREETEXT] = 'note';
      reverse[AnnotationEditorType.INK] = 'ink';
      this.curTool = (this._selectMode && mode === AnnotationEditorType.FREETEXT) ? 'cursor' : (reverse[mode] || 'cursor');
      if (this.curTool !== 'cursor') this._selectMode = false;
      this.syncToolButtons(this.curTool);
      this.syncToolModeClasses();
      this.updateDeleteButton();
      if (this.colorsEl) this.colorsEl.classList.toggle('show', this.curTool === 'highlight' || this.curTool === 'ink');
      // 选区快捷高亮：等真正进入 HIGHLIGHT 模式（高亮已创建）后，再切回目标工具，
      // 这样无论模式切换走同步还是异步路径都不会竞态（旧版固定延时会抢在创建前切回）。
      if (mode === AnnotationEditorType.HIGHLIGHT && this._afterHiTool) {
        const t = this._afterHiTool; this._afterHiTool = null;
        setTimeout(() => this.setTool(t), 60);
      }
    }

    syncToolButtons(mode) {
      const btns = { cursor: this.toolCursor, highlight: this.toolHighlight, note: this.toolNote, ink: this.toolInk };
      Object.entries(btns).forEach(([m, b]) => { if (b) b.classList.toggle('active', m === mode); });
    }

    syncToolModeClasses() {
      if (!this.view) return;
      this.view.classList.toggle('reader-selecting', this.curTool === 'cursor');
      this.view.classList.toggle('reader-highlighting', this.curTool === 'highlight');
    }

    /** 把颜色应用到 pdf.js 批注参数。高亮工具/选区浮窗用 HIGHLIGHT_DEFAULT_COLOR；手写用 INK_COLOR。 */
    applyColor(color, kind) {
      this.curColor = color;
      if (!this.uiManager || !AnnotationEditorParamsType) return;
      kind = kind || (this.curTool === 'ink' ? 'ink' : 'highlight');
      try {
        if (kind === 'ink') this.uiManager.updateParams(AnnotationEditorParamsType.INK_COLOR, color);
        else this.uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR, color);
      } catch {}
    }

    /** 删除当前选中的批注。只能从“选择”工具触发，避免高亮模式承担删除语义。 */
    deleteSelectedEditors() {
      if (!this.uiManager) return false;
      try {
        if (this.curTool !== 'cursor') {
          this.setStatus('请先切到「选择」模式，点选批注后再删除', true);
          return false;
        }
        // hasSelection 才是"点选中了批注"的可靠判定（getActive 只表示"正在编辑中"）。
        const hasSel = this.uiManager.hasSelection;
        if (!hasSel) {
          this.setStatus('选择模式下点选要删除的批注，再点删除', true);
          return false;
        }
        this.uiManager.delete();
        // pdf.js 的 annotationStorage.onSetModified 只在"新增/修改"时触发、删除时不触发，
        // 故这里显式调度保存，否则删除要等到下次滚动/关闭才落盘（曾导致"删了又回来"）。
        this.scheduleSaveAnnotations(true);
        this.setStatus('已删除批注');
        this.updateDeleteButton();
        return true;
      } catch { return false; }
    }

    /** 同步工具栏删除按钮的可用态：有选中才可点（视觉上更清晰，也避免误点）。 */
    updateDeleteButton() {
      if (!this.toolDelete) return;
      const enabled = this.curTool === 'cursor' && !!(this.uiManager && this.uiManager.hasSelection);
      this.toolDelete.classList.toggle('available', enabled);
      this.toolDelete.setAttribute('aria-disabled', String(!enabled));
      this.toolDelete.title = enabled ? '删除选中的批注' : '选择模式下点选批注后删除';
    }

    /** 退出已有批注的选中态：pdf.js 会同步隐藏原生浮窗，并移除 selectedEditor 边框。 */
    clearAnnotationSelection() {
      const hadSelection = !!(this.uiManager && this.uiManager.hasSelection);
      if (hadSelection) {
        try { this.uiManager.unselectAll(); } catch {}
      }
      this.updateDeleteButton();
      return hadSelection;
    }

    setupAnnotationPointerGuards() {
      this._onAnnotGuardDown = (e) => this.guardAnnotationPointer(e);
      this._onAnnotGuardUp = (e) => this.guardAnnotationPointer(e);
      this._onAnnotToolbarClick = (e) => this.handleAnnotationToolbarClick(e);
      this.wrap.addEventListener('pointerdown', this._onAnnotGuardDown, true);
      this.wrap.addEventListener('pointerup', this._onAnnotGuardUp, true);
      this.wrap.addEventListener('click', this._onAnnotToolbarClick, true);
    }

    handleAnnotationToolbarClick(e) {
      const target = e.target;
      if (!target || !target.closest) return;
      const colorChoice = target.closest('.editToolbar .colorPicker .dropdown button');
      if (colorChoice) {
        setTimeout(() => {
          this.clearAnnotationSelection();
          this.scheduleSaveAnnotations(true);
        }, 260);
        return;
      }
      const del = target.closest('.editToolbar .delete');
      if (!del) return;
      if (this.curTool !== 'cursor') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setStatus('请先切到「选择」模式，点选批注后再删除', true);
        return;
      }
      setTimeout(() => this.scheduleSaveAnnotations(true), 120);
    }

    guardAnnotationPointer(e) {
      const target = e.target;
      if (!target || !target.closest) return;
      if (target.closest('.editToolbar')) return;

      const editor = target.closest('.highlightEditor, .freeTextEditor, .inkEditor, .stampEditor');
      if (this.curTool === 'highlight' && editor) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (this.curTool !== 'cursor' || editor) return;

      if (e.type === 'pointerdown') this.clearAnnotationSelection();

      const layer = target.closest('.annotationEditorLayer');
      if (!layer) return;
      // 选择模式底层借用 FREETEXT；拦截空白点击，避免误新增便签。
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'pointerdown') {
        try { layer.focus({ preventScroll: true }); } catch {}
      }
    }

    applySpread(skipFit) {
      if (!this.viewer) return;
      this.hideSelectionPopup();
      this.clearAnnotationSelection();
      this.viewer.spreadMode = this.spread ? SpreadMode.ODD : SpreadMode.NONE;
      if (this.elSpread) {
        this.elSpread.textContent = this.spread ? '双页' : '单页';
        this.elSpread.classList.toggle('active', this.spread);
      }
      // 切换列数后重新自适应宽度。skipFit：初始化(afterReady)时由调用方统一 fit 一次，
      // 避免这里的延时 fit 与 afterReady 的直接 fit 形成 double-fit（第二次改 scale 会取消第二页在途渲染）。
      if (this._fitMode && !skipFit) {
        setTimeout(() => { this.fitToWidth(); this._ensureRender(60); }, 30);
      }
    }

    zoomBy(delta) {
      if (!this.viewer) return;
      this.hideSelectionPopup();
      this.clearAnnotationSelection();
      this._fitMode = false;                      // 手动缩放退出 fit 模式
      const next = Math.max(0.25, Math.min(5, +(this.viewer.currentScale + delta).toFixed(2)));
      this.viewer.currentScaleValue = String(next);
      this.updateZoomLabel();
    }

    updateZoomLabel() {
      if (this.viewer && this.elZoomLabel) {
        this.elZoomLabel.textContent = Math.round(this.viewer.currentScale * 100) + '%';
        this.elZoomLabel.classList.toggle('fit', this._fitMode);
      }
    }

    scrollToPage(no) {
      if (!this.viewer) return;
      no = Math.max(1, Math.min(this.total, no | 0));
      this.viewer.scrollPageIntoView({ pageNumber: no });
    }

    rerender() { this.updateZoomLabel(); } // 兼容旧 API

    get page() { return this.viewer ? this.viewer.currentPageNumber : 1; }
    get total() { return this.doc ? this.doc.numPages : 0; }
    get scale() { return this.viewer ? this.viewer.currentScale : 1.2; }
    set scale(v) { if (this.viewer) { this._fitMode = false; this.viewer.currentScaleValue = String(v); } this.updateZoomLabel(); }

    // ---- 状态条（带防抖恢复，避免一直停在临时提示上）----
    setStatus(text, sticky) {
      if (!this.elSaved) return;
      this.elSaved.textContent = text;
      if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
      if (!sticky) {
        this._statusTimer = setTimeout(() => {
          if (this.elSaved) this.elSaved.textContent = this.paper ? '第 ' + this.page + ' / ' + this.total + ' 页' : '';
        }, 2600);
      }
    }

    // ====================================================================
    // 选区浮窗（自建，替代 pdf.js 原生浮动高亮按钮）
    // ====================================================================
    setupSelectionPopup() {
      // 文本选完（pointerup）→ 短延时后判断是否展示浮窗
      this._onSelUp = (e) => {
        if (this._pop && this._pop.contains(e.target)) return;
        setTimeout(() => { this.maybeShowSelectionPopup(); this.updateDeleteButton(); }, 10);
      };
      // 重新交互（在内容区按下，且不在浮窗上）→ 收起
      this._onSelDown = (e) => {
        if (this._pop && this._pop.contains(e.target)) return;
        this.hideSelectionPopup();
      };
      this.wrap.addEventListener('pointerup', this._onSelUp);
      this.wrap.addEventListener('pointerdown', this._onSelDown);
    }

    ensureSelectionPopup() {
      if (this._pop) return this._pop;
      const pop = document.createElement('div');
      pop.className = 'reader-sel-pop';
      pop.hidden = true;
      const swatches = HL_COLORS
        .map((c) => `<button class="rsp-color" type="button" data-color="${c}" style="--c:${c}" title="高亮"></button>`)
        .join('');
      pop.innerHTML =
        '<div class="rsp-inner">' +
          '<span class="rsp-swatches">' + swatches + '</span>' +
          '<span class="rsp-sep"></span>' +
          '<button class="rsp-act" type="button" data-act="ai" title="划线问 AI（基于所选文字提问）">' + ICON.ai + '</button>' +
          '<button class="rsp-act" type="button" data-act="translate" title="翻译所选文字（按设置中的引擎）" id="rsp-translate" hidden>' + ICON.translate + '</button>' +
          '<button class="rsp-act" type="button" data-act="note" title="高亮并添加便签">' + ICON.note + '</button>' +
          '<button class="rsp-act" type="button" data-act="copy" title="复制所选文字">' + ICON.copy + '</button>' +
        '</div>' +
        '<span class="rsp-caret"></span>';
      // 关键：在浮窗上按下时阻止默认，保住文本选区（否则点击会清空 selection 导致高亮失败）
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      pop.addEventListener('pointerdown', (e) => e.preventDefault());
      pop.addEventListener('click', (e) => {
        const cbtn = e.target.closest('.rsp-color');
        if (cbtn) { this.quickHighlight(cbtn.dataset.color); return; }
        const abtn = e.target.closest('.rsp-act');
        if (!abtn) return;
        if (abtn.dataset.act === 'copy') this.copySelection();
        else if (abtn.dataset.act === 'translate') this.translateSelection();
        else if (abtn.dataset.act === 'note') this.quickHighlight(this.curColor, true);
        else if (abtn.dataset.act === 'ai') this.askSelection();
      });
      this.view.appendChild(pop);
      this._pop = pop;
      // 翻译按钮显隐：open 时 loadTranslateConfig 先跑、按钮此时才懒创建，
      // 故创建后立即按已加载的 _translateCfg 同步一次（engine=none 隐藏，其余显示）
      const trBtn = pop.querySelector('#rsp-translate');
      if (trBtn) trBtn.hidden = (this._translateCfg && this._translateCfg.engine) === 'none';
      return pop;
    }

    maybeShowSelectionPopup() {
      // 仅浏览（cursor）模式下展示；其它工具有各自交互
      if (this.curTool !== 'cursor') { this.hideSelectionPopup(); return; }
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { this.hideSelectionPopup(); return; }
      const anchor = sel.anchorNode;
      if (!anchor || !this.viewerEl.contains(anchor)) { this.hideSelectionPopup(); return; }
      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { return; }
      if (!rect || (!rect.width && !rect.height)) return;
      this.showSelectionPopup(rect);
    }

    showSelectionPopup(rect) {
      const pop = this.ensureSelectionPopup();
      pop.hidden = false;
      pop.classList.remove('below');
      // 先显示再量尺寸
      const pw = pop.offsetWidth || 240;
      const ph = pop.offsetHeight || 44;
      const vw = window.innerWidth;
      let left = rect.left + rect.width / 2 - pw / 2;
      left = Math.max(10, Math.min(vw - pw - 10, left));
      let top = rect.top - ph - 12;
      let below = false;
      if (top < 56) { top = rect.bottom + 12; below = true; }   // 顶部空间不足（避开工具栏）→ 放选区下方
      pop.classList.toggle('below', below);
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      // 小箭头对准选区中心
      const caretX = rect.left + rect.width / 2 - left;
      pop.style.setProperty('--caret-x', Math.max(14, Math.min(pw - 14, caretX)) + 'px');
      requestAnimationFrame(() => pop.classList.add('show'));
    }

    hideSelectionPopup() {
      // 翻译浮层与选区浮窗同生命周期：滚动/缩放/翻页/重交互时一并收起
      this.cancelTranslate();
      if (!this._pop || this._pop.hidden) return;
      this._pop.classList.remove('show');
      this._pop.hidden = true;
    }

    /** 选区快捷高亮：保住选区后用 pdf.js 内部方法真正创建高亮编辑器。 */
    quickHighlight(color, alsoNote) {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) { this.hideSelectionPopup(); return; }
      if (!this.uiManager) { this.setStatus('批注未就绪'); return; }
      const ranges = [];
      for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
      const targetTool = alsoNote ? 'note' : 'cursor';
      this.hideSelectionPopup();
      this.applyColor(color, 'highlight');
      // 选择工具底层是 FREETEXT，pdf.js 的 highlightSelection 必须等 HIGHLIGHT 模式落到 layer 后再调用。
      this._afterHiTool = null;
      try {
        if (this.viewer) {
          this._selectMode = false;
          this.viewer.annotationEditorMode = { mode: AnnotationEditorType.HIGHLIGHT };
          this.curTool = 'highlight';
          this.syncToolButtons('highlight');
          this.syncToolModeClasses();
        }
      } catch {}
      setTimeout(() => {
        try {
          const current = document.getSelection();
          if (current && ranges.length) {
            current.removeAllRanges();
            for (const range of ranges) current.addRange(range);
          }
          this.applyColor(color, 'highlight');
          this.uiManager.highlightSelection('floating_button');
          this.scheduleSaveAnnotations(true);
          this.setStatus(alsoNote ? '已高亮 · 点击页面位置添加便签' : '已高亮');
          setTimeout(() => this.setTool(targetTool), 160);
        } catch {
          this.setStatus('高亮失败，请重试', true);
          this.setTool('cursor');
        }
      }, 90);
    }

    copySelection() {
      const txt = document.getSelection().toString();
      if (txt && navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(() => this.setStatus('已复制所选文字')).catch(() => {});
      } else if (txt) {
        this.setStatus('已选择文字（剪贴板不可用）');
      }
      this.hideSelectionPopup();
    }

    /** 划线问 AI：取所选文字，打开聊天抽屉，以「请解释/分析这段内容」为问题发送。
     *  短选区直接问；长选区（>200 字）截断包裹，避免消息过长。 */
    async askSelection() {
      const txt = (document.getSelection().toString() || '').trim();
      this.hideSelectionPopup();
      if (!txt) { this.setStatus('未选中文本'); return; }
      if (!this.paper) return;
      await this.toggleChat(true); // 确保抽屉打开（首次会拉历史）
      const snippet = txt.length > 200 ? txt.slice(0, 200) + '…' : txt;
      const question = '论文里有这段内容，请解释/分析：\n\n' + snippet;
      if (this.elChatInput) this.elChatInput.value = question;
      // 直接发送（用户也可在发送前编辑输入框内容）
      this.sendChat();
    }

    /** 翻译选区文字：统一以浮窗展示译文（不跳转外链）。
     *  - engine=ai：浮窗内流式渲染 AI 译文（SSE，不离开页面）
     *  - engine=google：浮窗内显示 Google 译文（RESTful，服务端调免费端点，秒回）
     *  - engine=bing：浮窗内显示原文 + 「打开外部翻译」链接（Bing 无稳定免费端点，需抓 token，暂走外链）
     *  - engine=none：不应到这（按钮已隐藏） */
    translateSelection() {
      const raw = (document.getSelection().toString() || '').trim();
      if (!raw) { this.setStatus('未选中文本'); return; }
      const txt = this.cleanTranslateText(raw);   // 剔除 PDF 排版换行（行宽截断产生的假换行）
      const cfg = this._translateCfg || { engine: 'google', targetLang: 'zh-CN' };
      if (cfg.engine === 'none') { this.setStatus('划线翻译已关闭（设置中可开启）'); return; }
      let rect;
      try { rect = document.getSelection().getRangeAt(0).getBoundingClientRect(); } catch {}
      if (!rect || (!rect.width && !rect.height)) rect = { left: window.innerWidth / 2, top: 120, width: 0, bottom: 120 };
      this.hideSelectionPopup();
      if (cfg.engine === 'bing') {
        // Bing：无稳定免费端点（需抓 JWT token + 地区重定向），暂走外链兜底
        const tl = encodeURIComponent(cfg.targetLang || 'zh-CN');
        const q = encodeURIComponent(txt);
        const extUrl = `https://www.bing.com/translator?from=&to=${tl}&text=${q}`;
        this.showTranslatePanel(rect, txt, { external: true, extUrl, engineName: '必应 Bing 翻译' });
      } else {
        // ai / google：都走后端浮窗（ai=SSE 流式，google=RESTful JSON）
        this.showTranslatePanel(rect, txt, { engine: cfg.engine || 'ai' });
      }
    }
    /** 清理 PDF 排版换行：提交给翻译引擎前剔除行宽截断产生的假换行。
     *  PDF 文本层每行结尾的 \n 是排版产物（行宽不够折到下一行），不是真正的句子断开。
     *  - 连字符断词（opti-\nmization）→ 直接接回（去 \n 不加空格）
     *  - 行内换行（同一句折行）→ 换成空格（CJK 与 CJK 之间不加空格，避免译文词间距怪异）
     *  - 真正的段落分隔（\n\n+）→ 保留为单个换行，让译文也有段落感
     *  注意：原文预览（浮窗外链模式）也用清理后的文本，与提交给引擎的文本一致。 */
    cleanTranslateText(s) {
      if (!s) return s;
      // 1. 规范化换行：\r\n / \r → \n
      let t = s.replace(/\r\n?/g, '\n');
      // 2. 连字符断词：行尾 -\n → 接回（opti-\nmization → optimization，state-of-\nthe-art → state-of-the-art）
      //    仅当 - 紧贴 \n 且 \n 后是字母时，去掉 \n（保留 -，让词复原）
      t = t.replace(/-\n([A-Za-z])/g, '-$1');
      // 3. 段落分隔（\n\n+）先占位保护
      t = t.replace(/\n{2,}/g, '\u0000PARA\u0000');
      // 4. 行内换行（剩下的单个 \n）：行尾去空白后，按上下文决定拼接方式
      //    - 上行尾或下行首是 CJK → 直接接回（不加空格）
      //    - 否则 → 换成空格（西文词之间需要空格分隔）
      t = t.replace(/([^\n])\n([^\n])/g, (m, a, b) => {
        const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
        return (cjk.test(a) || cjk.test(b)) ? a + b : a + ' ' + b;
      });
      // 5. 还原段落分隔为单个换行（\u0000PARA\u0000 是上文段落占位符，禁用 control-regex 规则校验）
      t = t.replace(/\u0000PARA\u0000/g, '\n'); // eslint-disable-line no-control-regex
      // 6. 收尾：压缩多余空白
      return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    }
    /** 翻译浮窗：定位在选区附近，浮窗内显示译文（不跳转）。
     *  - opts.engine='ai'（默认）：SSE 流式（GET /api/translate?text=，EventSource），复用 renderMd。
     *  - opts.engine='google'：RESTful JSON（GET /api/translate?text=&engine=google，fetch），秒回。
     *  - opts.external=true（Bing）：显示原文预览 + 「打开外部翻译」按钮（无免费端点）。
     *  可关闭、可复制；滚轮/翻页/缩放时自动收起（同选区浮窗生命周期）。 */
    showTranslatePanel(rect, text, opts) {
      this.cancelTranslate(true);                     // 先关掉上一个（强制，含钉住态：新翻译替换旧钉住面板）
      const W = window;
      const cfg = this._translateCfg || { targetLang: 'zh-CN' };
      const langName = ({ 'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英文', ja: '日文', ko: '韩文', fr: '法文', de: '德文' })[cfg.targetLang] || cfg.targetLang;
      const external = !!(opts && opts.external);
      const engine = (opts && opts.engine) || 'ai';
      const loadingText = engine === 'google' ? 'Google 翻译中' : 'AI 正在翻译';
      const panel = document.createElement('div');
      panel.className = 'reader-tr-panel' + (external ? ' rtp-external' : '');
      panel.innerHTML =
        '<div class="rtp-head">' +
          '<span class="rtp-title">' + ICON.translate + '翻译为' + langName + '</span>' +
          '<div class="rtp-actions">' +
            (external ? '' : '<button class="rtp-act" type="button" data-act="copy" title="复制译文">' + ICON.copy + '</button>') +
            '<button class="rtp-act" type="button" data-act="pin" title="钉住（滚动/翻页时不自动收起，再点取消）">' + ICON.pin + '</button>' +
            '<button class="rtp-act" type="button" data-act="close" title="关闭"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
          '</div>' +
        '</div>' +
        '<div class="rtp-body"><div class="rtp-content thinking">' + (external ? '' : loadingText) + '</div></div>';
      this.view.appendChild(panel);
      this._trPanel = panel;
      this._trAccumulated = '';
      this._trPinned = false;          // 新翻译默认未钉住（showTranslatePanel 开头已 cancelTranslate 旧面板）
      const content = panel.querySelector('.rtp-content');
      const renderMdSafe = (md) => (W.renderMd ? W.renderMd(md) : (md || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br/>'));
      const escPlain = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br/>');
      // 定位（复用 showSelectionPopup 的策略：优先选区上方，空间不足放下方）
      const pw = 360, ph = 160;
      const vw = window.innerWidth;
      let left = rect.left + rect.width / 2 - pw / 2;
      left = Math.max(10, Math.min(vw - pw - 10, left));
      let top = rect.top - ph - 12;
      let below = false;
      if (top < 56) { top = rect.bottom + 12; below = true; }
      panel.classList.toggle('below', below);
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      requestAnimationFrame(() => panel.classList.add('show'));
      // 关闭（钉住态也能关：cancelTranslate(force) 强制移除）
      panel.querySelector('[data-act="close"]').onclick = () => this.cancelTranslate(true);
      // 钉住切换：钉住后滚动/翻页/缩放/重选不自动收起（cancelTranslate 不移除面板），再点取消
      panel.querySelector('[data-act="pin"]').onclick = (e) => {
        this._trPinned = !this._trPinned;
        const btn = e.currentTarget;
        btn.classList.toggle('active', this._trPinned);
        btn.title = this._trPinned ? '已钉住（点击取消，取消后滚动会自动收起）' : '钉住（滚动/翻页时不自动收起，再点取消）';
        this.setStatus(this._trPinned ? '已钉住翻译浮窗' : '已取消钉住');
      };
      // 复制按钮（ai/google 共用）
      if (!external) {
        panel.querySelector('[data-act="copy"]').onclick = () => {
          const t = (this._trAccumulated || content.textContent || '').trim();
          if (navigator.clipboard && t) navigator.clipboard.writeText(t).then(() => this.setStatus('已复制译文')).catch(() => {});
        };
      }
      // —— Bing 外链模式：原文预览 + 外链按钮 ——
      if (external) {
        content.classList.remove('thinking');
        const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
        content.innerHTML =
          '<div class="rtp-src">' + escPlain(preview) + '</div>' +
          '<a class="rtp-ext-link" href="' + opts.extUrl + '" target="_blank" rel="noopener">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
            '在 ' + opts.engineName + ' 中打开' +
          '</a>' +
          '<div class="rtp-ext-hint">外部引擎无法在浮窗内嵌入，点击在新标签页查看完整翻译</div>';
        this._trClose = null;
        return;
      }
      // —— Google：RESTful JSON（fetch，一次性返回完整译文，秒回）——
      if (engine === 'google') {
        const params = new URLSearchParams();
        params.set('text', text);
        params.set('engine', 'google');
        const ctrl = new AbortController();
        let settled = false;
        fetch(sp('/api/translate?' + params.toString()), { signal: ctrl.signal })
          .then((r) => r.json())
          .then((j) => {
            settled = true;
            if (j && j.ok === false) {
              content.classList.remove('thinking');
              content.textContent = '（' + (j.error || '翻译失败') + '）';
              return;
            }
            const reply = (j && j.data && j.data.reply) || '';
            this._trAccumulated = reply;
            content.classList.remove('thinking');
            content.innerHTML = reply ? escPlain(reply) : '（无译文）';
          })
          .catch((e) => {
            if (settled) return;
            content.classList.remove('thinking');
            const msg = (e && e.name === 'AbortError') ? '请求超时' : '翻译失败';
            content.textContent = '（' + msg + '）';
          });
        this._trClose = () => { try { ctrl.abort(); } catch {} };
        return;
      }
      // —— AI：SSE 流式（EventSource）——
      const params = new URLSearchParams();
      params.set('text', text);
      const url = sp('/api/translate?' + params.toString());
      const es = new EventSource(url);
      let finished = false;
      es.addEventListener('token', (e) => {
        let obj = null;
        try { obj = JSON.parse(e.data); } catch { return; }
        if (!obj || !obj.t) return;
        this._trAccumulated += obj.t;
        content.classList.remove('thinking');
        // try/catch 保护：流式中 _trAccumulated 是不完整片段（如半个公式 $$），
        // marked/katex 偶发抛异常，一旦抛出会中断回调让后续 token 全失效 → 永远「翻译中」。
        // 兜底：渲染失败时退化为纯文本（转义 + 换行），保证至少能看到译文。
        try {
          content.innerHTML = renderMdSafe(this._trAccumulated);
        } catch {
          content.textContent = '';
          content.innerHTML = escPlain(this._trAccumulated);
        }
        content.classList.add('streaming');
      });
      es.addEventListener('done', () => {
        finished = true;
        try { es.close(); } catch {}
        // 完成态最终渲染一次（完整片段，renderMd 通常不再抛）
        try { content.innerHTML = renderMdSafe(this._trAccumulated); } catch {}
        content.classList.remove('streaming');
        if (!this._trAccumulated.trim()) content.textContent = '（无译文）';
      });
      es.addEventListener('fail', (e) => {
        finished = true;
        try { es.close(); } catch {}
        let msg = '翻译失败';
        try { msg = JSON.parse(e.data).error || msg; } catch {}
        content.classList.remove('thinking', 'streaming');
        content.textContent = '（' + msg + '）';
      });
      es.onerror = () => {
        if (finished) return;
        finished = true;
        try { es.close(); } catch {}
        if (!this._trAccumulated) {
          content.classList.remove('thinking', 'streaming');
          content.textContent = '（连接中断，请重试）';
        } else {
          // 已收到部分译文：完成态渲染 + 去掉流式光标（连接断了但已有内容可读）
          try { content.innerHTML = renderMdSafe(this._trAccumulated); } catch {}
          content.classList.remove('streaming');
        }
      };
      this._trClose = () => { finished = true; try { es.close(); } catch {} };
    }
    /** 关闭翻译浮层 + 中止流。
     *  - force=false（默认，滚动/翻页/缩放/重选触发）：若已钉住（_trPinned），只中止流不移除面板，让译文常驻
     *  - force=true（点关闭键 / teardown / 切论文）：无论钉住与否都移除面板 */
    cancelTranslate(force) {
      if (this._trClose) { try { this._trClose(); } catch {} this._trClose = null; }
      if (this._trPinned && !force) return;   // 钉住态：中止流但保留面板（译文已落盘到 DOM）
      if (this._trPanel) { this._trPanel.remove(); this._trPanel = null; }
      this._trAccumulated = '';
      this._trPinned = false;
    }

    /** 添加划线引用 badge：选中文本以卡片形式加入对话框（非纯文本塞 textarea）。 */
    addChatQuote(text) {
      const t = String(text || '').trim();
      if (!t) return;
      if (!this._chatQuotes) this._chatQuotes = [];
      // 去重：已存在相同文本则不重复加
      if (this._chatQuotes.some((q) => q === t)) { this.setStatus('该段已添加'); return; }
      this._chatQuotes.push(t);
      this.renderQuotes();
      this.setStatus('已添加引用，输入问题后发送');
    }
    /** 渲染引用 badge 区。每个 badge：行数标签 + 截断文本 + × 删除。 */
    renderQuotes() {
      const box = document.getElementById('reader-chat-quotes');
      if (!box) return;
      const qs = this._chatQuotes || [];
      if (!qs.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = qs.map((q, i) => {
        const lines = q.split(/\r?\n/).filter(Boolean);
        const lineLabel = lines.length > 1 ? (lines.length + ' 行') : '1 行';
        return `<div class="rcd-quote"><span class="rcd-quote-tag">${lineLabel}</span><span class="rcd-quote-text"></span><button class="rcd-quote-x" data-qi="${i}" title="移除" aria-label="移除引用">×</button></div>`;
      }).join('');
      // textContent 设文本（防 XSS；DOMPurify 已加载但文本直接设最稳）
      [...box.querySelectorAll('.rcd-quote-text')].forEach((el, i) => { el.textContent = qs[i].replace(/\s+/g, ' ').slice(0, 120) + (qs[i].length > 120 ? '…' : ''); });
      // × 删除接线
      box.querySelectorAll('.rcd-quote-x').forEach((btn) => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.qi);
          this._chatQuotes.splice(idx, 1);
          this.renderQuotes();
        };
      });
    }
    /** 取所有引用文本拼成上下文（发送时拼到问题前）。 */
    getChatQuotesBlock() {
      const qs = this._chatQuotes || [];
      if (!qs.length) return '';
      return qs.map((q, i) => `【引用${i + 1}】\n${q}`).join('\n\n') + '\n\n';
    }

    /** 拉取划线翻译设置（engine + targetLang），更新选区浮窗的翻译按钮显隐。仅在 open 时拉一次。 */
    async loadTranslateConfig() {
      try {
        const r = await fetch(sp('/api/settings')).then((x) => x.json());
        const t = (r.data && r.data.translate) || {};
        this._translateCfg = { engine: t.engine || 'google', targetLang: t.targetLang || 'zh-CN' };
      } catch { this._translateCfg = { engine: 'google', targetLang: 'zh-CN' }; }
      // 按设置显隐翻译按钮（engine=none 隐藏，ai/bing/google 都显示）
      const btn = document.getElementById('rsp-translate');
      if (btn) btn.hidden = this._translateCfg.engine === 'none';
    }

    // ---- 批注持久化（用 annotationStorage.serializable）----
    scheduleSaveAnnotations(force = false) {
      if (this._suppressAnnotationDirty && !force) return;
      this._annotationsDirty = true;
      if (this.savingAnnotTimer) clearTimeout(this.savingAnnotTimer);
      this.savingAnnotTimer = setTimeout(() => this.saveAnnotations(), 1000);
    }

    flushAnnotationEditorsToStorage() {
      if (!this.uiManager || typeof this.uiManager.getEditors !== 'function') return 0;
      let added = 0;
      const total = this.total || (this.viewer && this.viewer.pagesCount) || 0;
      for (let pageIndex = 0; pageIndex < total; pageIndex++) {
        let editors = [];
        try { editors = this.uiManager.getEditors(pageIndex) || []; } catch { editors = []; }
        for (const editor of editors) {
          try {
            if (editor && !(editor.isEmpty && editor.isEmpty())) {
              this.uiManager.addToAnnotationStorage(editor);
              added++;
            }
          } catch {}
        }
      }
      return added;
    }

    serializeAnnotations() {
      try {
        const doc = this.doc;
        if (!doc || !doc.annotationStorage) return null;
        this.flushAnnotationEditorsToStorage();
        const serial = doc.annotationStorage.serializable;
        if (!serial || !serial.map) return { items: [], updatedAt: Date.now() };
        const items = [];
        for (const [id, val] of serial.map) {
          items.push(repairAnnotationValue({ id, ...val }));
        }
        if (!items.length) return { items: [], updatedAt: Date.now() };
        return { items, hash: serial.hash || '', updatedAt: Date.now() };
      } catch { return null; }
    }

    async saveAnnotations(force = false) {
      if (!this.paper || !this.doc) return;
      if (!this._annotationsDirty) return;
      const now = Date.now();
      // 2 秒限频仅防高频拖拽产生的抖动写入；close() 时 force=true 绕过，保证最后一次落盘不丢。
      // 窗口内不丢弃而是推迟重试：否则"删除/快速编辑"紧跟一次保存时会被吞，要等下次操作才落盘。
      if (!force && now - this.lastSavedAnnotAt < 2000) { this.scheduleSaveAnnotations(); return; }
      const payload = this.serializeAnnotations();
      if (!payload) return;
      this.lastSavedAnnotAt = now;
      try {
        await this.onSaveAnnotations(this.paper.id, payload);
        this._annotationsDirty = false;
        // 给一个可见的「已保存」反馈，避免用户怀疑高亮没存住（呼应刚修的保存丢失 bug）
        const n = (payload && payload.items && payload.items.length) || 0;
        this.setStatus(n ? ('✓ 批注已保存（' + n + '）') : '✓ 批注已清空');
      } catch (e) {
        // 保存失败要可见反馈，否则用户以为存了实际没存
        console.warn('[PaperWiki] 批注保存失败', e && e.message);
        this.setStatus('批注保存失败，请重试', true);
      }
    }

    /** 灌回批注：按 pageIndex 分组缓存，等每页渲染后经 layer.deserialize 重建可视 editor。
     *  回显依赖每页 AnnotationEditorLayer 已创建（pagerendered 后），由 restorePageAnnotations 触发；
     *  loadAnnotations 末尾也会主动扫一遍已就绪页，避免首页 pagerendered 早于 loadAnnotations 的竞态。 */
    loadAnnotations(annotations) {
      this._annotByPage = new Map();
      annotations = repairAnnotationPayload(annotations);
      if (!annotations || !annotations.items || !annotations.items.length) return;
      for (const it of annotations.items) {
        if (!it || it.annotationType == null) continue;
        const pIdx = it.pageIndex != null ? it.pageIndex : (it.page != null ? it.page - 1 : null);
        if (pIdx == null) continue;
        if (!this._annotByPage.has(pIdx)) this._annotByPage.set(pIdx, []);
        this._annotByPage.get(pIdx).push(it);
      }
      // 主动回显已就绪的页（解决首页 pagerendered 早于 loadAnnotations 的竞态）
      for (const pIdx of this._annotByPage.keys()) {
        this.restorePageAnnotations(pIdx);
      }
    }

    /** 某页渲染完成后，回显该页的批注（deserialize 重建可视高亮/便签/手写）。
     *  layer 未就绪时跳过（保留在 _annotByPage，等下次 pagerendered 或手动触发）。 */
    async restorePageAnnotations(pageIndex) {
      if (!this._annotByPage) return;
      const items = this._annotByPage.get(pageIndex);
      if (!items || !items.length) return;
      const pv = this.viewer && this.viewer.getPageView(pageIndex);
      const builder = pv && pv.annotationEditorLayer;
      const layer = builder && builder.annotationEditorLayer;
      // layer 未就绪：保留待下次（pagerendered 会重试）
      if (!layer || !layer.deserialize) return;
      // 关键：deserialize 全部成功后再 delete，否则某条抛错时整页批注会从缓存丢失，重试也补不回来
      let allOk = true;
      this._suppressAnnotationDirty = true;
      try {
        for (const it of items) {
          try {
            const ed = await layer.deserialize(it);
            if (ed && layer.add) layer.add(ed); else allOk = false;
          } catch (e) {
            allOk = false;
          }
        }
      } finally {
        this._suppressAnnotationDirty = false;
      }
      if (allOk) this._annotByPage.delete(pageIndex);
    }

    /** 扫描所有未回显的页，对已就绪的 layer 补回显（解决 drawLayer 异步就绪竞态）。 */
    retryPendingAnnotations() {
      if (!this._annotByPage || !this._annotByPage.size) return;
      for (const pIdx of [...this._annotByPage.keys()]) {
        this.restorePageAnnotations(pIdx);
      }
    }

    // ---- 阅读进度持久化 ----
    scheduleSaveProgress() {
      if (this.savingTimer) clearTimeout(this.savingTimer);
      this.savingTimer = setTimeout(() => this.saveProgress(), 900);
    }

    async saveProgress() {
      if (!this.paper || !this.viewer) return;
      const now = Date.now();
      if (now - this.lastSavedAt < 2000) return;
      this.lastSavedAt = now;
      const page = this.viewer.currentPageNumber;
      const pv = this.viewer.getPageView(page - 1);
      const pageTop = pv && pv.div ? pv.div.offsetTop - this.wrap.offsetTop : 0;
      const scrollTop = Math.max(0, this.wrap.scrollTop - pageTop);
      const payload = { page, scrollTop, scale: this.viewer.currentScale, total: this.total, updatedAt: now };
      try {
        await this.onSaveProgress(this.paper.id, payload);
        this.setStatus('已记录：第 ' + page + ' / ' + this.total + ' 页');
      } catch {}
    }

    /** 彻底拆除当前会话：保存(可选)、移除所有监听器、销毁 viewer/doc、清空画布 DOM。
     *  close() 与 open() 复用它——open() 开头调用可保证重开时：①不残留上一篇画布(否则会闪现旧PDF)
     *  ②不叠加泄漏监听器(wheel/scroll/pointer 等)。save 仅在用户主动关闭时为 true。
     *  返回一个 Promise：save=true 时它包含「批注保存」的网络落盘——调用方应 await 后再销毁 doc。 */
    async _teardown(save) {
      // 先发起强制保存（绕过限频，确保最后一次批注不丢），但要在销毁 doc 前就把内容序列化好
      // （serializeAnnotations 同步读取 doc.annotationStorage，故这一步必须在 destroy 之前完成）。
      if (save && this.uiManager) {
        try { this.uiManager.commitOrRemove(); } catch {}
        this.flushAnnotationEditorsToStorage();
      }
      const saveP = save ? this.saveAnnotations(true) : Promise.resolve();
      if (this.savingTimer) { clearTimeout(this.savingTimer); if (save) this.saveProgress(); this.savingTimer = null; }
      if (this.savingAnnotTimer) { clearTimeout(this.savingAnnotTimer); this.savingAnnotTimer = null; }
      if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
      if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
      if (this._annotRetry) { clearTimeout(this._annotRetry); this._annotRetry = null; }
      if (this._annotRetry2) { clearTimeout(this._annotRetry2); this._annotRetry2 = null; }
      this._annotByPage = null;
      if (this._onWheel) this.wrap.removeEventListener('wheel', this._onWheel);
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      if (this._onScroll) this.wrap.removeEventListener('scroll', this._onScroll);
      if (this._onSelUp) this.wrap.removeEventListener('pointerup', this._onSelUp);
      if (this._onSelDown) this.wrap.removeEventListener('pointerdown', this._onSelDown);
      if (this._onAnnotGuardDown) this.wrap.removeEventListener('pointerdown', this._onAnnotGuardDown, true);
      if (this._onAnnotGuardUp) this.wrap.removeEventListener('pointerup', this._onAnnotGuardUp, true);
      if (this._onAnnotToolbarClick) this.wrap.removeEventListener('click', this._onAnnotToolbarClick, true);
      if (this._onTouchStart) {
        this.wrap.removeEventListener('touchstart', this._onTouchStart);
        this.wrap.removeEventListener('touchmove', this._onTouchMove);
        this.wrap.removeEventListener('touchend', this._onTouchEnd);
      }
      this._onWheel = null; this._onResize = null; this._onScroll = null;
      this._onSelUp = null; this._onSelDown = null;
      this._onAnnotGuardDown = this._onAnnotGuardUp = this._onAnnotToolbarClick = null;
      this._onTouchStart = this._onTouchMove = this._onTouchEnd = null;
      this.hideSelectionPopup();
      this.cancelTranslate(true);              // teardown 强制移除翻译浮窗（含钉住态，PDF 已销毁）
      if (this._pop) { this._pop.remove(); this._pop = null; }
      // 等批注/进度落盘完成后再销毁 doc，避免网络尚未返回就被 destroy 打断
      try { await saveP; } catch {}
      try { if (this.viewer) this.viewer.cleanup(); } catch {}
      try { if (this.doc) this.doc.destroy(); } catch {}
      this.doc = null;
      this.viewer = null;
      this.linkService = null;
      this.eventBus = null;
      this.uiManager = null;
      // 清空上一篇 PDF 的画布（pdf.js 不会主动清旧 DOM），重开时直接从空画布渲染新 PDF，不再闪现旧内容
      if (this.viewerEl) this.viewerEl.replaceChildren();
      if (this.wrap) this.wrap.scrollTop = 0;
    }

    async close() {
      await this._teardown(true);
      this.view.classList.remove('active');
      document.body.style.overflow = '';
      // 恢复原 devicePixelRatio（open 时为清晰度临时提到 max(dpr,2)）
      if (this._origDpr != null && window.devicePixelRatio !== this._origDpr) {
        try { Object.defineProperty(window, 'devicePixelRatio', { value: this._origDpr, configurable: true }); }
        catch { /* ignore */ }
      }
      this.onClose();
    }
  }

  window.PaperReader = PaperReader;
})();
