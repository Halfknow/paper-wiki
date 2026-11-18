// 概念详情抽屉（v3.28）：单概念全貌——完整定义 / 可回溯出处 / 出现论文（年份·主题）/
// 共现概念 / 相关公式。从概念卡点击或公式卡的「相关概念」chip 打开，右侧滑入覆盖层。
//
// 设计动机：概念清单卡片只承载「扫一眼」的信息密度，深读动作（这个概念到底在哪些论文、
// 什么位置出现？和它一起出现的还有什么？对应哪个公式？）交给抽屉——学者复核一个术语时
// 的完整上下文一次给齐，不用在清单/论文页之间来回跳。
//
// v3.30 增强：⭐ 重点标记（组会指派/复习清单）、出现论文改按年份的**时间线**（演化脉络）、
// 「合并到…」（命名漂移产生的重复条目收敛，带疑似重复候选推荐）、「AI 综合解读」
// （SSE 流式：是什么/演化脉络/各论文用法差异——不落库，按需生成）。
//
// 打开入口：concepts.js 卡片点击、formulas.js 相关概念 chip、抽屉内共现概念 chip（换概念）。

import { DEL, PATCH, POST } from '../core/api.js';
import { sp } from '../core/api.js';
import { openFormDialog, openMergeDialog } from '../core/form-dialog.js';
import { gotoPaper } from '../core/nav.js';
import {
  coOccurringConcepts,
  formulasForConcept,
  renderKatexSafe,
  termSimilarity,
} from '../core/knowledge-link.js';
import { renderMd } from '../core/markdown.js';
import { state } from '../core/state.js';
import { streamPostSse } from '../core/stream.js';
import { toast } from '../core/ui-kit.js';
import { escapeHtml } from '../core/format.js';
import { icon } from '../core/icons.js';
// 与 concepts.js 构成模块循环（concepts → drawer → concepts），但双方都只在事件回调里
// 调对方函数（函数声明提升 + 运行时解析），顶层求值互不依赖——与 nav ↔ formulas 同构安全。
import { editConceptDialog, renderConcepts, renderConceptSidebar } from './concepts.js';

let _overlay = null; // 单例 DOM（body 级，跨页面复用）
let _explainClose = null; // 进行中的 AI 解读流（换概念/关抽屉时中止）

const _CAT_LABEL = {
  architecture: '架构',
  attention: '注意力',
  loss: '损失',
  optimization: '优化',
  regularization: '正则化',
  generative: '生成',
  representation: '表示',
  training: '训练',
  evaluation: '评估',
  inference: '推理',
  other: '其他',
};

/** 打开（或切换到）某概念的详情抽屉。概念不存在时静默关闭。 */
export function openConceptDetail(id) {
  const c = (state.concepts || []).find((x) => x.id === id);
  if (!c) { closeConceptDetail(); return; }
  if (!_overlay) _buildDom();
  _render(c);
  _overlay.classList.add('open');
  document.addEventListener('keydown', _onKey);
}

export function closeConceptDetail() {
  if (!_overlay) return;
  _overlay.classList.remove('open');
  document.removeEventListener('keydown', _onKey);
  _abortExplain();
}

export function isConceptDetailOpen() {
  return !!(_overlay && _overlay.classList.contains('open'));
}

function _onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConceptDetail(); }
}

/** 单例骨架（一次创建，内容每次重渲）。mask 点击关闭；抽屉本体拦截冒泡。 */
function _buildDom() {
  _overlay = document.createElement('div');
  _overlay.id = 'concept-detail-overlay';
  _overlay.className = 'concept-detail-overlay';
  _overlay.innerHTML = '<aside class="concept-detail" id="concept-detail-panel" role="dialog" aria-label="概念详情"></aside>';
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) closeConceptDetail(); });
  document.body.appendChild(_overlay);
}

/** 中止进行中的 AI 解读流（换概念 / 关抽屉）。 */
function _abortExplain() {
  if (_explainClose) { try { _explainClose(); } catch {} _explainClose = null; }
}

/** 渲染抽屉内容（全部 innerHTML 拼装后接线，数据均来自内存 state）。 */
function _render(c) {
  _abortExplain(); // 换概念时旧解读流不再回调（防串染到新内容）
  const panel = _overlay.querySelector('#concept-detail-panel');
  const freq = (c.paperIds || []).length;
  const paperById = new Map((state.papers || []).map((p) => [p.id, p]));
  const papers = (c.paperIds || [])
    .map((id) => ({ id, p: paperById.get(id) }))
    .filter((x) => x.p)
    // 时间线（v3.30）：按年份升序——概念的提出与演化一眼可读（写 related work 的脉络）
    .sort((a, b) => (Number(a.p.year) || 9999) - (Number(b.p.year) || 9999) || String(a.p.title || '').localeCompare(String(b.p.title || '')));
  const cooc = coOccurringConcepts(c, 10);
  const relF = formulasForConcept(c);
  const catLabel = _CAT_LABEL[c.category] || c.category;

  // 时间线论文行（年份节点 + 竖线的视觉在 CSS .cd-timeline）
  const paperRows = papers.length
    ? papers
        .map(({ id, p }) => {
          const topics = (p.topics || []).slice(0, 3).map((t) => `<span class="cd-topic">${escapeHtml(t)}</span>`).join('');
          // per-paper 由来（v3.29 contexts）：该概念在这篇论文里的章节/式号
          const ctx = ((c.contexts || []).find((x) => x.paperId === id) || {}).context || '';
          return `<div class="cd-paper" data-goto="${id}">
            <span class="cd-year">${escapeHtml(String(p.year || '—'))}</span>
            <span class="cd-paper-title" title="${escapeHtml(p.title || p.filename)}">${escapeHtml(p.title || p.filename)}</span>
            ${ctx ? `<span class="cd-paper-ctx" title="此篇中的出处">${icon('map-pin', { size: 12 })}${escapeHtml(ctx)}</span>` : ''}
            <span class="cd-paper-topics">${topics}</span>
          </div>`;
        })
        .join('')
    : '<div class="cd-empty">（已不在库内，或为独立条目）</div>';

  const coocChips = cooc.length
    ? cooc
        .map(
          ({ concept: x, count }) =>
            `<button class="cd-cooc-chip" data-cooc="${x.id}" title="共现于 ${count} 篇，点击查看">${escapeHtml(x.term)}<span class="cd-cooc-n">${count}</span></button>`,
        )
        .join('')
    : '<span class="cd-empty">（暂无共现概念——单篇独有或库内概念还很少）</span>';

  const formulaRows = relF.length
    ? relF
        .map(
          (f) => `<div class="cd-formula" data-fid="${f.id}">
            <div class="cd-formula-name">${escapeHtml(f.name || f.canonicalName)}</div>
            <div class="cd-formula-latex">${renderKatexSafe(f.latex, true)}</div>
          </div>`,
        )
        .join('')
    : '<span class="cd-empty">（暂无相关公式——公式抽取时会把本篇概念清单喂给模型建立关联）</span>';

  panel.innerHTML = `
    <header class="cd-head">
      <div class="cd-head-main">
        <h3 class="cd-term">${escapeHtml(c.term)}</h3>
        <div class="cd-badges">
          <button class="btn ghost xs icon star-btn cd-star${c.starred ? ' is-starred' : ''}" data-cd-star title="${c.starred ? '取消重点标记' : '标记为重点（组会讨论 / 复习清单）'}" aria-label="星标" aria-pressed="${!!c.starred}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
          ${catLabel ? `<span class="cd-badge badge" title="AI 分类">${escapeHtml(catLabel)}</span>` : ''}
          ${c.importance === 'core' ? '<span class="cd-badge badge warning" title="至少一篇论文把它列为核心创新">核心创新</span>' : ''}
          ${freq ? `<span class="cd-badge badge" title="出现在 ${freq} 篇论文中">${freq} 篇</span>` : ''}
        </div>
      </div>
      <div class="cd-head-actions">
        <button class="btn secondary sm" data-cd-edit title="编辑解释与分类">编辑</button>
        <button class="btn secondary sm" data-cd-merge title="把重复条目并入此概念，或把此概念并入目标">合并…</button>
        <button class="btn secondary sm danger" data-cd-del title="删除概念">删除</button>
        <button class="btn secondary sm icon-btn" data-cd-close title="关闭 (Esc)" aria-label="关闭">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </header>
    <div class="cd-body">
      <section class="cd-section">
        <h4>定义</h4>
        <p class="cd-def">${escapeHtml(c.definition || '') || '<span class="cd-empty">（缺解释——可在编辑里补写，或对该论文重新抽取概念）</span>'}</p>
        ${c.context ? `<p class="cd-ctx" title="首次定义处">出处：${escapeHtml(c.context)}</p>` : ''}
      </section>
      <section class="cd-section">
        <h4>出现论文 <span class="cd-n">${papers.length}</span><span class="cd-timeline-hint">按年份时间线</span></h4>
        <div class="cd-timeline cd-papers">${paperRows}</div>
      </section>
      <section class="cd-section">
        <h4>共现概念</h4>
        <div class="cd-coocs">${coocChips}</div>
      </section>
      <section class="cd-section">
        <h4>相关公式 <span class="cd-n">${relF.length}</span></h4>
        <div class="cd-formulas">${formulaRows}</div>
      </section>
      <section class="cd-section cd-explain-sec">
        <h4>AI 综合解读 <button class="btn secondary sm cd-explain-btn" data-cd-explain>生成</button></h4>
        <div class="cd-explain-body"><span class="cd-empty">基于库内出现论文生成「是什么 / 演化脉络 / 各论文用法差异」的综合讲解（按需生成，不保存）。</span></div>
      </section>
    </div>`;

  panel.querySelector('[data-cd-close]').onclick = closeConceptDetail;
  panel.querySelectorAll('.cd-paper[data-goto]').forEach((el) => {
    el.onclick = () => { closeConceptDetail(); gotoPaper(el.dataset.goto); };
  });
  panel.querySelectorAll('.cd-cooc-chip[data-cooc]').forEach((el) => {
    el.onclick = () => openConceptDetail(el.dataset.cooc); // 抽屉内换概念，不叠层
  });
  // ⭐ 星标切换（v3.30）：就地翻转，列表/侧栏计数联动
  panel.querySelector('[data-cd-star]').onclick = async () => {
    const next = !c.starred;
    const r = await PATCH('/api/concepts/' + c.id, { starred: next });
    if (r && r.ok) {
      c.starred = next;
      const btn = panel.querySelector('[data-cd-star]');
      btn.classList.toggle('is-starred', next);
      btn.title = next ? '取消重点标记' : '标记为重点（组会讨论 / 复习清单）';
      btn.setAttribute('aria-pressed', String(next));
      renderConceptSidebar();
      renderConcepts();
    } else toast((r && r.error) || '操作失败', 'error');
  };
  panel.querySelector('[data-cd-merge]').onclick = async () => {
    const candidates = (state.concepts || [])
      .filter((x) => x.id !== c.id)
      .map((x) => ({ id: x.id, label: x.term, sim: termSimilarity(c.term, x.term) }))
      .sort((a, b) => b.sim - a.sim || a.label.localeCompare(b.label))
      .slice(0, 60);
    const suspect = candidates.filter((x) => x.sim >= 0.6);
    const targetId = await openMergeDialog({
      title: '合并概念',
      selfLabel: c.term,
      candidates: [...suspect, ...candidates.filter((x) => x.sim < 0.6)],
    });
    if (!targetId) return;
    const r = await POST('/api/concepts/merge', { sourceId: c.id, targetId });
    if (r && r.ok) {
      const merged = r.data && r.data.concept;
      toast(`已并入「${merged ? merged.term : targetId}」`);
      state.concepts = (state.concepts || []).filter((x) => x.id !== c.id);
      if (merged) {
        const idx = state.concepts.findIndex((x) => x.id === merged.id);
        if (idx >= 0) state.concepts[idx] = merged;
      }
      renderConceptSidebar();
      renderConcepts();
      if (merged) openConceptDetail(merged.id); // 直接看合并结果
      else closeConceptDetail();
    } else toast((r && r.error) || '合并失败', 'error');
  };
  panel.querySelector('[data-cd-del]').onclick = async () => {
    if (!(await PWDialog.confirm(`删除概念「${c.term}」？`, { title: '删除概念', danger: true, okText: '删除' }))) return;
    const r = await DEL('/api/concepts/' + c.id);
    if (r && r.ok) {
      toast('概念已删除');
      state.concepts = (state.concepts || []).filter((x) => x.id !== c.id);
      closeConceptDetail();
      renderConceptSidebar();
      renderConcepts();
    } else toast((r && r.error) || '删除失败', 'error');
  };
  panel.querySelector('[data-cd-edit]').onclick = async () => {
    // 全字段编辑表单（v3.29）：术语/解释/分类/核心度
    await editConceptDialog(c);
    const cur = (state.concepts || []).find((x) => x.id === c.id);
    if (cur) _render(cur); // 表单保存后抽屉就地刷新（概念可能已改名）
  };
  // AI 综合解读（v3.30）：SSE 流式逐字渲染 Markdown
  panel.querySelector('[data-cd-explain]').onclick = () => {
    const body = panel.querySelector('.cd-explain-body');
    const btn = panel.querySelector('[data-cd-explain]');
    if (_explainClose) { _abortExplain(); } // 再点重新生成
    btn.disabled = true;
    btn.textContent = '生成中…';
    let acc = '';
    body.innerHTML = '<div class="cd-explain-stream"><span class="cd-empty">正在生成…</span></div>';
    const stream = body.querySelector('.cd-explain-stream');
    _explainClose = streamPostSse(sp('/api/concepts/' + c.id + '/explain'), {}, {
      onToken: (obj) => {
        acc += (obj && obj.tok) || '';
        stream.innerHTML = renderMd(acc);
        body.scrollTop = body.scrollHeight;
      },
      onDone: () => {
        _explainClose = null;
        btn.disabled = false;
        btn.textContent = '重新生成';
        if (!acc.trim()) stream.innerHTML = '<span class="cd-empty">（模型返回为空，请重试）</span>';
      },
      onFail: (msg) => {
        _explainClose = null;
        btn.disabled = false;
        btn.textContent = '重试';
        stream.insertAdjacentHTML('beforeend', `<div class="cd-explain-err">${escapeHtml(String(msg))}</div>`);
      },
    });
  };
}
