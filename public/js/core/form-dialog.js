// 通用表单对话框（v3.29）：概念/公式的手动新增与编辑表单。
// PWDialog 只有单字段 prompt，多字段表单（文本/多行/下拉/复选/论文选择器）由本组件承担。
// 视觉复用 PWDialog 的 .pwdlg-* 体系（遮罩/卡片/按钮），键盘语义对齐：
// Esc 取消、Enter 提交（textarea 内 Ctrl/Cmd+Enter 提交）、点遮罩取消。
//
// 用法：const values = await openFormDialog({ title, fields, okText });
//   fields: [{ key, label, type: 'text'|'textarea'|'select'|'checkbox'|'papers',
//              value, placeholder, options: [{value,label}], rows, mono, hint, required }]

import { escapeHtml } from './format.js';
import { state } from './state.js';

/** 论文选择器（可复用，公式编辑抽屉也用）：chips + 搜索下拉，值为 paperId 数组。
 *  @param {HTMLElement} host 挂载容器（清空重画）
 *  @param {string[]} initial 初始选中的 paperId
 *  @returns {{ get(): string[] }} 取值接口 */
export function attachPaperPicker(host, initial = []) {
  const picked = [...initial];
  const render = () => {
    host.innerHTML = '';
    const chipBox = document.createElement('div');
    chipBox.className = 'fpk-chips';
    for (const id of picked) {
      const p = (state.papers || []).find((x) => x.id === id);
      const chip = document.createElement('span');
      chip.className = 'fpk-chip';
      chip.textContent = (p && (p.title || p.filename)) || id;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'fpk-x';
      x.setAttribute('aria-label', '移除');
      x.textContent = '×';
      x.onclick = () => {
        const i = picked.indexOf(id);
        if (i >= 0) picked.splice(i, 1);
        render();
      };
      chip.appendChild(x);
      chipBox.appendChild(chip);
    }
    host.appendChild(chipBox);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fpk-input';
    input.placeholder = '搜索论文标题，回车/点击加入…';
    const drop = document.createElement('div');
    drop.className = 'fpk-drop';
    const suggest = () => {
      const q = input.value.trim().toLowerCase();
      drop.innerHTML = '';
      if (!q) { drop.hidden = true; return; }
      const hits = (state.papers || [])
        .filter((p) => !picked.includes(p.id))
        .filter((p) => ((p.title || '') + (p.filename || '')).toLowerCase().includes(q))
        .slice(0, 8);
      if (!hits.length) { drop.hidden = true; return; }
      drop.hidden = false;
      drop.innerHTML = hits
        .map((p, i) => `<div class="fpk-opt" data-i="${i}" title="${escapeHtml(p.title || p.filename)}">${escapeHtml((p.title || p.filename).slice(0, 60))}</div>`)
        .join('');
      drop.querySelectorAll('.fpk-opt').forEach((el) => {
        el.onclick = () => {
          picked.push(hits[Number(el.dataset.i)].id);
          input.value = '';
          drop.hidden = true;
          render();
        };
      });
    };
    input.oninput = suggest;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation(); // 不冒泡成表单提交
        const first = drop.querySelector('.fpk-opt');
        if (first) first.click();
        else suggest();
      }
    };
    host.appendChild(input);
    host.appendChild(drop);
  };
  render();
  return { get: () => [...picked] };
}

/** 打开表单对话框。resolve(values) 或 resolve(null)（取消）。 */
export function openFormDialog({ title, fields, okText = '保存', cancelText = '取消', wide = false }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'pwdlg-mask';
    const box = document.createElement('div');
    box.className = 'pwdlg pfdlg' + (wide ? ' wide' : '');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3');
    h.className = 'pwdlg-title';
    h.textContent = title || '填写';
    box.appendChild(h);

    const pickers = new Map(); // key -> paper picker（type=papers 字段）
    const inputs = new Map(); // key -> input/textarea/select 元素
    const checks = new Map(); // key -> checkbox 元素

    for (const f of fields || []) {
      const row = document.createElement('label');
      row.className = 'pfd-row';
      const label = document.createElement('span');
      label.className = 'pfd-label';
      label.textContent = f.label || f.key;
      row.appendChild(label);
      if (f.type === 'textarea') {
        const ta = document.createElement('textarea');
        ta.rows = f.rows || 4;
        ta.value = f.value != null ? String(f.value) : '';
        if (f.placeholder) ta.placeholder = f.placeholder;
        if (f.mono) ta.classList.add('mono');
        row.appendChild(ta);
        inputs.set(f.key, ta);
      } else if (f.type === 'select') {
        const sel = document.createElement('select');
        for (const opt of f.options || []) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          sel.appendChild(o);
        }
        sel.value = f.value != null ? String(f.value) : '';
        row.appendChild(sel);
        inputs.set(f.key, sel);
      } else if (f.type === 'checkbox') {
        row.classList.add('pfd-check');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!f.value;
        row.appendChild(cb);
        checks.set(f.key, cb);
      } else if (f.type === 'papers') {
        const host = document.createElement('div');
        host.className = 'fpk';
        row.appendChild(host);
        pickers.set(f.key, attachPaperPicker(host, Array.isArray(f.value) ? f.value : []));
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = f.value != null ? String(f.value) : '';
        if (f.placeholder) inp.placeholder = f.placeholder;
        if (f.mono) inp.classList.add('mono');
        row.appendChild(inp);
        inputs.set(f.key, inp);
      }
      if (f.hint) {
        const hint = document.createElement('span');
        hint.className = 'pfd-hint';
        hint.textContent = f.hint;
        row.appendChild(hint);
      }
      box.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'pwdlg-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn secondary sm';
    cancelBtn.textContent = cancelText;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn sm';
    okBtn.textContent = okText;
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(actions);
    mask.appendChild(box);

    let settled = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') {
        const t = e.target;
        if (t && t.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
        if (t && t.tagName === 'DIV') return; // 论文选择器的回车自处理
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 130);
      resolve(value);
    };
    const submit = () => {
      // 必填校验：缺必填项高亮首错并聚焦，不关弹窗
      for (const f of fields || []) {
        if (!f.required) continue;
        const el = inputs.get(f.key);
        if (el && !String(el.value || '').trim()) {
          el.classList.add('pfd-invalid');
          el.focus();
          setTimeout(() => el.classList.remove('pfd-invalid'), 1600);
          return;
        }
      }
      const values = {};
      for (const f of fields || []) {
        if (f.type === 'checkbox') values[f.key] = !!(checks.get(f.key) || {}).checked;
        else if (f.type === 'papers') values[f.key] = (pickers.get(f.key) || { get: () => [] }).get();
        else values[f.key] = String((inputs.get(f.key) || {}).value ?? '');
      }
      close(values);
    };

    okBtn.onclick = submit;
    cancelBtn.onclick = () => close(null);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
    setTimeout(() => {
      const first = inputs.get((fields || []).find((f) => f.type !== 'checkbox' && f.type !== 'papers')?.key);
      if (first) { first.focus(); if (first.select) first.select(); }
    }, 30);
  });
}

/** 合并目标选择对话框（v3.30 治理）：搜索过滤 + 疑似重复候选置顶（相似度标红）。
 *  candidates: [{id, label, sim}]（调用方排好序，sim>0.6 视为疑似重复）。
 *  resolve(targetId) 或 resolve(null)。 */
export function openMergeDialog({ title, selfLabel, candidates }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'pwdlg-mask';
    const box = document.createElement('div');
    box.className = 'pwdlg pfdlg';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3');
    h.className = 'pwdlg-title';
    h.textContent = title || '合并到…';
    box.appendChild(h);
    const note = document.createElement('div');
    note.className = 'pfd-merge-note';
    note.textContent = `把「${selfLabel}」并入下方选择的目标条目（论文关联与由来取并集，本条将被删除）`;
    box.appendChild(note);
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'fpk-input';
    search.placeholder = '搜索目标名称…';
    box.appendChild(search);
    const list = document.createElement('div');
    list.className = 'pfd-merge-list';
    box.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'pwdlg-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn secondary sm';
    cancel.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn sm';
    okBtn.textContent = '合并';
    okBtn.disabled = true;
    actions.appendChild(cancel);
    actions.appendChild(okBtn);
    box.appendChild(actions);
    mask.appendChild(box);

    let pickedId = null;
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const items = (candidates || []).filter((c) => !q || c.label.toLowerCase().includes(q)).slice(0, 30);
      list.innerHTML = '';
      for (const c of items) {
        const row = document.createElement('div');
        row.className = 'pfd-merge-item' + (c.sim >= 0.6 ? ' suspect' : '') + (c.id === pickedId ? ' picked' : '');
        row.textContent = c.label;
        if (c.sim >= 0.6) {
          const tag = document.createElement('span');
          tag.className = 'pfd-merge-suspect-tag';
          tag.textContent = '疑似重复';
          row.appendChild(tag);
        }
        row.onclick = () => {
          pickedId = c.id;
          okBtn.disabled = false;
          list.querySelectorAll('.pfd-merge-item').forEach((x) => x.classList.remove('picked'));
          row.classList.add('picked');
        };
        list.appendChild(row);
      }
    };
    search.oninput = renderList;
    renderList();

    let settled = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 130);
      resolve(value);
    };
    cancel.onclick = () => close(null);
    okBtn.onclick = () => { if (pickedId) close(pickedId); };
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
    setTimeout(() => search.focus(), 30);
  });
}
