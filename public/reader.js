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
      this.spread = true;                           // 默认双页
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
        if (this.isTypingTarget(e.target || document.activeElement)) return;
        if (e.key === 'Escape') {
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
    }

    async open(paper, readProgress, annotations) {
      this.paper = paper;
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

      const url = '/papers/' + encodeURIComponent(paper.filename);
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
        else if (abtn.dataset.act === 'note') this.quickHighlight(this.curColor, true);
      });
      this.view.appendChild(pop);
      this._pop = pop;
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
      this.onClose();
    }
  }

  window.PaperReader = PaperReader;
})();
