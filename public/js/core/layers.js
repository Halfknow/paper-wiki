// 浮层层级管理器的 ESM 薄封装（实现见 public/layers.js 经典脚本，挂 window.PWLayers）。
//
// 视图模块打开任何 Dialog / Drawer / Sheet / Popover 都必须经这里登记（设计系统 §6.8）：
// Esc 只关最上层、焦点陷阱与归还、背景 inert 由管理器统一负责。全局快捷键用 registerShortcut，
// 禁止再 document.addEventListener('keydown')（design-lint 硬约束）。

function L() {
  const l = typeof window !== 'undefined' && window.PWLayers;
  if (!l) throw new Error('PWLayers 未加载：index.html 须先于 app.js 引入 /layers.js');
  return l;
}

/** 打开一层（参数见 public/layers.js 头注）。返回 handle：close() / isOpen / isTop()。 */
export function openLayer(opts) {
  return L().open(opts);
}

/** 注册全局快捷键（模态打开时自动让位）。phase：'bubble'（缺省，晚于元素）| 'capture'。返回注销函数。 */
export function registerShortcut(fn, opts) {
  return L().registerShortcut(fn, opts);
}

export function hasModalLayer() {
  return L().hasModal();
}

export function layerDepth() {
  return L().depth();
}

/**
 * 宿主元素（body 级单例浮层的根，如抽屉遮罩）持有一层：已持有且未关则复用（切换内容时幂等）。
 * 句柄挂在宿主元素上，不放模块变量——UI 测试多次 boot 时模块是缓存的。
 */
export function holdLayer(host, opts) {
  if (host.__pwLayer && host.__pwLayer.isOpen) return host.__pwLayer;
  host.__pwLayer = openLayer(Object.assign({ root: host }, opts));
  return host.__pwLayer;
}

/** 释放宿主持有的层（焦点归还触发器、背景 inert 解除）。重复调用安全。 */
export function releaseLayer(host) {
  const h = host && host.__pwLayer;
  if (host) host.__pwLayer = null;
  if (h) h.close();
}

/**
 * index.html 静态模态（.modal-mask > .modal[role=dialog]）：显示 + 入栈。
 * onClose：Esc / 点遮罩时调用的关闭函数（各模块自己的 closeXxx，负责停流、清状态）；
 * 缺省直接 hideModal。handle 挂在元素上（不放模块变量——UI 测试多次 boot 时模块是缓存的）。
 */
export function showModal(mask, { onClose, initialFocus } = {}) {
  if (!mask) return null;
  mask.classList.add('active');
  const close = onClose || (() => hideModal(mask));
  return holdLayer(mask, {
    el: mask.querySelector('[role="dialog"]') || mask,
    kind: 'dialog',
    initialFocus,
    onEscape: () => {
      close();
    },
  });
}

export function hideModal(mask) {
  if (!mask) return;
  mask.classList.remove('active');
  releaseLayer(mask);
}

export function isModalShown(mask) {
  return !!(mask && mask.__pwLayer && mask.__pwLayer.isOpen);
}
