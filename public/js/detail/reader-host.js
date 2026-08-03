// 阅读器接入与批注同步
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PATCH, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { flushPendingNotes, state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { reader, set_reader, syncLocalAnnotations } from './info-tab.js';
import { refresh } from '../library/refresh.js';

// 打开前总是拉一次 detailView：summaryView 不含 annotations，且刚保存后的详情缓存也可能是旧的。
export async function openReader(paper) {
  if (!window.PaperReader) { toast('阅读器尚未加载', 'error'); return; }
  try {
    const { data: full } = await jget('/api/papers/' + encodeURIComponent(paper.id));
    if (full) {
      paper = { ...paper, ...full, annotations: full.annotations || null, readProgress: full.readProgress || paper.readProgress };
      if (state.detail && state.detail.id === paper.id) state.detail = { ...state.detail, ...full };
    }
  } catch (e) { /* 拉取失败不阻塞阅读，只是可能无法回显最新批注 */ }
  if (!reader) {
    set_reader(new window.PaperReader({
      view: $('reader-view'),
      canvasWrap: $('reader-canvas-wrap'),
      back: $('reader-back'),
      prev: $('reader-prev'), next: $('reader-next'),
      pageInput: $('reader-page-input'), pageTotal: $('reader-page-total'),
      zoomIn: $('reader-zoom-in'), zoomOut: $('reader-zoom-out'), zoomLabel: $('reader-zoom-label'),
      zoomFit: $('reader-zoom-fit'),
      spread: $('reader-spread'),
      toolCursor: $('reader-tool-cursor'), toolHighlight: $('reader-tool-highlight'),
      toolNote: $('reader-tool-note'), toolInk: $('reader-tool-ink'),
      toolDelete: $('reader-tool-delete'),
      colorsEl: $('reader-colors'),
      title: $('reader-title'), saved: $('reader-saved'),
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
