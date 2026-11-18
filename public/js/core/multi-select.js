// 多选模式控制器（设计系统 §7.4 / §10 P2「多选模式三页同构」，v3.65）。
//
// 论文库 / 概念 / 公式三页此前各写一套：论文库有「全选」无范围选，知识页连全选都没有，
// 键盘只有论文库能退出。现在三页共用这一个控制器，交互语义完全一致：
//   · 点击          切换单项（并把它设为范围锚点）
//   · Shift + 点击  从锚点到此处按**当前可见顺序**整段选中
//   · Ctrl/⌘ + A    全选当前可见项（输入框内不拦截，保留原生全选文字）
//   · Esc           退出多选（层管理器之后才轮到：弹窗/抽屉开着时先关它们）
//   · 底栏「全选 ↔ 取消全选」随选中态切换文案
// 键盘经 PWLayers.registerShortcut 注册（模态打开时自动让位），只在本页可见时生效。
//
// 选中集合仍归页面持有（getSet 惰性读取——论文库切空间/收藏夹时会整体替换 state.selected）。

import { registerShortcut } from './layers.js';

function isTyping(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/**
 * @param {object} o
 * @param {() => Set<string>} o.getSet   选中集合
 * @param {() => string[]} o.order       当前可见项 id（显示顺序）
 * @param {string} o.view                所属页（document.body.dataset.view），不在本页时快捷键不生效
 * @param {() => void} o.onChange        集合变化后（页面就地刷新选中态 + 底栏计数）
 * @param {() => void} o.onExit          Esc 退出多选
 */
export function createMultiSelect({ getSet, order, view, onChange, onExit }) {
  let anchor = null;
  let off = null;

  const api = {
    /** 点击条目。e 可选（Shift 范围选）。 */
    click(id, e) {
      const set = getSet();
      if (e && e.shiftKey && anchor != null && anchor !== id) {
        const ids = order();
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          for (let i = lo; i <= hi; i++) set.add(ids[i]);
          anchor = id;
          onChange();
          return;
        }
      }
      if (set.has(id)) set.delete(id);
      else set.add(id);
      anchor = id;
      onChange();
    },
    /** 当前可见项是否已全部选中（底栏「全选 / 取消全选」文案用）。 */
    allSelected() {
      const ids = order();
      const set = getSet();
      return ids.length > 0 && ids.every((id) => set.has(id));
    },
    selectAll() {
      const set = getSet();
      for (const id of order()) set.add(id);
      onChange();
    },
    /** 全选 ↔ 取消全选（只作用于当前可见项，不动视图外的已选项）。 */
    toggleAll() {
      const set = getSet();
      const ids = order();
      if (api.allSelected()) ids.forEach((id) => set.delete(id));
      else ids.forEach((id) => set.add(id));
      onChange();
    },
    /** Shift+点击时阻止浏览器顺带做文字选区（否则 click 守卫会把它当成「在选文字」而放弃）。 */
    onMouseDown(e) {
      if (e.shiftKey) e.preventDefault();
    },
    /** 进入多选：挂键盘（幂等）。 */
    activate() {
      if (off) return;
      off = registerShortcut((e) => {
        if (document.body.dataset.view !== view || e.defaultPrevented) return false;
        if (e.key === 'Escape') {
          e.preventDefault();
          onExit();
          return true;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a' && !isTyping(e.target)) {
          e.preventDefault();
          api.selectAll();
          return true;
        }
        return false;
      });
    },
    /** 退出多选：摘键盘、清锚点（集合由页面自己清，论文库还要关批量菜单等）。 */
    deactivate() {
      if (off) off();
      off = null;
      anchor = null;
    },
  };
  return api;
}
