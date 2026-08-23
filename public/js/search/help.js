// 搜索语法帮助浮层
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。
// v3.20：按 currentView() 显示对应语法表（概念/公式页的字段与论文页不同）。

import { $ } from '../core/dom.js';
import { currentView } from '../views/view-switch.js';

/** 论文页语法内容（v3.2 原有）。 */
function libraryHelpBody() {
  return `
    <div class="shp-section"><div class="shp-title">字段前缀</div>
      <table class="shp-table">
        <tr><td><code>title:</code></td><td>仅标题</td><td><code>tag:</code></td><td>含某标签</td></tr>
        <tr><td><code>abstract:</code></td><td>仅摘要</td><td><code>topic:</code></td><td>含某主题</td></tr>
        <tr><td><code>summary:</code></td><td>仅 AI 总结</td><td><code>author:</code></td><td>作者子串</td></tr>
        <tr><td><code>notes:</code></td><td>仅笔记</td><td><code>year:</code></td><td>年份（见下）</td></tr>
        <tr><td><code>status:</code></td><td>处理状态</td><td><code>read:</code></td><td>阅读状态</td></tr>
        <tr><td><code>star:1</code></td><td>仅星标</td><td><code>body:</code></td><td>正文全文检索</td></tr>
      </table>
    </div>
    <div class="shp-section"><div class="shp-title">年份格式</div>
      <div class="shp-codes"><code>year:2024</code> <code>year:&gt;=2020</code> <code>year:2020-2024</code> <code>year:&lt;2023</code></div>
    </div>
    <div class="shp-section"><div class="shp-title">操作符</div>
      <div class="shp-codes"><code>"exact phrase"</code> <code>-tag:draft</code>（排除） <code>AND</code> <code>OR</code> <code>NOT</code> <code>( ... )</code></div>
      <div class="shp-note">裸词默认 AND：transformer attention = 两词都命中。</div>
    </div>
    <div class="shp-section"><div class="shp-title">示例</div>
      <div class="shp-examples">
        <div><code>title:diffusion year:&gt;=2023 tag:image</code></div>
        <div><code>"vision transformer" author:dosovitskiy</code></div>
        <div><code>body:in-context-learning topic:推理</code> <span class="shp-note">（正文 + 元数据交集）</span></div>
        <div><code>(tag:moe OR tag:icl) -status:error</code></div>
      </div>
    </div>`;
}

/** 概念页语法内容（v3.20 → v3.28 扩容）：裸词搜 term/definition + 结构化字段。 */
function conceptsHelpBody() {
  return `
    <div class="shp-section"><div class="shp-title">关键词</div>
      <div class="shp-note">直接输入词，搜术语名与解释（term + definition）。多个词默认 AND，都需命中。</div>
    </div>
    <div class="shp-section"><div class="shp-title">字段前缀</div>
      <table class="shp-table">
        <tr><td><code>freq:</code></td><td>热度（shared/hot/solo）</td><td><code>topic:</code></td><td>论文主题关联</td></tr>
        <tr><td><code>importance:core</code></td><td>核心创新概念</td><td><code>added:7d</code></td><td>最近新增（7d/30d）</td></tr>
        <tr><td><code>category:</code></td><td>按 AI 分类筛</td><td><code>context:.</code></td><td>有章节出处</td></tr>
        <tr><td><code>quality:nodef</code></td><td>缺解释</td><td><code>-category:</code></td><td>排除某分类</td></tr>
      </table>
      <div class="shp-note">这些分面在左侧栏都有对应入口（热度/主题/质量/最近新增/AI 分类）；freq 取值 <code>shared</code>（≥2 篇）/ <code>hot</code>（≥4 篇）/ <code>solo</code>（仅单篇）。</div>
    </div>
    <div class="shp-section"><div class="shp-title">操作符</div>
      <div class="shp-codes"><code>"exact phrase"</code> <code>-category:other</code>（排除） <code>AND</code> <code>OR</code></div>
    </div>
    <div class="shp-section"><div class="shp-title">示例</div>
      <div class="shp-examples">
        <div><code>attention category:attention</code></div>
        <div><code>freq:shared importance:core context:.</code> <span class="shp-note">（多篇共享 + 核心创新 + 有出处）</span></div>
        <div><code>topic:推理 added:7d</code> <span class="shp-note">（推理主题论文的概念，最近 7 天新增）</span></div>
        <div><code>"self-attention" -category:other</code></div>
      </div>
    </div>`;
}

/** 公式页语法内容（v3.20 → v3.28 扩容）：裸词搜 name/latex/description + 结构化字段。 */
function formulasHelpBody() {
  return `
    <div class="shp-section"><div class="shp-title">关键词</div>
      <div class="shp-note">直接输入词，搜公式名 / LaTeX / 解读（name / canonicalName / latex / description / category）。多个词默认 AND。</div>
    </div>
    <div class="shp-section"><div class="shp-title">字段前缀</div>
      <table class="shp-table">
        <tr><td><code>freq:</code></td><td>热度（shared/hot/solo）</td><td><code>source:</code></td><td>抽取来源</td></tr>
        <tr><td><code>added:7d</code></td><td>最近新增（7d/30d）</td><td><code>quality:nodef</code></td><td>缺解读</td></tr>
        <tr><td><code>category:</code></td><td>按分类筛（如 loss）</td><td><code>plottable:1</code></td><td>仅可绘图</td></tr>
      </table>
      <div class="shp-note">这些分面在左侧栏都有对应入口（热度/来源/特性/最近新增/AI 分类）；source 取值 <code>ai</code> / <code>vision</code> / <code>mineru</code> / <code>manual</code>。</div>
    </div>
    <div class="shp-section"><div class="shp-title">操作符</div>
      <div class="shp-codes"><code>"exact phrase"</code> <code>-category:loss</code>（排除） <code>AND</code> <code>OR</code></div>
    </div>
    <div class="shp-section"><div class="shp-title">示例</div>
      <div class="shp-examples">
        <div><code>softmax category:attention</code></div>
        <div><code>freq:hot added:30d</code> <span class="shp-note">（最近 30 天新增的高频公式）</span></div>
        <div><code>source:mineru plottable:1</code> <span class="shp-note">（MinerU 抽取且可绘图）</span></div>
      </div>
    </div>`;
}

// ---- 语法帮助 popover ----
export function toggleSearchHelp() {
  const existing = document.querySelector('.search-help-pop');
  if (existing) { existing.remove(); return; }
  const view = currentView();
  const body = view === 'concepts' ? conceptsHelpBody() : view === 'formulas' ? formulasHelpBody() : libraryHelpBody();
  const title = view === 'concepts' ? '概念搜索语法' : view === 'formulas' ? '公式搜索语法' : '搜索语法';
  const pop = document.createElement('div');
  pop.className = 'search-help-pop';
  pop.innerHTML = `
    <div class="shp-head"><span>${title}</span><button class="shp-close" type="button" aria-label="关闭">×</button></div>
    <div class="shp-body">${body}</div>`;
  document.body.appendChild(pop);
  const btn = $('search-help');
  const r = btn ? btn.getBoundingClientRect() : { left: 100, bottom: 100 };
  const popH = pop.offsetHeight || 400;
  let top = r.bottom + 6;
  if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - popH - 6);
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.querySelector('.shp-close').onclick = () => pop.remove();
  setTimeout(() => {
    const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', onDoc); } };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}
