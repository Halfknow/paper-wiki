// DOM 取元素快捷方式
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

export const $ = (id) => document.getElementById(id);

/** 容器内是否有活动文本选择。周期性/流式 innerHTML 重建的选区守卫共用：
 *  重建前调用，为真则跳过本轮（重建会摧毁选区，表现为「选中文字无法复制」）。 */
export function selectionWithin(...els) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return els.some((el) => el && el.contains(sel.anchorNode));
}

/** 等选区释放后执行 fn（流式定型重渲的推迟执行：replaceWith 会摧毁进行中的选区）。
 *  el 已脱离文档（切论文/切 tab 重建）则放弃执行——彼时新结构已由别的路径渲染。 */
export function runAfterSelectionRelease(el, fn) {
  const onChange = () => {
    if (el.isConnected && selectionWithin(el)) return; // 仍选着，继续等
    document.removeEventListener('selectionchange', onChange);
    if (el.isConnected) fn();
  };
  document.addEventListener('selectionchange', onChange);
}

// 主题调色板（v3.16 单一真相源迁到此；原 reader.js 经 window.READER_PALETTE 注入，
// 时序靠「赌 reader 先加载」不可靠。现 reader.js 反向 import 此常量）。
export const PALETTE = ['#4f46e5', '#7c3aed', '#0891b2', '#d97706', '#db2777', '#2563eb', '#16a34a', '#475569'];
