// 知识页批量操作底栏（v3.29）：概念/公式清单页共用的多选动作条。
// 「已选 N 项 ｜ 改分类 ｜ 删除 ｜ 退出」——固定悬浮在视口底部，与论文库 .bulk-bar 同语义。
// 选中集合归各页面模块持有（渲染/重渲时读它），本组件只负责动作条 UI 与确认对话。
//
// 用法：
//   const bar = createPickBar({ itemsLabel: '概念', categories: [...], onDelete, onCategorize });
//   bar.open(); bar.setCount(n); bar.close();

import { openFormDialog } from './form-dialog.js';

export function createPickBar({ itemsLabel = '项', categories = null, onDelete, onCategorize, onExit }) {
  let el = null;
  let count = 0;

  const ensure = () => {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'kpick-bar';
    el.setAttribute('role', 'toolbar');
    el.innerHTML =
      `<span class="kpick-count">已选 0 ${itemsLabel}</span>` +
      `<button type="button" class="btn ghost sm kpick-cat">改分类…</button>` +
      `<button type="button" class="btn ghost sm danger kpick-del">删除</button>` +
      `<span class="kpick-spacer"></span>` +
      `<button type="button" class="btn ghost sm kpick-exit">退出多选</button>`;
    document.body.appendChild(el);
    el.querySelector('.kpick-del').onclick = async () => {
      if (!(await PWDialog.confirm(`删除选中的 ${count} 个${itemsLabel}？此操作不可恢复。`, { title: '批量删除', danger: true, okText: '删除' }))) return;
      if (onDelete) await onDelete();
    };
    el.querySelector('.kpick-cat').onclick = async () => {
      const values = await openFormDialog({
        title: `批量改分类（${count} 个${itemsLabel}）`,
        fields: categories
          ? [{ key: 'category', label: '分类', type: 'select', options: categories, required: true }]
          : [{ key: 'category', label: '分类（小写英文，连字符）', type: 'text', placeholder: '如 attention / loss', required: true }],
      });
      if (values && values.category && onCategorize) await onCategorize(values.category);
    };
    el.querySelector('.kpick-exit').onclick = () => { if (onExit) onExit(); };
    return el;
  };

  return {
    open() { ensure().classList.add('open'); },
    close() { if (el) el.classList.remove('open'); },
    setCount(n) { count = n; const c = ensure().querySelector('.kpick-count'); if (c) c.textContent = `已选 ${n} ${itemsLabel}`; },
    destroy() { if (el) el.remove(); el = null; },
  };
}
