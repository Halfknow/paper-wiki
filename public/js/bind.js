// 全局事件接线
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { _conceptLayout, _conceptSort, _conceptView, generateConceptMap, renderConcepts, set_conceptLayout, set_conceptSort } from './concepts/concepts.js';
import { DEL, PATCH, POST, api, sp } from './core/api.js';
import { $ } from './core/dom.js';
import { escapeHtml } from './core/format.js';
import { gotoPaperRoute, router } from './core/nav.js';
import { buildPath } from './core/router.js';
import { state } from './core/state.js';
import { setBusy, toast } from './core/ui-kit.js';
import { select } from './detail/detail.js';
import { patch, reader } from './detail/info-tab.js';
import { _formulaLayout, _formulaSort, renderFormulas, set_formulaLayout, set_formulaSort } from './formulas/formulas.js';
import { closeBulkMenu, setBulkBusy, syncPickUI, toggleBulkMenu, togglePickMode, updateBulkProgress } from './library/bulk.js';
import { closeStatusMenu, openFilterPop, renderStatusMenu, toggleStatusMenu } from './library/filters.js';
import { editingFolder, goHome, openFolderModal, pickedColor } from './library/folders.js';
import { renderList, triggerSearch, updateSearchModeIndicator } from './library/list.js';
import { refresh } from './library/refresh.js';
import { syncAdvancedPanelFromDsl } from './search/advanced.js';
import { closeSuggest, handleSuggestKeydown } from './search/suggest.js';
import { bindChannelGrid, chEditModels, editingChannelId, renderChannels, set_chEditModels, set_editingChannelId } from './settings/channels.js';
import { filterSettingsNav, normalizeWeights, renderWeightProp, resetAllSettings, resetSection, saveArxiv, saveDiscover, saveFormulaEngine, saveMineruNamingPrompt, saveScan, saveTranslate } from './settings/collect.js';
import { saveConceptMapPrompt, saveConceptPrompt, saveFormulaPrompt, saveSummaryPrompt, saveTagsPrompt } from './settings/prompts.js';
import { saveAiConfig, settingsSwitchTab } from './settings/settings.js';
import { renderTaxonomy, taxBatchDelete, taxBatchMerge, taxState, taxSwitchKind, taxToggleSelectMode } from './settings/taxonomy.js';
import { applyListWidth, bindListSplitter, refreshSystemHealth, setSidebarCollapsed } from './views/layout.js';

// ---- 绑定事件 ----
export function bind() {
  let t;
  // v3.2 统一搜索：oninput 250ms 防抖。
  //   - DSL 含 body:/in:body → 走正文检索（/api/search），后端把元数据部分作为候选 id 子集
  //   - 否则 → 元数据即时筛选（/api/papers?q=DSL，后端解析字段前缀 + 分词 AND）
  //   - 同时把 DSL 镜像回填高级面板（双向同步）
  $('search').oninput = (e) => {
    const v = e.target.value;
    state.filter.q = v;
    syncAdvancedPanelFromDsl(v);          // DSL → 面板回填
    updateSearchModeIndicator(v);         // body: 模式提示
    clearTimeout(t);
    t = setTimeout(() => triggerSearch(v), 250);
  };
  // 回车 = 立即应用当前 DSL（不等防抖）；Esc = 清空退出
  $('search').addEventListener('keydown', (e) => {
    // 内联补全浮层打开时：↑↓/Enter/Tab/Esc 走补全
    if (handleSuggestKeydown(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('search').value.trim();
      closeSuggest();
      if (v) triggerSearch(v, { immediate: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (closeSuggest()) return;          // 先关补全浮层
      $('search').value = '';
      state.filter.q = '';
      if (state.ft) { state.ft = null; renderList(); }
      syncAdvancedPanelFromDsl('');
      refresh();
    }
  });
  // 输入框失焦时关补全（延迟，让点击事件先触发）
  $('search').addEventListener('blur', () => { setTimeout(closeSuggest, 200); });
  // 「全部状态」自定义下拉：触发器 toggle + 菜单项点击写对应字段 + 外部关闭（仿 space-menu）
  const statusTrig = $('filter-status-trigger');
  if (statusTrig) statusTrig.onclick = (e) => { e.stopPropagation(); toggleStatusMenu(); };
  document.querySelectorAll('#filter-status-menu .fsm-item').forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      const v = item.dataset.value;
      const field = item.dataset.field; // ''|'status'|'readStatus'
      // 选「全部状态」(field='') 清两个字段；否则按 field 写、清另一字段 + 清 mode（避免与侧栏视图冲突）
      state.filter.status = field === 'status' ? v : '';
      state.filter.readStatus = field === 'readStatus' ? v : '';
      state.filter.mode = '';
      renderStatusMenu();
      closeStatusMenu();
      refresh();
    };
  });
  document.addEventListener('click', (e) => {
    const w = $('filter-status-wrap');
    if (w && !w.contains(e.target)) closeStatusMenu();
  });
  const tagTrig = $('filter-tag-trigger');
  if (tagTrig) tagTrig.onclick = () => openFilterPop('tag');
  const topicTrig = $('filter-topic-trigger');
  if (topicTrig) topicTrig.onclick = () => openFilterPop('topic');
  $('filter-starred').onchange = (e) => { state.filter.starred = e.target.checked; refresh(); };
  $('sort').onchange = (e) => { state.filter.sort = e.target.value; refresh(); };

  // 侧栏视图项
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => {
    el.onclick = () => {
      const m = el.dataset.mode;
      if (m === 'all') state.filter = { ...state.filter, mode: '', starred: false, folder: '', readStatus: '', status: '', tags: [], topics: [] };
      else if (m === 'starred') state.filter = { ...state.filter, mode: '', starred: true, folder: '', readStatus: '' };
      else if (m === 'unread') state.filter = { ...state.filter, mode: 'unread', starred: false, folder: '', status: '', readStatus: 'unread' };
      refresh();
    };
  });

  $('btn-scan').onclick = async () => {
    const btn = $('btn-scan');
    setBusy(btn, true, '扫描中…');
    const r = await POST('/api/scan');
    setBusy(btn, false);
    if (r.ok) toast('扫描已触发，处理队列会自动刷新');
    else toast(r.error || '扫描失败', 'error');
    setTimeout(refresh, 600);
  };

  // arXiv 网址导入
  function openImportModal() {
    $('import-url-input').value = '';
    const h = $('import-hint');
    h.textContent = '支持 abs / pdf / html 网址或裸 ID，会自动下载 PDF 并开始 AI 处理。';
    h.classList.remove('error');
    $('import-modal').classList.add('active');
    setTimeout(() => $('import-url-input').focus(), 50);
  }
  function closeImportModal() { $('import-modal').classList.remove('active'); }
  $('btn-import').onclick = openImportModal;
  $('import-modal-cancel').onclick = closeImportModal;
  $('import-modal').addEventListener('click', (e) => { if (e.target.id === 'import-modal') closeImportModal(); });
  $('import-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('import-modal-ok').click(); });
  $('import-modal-ok').onclick = async () => {
    const url = $('import-url-input').value.trim();
    const hint = $('import-hint');
    hint.classList.remove('error');
    if (!url) { hint.textContent = '请粘贴 arXiv 网址或 ID'; hint.classList.add('error'); return; }
    const btn = $('import-modal-ok');
    const old = btn.textContent;
    btn.textContent = '下载中…'; btn.disabled = true;
    try {
      const r = await POST('/api/import', { url });
      if (r.ok) {
        if (r.data.status === 'duplicate') toast('该论文已导入过：' + (r.data.title || r.data.arxivId || r.data.id));
        else toast('已开始下载并处理，可在列表查看进度', 'good');
        closeImportModal();
        setTimeout(refresh, 300);
      } else {
        hint.textContent = r.error || '导入失败';
        hint.classList.add('error');
      }
    } catch (e) {
      hint.textContent = '导入失败：' + ((e && e.message) || '网络错误');
      hint.classList.add('error');
    } finally { btn.textContent = old; btn.disabled = false; }
  };

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
                <a class="discover-title" href="${r.arxivUrl}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
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
  // 左上角 logo：点击回到初始页面（库视图 + 全部论文 + 清筛选/搜索/选中）
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.setAttribute('data-clickable', '');
    brand.setAttribute('role', 'button');
    brand.setAttribute('tabindex', '0');
    brand.setAttribute('title', '回到全部论文');
    brand.setAttribute('aria-label', '回到全部论文');
    brand.onclick = goHome;
    brand.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
    });
  }
  $('btn-concepts').onclick = () => router.navigate(_conceptView === 'maps' ? '/concepts/maps' : '/concepts', { force: true }); // 记忆上次子视图
  $('btn-concepts-close').onclick = () => router.navigate('/library', { keepQuery: true });
  $('concept-q').oninput = renderConcepts;
  // 公式清单视图（v3.9，与概念视图同构）
  $('btn-formulas').onclick = () => router.navigate('/formulas', { force: true });
  $('btn-formulas-close').onclick = () => router.navigate('/library', { keepQuery: true });
  $('formula-q').oninput = renderFormulas;
  document.querySelectorAll('#formula-layout button').forEach((b) => {
    b.onclick = () => {
      set_formulaLayout(b.dataset.layout);
      localStorage.setItem('pw-formula-layout', _formulaLayout);
      renderFormulas();
    };
  });
  document.querySelectorAll('#formula-sort button').forEach((b) => {
    b.onclick = () => {
      set_formulaSort(b.dataset.sort);
      localStorage.setItem('pw-formula-sort', _formulaSort);
      renderFormulas();
    };
  });
  // 显示方式切换（瀑布流 / 清单），持久化用户选择
  document.querySelectorAll('#concept-layout button').forEach((b) => {
    b.onclick = () => {
      set_conceptLayout(b.dataset.layout);
      localStorage.setItem('pw-concept-layout', _conceptLayout);
      renderConcepts();
    };
  });
  // 排序切换（频次/字母），持久化用户选择
  document.querySelectorAll('#concept-sort button').forEach((b) => {
    b.onclick = () => {
      set_conceptSort(b.dataset.sort);
      localStorage.setItem('pw-concept-sort', _conceptSort);
      renderConcepts();
    };
  });
  // 视图切换（清单/总览图），持久化用户选择
  document.querySelectorAll('#concept-view button').forEach((b) => {
    b.onclick = () => router.navigate(b.dataset.view === 'maps' ? '/concepts/maps' : '/concepts');
  });

  // 设置中心（统一从左下角「设置」进入）
  $('btn-settings').onclick = () => router.navigate('/settings/overview', { force: true }); // 左下角「设置」→ 概览
  $('btn-settings-close').onclick = () => router.navigate('/library', { keepQuery: true });
  // 设置 tab 导航
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    el.onclick = () => router.navigate(buildPath('/settings/:tab', { tab: el.dataset.tab }));
  });
  // AI 接口
  $('btn-ai-save').onclick = saveAiConfig;
  // v3.13 模型渠道卡片：添加渠道 + 网格事件委托
  $('btn-ch-add').onclick = () => {
    set_chEditModels([]);
    set_editingChannelId('__new__');
    renderChannels();
    const card = document.querySelector('.ch-card.editing');
    if (card) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const nameInput = card.querySelector('.chf-name');
      if (nameInput) nameInput.focus();
    }
  };
  bindChannelGrid();
  // 总结提示词
  $('btn-summary-prompt-save').onclick = saveSummaryPrompt;
  $('btn-summary-prompt-default').onclick = async () => {
    if (await PWDialog.confirm('清空当前编辑内容并恢复为内置默认总结提示词？（保存后生效）', { title: '恢复默认提示词', okText: '恢复默认' })) {
      $('summary-prompt-edit').value = $('summary-prompt-default-pre').textContent || '';
      $('summary-prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  // 标签/主题提示词
  $('btn-tags-prompt-save').onclick = saveTagsPrompt;
  $('btn-tags-prompt-default').onclick = async () => {
    if (await PWDialog.confirm('清空当前编辑内容并恢复为内置默认标签/主题提示词？（保存后生效）', { title: '恢复默认提示词', okText: '恢复默认' })) {
      $('tags-prompt-edit').value = $('tags-prompt-default-pre').textContent || '';
      $('tags-prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  // 公式抽取提示词
  $('btn-formula-prompt-save').onclick = saveFormulaPrompt;
  $('btn-formula-prompt-default').onclick = async () => {
    if (await PWDialog.confirm('清空当前编辑内容并恢复为内置默认公式提示词？（保存后生效）', { title: '恢复默认提示词', okText: '恢复默认' })) {
      $('formula-prompt-edit').value = $('formula-prompt-default-pre').textContent || '';
      $('formula-prompt-hint').textContent = '已载入默认提示词，尚未保存';
      toast('已载入默认提示词');
    }
  };
  // 概念抽取提示词（v3.10）
  if ($('btn-concept-prompt-save')) $('btn-concept-prompt-save').onclick = saveConceptPrompt;
  if ($('btn-concept-prompt-default')) {
    $('btn-concept-prompt-default').onclick = async () => {
      if (await PWDialog.confirm('清空当前编辑内容并恢复为内置默认概念提示词？（保存后生效）', { title: '恢复默认提示词', okText: '恢复默认' })) {
        $('concept-prompt-edit').value = $('concept-prompt-default-pre').textContent || '';
        $('concept-prompt-hint').textContent = '已载入默认提示词，尚未保存';
        toast('已载入默认提示词');
      }
    };
  }
  // 概念地图提示词（v3.14）
  if ($('btn-concept-map-prompt-save')) $('btn-concept-map-prompt-save').onclick = saveConceptMapPrompt;
  if ($('btn-concept-map-prompt-default')) {
    $('btn-concept-map-prompt-default').onclick = async () => {
      if (await PWDialog.confirm('清空当前编辑内容并恢复为内置默认概念地图提示词？（保存后生效）', { title: '恢复默认提示词', okText: '恢复默认' })) {
        $('concept-map-prompt-edit').value = $('concept-map-prompt-default-pre').textContent || '';
        $('concept-map-prompt-hint').textContent = '已载入默认提示词，尚未保存';
        toast('已载入默认提示词');
      }
    };
  }
  // 概念地图生成按钮（v3.10）
  if ($('btn-concept-map')) $('btn-concept-map').onclick = generateConceptMap;
  // 采集：文件扫描 / arXiv / 主题发现
  $('btn-scan-save').onclick = saveScan;
  $('btn-scan-reset').onclick = () => resetSection('scan', '文件扫描');
  $('btn-arxiv-save').onclick = saveArxiv;
  $('btn-arxiv-reset').onclick = () => resetSection('arxiv', 'arXiv 元数据');
  $('btn-discover-save').onclick = saveDiscover;
  $('btn-discover-reset').onclick = () => resetSection('discover', '主题发现');
  $('btn-translate-save').onclick = saveTranslate;
  $('btn-translate-reset').onclick = () => resetSection('translate', '划线翻译');
  $('btn-formula-engine-save').onclick = saveFormulaEngine;
  $('btn-formula-engine-reset').onclick = () => resetSection('formulas', '公式抽取引擎');
  $('btn-mineru-naming-save').onclick = saveMineruNamingPrompt;
  if ($('btn-mineru-naming-default')) {
    $('btn-mineru-naming-default').onclick = () => {
      const pre = $('mineru-naming-default-pre');
      if (pre && $('mineru-naming-prompt-edit')) $('mineru-naming-prompt-edit').value = pre.textContent;
    };
  }
  // 主题发现：权重三联实时占比条 + 一键归一化为 1
  ['disc-w-rel', 'disc-w-auth', 'disc-w-rec'].forEach((id) => { const el = $(id); if (el) el.oninput = renderWeightProp; });
  const wNorm = $('btn-w-norm');
  if (wNorm) wNorm.onclick = normalizeWeights;
  // AI 接口恢复默认
  $('btn-ai-reset').onclick = () => resetSection('ai', '模型渠道与全局参数');
  // 概览：全部恢复默认 + 快捷入口
  $('btn-reset-all').onclick = resetAllSettings;
  document.querySelectorAll('.ov-quick-links [data-goto]').forEach((b) => {
    b.onclick = () => settingsSwitchTab(b.dataset.goto);
  });
  // 系统信息：刷新服务状态
  $('btn-system-health').onclick = refreshSystemHealth;
  // 设置内搜索
  $('settings-search-input').oninput = (e) => filterSettingsNav(e.target.value);
  // 主题与标签管理：分段切换 / 搜索 / 排序 / 多选 / 批量
  document.querySelectorAll('.tax-seg-btn').forEach((b) => (b.onclick = () => taxSwitchKind(b.dataset.kind)));
  $('tax-search').oninput = (e) => {
    taxState.q = e.target.value;
    renderTaxonomy();
  };
  $('tax-sort').onchange = (e) => {
    taxState.sort = e.target.value;
    renderTaxonomy();
  };
  $('tax-select-toggle').onclick = () => taxToggleSelectMode();
  $('tax-batch-merge').onclick = taxBatchMerge;
  $('tax-batch-delete').onclick = taxBatchDelete;
  $('tax-batch-cancel').onclick = () => taxToggleSelectMode(false);

  // 多选
  $('btn-pick').onclick = () => togglePickMode(!state.pickMode);

  // 紧凑视图切换（记忆到 localStorage）
  // 视图密度分段：紧凑 / 舒适 两个独立按钮（localStorage 记忆）
  const setDensity = (compact) => {
    state.compact = compact;
    localStorage.setItem('pw-compact', compact ? '1' : '0');
    renderList();
  };
  const vc2 = $('view-compact'), vf2 = $('view-comfort');
  if (vc2) vc2.onclick = () => setDensity(true);
  if (vf2) vf2.onclick = () => setDensity(false);

  // 侧栏收起 / 展开（记忆到 localStorage）
  $('btn-collapse').onclick = () => setSidebarCollapsed(true);
  $('btn-expand').onclick = () => setSidebarCollapsed(false);
  bindListSplitter();
  window.addEventListener('resize', () => applyListWidth(state.listWidth));
  $('btn-pick-cancel').onclick = () => togglePickMode(false);
  // 批量操作下拉触发器：stopPropagation 后 toggle，document click 外部关闭（仿 space-menu）
  const bulkTrig = $('bulk-trigger');
  if (bulkTrig) bulkTrig.onclick = (e) => { e.stopPropagation(); toggleBulkMenu(); };
  document.addEventListener('click', (e) => {
    if (!$('bulk-actions').contains(e.target)) closeBulkMenu();
  });
  // 全选/取消全选当前列表
  $('btn-pick-all').onclick = () => {
    const total = state.papers.length;
    if (!total) return;
    if (state.selected.size === total) state.selected.clear();
    else state.papers.forEach((p) => state.selected.add(p.id));
    syncPickUI();
    renderList();
  };
  // 批量抽取概念：逐篇循环拿真实进度（批量端点是一次性 await 整批、无流式）。
  // 后端 /api/papers/concepts 按 ids 数组处理，传单 id 等价单篇，行为与整批一致（串行 AI 调用）。
  $('btn-pick-concepts').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    setBulkBusy(true);
    let processed = 0, added = 0, failed = 0, aborted = false;
    try {
      for (let i = 0; i < ids.length; i++) {
        const r = await POST('/api/papers/concepts', { ids: [ids[i]] });
        if (r.ok && r.data) { processed += r.data.processed || 0; added += r.data.added || 0; }
        else failed++;
        updateBulkProgress(i + 1, ids.length, '抽取概念');
      }
    } catch (e) { aborted = true; toast('抽取中断：' + (e && e.message ? e.message : '网络错误'), 'error'); }
    finally { setBulkBusy(false); }
    if (!aborted) {
      if (failed) toast(`完成：处理 ${processed} 篇，新增 ${added} 个概念（${failed} 篇失败）`, failed && !processed ? 'error' : undefined);
      else toast(`完成：处理 ${processed} 篇，新增 ${added} 个概念`);
    }
    togglePickMode(false);
    refresh();
  };
  // 批量删除：确认后调 bulk-delete（后端会删文件 + 清理空 tags/topics/概念）。删除无需逐篇进度。
  $('btn-pick-delete').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    if (!(await PWDialog.confirm(`删除已选的 ${ids.length} 篇论文？\n将同时删除本地 PDF 与全文文本，并清理仅被这些论文使用的标签/主题/概念。此操作不可恢复。`, { title: '批量删除论文', danger: true, okText: '删除' }))) return;
    setBulkBusy(true, '删除中…');
    let r;
    try { r = await POST('/api/papers/bulk-delete', { ids }); }
    catch (e) { setBulkBusy(false); toast('删除中断：' + (e && e.message ? e.message : '网络错误'), 'error'); refresh(); return; }
    setBulkBusy(false);
    if (r.ok) { toast(`已删除 ${r.data.deleted} 篇`); togglePickMode(false); }
    else toast(r.error || '删除失败', 'error');
    refresh();
  };
  // 批量抽取公式：逐篇循环拿真实进度（同 concepts）
  $('btn-pick-formulas').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    setBulkBusy(true);
    let processed = 0, added = 0, failed = 0, aborted = false;
    try {
      for (let i = 0; i < ids.length; i++) {
        const r = await POST('/api/papers/formulas', { ids: [ids[i]] });
        if (r.ok && r.data) { processed += r.data.processed || 0; added += r.data.added || 0; }
        else failed++;
        updateBulkProgress(i + 1, ids.length, '抽取公式');
      }
    } catch (e) { aborted = true; toast('抽取中断：' + (e && e.message ? e.message : '网络错误'), 'error'); }
    finally { setBulkBusy(false); }
    if (!aborted) {
      if (failed) toast(`完成：处理 ${processed} 篇，新增 ${added} 个公式（${failed} 篇失败）`, failed && !processed ? 'error' : undefined);
      else toast(`完成：处理 ${processed} 篇，新增 ${added} 个公式`);
    }
    togglePickMode(false);
    refresh();
  };
  // 批量重新打标：走已有的单篇端点 /api/papers/:id/retag，逐篇拿真实进度
  $('btn-pick-retag').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    setBulkBusy(true);
    let okN = 0, failed = 0, aborted = false;
    try {
      for (let i = 0; i < ids.length; i++) {
        const r = await POST('/api/papers/' + ids[i] + '/retag');
        if (r.ok) okN++; else failed++;
        updateBulkProgress(i + 1, ids.length, '重新打标');
      }
    } catch (e) { aborted = true; toast('打标中断：' + (e && e.message ? e.message : '网络错误'), 'error'); }
    finally { setBulkBusy(false); }
    if (!aborted) {
      if (okN) toast(`已重新打标 ${okN} 篇` + (failed ? `（${failed} 篇失败）` : ''));
      else toast('重新打标失败', 'error');
    }
    togglePickMode(false);
    refresh();
  };
  // 批量重新总结：逐篇加入串行队列（POST summarize 每篇独立入队，串行 pipeline 处理）
  $('btn-pick-resume').onclick = async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    setBulkBusy(true);
    let okN = 0, aborted = false;
    try {
      for (let i = 0; i < ids.length; i++) {
        const r = await POST('/api/papers/' + ids[i] + '/summarize');
        if (r.ok) okN++;
        updateBulkProgress(i + 1, ids.length, '排队总结');
      }
    } catch (e) { aborted = true; toast('排队中断：' + (e && e.message ? e.message : '网络错误'), 'error'); }
    finally { setBulkBusy(false); }
    if (!aborted) {
      if (okN) toast(`已把 ${okN} 篇加入重新总结队列`);
      else toast('重新总结失败', 'error');
    }
    togglePickMode(false);
    refresh();
  };

  // 收藏夹模态
  $('btn-new-folder').onclick = () => openFolderModal(null);
  $('folder-modal-cancel').onclick = () => $('folder-modal').classList.remove('active');
  $('folder-modal-save').onclick = async () => {
    const name = $('folder-name-input').value.trim();
    if (!name) { toast('收藏夹名称不能为空', 'error'); return; }
    if (editingFolder) {
      const r = await PATCH('/api/folders/' + editingFolder.id, { name, color: pickedColor });
      if (!r.ok) { toast(r.error || '收藏夹保存失败', 'error'); return; }
    } else {
      const r = await POST('/api/folders', { name, color: pickedColor });
      if (!r.ok) { toast(r.error || '收藏夹创建失败', 'error'); return; }
    }
    $('folder-modal').classList.remove('active');
    toast(editingFolder ? '收藏夹已更新' : '收藏夹已创建');
    refresh();
  };
  $('folder-modal-delete').onclick = async () => {
    if (!editingFolder) return;
    if (!(await PWDialog.confirm(`删除收藏夹「${editingFolder.name}」？论文不会被删除。`, { title: '删除收藏夹', danger: true, okText: '删除' }))) return;
    const r = await DEL('/api/folders/' + editingFolder.id);
    if (!r.ok) { toast(r.error || '收藏夹删除失败', 'error'); return; }
    if (state.filter.folder === editingFolder.id) state.filter.folder = '';
    $('folder-modal').classList.remove('active');
    toast('收藏夹已删除');
    refresh();
  };
  $('folder-modal').onclick = (e) => {
    if (e.target.id === 'folder-modal') $('folder-modal').classList.remove('active');
  };

  // ESC 关闭阅读器/模态
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
      return;
    }
    if ($('reader-view').classList.contains('active') && reader && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); reader.scrollToPage(Math.max(1, reader.page - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); reader.scrollToPage(Math.min(reader.total, reader.page + 1)); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); reader.scale = Math.min(3, +(reader.scale + 0.2).toFixed(2)); reader.rerender(); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); reader.scale = Math.max(0.5, +(reader.scale - 0.2).toFixed(2)); reader.rerender(); return; }
    }
    // 列表键盘导航：仅在不输入、不开阅读器、不开模态、不在设置/概念视图时生效
    if (!$('reader-view').classList.contains('active')
        && !$('folder-modal').classList.contains('active')
        && !$('import-modal').classList.contains('active')
        && !$('discover-modal').classList.contains('active')
        && document.body.dataset.view === 'library'
        && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
        && state.papers.length) {
      const curIdx = state.papers.findIndex((p) => p.id === state.current);
      const move = (d) => {
        const next = state.papers[Math.max(0, Math.min(state.papers.length - 1, (curIdx < 0 ? 0 : curIdx) + d))];
        if (next && next.id !== state.current) gotoPaperRoute(next.id);
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      if (e.key === 'Enter' && state.current) { e.preventDefault(); router.navigate(buildPath('/reader/:id', { id: state.current }), { keepQuery: true }); return; }
      if (e.key.toLowerCase() === 's' && state.current) {
        const cp = state.papers.find((p) => p.id === state.current);
        // 星标：无评分↔5 星来回切（兼容旧「收藏」语义）
        if (cp) { const next = (cp.rating || 0) > 0 ? 0 : 5; e.preventDefault(); patch(cp.id, { rating: next }); toast(next ? '已评 5 星' : '已清除评分'); return; }
      }
    }
    if (e.key === 'Escape') {
      // 内层（@ 引用浮层 / 聊天抽屉 / 批注选中 / 框选模式）已消费的 Esc 不再关阅读器，
      // 保证分层退出：@浮层 → 聊天抽屉 → 批注选中 → 阅读器。
      if (e.defaultPrevented) return;
      // 阅读器有自己的路由（/reader/:id）：Esc 退回上一页，由 leave 钩子关闭阅读器
      if ($('reader-view').classList.contains('active')) {
        if (router.current() && router.current().name === 'reader') window.history.back();
        else if (reader) reader.close();
      }
      $('folder-modal').classList.remove('active');
      $('import-modal').classList.remove('active');
      $('discover-modal').classList.remove('active');
      if (document.body.dataset.view === 'settings') router.navigate('/library', { keepQuery: true });
    }
  });
}
