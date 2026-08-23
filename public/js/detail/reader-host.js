// 阅读器接入与批注同步
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { buildPath } from '../core/router.js';
import { router } from '../core/nav.js';
import { flushPendingNotes, state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { reader, set_reader, syncLocalAnnotations } from './info-tab.js';
import { shelfActivate } from '../reader/shelf.js';
import { refresh } from '../library/refresh.js';
// PaperReader 改为首次打开时动态 import（下方 openReader 内）——reader.js 顶层静态引入
// pdfjs.js + pdfjs-viewer.js（合计 ~770KB），静态 import 会让首屏无条件背上这份成本。

// 打开前总是拉一次 detailView：summaryView 不含 annotations，且刚保存后的详情缓存也可能是旧的。
export async function openReader(paper) {
  try {
    const { data: full } = await jget('/api/papers/' + encodeURIComponent(paper.id));
    if (full) {
      paper = { ...paper, ...full, annotations: full.annotations || null, readProgress: full.readProgress || paper.readProgress };
      if (state.detail && state.detail.id === paper.id) state.detail = { ...state.detail, ...full };
    }
  } catch (e) { /* 拉取失败不阻塞阅读，只是可能无法回显最新批注 */ }
  // 标记阅读架当前篇（v3.23）：只在架上时激活；打开论文**不再自动上架**——
  // 上架是显式动作（工具栏 🔖 / Ctrl+D / 抽屉搜索）。不 await：PDF 打开不等这次网络往返。
  shelfActivate(paper.id);
  if (!reader) {
    const { PaperReader } = await import('../../reader.js'); // 惰性加载 pdf.js（模块map缓存，二次打开零成本）
    set_reader(new PaperReader({
      view: $('reader-view'),
      canvasWrap: $('reader-canvas-wrap'),
      back: $('reader-close'),
      prev: $('reader-prev'), next: $('reader-next'),
      pageInput: $('reader-page-input'), pageTotal: $('reader-page-total'),
      zoomIn: $('reader-zoom-in'), zoomOut: $('reader-zoom-out'), zoomLabel: $('reader-zoom-label'),
      zoomFit: $('reader-zoom-fit'),
      spread: $('reader-spread'),
      toolCursor: $('reader-tool-cursor'), toolHighlight: $('reader-tool-highlight'),
      toolNote: $('reader-tool-note'), toolInk: $('reader-tool-ink'),
      toolDelete: $('reader-tool-delete'),
      colorsEl: $('reader-colors'),
      title: $('reader-title'),
      // 关闭按钮（左上角 ×，v3.23 替代「← 返回」）：与全局 Esc 同语义——当前在 /reader/:id
      // 路由时 history.back()（路由 leave 钩子负责关阅读器，URL 同步退回）；否则（异常态）直接关视图。
      onBack: () => {
        const r = router.current && router.current();
        if (r && r.name === 'reader') window.history.back();
        else if (reader) reader.close();
      },
      // 阅读架切论文（v3.21）：走 /reader/:id 路由 replace 导航——同名路由不触发 leave
      // （阅读器不闪关），enter 重跑本函数整链（URL 深链/刷新语义天然正确；replace 不污染后退栈）。
      onSwitchPaper: (id) => router.navigate(buildPath('/reader/:id', { id }), { replace: true, keepQuery: true }),
      onClose: () => { flushPendingNotes(); setTimeout(refresh, 200); },
      onSaveProgress: async (id, payload) => {
        // 阅读进度 ≥ 95% 自动判为已读，免去手动改状态；首次进入(reading)也一起带上
        const patchBody = { readProgress: payload };
        const pct = (payload && payload.total) ? payload.page / payload.total : 0;
        if (pct >= 0.95) patchBody.readStatus = 'done';
        else if (pct > 0.02) patchBody.readStatus = 'reading';
        await PATCH('/api/papers/' + encodeURIComponent(id), patchBody);
      },
      onSaveAnnotations: async (id, payload) => {
        const r = await PATCH('/api/papers/' + encodeURIComponent(id), { annotations: payload });
        if (r && r.ok) syncLocalAnnotations(id, (r.data && r.data.annotations) || payload, r.data || null);
      },
    }));
  }
  reader.open(paper, paper.readProgress, paper.annotations);
}
