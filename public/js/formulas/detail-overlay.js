// 公式预览浮窗（v3.52）：居中模态（与设置中心同族），单公式全貌——
// 完整 LaTeX / 曲线 / 解读全文 / 符号表 / 逐篇出处（原文写法 + 符号对照）/ 相关概念。
//
// 设计动机（v3.52 产品重设计）：清单卡片只承载「扫一眼」的信息（名称/公式/截断解读/
// 论文标签），深读动作（这篇里公式长什么样？符号怎么定义？）交给浮窗一次给齐——
// 卡片上的 <details> 折叠区（符号表/出处明细）整块退役，卡片高度稳定，
// 「文字与符号表重叠」的布局源一并消除。编辑走「预览 → 编辑」链路（浮窗头部按钮）。
//
// 打开入口：公式卡点击（非按钮/胶囊/选区）、卡上编辑外的区域。
// 关闭：Esc / 遮罩 / 头部 ×。与编辑抽屉互斥（打开编辑时先关预览）。

import { DEL, PATCH, POST } from '../core/api.js';
import { openMergeDialog } from '../core/form-dialog.js';
import { gotoPaper } from '../core/nav.js';
import { conceptsForFormula, renderKatexSafe, termSimilarity } from '../core/knowledge-link.js';
import { renderMd } from '../core/markdown.js';
import { plotSvg } from '../core/plot.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { chipClass, escapeHtml } from '../core/format.js';
// 与 formulas.js / editor-drawer.js 构成模块循环，双方只在事件回调里调对方函数
// （声明提升 + 运行时解析），顶层求值互不依赖——与 concepts ↔ drawer 同构安全。
import { renderFormulaSidebar, renderFormulas, VAR_ROLE_LABEL } from './formulas.js';
import { openFormulaEditor } from './editor-drawer.js';

let _overlay = null;

const ICONS = {
  close:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  star:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
};

/** 打开（或切换到）某公式的预览浮窗。公式不存在时静默关闭。 */
export function openFormulaDetail(id) {
  const f = (state.formulas || []).find((x) => x.id === id);
  if (!f) { closeFormulaDetail(); return; }
  if (!_overlay) _buildDom();
  _render(f);
  _overlay.classList.add('open');
  document.addEventListener('keydown', _onKey);
}

export function closeFormulaDetail() {
  if (!_overlay) return;
  _overlay.classList.remove('open');
  document.removeEventListener('keydown', _onKey);
}

function _onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFormulaDetail(); }
}

function _buildDom() {
  _overlay = document.createElement('div');
  _overlay.id = 'formula-detail-overlay';
  _overlay.className = 'formula-detail-overlay';
  _overlay.innerHTML = '<div class="fdv" id="formula-detail-panel" role="dialog" aria-modal="true" aria-label="公式预览"></div>';
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) closeFormulaDetail(); });
  document.body.appendChild(_overlay);
}

/** 渲染一次浮窗内容。f 是渲染时点的快照；编辑保存后由调用方重开/关窗刷新。 */
function _render(f) {
  const panel = _overlay.querySelector('#formula-detail-panel');
  const freq = (f.paperIds || []).length;
  const occs = (f.occurrences || [])
    .map((o) => ({ o, p: state.papers.find((x) => x.id === o.paperId) }))
    .filter((x) => x.p);
  const relConcepts = conceptsForFormula(f).slice(0, 6);
  const vars = f.variables || [];

  panel.innerHTML = `
    <header class="fdv-head">
      <div class="fdv-head-main">
        <h3>${escapeHtml(f.name || f.canonicalName)}</h3>
        ${freq ? `<span class="fdv-freq" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}
      </div>
      <div class="fdv-head-actions">
        <button type="button" class="qbtn icon fdv-copy" title="复制 LaTeX（$…$ 包裹，可直接粘进 Markdown）" aria-label="复制 LaTeX">${ICONS.copy}</button>
        <button type="button" class="qbtn icon fdv-edit" title="编辑公式（LaTeX / 符号表 / 绘图 / 概念关联）" aria-label="编辑">${ICONS.edit}</button>
        <button type="button" class="card-star${f.starred ? ' on' : ''} fdv-star" title="${f.starred ? '取消重点' : '标记为重点'}" aria-label="星标" aria-pressed="${!!f.starred}">${ICONS.star}</button>
        <button type="button" class="qbtn icon fdv-close" title="关闭 (Esc)" aria-label="关闭">${ICONS.close}</button>
      </div>
    </header>
    <div class="fdv-body">
      <div class="fdv-meta">
        <code class="fdv-canon">${escapeHtml(f.canonicalName)}</code>
        ${f.category ? `<span class="fdv-cat">${escapeHtml(f.category)}</span>` : ''}
        ${f.source === 'vision' ? '<span class="fdv-src" title="由阅读器框选补录">框选</span>' : ''}
        ${f.source === 'mineru' ? '<span class="fdv-src" title="由 MinerU 抽取">MinerU</span>' : ''}
        ${f.source === 'manual' ? '<span class="fdv-src" title="已人工修订">人工</span>' : ''}
      </div>
      <div class="fdv-latex">${renderKatexSafe(f.latex, true)}</div>
      ${f.plottable && f.plotHint ? `<div class="fdv-plot">${plotSvg(f.plotHint, 640, 170) || ''}</div>` : ''}
      ${f.description ? `<div class="fdv-desc">${renderMd(f.description)}</div>` : '<div class="fdv-desc muted">（无解读）</div>'}
      ${vars.length ? `
      <section class="fdv-sec">
        <div class="fdv-sec-title">符号表</div>
        <table class="fdv-vars-table">
          <thead><tr><th>符号</th><th>含义</th><th>角色</th></tr></thead>
          <tbody>${vars
            .map(
              (v) =>
                `<tr><td class="vs">${renderKatexSafe(v.symbol, false)}</td><td>${escapeHtml(v.meaning || '')}</td><td class="vr">${escapeHtml(VAR_ROLE_LABEL[v.role] || v.role || '')}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
      </section>` : ''}
      ${occs.length ? `
      <section class="fdv-sec">
        <div class="fdv-sec-title">出处明细（${occs.length} 篇）</div>
        <div class="fdv-occs">${occs
          .map((x) => {
            const label = x.p.title || x.p.filename;
            const map = Object.entries(x.o.symbolMap || {}).map(([k, v]) => `${k}→${v}`).join('、');
            const raw = String(x.o.rawLatex || '')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
              .replace(/\\tag\s*\{[^}]*\}/g, '').trim();
            return `<div class="fdv-occ">
              <div class="fdv-occ-paper">
                <button class="fdv-occ-link" data-goto="${x.o.paperId}" title="打开「${escapeHtml(label)}」">${escapeHtml(label)}</button>
                ${x.o.context ? `<span class="fdv-occ-ctx">${escapeHtml(x.o.context)}</span>` : ''}
              </div>
              ${raw ? `<div class="fdv-occ-raw">${renderKatexSafe(raw, false)}</div>` : ''}
              ${map ? `<div class="fdv-occ-map">符号对照：${escapeHtml(map)}</div>` : ''}
            </div>`;
          })
          .join('')}</div>
      </section>` : ''}
      ${relConcepts.length ? `
      <section class="fdv-sec">
        <div class="fdv-sec-title">相关概念</div>
        <div class="fdv-concepts">${relConcepts
          .map((c) => `<button class="concept-chip ${chipClass(c.term)}" data-cdopen="${c.id}" title="查看概念「${escapeHtml(c.term)}」">${escapeHtml(c.term)}</button>`)
          .join('')}</div>
      </section>` : ''}
    </div>
    <footer class="fdv-foot">
      <button type="button" class="btn ghost sm danger fdv-merge">合并到…</button>
      <button type="button" class="btn ghost sm danger fdv-del">删除</button>
      <span class="fdv-spacer"></span>
      <button type="button" class="btn sm fdv-edit2">${ICONS.edit} 编辑</button>
    </footer>`;

  // ---- 事件 ----
  panel.querySelector('.fdv-close').onclick = closeFormulaDetail;
  const editFn = () => { closeFormulaDetail(); openFormulaEditor(f); };
  panel.querySelector('.fdv-edit').onclick = editFn;
  panel.querySelector('.fdv-edit2').onclick = editFn;
  panel.querySelector('.fdv-copy').onclick = async () => {
    const text = '$' + (f.latex || '') + '$';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('LaTeX 已复制');
    } catch {
      toast('复制失败', 'error');
    }
  };
  const starBtn = panel.querySelector('.fdv-star');
  starBtn.onclick = async () => {
    const next = !f.starred;
    const r = await PATCH('/api/formulas/' + f.id, { starred: next });
    if (r && r.ok) {
      f.starred = next;
      starBtn.classList.toggle('on', next);
      starBtn.title = next ? '取消重点' : '标记为重点';
      starBtn.setAttribute('aria-pressed', String(next));
      renderFormulaSidebar();
    } else toast((r && r.error) || '操作失败', 'error');
  };
  panel.querySelector('.fdv-merge').onclick = async () => {
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
        closeFormulaDetail();
        renderFormulaSidebar();
        renderFormulas();
      } else toast((r && r.error) || '合并失败', 'error');
    } catch (e) {
      toast('网络错误：' + (e && e.message ? e.message : e), 'error');
    }
  };
  panel.querySelector('.fdv-del').onclick = async () => {
    const yes = await PWDialog.confirm(`删除公式「${f.name || f.canonicalName}」？\n此操作不可撤销。`, {
      title: '删除公式',
      danger: true,
      okText: '删除',
    });
    if (!yes) return;
    const r = await DEL('/api/formulas/' + f.id);
    if (r && r.ok) {
      toast('公式已删除');
      state.formulas = (state.formulas || []).filter((x) => x.id !== f.id);
      closeFormulaDetail();
      renderFormulaSidebar();
      renderFormulas();
    } else toast((r && r.error) || '删除失败', 'error');
  };
  panel.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); closeFormulaDetail(); gotoPaper(b.dataset.goto); };
  });
  panel.querySelectorAll('[data-cdopen]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      import('../concepts/detail-drawer.js').then((m) => { closeFormulaDetail(); m.openConceptDetail(b.dataset.cdopen); });
    };
  });
}
