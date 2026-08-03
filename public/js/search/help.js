// 搜索语法帮助浮层
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';

// ---- 语法帮助 popover ----
export function toggleSearchHelp() {
  const existing = document.querySelector('.search-help-pop');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.className = 'search-help-pop';
  pop.innerHTML = `
    <div class="shp-head"><span>搜索语法</span><button class="shp-close" type="button" aria-label="关闭">×</button></div>
    <div class="shp-body">
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
      </div>
    </div>`;
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
