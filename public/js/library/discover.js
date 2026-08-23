// 「按主题发现」弹窗：主题 → 检索式 → arXiv 候选 + 引用量 → 勾选批量导入（SSE 流式进度）。
//
// 自 public/js/bind.js 抽出（v3.15）——原是 bind() 里最大的一块自包含逻辑（自带 discoverState /
// discoverES / DISCOVER_STEPS，与其余接线无共享局部变量）。

import { POST, sp } from '../core/api.js';
import { $ } from '../core/dom.js';
import { setBusy, toast } from '../core/ui-kit.js';
import { refresh } from './refresh.js';

export function bindDiscover() {
// ============================================================
// 按主题发现论文：输入主题 → claude 生成检索式 → arXiv 候选 + S2 引用量 → 去重 → 勾选批量导入
// 流程：search 后端 POST /api/discover 返回候选；勾选后逐个 POST /api/import（复用下载+入库）。
// ============================================================
const discoverState = { results: [] }; // 最近一次发现结果，供勾选/全选读（mutate results，不重新赋值）
let discoverES = null; // 当前 SSE 连接；切主题/关弹窗时务必 close()，否则 EventSource 会自动重连重跑
function stopDiscoverStream() {
  if (discoverES) { try { discoverES.close(); } catch {} discoverES = null; }
}
function openDiscoverModal() {
  stopDiscoverStream();
  $('discover-topic-input').value = '';
  $('discover-results').innerHTML = '';
  $('discover-progress').style.display = 'none';
  $('discover-progress').innerHTML = '';
  $('discover-actions').style.display = 'none';
  const h = $('discover-hint');
  h.textContent = 'claude 把主题转成 arXiv 检索式，按「相关度 + 最新」两轴召回，再用 相关度·引用量·新近 复合排序，并剔除已入库论文。';
  h.classList.remove('error');
  $('discover-modal').classList.add('active');
  setTimeout(() => $('discover-topic-input').focus(), 50);
}
function closeDiscoverModal() { stopDiscoverStream(); $('discover-modal').classList.remove('active'); }
$('btn-discover').onclick = openDiscoverModal;
$('discover-modal-cancel').onclick = closeDiscoverModal;
$('discover-modal').addEventListener('click', (e) => { if (e.target.id === 'discover-modal') closeDiscoverModal(); });
$('discover-topic-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('discover-search-btn').click(); });

function renderDiscoverResults(results) {
  const root = $('discover-results');
  if (!results.length) {
    root.innerHTML = '<div class="discover-empty">没有找到新的相关论文（可能已全部在你的库里，或主题太窄）</div>';
    $('discover-actions').style.display = 'none';
    return;
  }
  root.innerHTML = results
    .map((r, i) => {
      const cite =
        typeof r.citationCount === 'number'
          ? `<span class="discover-cite" title="被引用量（Semantic Scholar / OpenAlex）">引用 ${r.citationCount}${typeof r.influentialCitationCount === 'number' ? `·重要 ${r.influentialCitationCount}` : ''}</span>`
          : '<span class="discover-cite muted" title="未取得引用量">引用 —</span>';
      // 相关度 0~1 → 5 格点条
      const relPct = Math.max(0, Math.min(1, r.relevance || 0));
      const dots = Math.round(relPct * 5);
      const rel = `<span class="discover-rel" title="与主题相关度 ${(relPct * 100).toFixed(0)}%">${'●'.repeat(dots)}${'○'.repeat(5 - dots)}</span>`;
      const meta = [r.year, r.primaryCategory, (r.authors || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ');
      const abs = r.summary ? `<div class="discover-abs">${escapeHtml(r.summary.slice(0, 220))}${r.summary.length > 220 ? '…' : ''}</div>` : '';
      return (
        `<label class="discover-item">
          <input type="checkbox" data-idx="${i}" class="discover-pick" />
          <div class="discover-main">
            <div class="discover-title-line">
              <span class="discover-rank">#${i + 1}</span>
              <a class="discover-title" href="${escapeHtml(r.arxivUrl || '')}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
              ${cite}
              ${rel}
            </div>
            <div class="discover-meta">${escapeHtml(meta)}</div>
            ${abs}
          </div>
        </label>`
      );
    })
    .join('');
  $('discover-actions').style.display = 'flex';
  $('discover-select-all').checked = false;
}

// 极小的 HTML 转义，避免摘要里的尖括号破坏 DOM（摘要不含脚本，但仍转义更稳妥）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 进度面板：固定 5 步，随 SSE 事件推进（pending→active→done）
const DISCOVER_STEPS = [
  { key: 'understanding', label: '理解主题 · 生成检索式' },
  { key: 'searching', label: '检索 arXiv（相关度 + 最新）' },
  { key: 'citations', label: '查询引用量（S2 + OpenAlex 兜底）' },
  { key: 'ranking', label: '去重与复合排序' },
  { key: 'done', label: '完成' },
];
function renderDiscoverProgress(state) {
  const root = $('discover-progress');
  root.style.display = 'block';
  root.innerHTML = DISCOVER_STEPS.map((s) => {
    const st = state[s.key] || {};
    const ico = st.status === 'done' ? '✓' : st.status === 'active' ? '<span class="dsc-spin"></span>' : '○';
    const cls = st.status === 'done' ? 'done' : st.status === 'active' ? 'active' : '';
    const detail = st.detail ? `<span class="dsc-detail">${escapeHtml(st.detail)}</span>` : '';
    return `<div class="dsc-step ${cls}"><span class="dsc-ico">${ico}</span><span class="dsc-label">${s.label}</span>${detail}</div>`;
  }).join('');
}
// 把单条 SSE 进度事件映射到 5 步状态机
function applyDiscoverEvent(state, ev) {
  DISCOVER_STEPS.forEach((s) => (state[s.key] = state[s.key] || { status: 'pending' }));
  const done = (...keys) => keys.forEach((k) => (state[k].status = 'done'));
  switch (ev.stage) {
    case 'start':
    case 'understanding':
      state.understanding.status = 'active';
      break;
    case 'query': {
      state.understanding.status = 'done';
      const eng = ev.engine === 'claude' ? 'claude' : ev.engine === 'gateway' ? 'GLM 网关' : '原始主题';
      state.understanding.detail = `${eng}：${ev.note || (ev.queries || []).join(' / ')}`;
      state.searching.status = 'active';
      break;
    }
    case 'searching':
      state.understanding.status = 'done';
      state.searching.status = 'active';
      state.searching.detail = `已收集 ${ev.total} 篇（本轮 ${ev.label} +${ev.added}）`;
      break;
    case 'searched':
      done('understanding', 'searching');
      state.searching.detail = `候选池 ${ev.total} 篇`;
      state.citations.status = 'active';
      break;
    case 'citations':
      state.citations.status = 'active';
      state.citations.detail = ev.message || '查询引用量…';
      break;
    case 'citations-done':
      state.citations.status = 'done';
      state.citations.detail = ev.available ? `已获取 ${ev.resolved}/${ev.total} 篇引用量` : '引用量暂不可用（S2/OpenAlex 限流）';
      break;
    case 'ranking':
      done('understanding', 'searching', 'citations');
      state.ranking.status = 'active';
      break;
    case 'done':
      done('understanding', 'searching', 'citations', 'ranking');
      state.done.status = 'done';
      state.done.detail = `${ev.count} 篇候选`;
      break;
  }
}

$('discover-search-btn').onclick = () => {
  const topic = $('discover-topic-input').value.trim();
  const hint = $('discover-hint');
  hint.classList.remove('error');
  if (!topic) { hint.textContent = '请输入主题或关键词'; hint.classList.add('error'); return; }
  if (typeof EventSource === 'undefined') { hint.textContent = '当前浏览器不支持流式进度'; hint.classList.add('error'); return; }
  const btn = $('discover-search-btn');
  setBusy(btn, true, '搜索中…');
  $('discover-results').innerHTML = '';
  $('discover-actions').style.display = 'none';
  discoverState.results = [];
  const pstate = {};
  renderDiscoverProgress(pstate);
  hint.textContent = '正在发现，下方可查看实时进度…';
  stopDiscoverStream();

  let finished = false; // 收到 done/fail 后置位，避免 SSE 关闭触发的原生 error 被误判为失败
  const es = new EventSource(sp('/api/discover/stream?topic=' + encodeURIComponent(topic)));
  discoverES = es;

  es.addEventListener('progress', (e) => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch { return; }
    applyDiscoverEvent(pstate, ev);
    renderDiscoverProgress(pstate);
    if (ev.stage === 'query') {
      const eng = ev.engine === 'claude' ? 'claude' : ev.engine === 'gateway' ? 'GLM 网关' : '原始主题';
      hint.textContent = `检索式（${eng}）：` + (ev.queries || []).join('  |  ');
      hint.classList.toggle('error', ev.engine === 'fallback');
    }
  });

  es.addEventListener('done', (e) => {
    finished = true;
    stopDiscoverStream();
    setBusy(btn, false);
    let data = {};
    try { data = JSON.parse(e.data); } catch {}
    discoverState.results = data.results || [];
    const extra = data.citationsAvailable === false ? '（引用量暂不可用，已按 相关度 + 新近 排序）' : '';
    hint.textContent = `找到 ${discoverState.results.length} 篇未入库候选${extra}`;
    hint.classList.remove('error');
    $('discover-progress').style.display = 'none';
    renderDiscoverResults(discoverState.results);
  });

  es.addEventListener('fail', (e) => {
    finished = true;
    stopDiscoverStream();
    setBusy(btn, false);
    let msg = '发现失败';
    try { msg = JSON.parse(e.data).error || msg; } catch {}
    hint.textContent = msg;
    hint.classList.add('error');
  });

  es.onerror = () => {
    if (finished) return; // 正常结束后的关闭
    finished = true;
    stopDiscoverStream();
    setBusy(btn, false);
    hint.textContent = '发现连接中断，请重试（claude 生成检索式可能较慢，可稍候再试）';
    hint.classList.add('error');
  };
};

// 全选联动
$('discover-select-all').onchange = (e) => {
  document.querySelectorAll('.discover-pick').forEach((cb) => { cb.checked = e.target.checked; });
};

// 导入所选：逐个 POST /api/import（已有去重/下载/入队），并发 3 个避免压垮本地
$('discover-import-btn').onclick = async () => {
  const picks = [...document.querySelectorAll('.discover-pick')];
  const chosen = picks.filter((cb) => cb.checked).map((cb) => discoverState.results[+cb.dataset.idx]).filter(Boolean);
  if (!chosen.length) { toast('请先勾选要导入的论文'); return; }
  const btn = $('discover-import-btn');
  setBusy(btn, true, `导入中 0/${chosen.length}…`);
  let ok = 0,
    dup = 0,
    fail = 0;
  // 简单并发池：最多 3 个在飞
  const queue = chosen.slice();
  const concurrency = Math.min(3, queue.length);
  let done = 0;
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        // 带上候选元数据：后端据此命名「作者 等 - 年份 - 标题.pdf」并预填，避免空标题→空总结
        const meta = {
          title: r.title,
          authors: r.authors || [],
          year: r.year,
          abstract: r.summary || '',
          primaryCategory: r.primaryCategory || null,
          arxivId: r.arxivId,
        };
        const res = await POST('/api/import', { url: r.arxivUrl, meta });
        if (res.ok && res.data.status === 'imported') ok++;
        else if (res.ok && res.data.status === 'duplicate') dup++;
        else fail++;
      } catch {
        fail++;
      }
      done++;
      btn.textContent = `导入中 ${done}/${chosen.length}…`;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  setBusy(btn, false);
  const parts = [`成功 ${ok}`];
  if (dup) parts.push(`重复 ${dup}`);
  if (fail) parts.push(`失败 ${fail}`);
  toast('导入完成：' + parts.join(' · '), fail ? 'error' : 'info');
  closeDiscoverModal();
  setTimeout(refresh, 300);
};
}
