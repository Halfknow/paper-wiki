// 知识页批量操作底栏（v3.29）：概念/公式清单页共用的多选动作条。
// v3.65 P2「多选三页同构」：与论文库 #bulk-bar 同一结构与文案——
//   「已选 N 项 ｜ 全选 ｜ 退出多选 ——— 改分类… ｜ 删除」
// 选择语义（Shift 范围选 / Ctrl+A / Esc 退出）由 core/multi-select.js 统一提供；
// 选中集合归各页面模块持有，本组件只负责动作条 UI 与确认对话。
//
// 用法：
//   const bar = createPickBar({ itemsLabel: '概念', categories: [...], onDelete, onCategorize, onToggleAll, onExit });
//   bar.open(); bar.setCount(n, allSelected); bar.close();

import { openFormDialog } from './form-dialog.js';

export function createPickBar({ itemsLabel = '项', categories = null, onDelete, onCategorize, onToggleAll, onExit }) {
  let el = null;
  let count = 0;

  const ensure = () => {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.className = 'kpick-bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', `${itemsLabel}批量操作`);
    el.innerHTML =
      `<span class="kpick-count" aria-live="polite">已选 0 ${itemsLabel}</span>` +
      `<button type="button" class="btn secondary sm kpick-all">全选</button>` +
      `<button type="button" class="btn secondary sm kpick-exit" title="退出多选（Esc）">退出多选</button>` +
      `<span class="kpick-spacer"></span>` +
      `<button type="button" class="btn secondary sm kpick-cat">改分类…</button>` +
      `<button type="button" class="btn secondary sm danger kpick-del">删除</button>`;
    document.body.appendChild(el);
    el.querySelector('.kpick-del').onclick = async () => {
      if (!count) return;
      if (!(await PWDialog.confirm(`删除选中的 ${count} 个${itemsLabel}？此操作不可恢复。`, { title: `删除${itemsLabel}`, danger: true, okText: '删除' }))) return;
      if (onDelete) await onDelete();
    };
    el.querySelector('.kpick-cat').onclick = async () => {
      if (!count) return;
      const values = await openFormDialog({
        title: `批量改分类（${count} 个${itemsLabel}）`,
        fields: categories
          ? [{ key: 'category', label: '分类', type: 'select', options: categories, required: true }]
          : [{ key: 'category', label: '分类（小写英文，连字符）', type: 'text', placeholder: '如 attention / loss', required: true }],
      });
      if (values && values.category && onCategorize) await onCategorize(values.category);
    };
    el.querySelector('.kpick-all').onclick = () => { if (onToggleAll) onToggleAll(); };
    el.querySelector('.kpick-exit').onclick = () => { if (onExit) onExit(); };
    return el;
  };

  return {
    open() { ensure().classList.add('open'); },
    close() { if (el) el.classList.remove('open'); },
    /** n：已选数；allOn：当前可见项是否已全选（「全选 ↔ 取消全选」与论文库同语义）。 */
    setCount(n, allOn = false) {
      count = n;
      const bar = ensure();
      bar.querySelector('.kpick-count').textContent = `已选 ${n} ${itemsLabel}`;
      const all = bar.querySelector('.kpick-all');
      all.textContent = allOn ? '取消全选' : '全选';
      all.classList.toggle('active', allOn);
      // 没选中时动作钮禁用（之前可以对 0 项点「删除」弹出空确认）
      bar.querySelector('.kpick-cat').disabled = n === 0;
      bar.querySelector('.kpick-del').disabled = n === 0;
    },
    destroy() { if (el) el.remove(); el = null; },
  };
}
