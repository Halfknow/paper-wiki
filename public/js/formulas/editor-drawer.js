// 公式编辑抽屉（v3.29）：全字段编辑——LaTeX（KaTeX 实时预览）/ 解读（三问结构提示）/ 分类 /
// 符号表（行编辑）/ 可绘图 + plotHint（变量/区间/plotExpr，曲线实时预览）/ 概念关联 / 关联论文（新增）。
// 取代旧的两步 PWDialog（只能改 latex+description）。新增模式（f=null）同时是手动录入入口。
//
// 保存：编辑走 PATCH /api/formulas/:id；新增走 POST /api/formulas（source='manual'）。
// 命中已有 canonicalName 时后端按合并语义处理（补空字段 + occurrence 追加），前端 toast 提示。

import { PATCH, POST } from '../core/api.js';
import { attachPaperPicker, openMergeDialog } from '../core/form-dialog.js';
import { termSimilarity } from '../core/knowledge-link.js';
import { renderKatexSafe } from '../core/knowledge-link.js';
import { plotSvg } from '../core/plot.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { escapeHtml } from '../core/format.js';
// 与 formulas.js 构成模块循环（formulas → editor → formulas），双方都只在事件回调里调对方
// 函数（声明提升 + 运行时解析），顶层求值互不依赖——与 nav ↔ formulas 同构安全。
import { renderFormulaSidebar, renderFormulas } from './formulas.js';

let _overlay = null;
let _uid = 0; // 字段 id 计数器（label[for] 聚焦）

const ROLE_OPTIONS = [
  { value: 'input', label: '输入' },
  { value: 'param', label: '参数' },
  { value: 'output', label: '输出' },
  { value: 'const', label: '常量' },
];

/** 打开编辑抽屉。f=null 为新增模式（canonicalName 可填 + 关联论文选择器）。 */
export function openFormulaEditor(f) {
  const isCreate = !f;
  if (!_overlay) _buildDom();
  _render(isCreate ? null : f);
  _overlay.classList.add('open');
  document.addEventListener('keydown', _onKey);
}

export function closeFormulaEditor() {
  if (!_overlay) return;
  _overlay.classList.remove('open');
  document.removeEventListener('keydown', _onKey);
}

function _onKey(e) {
  if (e.key === 'Escape') {
    // textarea 内的 Esc 先由输入框自然处理（清 IME 等），仅裸 Esc 关抽屉
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    closeFormulaEditor();
  }
}

function _buildDom() {
  _overlay = document.createElement('div');
  _overlay.id = 'formula-editor-overlay';
  _overlay.className = 'formula-editor-overlay';
  _overlay.innerHTML = '<aside class="formula-editor" id="formula-editor-panel" role="dialog" aria-label="公式编辑"></aside>';
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) closeFormulaEditor(); });
  document.body.appendChild(_overlay);
}

/**
 * 堆叠字段（v3.46 表单系统）：标签在输入上方 + 可选 hint，输入占满整行宽。
 * 取代旧版「88px 左标签列」——标签上置是现代 SaaS 表单惯例，短标签不再挤压输入宽。
 */
function _field(labelText, control, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'fe-field';
  const label = document.createElement('label');
  label.className = 'fe-field-label';
  label.textContent = labelText;
  const tag = control && control.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const id = 'fe-fld-' + ++_uid;
    control.id = id;
    label.htmlFor = id;
  }
  wrap.appendChild(label);
  wrap.appendChild(control);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'fe-field-hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/** 开关（switch）：取代裸 checkbox 行——可绘图 / 重点 这类布尔项用它更可点、更可扫读。 */
function _switch(labelText, checked) {
  const lab = document.createElement('label');
  lab.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const txt = document.createElement('span');
  txt.className = 'switch-label';
  txt.textContent = labelText;
  lab.append(cb, track, txt);
  return lab;
}

function _input(value = '', placeholder = '', mono = false) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'fe-input' + (mono ? ' mono' : '');
  inp.value = value;
  if (placeholder) inp.placeholder = placeholder;
  return inp;
}

function _render(f) {
  const panel = _overlay.querySelector('#formula-editor-panel');
  const isCreate = !f;
  const ph = (f && f.plotHint) || {};
  const variables = ((f && f.variables) || []).map((v) => ({ ...v }));

  panel.innerHTML = `
    <header class="fe-head">
      <div class="fe-head-txt">
        <h3>${isCreate ? '新增公式' : '编辑公式'}</h3>
        ${isCreate ? '' : `<span class="fe-head-sub mono">${escapeHtml(f.canonicalName || '')}</span>`}
      </div>
      <button type="button" class="btn secondary sm icon-btn fe-close" title="关闭 (Esc)" aria-label="关闭">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="fe-body">
      <section class="fe-card"><div class="fe-card-head"><span class="fe-card-title">基本信息</span></div><div class="fe-card-body fe-sec-basic"></div></section>
      <section class="fe-card"><div class="fe-card-head"><span class="fe-card-title">LaTeX 表达式</span><span class="fe-card-hint">一般形式 · 下方实时预览</span></div><div class="fe-card-body fe-sec-latex"></div></section>
      <section class="fe-card"><div class="fe-card-head"><span class="fe-card-title">解读</span><span class="fe-card-hint">做什么 · 设计直觉 · 适用边界</span></div><div class="fe-card-body fe-sec-desc"></div></section>
      <section class="fe-card"><div class="fe-card-head"><span class="fe-card-title">符号表</span><span class="fe-card-hint">含义建议含形状 / 量纲</span></div><div class="fe-card-body fe-sec-vars"></div></section>
      <section class="fe-card fe-plot-sec"><div class="fe-card-head"><span class="fe-card-title">绘图</span><span class="fe-card-hint">勾选「可绘图」后生效</span></div><div class="fe-card-body fe-sec-plot"></div></section>
      <section class="fe-card"><div class="fe-card-head"><span class="fe-card-title">相关概念</span><span class="fe-card-hint">term，逗号分隔，建立概念 ↔ 公式联动</span></div><div class="fe-card-body fe-sec-concepts"></div></section>
      <section class="fe-card fe-papers-sec" ${isCreate ? '' : 'hidden'}><div class="fe-card-head"><span class="fe-card-title">关联论文</span></div><div class="fe-card-body fe-pickers"></div></section>
    </div>
    <footer class="fe-foot">
      ${isCreate ? '' : '<button type="button" class="btn secondary sm danger fe-merge">合并到…</button>'}
      <span class="fe-err"></span>
      <button type="button" class="btn secondary sm fe-cancel">取消</button>
      <button type="button" class="btn sm fe-save">保存</button>
    </footer>`;

  const basic = panel.querySelector('.fe-sec-basic');

  // --- 基本信息 ---
  if (isCreate) {
    const cn = _input('', 'scaled-dot-product-attention（小写英文 + 连字符）', true);
    basic.appendChild(_field('规范名 *', cn, '跨论文合并去重的 key；命中已有规范名会自动并入'));
    panel._canonicalName = cn;
  } else {
    const cn = document.createElement('div');
    cn.className = 'fe-readonly';
    cn.textContent = f.canonicalName;
    basic.appendChild(_field('规范名', cn, '跨论文合并去重的 key，不可修改'));
  }
  const grid2 = document.createElement('div');
  grid2.className = 'fe-grid-2';
  const nameInp = _input((f && f.name) || '', '中文名，如 缩放点积注意力');
  const catInp = _input((f && f.category) || '', '如 attention / loss / optimization');
  grid2.append(_field('名称', nameInp), _field('分类', catInp));
  basic.appendChild(grid2);
  const plottableCb = _switch('可绘图（支持曲线预览）', f && f.plottable).querySelector('input');
  const starredSw = _switch('重点公式', f && f.starred);
  const starredCb = starredSw.querySelector('input');
  panel._starredCb = starredCb; // 保存时读（新增模式默认 false）
  const swRow = document.createElement('div');
  swRow.className = 'fe-switch-row';
  swRow.append(plottableCb.closest('.switch'), starredSw);
  basic.appendChild(swRow);

  // --- LaTeX ---
  const latexTa = document.createElement('textarea');
  latexTa.className = 'fe-input mono fe-latex';
  latexTa.value = (f && f.latex) || '';
  latexTa.placeholder = '\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V';
  const preview = document.createElement('div');
  preview.className = 'fe-katex-preview';
  panel.querySelector('.fe-sec-latex').append(latexTa, preview);
  const renderPreview = () => { preview.innerHTML = renderKatexSafe(latexTa.value, true); };
  latexTa.addEventListener('input', renderPreview);
  renderPreview();

  // --- 解读 ---
  const descTa = document.createElement('textarea');
  descTa.className = 'fe-input fe-desc';
  descTa.value = (f && f.description) || '';
  descTa.placeholder = '做什么：一句话说清这个公式刻画的关系…\n设计直觉：为什么是这个形式…\n适用边界：什么时候失效…';
  panel.querySelector('.fe-sec-desc').appendChild(descTa);

  // --- 符号表（列头 + 行编辑） ---
  const varsSec = panel.querySelector('.fe-sec-vars');
  varsSec.innerHTML = `
    <div class="fe-var-head"><span>符号</span><span>含义（建议含形状 / 量纲）</span><span>角色</span><span></span></div>
    <div class="fe-vars"></div>
    <button type="button" class="fe-var-add">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      添加符号
    </button>`;
  const varsBox = varsSec.querySelector('.fe-vars');
  const varRow = (v = { symbol: '', meaning: '', role: 'param' }) => {
    const row = document.createElement('div');
    row.className = 'fe-var-row';
    const sym = _input(v.symbol, 'Q', true);
    const mean = _input(v.meaning, '查询矩阵（n×d_k）');
    const role = document.createElement('select');
    for (const r of ROLE_OPTIONS) {
      const o = document.createElement('option');
      o.value = r.value;
      o.textContent = r.label;
      role.appendChild(o);
    }
    role.value = v.role || 'param';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn ghost xs icon danger qbtn';
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.title = '删除此符号';
    del.setAttribute('aria-label', '删除此符号');
    del.onclick = () => row.remove();
    row.append(sym, mean, role, del);
    row._get = () => ({ symbol: sym.value.trim(), meaning: mean.value.trim(), role: role.value });
    varsBox.appendChild(row);
    return row;
  };
  for (const v of variables) varRow(v);
  varsSec.querySelector('.fe-var-add').onclick = () => varRow();

  // --- 绘图 ---
  const plotSec = panel.querySelector('.fe-sec-plot');
  const varInp = _input(ph.variable || 'x', 'x', true);
  const loInp = _input(ph.range ? String(ph.range[0]) : '0', '0', true);
  const hiInp = _input(ph.range ? String(ph.range[1]) : '10', '10', true);
  const exprInp = _input(ph.plotExpr || '', 'exp(-gamma*x)，支持 + - * / ^ 与 sin cos exp log sqrt…', true);
  plotSec.innerHTML = `
    <div class="fe-plot-controls">
      <div class="fe-plot-grid"></div>
    </div>
    <div class="fe-plot-preview"></div>`;
  const plotGrid = plotSec.querySelector('.fe-plot-grid');
  plotGrid.append(_field('自变量', varInp), _field('区间下限', loInp), _field('区间上限', hiInp));
  plotSec.querySelector('.fe-plot-controls').appendChild(_field('plotExpr（关于自变量的表达式）', exprInp));
  const plotPreview = plotSec.querySelector('.fe-plot-preview');
  const plotControls = plotSec.querySelector('.fe-plot-controls');
  const syncPlotVis = () => {
    plotControls.classList.toggle('fe-disabled', !plottableCb.checked);
    plotPreview.innerHTML = plottableCb.checked ? '' : '<div class="fe-plot-none">勾选上方「可绘图」后，这里会出现曲线预览</div>';
    if (!plottableCb.checked) return;
    const svg = plotSvg(
      {
        variable: varInp.value.trim() || 'x',
        range: [Number(loInp.value), Number(hiInp.value)],
        params: ph.params || {},
        plotExpr: exprInp.value,
      },
      560,
      150,
    );
    plotPreview.innerHTML = svg || '<div class="fe-plot-none">plotExpr 为空或无法求值——填好表达式后这里会出现曲线预览</div>';
  };
  plottableCb.addEventListener('change', syncPlotVis);
  [varInp, loInp, hiInp, exprInp].forEach((el) => el.addEventListener('input', syncPlotVis));
  syncPlotVis();

  // --- 相关概念 ---
  const ctInp = _input(((f && f.conceptTerms) || []).join(', '), '如 Scaled Dot-Product Attention, InfoNCE');
  panel.querySelector('.fe-sec-concepts').appendChild(_field('概念 terms', ctInp));

  // --- 关联论文（新增模式） ---
  let paperPicker = null;
  if (isCreate) {
    const host = panel.querySelector('.fe-pickers');
    paperPicker = attachPaperPicker(host, []);
  }

  // --- footer ---
  const err = panel.querySelector('.fe-err');
  const mergeBtn = panel.querySelector('.fe-merge');
  if (mergeBtn)
    mergeBtn.onclick = async () => {
      const candidates = (state.formulas || [])
        .filter((x) => x.id !== f.id)
        .map((x) => ({ id: x.id, label: `${x.name || x.canonicalName}（${x.canonicalName}）`, sim: termSimilarity(f.canonicalName, x.canonicalName || x.name) }))
        .sort((a, b) => b.sim - a.sim || a.label.localeCompare(b.label))
        .slice(0, 60);
      const suspect = candidates.filter((x) => x.sim >= 0.6);
      const targetId = await openMergeDialog({
        title: '合并公式',
        selfLabel: f.name || f.canonicalName,
        candidates: [...suspect, ...candidates.filter((x) => x.sim < 0.6)],
      });
      if (!targetId) return;
      try {
        const r = await POST('/api/formulas/merge', { sourceId: f.id, targetId });
        if (r && r.ok) {
          const merged = r.data && r.data.formula;
          toast(`已并入「${merged ? merged.name || merged.canonicalName : targetId}」`);
          state.formulas = (state.formulas || []).filter((x) => x.id !== f.id);
          if (merged) {
            const idx = state.formulas.findIndex((x) => x.id === merged.id);
            if (idx >= 0) state.formulas[idx] = merged;
            else state.formulas.push(merged);
          }
          closeFormulaEditor();
          renderFormulaSidebar();
          renderFormulas();
        } else panel.querySelector('.fe-err').textContent = (r && r.error) || '合并失败';
      } catch (e) {
        panel.querySelector('.fe-err').textContent = '网络错误：' + (e && e.message ? e.message : e);
      }
    };
  panel.querySelector('.fe-close').onclick = closeFormulaEditor;
  panel.querySelector('.fe-cancel').onclick = closeFormulaEditor;
  panel.querySelector('.fe-save').onclick = async () => {
    err.textContent = '';
    const latex = latexTa.value.trim();
    const canonicalName = isCreate ? panel._canonicalName.value.trim() : f.canonicalName;
    if (isCreate && !canonicalName) { err.textContent = '规范名必填'; panel._canonicalName.focus(); return; }
    if (!latex) { err.textContent = 'LaTeX 必填'; latexTa.focus(); return; }
    const vars = [...varsBox.querySelectorAll('.fe-var-row')].map((r) => r._get()).filter((v) => v.symbol);
    const payload = {
      name: nameInp.value.trim(),
      latex,
      description: descTa.value.trim(),
      category: catInp.value.trim(),
      variables: vars,
      plottable: plottableCb.checked,
      starred: starredCb.checked,
      plotHint: plottableCb.checked
        ? {
            variable: varInp.value.trim() || 'x',
            range: [Number(loInp.value) || 0, Number(hiInp.value) || 10],
            params: ph.params || {},
            plotExpr: exprInp.value.trim(),
          }
        : null,
      conceptTerms: ctInp.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (isCreate) {
        payload.canonicalName = canonicalName;
        payload.paperIds = paperPicker ? paperPicker.get() : [];
        const r = await POST('/api/formulas', payload);
        if (r && r.ok && r.data && r.data.formula) {
          toast(r.data.merged ? `已并入已有公式「${r.data.formula.name}」（补关联与空缺字段）` : '公式已新增');
          _applyServerItem(r.data.formula);
          closeFormulaEditor();
        } else err.textContent = (r && r.error) || '保存失败';
      } else {
        const r = await PATCH('/api/formulas/' + f.id, payload);
        if (r && r.ok) {
          toast('公式已更新');
          _applyServerItem(r.data);
          closeFormulaEditor();
        } else err.textContent = (r && r.error) || '保存失败';
      }
    } catch (e) {
      err.textContent = '网络错误：' + (e && e.message ? e.message : e);
    }
  };
}

/** 服务端返回的条目就地更新 state.formulas 并重渲（免整页重拉）。新增则插入。 */
function _applyServerItem(item) {
  if (!item || !item.id) return;
  const list = (state.formulas = state.formulas || []);
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  renderFormulaSidebar();
  renderFormulas();
}
