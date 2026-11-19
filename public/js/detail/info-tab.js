// 信息 tab 与字段 patch
//
// v3.59 重做：此前是一个 .info-grid，把三类性质完全不同的东西塞进同一种格子——
//   纯展示（摘要 / 文件 / 阅读进度）、就地编辑（阅读状态 / 主题 / 标签 / 收藏夹）、
//   耗时动作（重新抽概念 / 抽公式）——看不出哪些能改、哪些一点就跑 AI。
//   操作说明还只能塞进 label 文案（「主题（点 × 移除，Enter 添加）」），是用文案补设计。
//
// 现在按「读什么 → 改什么 → 做什么」分层，复用全站已统一的行式语言（.set-section /
// .set-row / .sr-*，令牌见 styles.css :root「行式布局令牌」）：
//   概览   只读行，右侧是值
//   属性   可编辑行，右侧是控件
//   知识产出 展示 + 重算
//   操作   动作行，右侧是按钮（含自论文卡下沉来的重新总结 / 打标 / BibTeX）
//   危险区 删除，单独一节，同设置页「恢复默认」的位置语义
// 论文卡顶部因此只留「评分 + 打开 PDF」，不再堆 6 个按钮。

import { icon } from '../core/icons.js';
import { DEL, PATCH, POST, jget, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { chipClass, escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { setBusy, toast } from '../core/ui-kit.js';
import { renderDetail } from './detail.js';
import { refresh } from '../library/refresh.js';
// 概念/公式的详情与编辑复用既有实现——同一个实体在概念页和信息页应当是同一个编辑器
import { openConceptDetail } from '../concepts/detail-drawer.js';
import { openFormulaDetail } from '../formulas/detail-overlay.js';
import { openFormulaEditor } from '../formulas/editor-drawer.js';

/** 只读行：左标签（可带说明）、右值。 */
function readRow(label, value, opts = {}) {
  const hint = opts.hint ? `<div class="sr-hint">${opts.hint}</div>` : '';
  const cls = opts.mono ? 'sr-val mono' : 'sr-val';
  return (
    `<div class="set-row"><div class="sr-main"><div class="sr-label">${escapeHtml(label)}</div>${hint}</div>` +
    `<div class="sr-ctl"><span class="${cls}">${value}</span></div></div>`
  );
}

/** 控件行 / 动作行：左标签 + 说明，右侧塞任意 HTML。 */
function ctlRow(label, ctl, hint) {
  return (
    `<div class="set-row"><div class="sr-main"><div class="sr-label">${escapeHtml(label)}</div>` +
    (hint ? `<div class="sr-hint">${hint}</div>` : '') +
    `</div><div class="sr-ctl">${ctl}</div></div>`
  );
}

/** 整行铺开的编辑块（chips 这类横向会长的内容不适合挤在右侧控件列）。 */
function wideRow(label, hint, inner) {
  return (
    `<div class="set-row set-row-stack"><div class="sr-main"><div class="sr-label">${escapeHtml(label)}</div>` +
    (hint ? `<div class="sr-hint">${hint}</div>` : '') +
    `<div class="sr-stack-body">${inner}</div></div></div>`
  );
}

function progressText(p) {
  if (!p.readProgress) return '尚未阅读';
  const rp = p.readProgress;
  return `第 ${rp.page}/${rp.total || '?'} 页 · ${new Date(rp.updatedAt).toLocaleString()}`;
}


// ---------------------------------------------------------------------------
// 知识产出清单（v3.60）
//
// 此前信息页只显示「已贡献 12 个概念」这样一个数字——看得到量，看不到是什么，
// 更改不了。现在可展开成清单，每条接进**已有的**详情抽屉 / 编辑器：
//   概念 → openConceptDetail（出现论文、共现概念、相关公式、合并、AI 解读、星标、删除）
//   公式 → openFormulaDetail（预览浮窗）/ openFormulaEditor（全字段编辑）
// 不另造一套编辑界面：同一个实体在概念页和这里应当是同一个编辑器，否则两处会漂。
//
// 那两个抽屉都从 state.concepts / state.formulas 里按 id 找对象，若用户没进过
// 概念/公式页，这两个数组是空的、抽屉会静默关掉。故展开前先确保全局列表已加载，
// 而不是单独拉 ?paper= 的子集——子集喂不饱抽屉里的「共现概念」等跨条目信息。
let _kxLoading = false;
async function ensureKnowledgeLoaded(force = false) {
  if (_kxLoading) return;
  const needC = force || !(state.concepts || []).length;
  const needF = force || !(state.formulas || []).length;
  if (!needC && !needF) return;
  _kxLoading = true;
  try {
    const [cr, fr] = await Promise.all([needC ? jget("/api/concepts") : null, needF ? jget("/api/formulas") : null]);
    if (cr && Array.isArray(cr.data)) state.concepts = cr.data;
    if (fr && Array.isArray(fr.data)) state.formulas = fr.data;
  } catch { /* 拉取失败时清单显示空态，不影响页面其余部分 */ }
  _kxLoading = false;
}

/** 用真实关系校正「已贡献 N 个」。
 *  论文记录上的 conceptIds/formulaIds 与概念/公式侧的 paperIds 会不一致（实测有
 *  论文 conceptIds=0 而概念侧有 5 条指向它）——权威关系在概念/公式那一侧，
 *  论文侧那两个数组只是冗余缓存。旧版信息页只显示数字，所以这个偏差一直没被发现。 */
async function syncKnowledgeCounts(pid) {
  await ensureKnowledgeLoaded();
  const set = (id, n, tpl, btnId) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = tpl(n);
    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = !n;
  };
  const cn = (state.concepts || []).filter((c) => (c.paperIds || []).includes(pid)).length;
  const fn = (state.formulas || []).filter((f) => (f.paperIds || []).includes(pid)).length;
  set("kx-concepts-count", cn, (n) => `已贡献 <b>${n}</b> 个概念`, "b-concepts-expand");
  set("kx-formulas-count", fn, (n) => `已涉及 <b>${n}</b> 个公式`, "b-formulas-expand");
}

const KX_IMPORTANCE = { core: "核心", supporting: "支撑" };

/** 本篇的概念清单。右侧动作交给概念详情抽屉（它自带改名/合并/删除/星标）。 */
function conceptRowsHtml(pid) {
  const list = (state.concepts || []).filter((c) => (c.paperIds || []).includes(pid));
  if (!list.length) return '<div class="kx-empty">本篇还没有抽取出概念。点上方「重新抽取」试试。</div>';
  return list
    .map((c) => {
      const imp = KX_IMPORTANCE[c.importance] || "";
      const meta = [imp, c.category ? escapeHtml(c.category) : "", `${(c.paperIds || []).length} 篇`]
        .filter(Boolean)
        .join(" · ");
      return (
        `<div class="kx-item" data-kx-concept="${escapeHtml(c.id)}" tabindex="0" role="button" title="查看概念详情">` +
        `<span class="kx-main"><span class="kx-title ${chipClass(c.term)}">${escapeHtml(c.term)}</span>` +
        `<span class="kx-meta">${meta}</span></span>` +
        `<span class="kx-def">${escapeHtml((c.definition || "").slice(0, 60))}</span>` +
        `</div>`
      );
    })
    .join("");
}

/** 本篇的公式清单。行内两个动作：预览（浮窗）与编辑（全字段抽屉）。 */
function formulaRowsHtml(pid) {
  const list = (state.formulas || []).filter((f) => (f.paperIds || []).includes(pid));
  if (!list.length) return '<div class="kx-empty">本篇还没有抽取出公式。点上方「重新抽取」试试。</div>';
  return list
    .map((f) => {
      const meta = [f.category ? escapeHtml(f.category) : "", `${(f.paperIds || []).length} 篇`].filter(Boolean).join(" · ");
      return (
        `<div class="kx-item" data-kx-formula="${escapeHtml(f.id)}" tabindex="0" role="button" title="预览公式">` +
        `<span class="kx-main"><span class="kx-title">${escapeHtml(f.name || f.canonicalName || "(未命名)")}</span>` +
        `<span class="kx-meta">${meta}</span></span>` +
        `<span class="kx-latex">${escapeHtml((f.latex || "").slice(0, 48))}</span>` +
        `<button class="btn ghost sm kx-edit" type="button" data-kx-fedit="${escapeHtml(f.id)}" title="编辑公式">编辑</button>` +
        `</div>`
      );
    })
    .join("");
}
export function renderInfoTab(body, p) {
  const folderChecks = state.folders
    .map(
      (fo) => `
    <label class="tag folder-check" style="border-color:${escapeHtml(fo.color)};color:${escapeHtml(fo.color)}">
      <input type="checkbox" value="${fo.id}" ${(p.folders || []).includes(fo.id) ? 'checked' : ''} data-fcheck/>
      ${escapeHtml(fo.name)}
    </label>`,
    )
    .join(' ');

  const topicChips =
    (p.topics || [])
      .map(
        (t) =>
          `<span class="topic ${chipClass(t)}">${escapeHtml(t)} <span class="x" data-topic-del="${escapeHtml(t)}" role="button" tabindex="0" title="移除" aria-label="移除主题 ${escapeHtml(t)}">${icon('x', { size: 12 })}</span></span>`,
      )
      .join(' ') || '';
  const tagChips =
    (p.tags || [])
      .map(
        (t) =>
          `<span class="tag ${chipClass(t)}">${escapeHtml(t)} <span class="x" data-tag-del="${escapeHtml(t)}" role="button" tabindex="0" title="移除" aria-label="移除标签 ${escapeHtml(t)}">${icon('x', { size: 12 })}</span></span>`,
      )
      .join(' ') || '';

  const srcLabel =
    p.metaSource === 'ai-fallback' ? 'AI 推断（未匹配到 arXiv）' : p.metaSource ? escapeHtml(p.metaSource) : '未知';

  body.innerHTML = `
    <div class="info-page">
      <div class="set-section">概览</div>
      <div class="info-abstract">
        <div class="ia-label">摘要</div>
        <div class="ia-text${(p.abstract || '').length > 420 ? ' clamped' : ''}" id="info-abstract">${escapeHtml(p.abstract || '（无摘要）')}</div>
        ${(p.abstract || '').length > 420 ? '<button class="btn ghost sm ia-more" id="b-abstract-more" type="button">展开全文</button>' : ''}
      </div>
      <div class="set-rows">
        ${readRow('阅读进度', escapeHtml(progressText(p)))}
        ${readRow('文件', escapeHtml(p.filename) + (p.fulltextChars ? ` · ${Math.round(p.fulltextChars / 1000)}k 字` : ''), { mono: true })}
        ${readRow('元数据来源', srcLabel, { hint: '入库时从 arXiv 匹配；匹配不到才由 AI 从正文推断。' })}
      </div>

      <div class="set-section">属性<span class="set-section-sub">改动即时保存，无需确认。</span></div>
      <div class="set-rows">
        ${ctlRow(
          '阅读状态',
          `<div class="read-pill" id="read-pill">
            <button data-rs="unread" class="${(p.readStatus || 'unread') === 'unread' ? 'active' : ''}">未读</button>
            <button data-rs="reading" class="${p.readStatus === 'reading' ? 'active' : ''}">在读</button>
            <button data-rs="done" class="${p.readStatus === 'done' ? 'active' : ''}">已读</button>
          </div>`,
        )}
        ${wideRow(
          '主题',
          '中文主题，用于跨论文归类。回车添加，点 × 移除。',
          `<div class="chip-row" id="topic-row">${topicChips}<input type="text" id="topic-add" class="chip-input" placeholder="+ 主题" /></div>`,
        )}
        ${wideRow(
          '标签',
          '英文标签，偏细粒度。回车添加，点 × 移除。',
          `<div class="chip-row">${tagChips}<input type="text" id="tag-add" class="chip-input" placeholder="+ 标签" /></div>`,
        )}
        ${wideRow(
          '收藏夹',
          state.folders.length ? '可同时归入多个收藏夹。' : '',
          `<div class="chip-row">${folderChecks || '<span class="sr-hint">暂无收藏夹，点侧栏「收藏夹」标题右侧的齿轮按钮新建</span>'}</div>`,
        )}
      </div>

      <div class="set-section">知识产出<span class="set-section-sub">本篇贡献到全局概念库 / 公式库的内容。展开可逐条查看与管理；重算会追加新条目，不会删除已有的。</span></div>
      <div class="set-rows">
        <div class="set-row">
          <div class="sr-main">
            <div class="sr-label">概念</div>
            <div class="sr-hint" id="kx-concepts-count">已贡献 <b>${(p.conceptIds || []).length}</b> 个概念</div>
          </div>
          <div class="sr-ctl">
            <button class="btn ghost sm kx-toggle" id="b-concepts-expand" type="button" aria-expanded="false">展开</button>
            <button class="btn secondary sm" id="b-concepts-this" type="button">重新抽取</button>
          </div>
        </div>
        <div class="kx-list" id="kx-concepts" hidden></div>
        <div class="set-row">
          <div class="sr-main">
            <div class="sr-label">公式</div>
            <div class="sr-hint" id="kx-formulas-count">已涉及 <b>${(p.formulaIds || []).length}</b> 个公式</div>
          </div>
          <div class="sr-ctl">
            <button class="btn ghost sm kx-toggle" id="b-formulas-expand" type="button" aria-expanded="false">展开</button>
            <button class="btn secondary sm" id="b-formulas-this" type="button">重新抽取</button>
          </div>
        </div>
        <div class="kx-list" id="kx-formulas" hidden></div>
      </div>

      <div class="set-section">操作</div>
      <div class="set-rows">
        ${ctlRow(
          '重新总结',
          '<button class="btn secondary sm" id="b-resume" type="button">重新总结</button>',
          '按当前的总结提示词重跑，同时刷新主题与概念。已有总结会被替换。',
        )}
        ${ctlRow(
          '重新打标',
          '<button class="btn secondary sm" id="b-retag" type="button">重新打标</button>',
          '按当前的标签提示词重打标签与主题，标签库随之增删。',
        )}
        ${ctlRow(
          '引用',
          '<button class="btn secondary sm" id="b-copy-bib" type="button">复制 BibTeX</button>',
          '复制本篇的 BibTeX 条目到剪贴板。',
        )}
      </div>

      <div class="set-rows set-rows-foot">
        <div class="set-row set-row-reset">
          <div class="sr-main"><div class="sr-hint">删除论文，连同本地 PDF 与已抽取的全文一并移除，<b>不可恢复</b>。概念/公式默认保留在库中，可在确认框勾选一并删除仅由本篇贡献的条目。</div></div>
          <div class="sr-ctl"><button class="btn ghost sm danger" id="b-delete" type="button">删除论文</button></div>
        </div>
      </div>
    </div>`;

  wireInfoTab(body, p);
  // 计数以概念/公式侧的 paperIds 为准后台校正——见 syncKnowledgeCounts 注释。
  syncKnowledgeCounts(p.id);
}

/** 事件接线。与渲染分开，读起来是「这一屏有哪些行」和「每一行怎么动」两件事。 */
function wireInfoTab(body, p) {
  // ---- 概览：摘要展开 ----
  const more = $('b-abstract-more');
  if (more) {
    more.onclick = () => {
      const t = $('info-abstract');
      const open = t.classList.toggle('clamped');
      more.textContent = open ? '展开全文' : '收起';
    };
  }

  // ---- 属性：即时保存 ----
  body.querySelectorAll('#read-pill button').forEach((b) => {
    b.onclick = () => patch(p.id, { readStatus: b.dataset.rs });
  });
  body.querySelectorAll('[data-fcheck]').forEach((cb) => {
    cb.onchange = () => {
      const next = body.querySelectorAll('[data-fcheck]:checked');
      patch(p.id, { folders: [...next].map((x) => x.value) });
    };
  });

  const removeChip = (attr, field) => {
    body.querySelectorAll(`[${attr}]`).forEach((x) => {
      const run = () => patch(p.id, { [field]: (p[field] || []).filter((t) => t !== x.getAttribute(attr)) });
      x.onclick = run;
      x.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); }
      };
    });
  };
  removeChip('data-topic-del', 'topics');
  removeChip('data-tag-del', 'tags');

  const addChip = (inputId, field, label) => {
    const el = $(inputId);
    if (!el) return;
    el.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const v = el.value.trim();
      if (!v) return;
      if ((p[field] || []).includes(v)) { toast(`${label}「${v}」已存在`, 'info'); el.value = ''; return; }
      patch(p.id, { [field]: [...(p[field] || []), v] });
      toast(`${label}已添加`);
    };
  };
  addChip('topic-add', 'topics', '主题');
  addChip('tag-add', 'tags', '标签');

  // ---- 知识产出：抽完重拉详情，让计数实时更新 ----
  //（refresh 拉的是 summaryView，不含 conceptIds/formulaIds，必须单独拉详情）
  const reextract = (btnId, url, unit) => {
    const b = $(btnId);
    if (!b) return;
    b.onclick = async () => {
      setBusy(b, true, '抽取中…');
      let r;
      try {
        r = await POST(url, { ids: [p.id] });
      } catch (e) {
        toast('抽取失败：' + (e && e.message), 'error');
        return;
      } finally {
        setBusy(b, false);
      }
      if (r.data && r.data.added != null) toast(`完成：处理 ${r.data.processed} 篇，新增 ${r.data.added} 个${unit}`);
      else toast(r.error || '抽取失败', 'error');
      // 抽取改的是概念/公式侧的 paperIds 关联；state 里这两份清单是页面上次拉取的旧快照，
      // 而 ensureKnowledgeLoaded 只在空数组时才拉——不强制重拉，本篇计数永远停在抽取前的值。
      try {
        await ensureKnowledgeLoaded(true);
      } catch { /* 清单重拉失败时按旧快照展示 */ }
      try {
        const { data: fresh } = await jget('/api/papers/' + encodeURIComponent(p.id));
        if (fresh) { state.detail = fresh; renderDetail(); }
      } catch { /* 详情重拉失败不影响已完成的抽取 */ }
      refresh();
    };
  };
  // ---- 知识产出：展开清单 ----
  const wireExpand = (btnId, listId, rowsHtml, onRowClick) => {
    const btn = $(btnId), box = $(listId);
    if (!btn || !box) return;
    btn.onclick = async () => {
      const open = box.hidden;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '收起' : '展开';
      if (!open) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="kx-empty">加载中…</div>';
      await ensureKnowledgeLoaded();
      box.innerHTML = rowsHtml(p.id);
    };
    box.onclick = (e) => onRowClick(e);
    box.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.closest('[data-kx-concept],[data-kx-formula]')) return;
      e.preventDefault();
      onRowClick(e);
    };
  };

  wireExpand('b-concepts-expand', 'kx-concepts', conceptRowsHtml, (e) => {
    const row = e.target.closest('[data-kx-concept]');
    if (row) openConceptDetail(row.dataset.kxConcept);
  });
  wireExpand('b-formulas-expand', 'kx-formulas', formulaRowsHtml, (e) => {
    const ed = e.target.closest('[data-kx-fedit]');
    if (ed) {
      e.stopPropagation();
      const f = (state.formulas || []).find((x) => x.id === ed.dataset.kxFedit);
      if (f) openFormulaEditor(f);
      return;
    }
    const row = e.target.closest('[data-kx-formula]');
    if (row) openFormulaDetail(row.dataset.kxFormula);
  });

  reextract('b-concepts-this', '/api/papers/concepts', '概念');
  reextract('b-formulas-this', '/api/papers/formulas', '公式');

  // ---- 操作（v3.59 自论文卡顶部下沉）----
  const resume = $('b-resume');
  if (resume) resume.onclick = async () => {
    setBusy(resume, true, '已排队…');
    const r = await POST('/api/papers/' + p.id + '/summarize');
    setBusy(resume, false);
    if (r.ok) toast('已加入重新总结队列');
    else toast(r.error || '重新总结失败', 'error');
    setTimeout(refresh, 600);
  };

  const retag = $('b-retag');
  if (retag) retag.onclick = async () => {
    setBusy(retag, true, '打标中…');
    if (resume) resume.disabled = true;   // 两者都会改主题，并发跑会互相覆盖
    const r = await POST('/api/papers/' + p.id + '/retag');
    setBusy(retag, false);
    if (resume) resume.disabled = false;
    if (r.ok) { toast('已重新打标'); refresh(); }
    else toast(r.error || '重新打标失败', 'error');
  };

  // 复制本篇 BibTeX：从导出端点取单篇文本 → 剪贴板（写论文引用即取即用）
  const bib = $('b-copy-bib');
  if (bib) bib.onclick = async () => {
    setBusy(bib, true, '复制中…');
    try {
      const r = await fetch(sp('/api/papers.bib?ids=' + encodeURIComponent(p.id)));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await navigator.clipboard.writeText(await r.text());
      toast('BibTeX 已复制到剪贴板');
    } catch (e) {
      toast('复制失败：' + (e && e.message ? e.message : '网络错误'), 'error');
    } finally {
      setBusy(bib, false);
    }
  };

  // ---- 危险区 ----
  // 知识产出选项：勾选=同时删除仅由本篇贡献的概念/公式（共享条目只解除关联）；
  // 不勾（默认）=知识条目全部保留在库中，只解除与本篇的关联
  const del = $('b-delete');
  if (del) del.onclick = async () => {
    const r = await PWDialog.confirmCheck(
      `删除论文「${p.title || p.filename}」？
将同时删除本地 PDF 与全文文本，且不可恢复。`,
      {
        title: '删除论文',
        danger: true,
        okText: '删除',
        checkbox: { label: '同时删除仅由本篇贡献的概念/公式（其他论文共享的条目只解除关联）', checked: false },
      },
    );
    if (!r || !r.ok) return;
    setBusy(del, true, '删除中…');
    const res = await DEL('/api/papers/' + p.id + '?keepKnowledge=' + (r.checked ? '0' : '1'));
    setBusy(del, false);
    if (res.ok) {
      const c = res.data && res.data.conceptsRemoved;
      const f = res.data && res.data.formulasRemoved;
      toast(c || f ? `已删除（一并移除 ${c} 个概念、${f} 个公式）` : '已删除');
      state.detail = null;   // 清空详情，回到「从左侧选择一篇论文」
      renderDetail();
      refresh();
    } else toast(res.error || '删除失败', 'error');
  };
}

export async function patch(id, fields, silent) {
  const r = await PATCH('/api/papers/' + encodeURIComponent(id), fields);
  if (!silent && r.ok && r.data) {
    state.detail = r.data;
    renderDetail();
    refresh();
  } else if (!silent && !r.ok) {
    toast(r.error || '保存失败', 'error');
  }
  return r;
}

// ---- 阅读器 ----
export let reader = null;

export function syncLocalAnnotations(id, annotations, extra) {
  if (state.detail && state.detail.id === id) {
    state.detail = { ...state.detail, ...(extra || {}), annotations };
  }
  const row = state.papers.find((p) => p.id === id);
  if (row) row.annotations = annotations;
  if (reader && reader.paper && reader.paper.id === id) reader.paper.annotations = annotations;
}

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_reader(v) {
  reader = v;
}
