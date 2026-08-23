// 全局事件接线
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { _conceptLayout, _conceptSort, _conceptView, createConcept, exportConceptsMd, generateConceptMap, renderConcepts, set_conceptLayout, set_conceptSort, toggleConceptPickMode } from './concepts/concepts.js';
import { POST, sp } from './core/api.js';
import { $ } from './core/dom.js';
import { isTypingTarget, openCommandPalette, openShortcutsHelp } from './core/command-palette.js';
import { wireTheme } from './core/theme.js';
import { escapeHtml } from './core/format.js';
import { gotoPaperRoute, router, syncPageQueryToUrl } from './core/nav.js';
import { buildPath } from './core/router.js';
import { filterToQuery } from './core/routes.js';
import { state } from './core/state.js';
import { setBusy, toast } from './core/ui-kit.js';
import { select } from './detail/detail.js';
import { patch, reader } from './detail/info-tab.js';
import { _formulaLayout, _formulaSort, exportFormulasMd, renderFormulas, resetFormulaFacet, set_formulaLayout, set_formulaSort, toggleFormulaPickMode } from './formulas/formulas.js';
import { openFormulaEditor } from './formulas/editor-drawer.js';
import { closeBulkMenu, setBulkBusy, syncPickUI, toggleBulkMenu, togglePickMode, updateBulkProgress } from './library/bulk.js';
import { closeStatusMenu, openFilterPop, renderStatusMenu, toggleStatusMenu } from './library/filters.js';
import { goHome } from './library/folders.js';
import { openFolderManager } from './library/folder-manager.js';
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
import { currentView } from './views/view-switch.js';
import { bindDiscover } from './library/discover.js';

// ---- 绑定事件 ----
export function bind() {
  let t;
  // v3.2 统一搜索：oninput 250ms 防抖。
  //   - DSL 含 body:/in:body → 走正文检索（/api/search），后端把元数据部分作为候选 id 子集
  //   - 否则 → 元数据即时筛选（/api/papers?q=DSL，后端解析字段前缀 + 分词 AND）
  //   - 同时把 DSL 镜像回填高级面板（双向同步）
  // v3.17 上下文搜索：同一个 #search 在三个视图下检索目标不同。
  // 概念/公式页只是本地过滤（数据已全量在内存），故直接重渲 + 回写 ?q=；
  // 论文页保持原有的 DSL / 全文检索链路不变。
  const pageSearch = { concepts: renderConcepts, formulas: renderFormulas };
  $('search').oninput = (e) => {
    const v = e.target.value;
    const render = pageSearch[currentView()];
    if (render) {
      syncAdvancedPanelFromDsl(v);        // v3.20：概念/公式页也镜像 DSL 到高级面板
      clearTimeout(t);
      t = setTimeout(() => { render(); syncPageQueryToUrl(); }, 250);
      return;
    }
    state.filter.q = v;
    syncAdvancedPanelFromDsl(v);          // DSL → 面板回填
    updateSearchModeIndicator(v);         // body: 模式提示
    clearTimeout(t);
    t = setTimeout(() => triggerSearch(v), 250);
  };
  // 回车 = 立即应用当前 DSL（不等防抖）；Esc = 清空退出
  // 清空搜索（Esc 与 × 按钮共用）：按当前视图走对应清理 + 回写 URL
  const clearSearch = () => {
    clearTimeout(t);
    closeSuggest();
    const render = pageSearch[currentView()];
    $('search').value = '';
    if (render) { render(); syncPageQueryToUrl(); return; }
    state.filter.q = '';
    if (state.ft) { state.ft = null; renderList(); }
    syncAdvancedPanelFromDsl('');
    refresh();
  };
  $('search-clear').onclick = () => { clearSearch(); $('search').focus(); };
  $('search').addEventListener('keydown', (e) => {
    // 内联补全浮层打开时：↑↓/Enter/Tab/Esc 走补全（仅论文页有补全）
    if (handleSuggestKeydown(e)) { e.preventDefault(); return; }
    const render = pageSearch[currentView()];
    if (render) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); render(); syncPageQueryToUrl(); }
      else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('search').value.trim();
      closeSuggest();
      if (v) triggerSearch(v, { immediate: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (closeSuggest()) return;          // 先关补全浮层
      clearSearch();
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
  $('sort').onchange = (e) => { state.filter.sort = e.target.value; refresh(); };

  // 侧栏视图项（展开态 .side-item + 收起态 rail .rail-btn 共用同一逻辑）
  const onSideViewClick = (el) => {
    const m = el.dataset.mode;
    if (m === 'all') state.filter = { ...state.filter, mode: '', starred: false, folder: '', readStatus: '', status: '', tags: [], topics: [] };
    else if (m === 'starred') state.filter = { ...state.filter, mode: '', starred: true, folder: '', readStatus: '' };
    else if (m === 'unread') state.filter = { ...state.filter, mode: 'unread', starred: false, folder: '', status: '', readStatus: 'unread' };
    refresh();
  };
  document.querySelectorAll('.sidebar .side-item[data-mode]').forEach((el) => { el.onclick = () => onSideViewClick(el); });
  document.querySelectorAll('.sidebar-rail .rail-btn[data-mode]').forEach((el) => { el.onclick = () => onSideViewClick(el); });
  // 概念页 rail：清单/地图（与展开侧栏 data-cview 项同语义，走路由切换）
  document.querySelectorAll('.rail-ctx[data-ctx="concepts"] .rail-btn[data-cview]').forEach((el) => {
    el.onclick = () => router.navigate(el.dataset.cview === 'maps' ? '/concepts/maps' : '/concepts', { keepQuery: true });
  });
  // 公式页 rail：「全部公式」= 清空分类分面
  const railFormulaAll = $('rail-formula-all');
  if (railFormulaAll) railFormulaAll.onclick = () => resetFormulaFacet();

  // ---- 顶栏状态胶囊（v3.17）：点开 popover 看明细 + 立即扫描 ----
  const statusPop = $('status-pop');
  const closeStatusPop = () => {
    statusPop.hidden = true;
    $('status-chip').setAttribute('aria-expanded', 'false');
  };
  $('status-chip').onclick = (e) => {
    e.stopPropagation();
    const open = statusPop.hidden;
    closeAddMenu();
    statusPop.hidden = !open;
    $('status-chip').setAttribute('aria-expanded', String(open));
  };
  statusPop.addEventListener('click', (e) => e.stopPropagation());

  // ---- 「+ 添加」下拉（v3.17）：导入 / 发现是同一意图的两条路径 ----
  const addList = $('add-menu-list');
  function closeAddMenu() {
    addList.hidden = true;
    $('btn-add').setAttribute('aria-expanded', 'false');
  }
  $('btn-add').onclick = (e) => {
    e.stopPropagation();
    const open = addList.hidden;
    closeStatusPop();
    addList.hidden = !open;
    $('btn-add').setAttribute('aria-expanded', String(open));
  };
  addList.addEventListener('click', () => closeAddMenu()); // 选中任一项即收起
  document.addEventListener('click', () => { closeStatusPop(); closeAddMenu(); });

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

  bindDiscover(); // 「按主题发现」整块已抽到 library/discover.js
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
  // 一级导航（#view-nav）：元素是 <a href>，core/router.js 的站内链接拦截已能接管，
  // 这里再覆盖一层是为了两件拦截层给不了的事——
  //   ① force:true：点当前所在页的那一段要重新入场拉数据（沿用旧 btn-concepts 的语义），
  //      否则同址 navigate 会早退，「点概念刷新一下」变成无反应；
  //   ② 概念页记忆上次子视图（清单/地图），目标路径要动态改写。
  // 带修饰键 / 中键的点击一律放行给浏览器，保住「新标签页打开」这个 <a> 的本分。
  document.querySelectorAll('#view-nav .vn-item').forEach((a) => {
    a.onclick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const v = a.dataset.view;
      if (v === 'library') {
        // 论文页筛选以 state.filter 显式还原（v3.51 修）：此前 keepQuery 会把概念/公式页
        // 的 ?q= DSL 一并带进 /library，论文列表被别页的筛选条件清空。
        router.navigate('/library', { force: true, query: filterToQuery(state.filter) });
        return;
      }
      const to = v === 'concepts'
        ? (_conceptView === 'maps' ? '/concepts/maps' : '/concepts')
        : a.getAttribute('href');
      router.navigate(to, { force: true });
    };
  });
  // 概念筛选漏斗已退役（v3.28）：热度/主题/质量/时间/分类分面全部在侧栏（renderConceptSidebar 自行接线）。
  // 手动新增 + 多选批量（v3.29）：pick 按钮 active/title 态在下一帧按「卡片是否带 pickable」回读同步。
  $('btn-concept-add').onclick = () => createConcept();
  $('btn-concepts-md').onclick = () => exportConceptsMd(); // v3.30：有筛选导出子集
  const cPick = $('btn-concept-pick');
  cPick.onclick = () => {
    toggleConceptPickMode();
    requestAnimationFrame(() => {
      const on = document.querySelector('#concepts-grid .concept-card.pickable') != null;
      cPick.classList.toggle('active', on);
      cPick.title = on ? '退出多选' : '多选概念以批量删除 / 改分类';
    });
  };
  $('btn-formula-add').onclick = () => openFormulaEditor(null);
  const fMd = $('btn-formulas-md');
  if (fMd) fMd.onclick = () => exportFormulasMd(); // v3.30：有筛选导出子集
  const fPick = $('btn-formula-pick');
  fPick.onclick = () => {
    toggleFormulaPickMode();
    requestAnimationFrame(() => {
      const on = document.querySelector('#formulas-grid .formula-card.pickable') != null;
      fPick.classList.toggle('active', on);
      fPick.title = on ? '退出多选' : '多选公式以批量删除 / 改分类';
    });
  };
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
  // 概念页「清单 / 地图」切换已移入侧栏（renderConceptSidebar 自行接线）。

  // 设置中心（v3.17：顶栏齿轮进入 + 覆盖层呈现）。
  // 覆盖层关掉要回到**打开它之前的那个页面**，而不是一律回论文库——从概念页点齿轮再关掉
  // 却落到论文库，是最容易被抱怨的那种「丢上下文」。深链直接进 /settings 时无来路，兜底 /library。
  let settingsReturnTo = null;
  const openSettingsOverlay = () => {
    const cur = window.location.pathname + window.location.search;
    settingsReturnTo = cur.startsWith('/settings') ? null : cur;
    router.navigate('/settings/overview', { force: true });
  };
  const closeSettingsOverlay = () => {
    const to = settingsReturnTo || '/library';
    settingsReturnTo = null;
    router.navigate(to.split('?')[0], { query: to.includes('?') ? '?' + to.split('?')[1] : '' });
  };
  // 设置入口：侧栏 footer（展开态）+ rail 底部（收起态），两处同一行为（v3.18 自顶栏移回）
  $('btn-settings').onclick = openSettingsOverlay;
  $('btn-settings-rail').onclick = openSettingsOverlay;
  $('btn-settings-close').onclick = closeSettingsOverlay;
  // 点遮罩（面板之外）关闭——覆盖层的常规语义
  $('settings-view').addEventListener('click', (e) => { if (e.target.id === 'settings-view') closeSettingsOverlay(); });
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
  // 导出（BibTeX / CSV）：多选菜单两项，共用 downloadExport（v3.20 工具条导出按钮已退役——详情头有复制 BibTeX）。
  // 走 <a href> 让浏览器原生下载（响应带 Content-Disposition），sp() 注入空间上下文。
  const downloadExport = (format, ids) => {
    const qs = ids && ids.length ? '?ids=' + ids.map(encodeURIComponent).join(',') : '';
    const a = document.createElement('a');
    a.href = sp('/api/papers.' + format + qs);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const bulkExport = (format) => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择论文', 'error'); return; }
    downloadExport(format, ids);
    closeBulkMenu();
  };
  if ($('btn-pick-export-bib')) $('btn-pick-export-bib').onclick = () => bulkExport('bib');
  if ($('btn-pick-export-csv')) $('btn-pick-export-csv').onclick = () => bulkExport('csv');
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

  // 收藏夹管理面板（v3.22）：入口在侧栏「收藏夹」标题行 ⚙；新建/改名/换色/排序/删除
  // 一处收口（旧 folder-modal 与行内铅笔退役）。面板内部事件由 folder-manager.js 自行接线。
  $('btn-manage-folders').onclick = () => openFolderManager();

  // 主题外观（v3.32 R10）：分段控件 + 系统主题跟随
  wireTheme();

  // ESC 关闭阅读器/模态
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+K：命令面板（v3.32 R8）——沿业界惯例升级旧「聚焦搜索」绑定
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    // '/'：聚焦搜索（不打断输入态）；'?'：快捷键帮助（Shift+/）
    if (!isTypingTarget(e.target)) {
      if (e.key === '/') {
        e.preventDefault();
        $('search').focus();
        $('search').select();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        openShortcutsHelp();
        return;
      }
    }
    if ($('reader-view').classList.contains('active') && reader && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); reader.scrollToPage(Math.max(1, reader.page - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); reader.scrollToPage(Math.min(reader.total, reader.page + 1)); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); reader.scale = Math.min(3, +(reader.scale + 0.2).toFixed(2)); reader.rerender(); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); reader.scale = Math.max(0.5, +(reader.scale - 0.2).toFixed(2)); reader.rerender(); return; }
    }
    // 列表键盘导航：仅在不输入、不开阅读器、不开模态、不在设置/概念视图时生效
    if (!$('reader-view').classList.contains('active')
        && !$('folder-manager').classList.contains('active')
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
      $('folder-manager').classList.remove('active');
      $('import-modal').classList.remove('active');
      $('discover-modal').classList.remove('active');
      // 设置覆盖层：回到打开它之前的那个页面（同 closeSettingsOverlay）
      if (document.body.dataset.view === 'settings') closeSettingsOverlay();
    }
  });
}
