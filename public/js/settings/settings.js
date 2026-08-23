// 设置中心骨架 / 概览 / 系统信息 / AI 配置
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PUT, api, jget } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { setBusy, toast } from '../core/ui-kit.js';
import { chatPresetsOverride, set_chatPresetsOverride } from '../detail/chat-view.js';
import { renderSavedSearches, setSavedSearches } from '../search/saved.js';
import { channelsState, editingChannelId, renderChannels, set_channelsState, set_editingChannelId } from './channels.js';
import { renderWeightProp, saveFormulaEngine, saveTranslate } from './collect.js';
import { openPromptPane, refreshAllStudios, renderPromptIndex, showPromptIndex } from './prompt-studio.js';
import { loadTaxonomy } from './taxonomy.js';
import { showView } from '../views/view-switch.js';
import { SETTINGS_TAB_ALIASES } from '../core/routes.js';
import { buildPath } from '../core/router.js';

// ---- 设置中心（迁移并扩展原 prompt-view） ----
export const APIKEY_MASK = '********'; // 占位，表示「未改动」

// 每任务输入上限的任务键（v3.9）。顺序 = 设置页输入框顺序；
// 与后端 ai.js 的 INPUT_BUDGET_TASKS 必须一致（后端按白名单校验，多余键被忽略）。
const TASK_BUDGET_KEYS = ['summary', 'tags', 'notes', 'concepts', 'formulas', 'chat'];

export async function openSettings(tab) {
  showView('settings');
  settingsSwitchTab(tab || 'overview');
  await loadSettingsData();
}

/** 把 URL 里的 :tab 解析成 { tab, sub }：tab 是真实存在的导航项，sub 是页内子项。
 *  v3.56 导航从 14 项收敛到 8 项，老 tab 通过 SETTINGS_TAB_ALIASES 落到新页的对应子项。 */
export function resolveSettingsTab(tab) {
  const alias = SETTINGS_TAB_ALIASES[tab];
  if (!alias) return { tab: tab || 'overview', sub: '' };
  const [t, sub] = alias.split('#');
  return { tab: t, sub: sub || '' };
}

export function settingsSwitchTab(tab) {
  const { tab: real, sub } = resolveSettingsTab(tab);
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === real);
  });
  document.querySelectorAll('.settings-panel').forEach((el) => {
    el.hidden = el.dataset.panel !== real;
    if (!el.hidden) el.scrollTop = 0;
  });
  const body = document.querySelector('.settings-body');
  if (body) body.scrollTop = 0;
  if (real === 'prompts') {
    // 老深链（/settings/summary…）直接展开对应条目；直接进 /settings/prompts 则停在列表
    if (sub) openPromptPane(sub);
    else showPromptIndex();
  }
  if (real === 'ingest' && sub) scrollToSection(sub);
  if (real === 'taxonomy') loadTaxonomy();
}

/** 页内跳转到另一个设置分区，并把 URL 一起改掉（浏览器前进/后退因此可用）。
 *  router 从 nav.js 动态取，避开 settings ↔ nav 的模块环在求值期互相要值。 */
export async function gotoSettingsTab(tab) {
  try {
    const { router } = await import('../core/nav.js');
    router.navigate(buildPath('/settings/:tab', { tab }));
  } catch {
    settingsSwitchTab(tab); // 路由不可用时退化为纯视图切换，至少不卡住
  }
}

/** 「入库与解析」页内定位到某一节（老 /settings/scan|arxiv|formula-engine 深链落点）。 */
function scrollToSection(sec) {
  const el = document.querySelector(`.settings-panel[data-panel="ingest"] .set-section[data-sec="${sec}"]`);
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  });
}

/** 回填表单值时的聚焦保护：即时保存后会整页重载设置，正在被编辑的输入框不能被覆盖。 */
function setField(id, value) {
  const el = $(id);
  if (!el || el === document.activeElement) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

// ---- 即时保存的轻提示（v3.56，取代每个面板底部的「保存」按钮 + 「已保存·时间」长句）----
const _savedTimers = {};

/** 在某个 hint 位置显示保存态。state ∈ 'saving' | 'saved' | 'error'。 */
export function markSaved(hintId, state, msg) {
  const el = $(hintId);
  if (!el) return;
  clearTimeout(_savedTimers[hintId]);
  el.className = 'set-saved ' + state;
  el.textContent = state === 'saving' ? '保存中…' : state === 'error' ? msg || '保存失败' : '已保存';
  if (state === 'saved') {
    _savedTimers[hintId] = setTimeout(() => {
      el.className = 'set-saved';
      el.textContent = '';
    }, 2000);
  }
}

function fmtDef(v) {
  return v === undefined || v === null || v === '' ? '未设置' : v;
}

// ---- 设置页自定义下拉（v3.10：原生 <select> 改自定义按钮+菜单，与顶栏「全部状态」同设计语言）----
// sdRegistry：wrapId → { value, opts }，供 saveXxx 读当前值
export const sdRegistry = {};

/** 在 .sd-wrap 容器挂载自定义下拉（触发按钮 + 菜单，仿 filter-status-menu/fsm-item）。
 *  options: [{value, label}]，initialValue: 初始选中值，onChange(value): 选中回调。
 *  返回控制器 { get, set }，供 loadSettings/save 读写当前值。 */
function mountSettingDropdown(wrapId, options, initialValue, onChange) {
  const wrap = $(('' + wrapId).replace(/^#/, ''));
  if (!wrap) return null;
  const opts = Array.isArray(options) ? options : [];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const labelOf = (v) => { const o = opts.find((x) => x.value === v); return o ? o.label : v; };
  wrap.innerHTML =
    '<button class="filter-trigger sd-trigger" type="button">' +
    '<span class="ft-label sd-label">' + esc(labelOf(initialValue)) + '</span>' +
    '<span class="ft-chev"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>' +
    '</button>' +
    '<div class="sd-menu" hidden>' + opts.map((o) => '<button class="fsm-item" type="button" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>').join('') + '</div>';
  const trigger = wrap.querySelector('.sd-trigger');
  const menu = wrap.querySelector('.sd-menu');
  const labelEl = wrap.querySelector('.sd-label');
  const state = { value: initialValue, opts };
  sdRegistry[wrapId] = state;
  const syncActive = () => {
    menu.querySelectorAll('.fsm-item').forEach((it) => it.classList.toggle('active', it.dataset.v === state.value));
    if (labelEl) labelEl.textContent = labelOf(state.value);
    trigger.classList.toggle('active', !!state.value && state.value !== opts[0]?.value);
  };
  syncActive();
  trigger.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.querySelectorAll('.fsm-item').forEach((it) => {
    it.onclick = (e) => {
      e.stopPropagation();
      state.value = it.dataset.v;
      menu.hidden = true;
      syncActive();
      if (onChange) onChange(state.value);
    };
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
  return {
    get: () => state.value,
    set: (v) => { state.value = v; syncActive(); },
  };
}

export async function loadSettingsData() {
  try {
    const { data } = await jget('/api/settings');
    // ---- 模型渠道（v3.13 卡片式多渠道；apiKey 只回显掩码，卡片内编辑）----
    set_channelsState({
      channels: Array.isArray(data.ai.channels) ? data.ai.channels : [],
      activeChannelId: data.ai.activeChannelId || '',
    });
    set_editingChannelId(null);
    renderChannels();
    // v3.11：输入上限以 tokens 为准（OpenAI 标准）。后端同时回显旧 maxInputChars（兼容存量），
    // 这里优先取 tokens；tokens 缺失时说明是旧部署未保存过 → 回显空让用户填（默认值由 placeholder 暗示）。
    setField('ai-maxinput', data.ai.maxInputTokens || '');
    setField('ai-timeout', Math.round((data.ai.timeoutMs || 120000) / 1000));
    // 每任务输入上限：null = 跟随全局，输入框留空 + placeholder 显示全局 tokens 值
    const tb = data.ai.taskMaxInputTokens || {};
    const globalTokens = data.ai.maxInputTokens || '';
    for (const t of TASK_BUDGET_KEYS) {
      const el = $('tb-' + t);
      if (!el) continue;
      setField('tb-' + t, tb[t] == null ? '' : tb[t]);
      el.placeholder = globalTokens ? '跟随全局 ' + globalTokens : '跟随全局';
    }
    // 有任一任务级覆盖时展开折叠区，避免用户以为没生效
    const tbBox = $('task-budget');
    if (tbBox) tbBox.open = TASK_BUDGET_KEYS.some((t) => tb[t] != null);
    $('ai-config-ref').innerHTML =
      `<span><span class="ref-k">Base URL</span><span class="ref-v">${escapeHtml(data.configAi.baseURL || '（未设置）')}</span></span>` +
      `<span><span class="ref-k">Model</span><span class="ref-v">${escapeHtml(data.configAi.model || '（未设置）')}</span></span>`;
    // ---- 提示词 ----
    $('summary-prompt-edit').value = data.summaryPrompt || '';
    $('summary-prompt-default-pre').textContent = data.defaultPrompt || '';
    $('tags-prompt-edit').value = data.tagsPrompt || '';
    $('tags-prompt-default-pre').textContent = data.defaultTagsPrompt || '';
    $('formula-prompt-edit').value = data.formulaPrompt || '';
    $('formula-prompt-default-pre').textContent = data.defaultFormulaPrompt || '';
    // 概念提示词（v3.10）
    if ($('concept-prompt-edit')) $('concept-prompt-edit').value = data.conceptPrompt || '';
    if ($('concept-prompt-default-pre')) $('concept-prompt-default-pre').textContent = data.defaultConceptPrompt || '';
    // 概念地图提示词（v3.14）
    if ($('concept-map-prompt-edit')) $('concept-map-prompt-edit').value = data.conceptMapPrompt || '';
    if ($('concept-map-prompt-default-pre')) $('concept-map-prompt-default-pre').textContent = data.defaultConceptMapPrompt || '';
    // ---- 聊天预置 Prompt（输入框上方快捷提问按钮，store.settings.chatPresets 覆盖内置默认）----
    set_chatPresetsOverride(Array.isArray(data.chatPresets) ? data.chatPresets : null);
    // ---- v3.2 保存的搜索预设（高级搜索命名预设）----
    setSavedSearches(Array.isArray(data.savedSearches) ? data.savedSearches : []);
    renderSavedSearches();
    // ---- 文件扫描 ----
    setField('scan-interval', data.scan.scanIntervalMinutes ?? 5);
    $('scan-default-hint').textContent = `config.json 默认：${data.configScan.scanIntervalMinutes} 分钟 · 设为 0 关闭定时扫描，仅手动 / 导入触发`;
    // ---- arXiv 元数据 ----
    setField('arxiv-enabled', data.arxiv.enabled !== false);
    setField('arxiv-thr', data.arxiv.titleSimilarityThreshold ?? '');
    setField('arxiv-interval', data.arxiv.minIntervalMs ?? '');
    $('arxiv-thr-hint').textContent = `0–1，越高越严格（避免误匹配）。config 默认：${fmtDef(data.configArxiv.titleSimilarityThreshold)}`;
    $('arxiv-interval-hint').textContent = `遵守 arXiv 礼貌限速，建议 ≥3000。config 默认：${fmtDef(data.configArxiv.minIntervalMs)}`;
    // ---- 主题发现 ----
    const d = data.discover;
    const cd = data.configDiscover;
    setField('disc-maxresults', d.maxResults ?? '');
    setField('disc-peraxis', d.perAxis ?? '');
    setField('disc-recency', d.recencyWindowYears ?? '');
    setField('disc-titlesim', d.titleSimThreshold ?? '');
    setField('disc-s2', d.semanticScholar !== false);
    setField('disc-openalex', d.openAlex !== false);
    setField('disc-s2key', d.hasS2Key ? APIKEY_MASK : '');
    $('disc-s2key').dataset.masked = d.hasS2Key ? '1' : '';
    const w = d.weights || {};
    setField('disc-w-rel', w.rel ?? '');
    setField('disc-w-auth', w.auth ?? '');
    setField('disc-w-rec', w.rec ?? '');
    $('disc-maxresults-hint').textContent = `config 默认：${fmtDef(cd.maxResults)}`;
    $('disc-peraxis-hint').textContent = `config 默认：${fmtDef(cd.perAxis)}`;
    renderWeightProp();
    // ---- 划线翻译（自定义下拉） ----
    {
      const engineOpts = [
        { value: 'google', label: 'Google 翻译（免费端点，秒回，推荐）' },
        { value: 'ai', label: 'AI 翻译（流式，保留术语/公式）' },
        { value: 'bing', label: '必应 Bing 翻译（外链）' },
        { value: 'none', label: '关闭（不显示翻译按钮）' },
      ];
      const langOpts = [
        { value: 'zh-CN', label: '简体中文 zh-CN' }, { value: 'zh-TW', label: '繁体中文 zh-TW' },
        { value: 'en', label: '英文 en' }, { value: 'ja', label: '日文 ja' },
        { value: 'ko', label: '韩文 ko' }, { value: 'fr', label: '法文 fr' }, { value: 'de', label: '德文 de' },
      ];
      const ev = data.translate.engine || 'google';
      const lv = data.translate.targetLang || 'zh-CN';
      if (!sdRegistry['sd-translate-engine-wrap']) {
        // 自定义下拉没有原生 change，选中回调直连即时保存
        mountSettingDropdown('sd-translate-engine-wrap', engineOpts, ev, () => saveTranslate({ auto: true }));
        mountSettingDropdown('sd-translate-lang-wrap', langOpts, lv, () => saveTranslate({ auto: true }));
      } else {
        sdRegistry['sd-translate-engine-wrap'].value = ev;
        sdRegistry['sd-translate-lang-wrap'].value = lv;
      }
      if ($('translate-engine-hint')) $('translate-engine-hint').textContent = `config 默认：${data.configTranslate.engine || 'google'} · Google 免费端点秒回（推荐），AI 流式保留术语，Bing 走外链`;
      if ($('translate-lang-hint')) $('translate-lang-hint').textContent = `config 默认：${data.configTranslate.targetLang || 'zh-CN'}`;
    }
    // ---- 公式抽取引擎（AI | MinerU，自定义下拉） ----
    {
      const engineOpts = [
        { value: 'ai', label: 'AI 抽取（默认，从全文识别）' },
        { value: 'mineru', label: 'MinerU 服务（高保真 LaTeX，需填地址）' },
      ];
      const ev = data.formulas.engine || 'ai';
      if (!sdRegistry['sd-formula-engine-wrap']) {
        mountSettingDropdown('sd-formula-engine-wrap', engineOpts, ev, () => saveFormulaEngine({ auto: true }));
      } else {
        sdRegistry['sd-formula-engine-wrap'].value = ev;
      }
      setField('formula-mineru-url', data.formulas.mineruUrl || '');
      if ($('formula-engine-hint')) $('formula-engine-hint').textContent = `config 默认：${data.configFormulas.engine || 'ai'} · MinerU 解析 PDF 出高保真 LaTeX，再用 AI 命名/解读`;
      // MinerU 命名提示词（正文在「提示词」页编辑，这里只负责回显）
      if ($('mineru-naming-prompt-edit')) $('mineru-naming-prompt-edit').value = data.formulas.namingPrompt || '';
      if ($('mineru-naming-default-pre')) $('mineru-naming-default-pre').textContent = data.defaultNamingPrompt || '';
    }
    // ---- 概览 / 系统 / 覆盖徽标 ----
    renderOverview(data);
    renderSystem(data);
    markOverrides(data.overrides);
    // 提示词工作台（v3.55）：textarea/default pre 已回显，同步只读视图与「自定义/内置默认」角标
    refreshAllStudios();
    renderPromptIndex();
  } catch (e) {
    toast('加载设置失败：' + (e.message || e), 'error');
  }
}

/** 概览（v3.56）：生效配置改成只读行清单——左标签、右值，可跳的行整行可点并带 ›。
 *  原来的 metric 卡片是「仪表盘」形态，与设置页其余部分的行式语言不一致，且把只读信息
 *  抬得比可改的设置项还显眼；改成行后与 arXiv / 发现等页同构。 */
function renderOverview(data) {
  const m = $('ov-metrics');
  if (!m) return;
  const arxivOn = data.arxiv.enabled !== false;
  const sources = [data.discover.semanticScholar !== false ? 'S2' : null, data.discover.openAlex !== false ? 'OpenAlex' : null]
    .filter(Boolean)
    .join(' · ');
  // [label, valueHtml, tone, goto?]。goto 为可跳转的导航项；无 goto 则整行只读。
  const rows = [
    ['当前模型', escapeHtml(data.ai.model || '未设置'), '', 'ai'],
    ['API 端点', escapeHtml(data.ai.baseURL || '未设置'), 'mono', 'ai'],
    ['扫描间隔', data.scan.scanIntervalMinutes ? data.scan.scanIntervalMinutes + ' 分钟' : '已关闭', '', 'ingest'],
    ['arXiv 自动补全', arxivOn ? '开启' : '关闭', arxivOn ? '' : 'muted', 'ingest'],
    ['发现来源', sources || '无', '', 'discover'],
    ['论文总数', String(data.system.papers ?? '?'), '', null],
    ['服务状态', '<span class="live-dot"></span>运行中', 'good', null],
  ];
  const CHEV =
    '<svg class="sr-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
  m.innerHTML = rows
    .map(
      ([k, v, tone, goto]) =>
        `<div class="set-row${goto ? ' set-row-jump' : ''}"${goto ? ` data-goto="${goto}" tabindex="0" role="button" title="前往${escapeHtml(k)}设置"` : ''}>` +
        `<div class="sr-main"><div class="sr-label">${escapeHtml(k)}</div></div>` +
        `<div class="sr-ctl"><span class="sr-val ${tone}">${v}</span>${goto ? CHEV : ''}</div>` +
        `</div>`,
    )
    .join('');
  m.querySelectorAll('.set-row-jump').forEach((c) => {
    const go = () => gotoSettingsTab(c.dataset.goto);
    c.onclick = go;
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  const ov = data.overrides || {};
  const count =
    (ov.ai || []).length +
    (ov.arxiv || []).length +
    (ov.discover || []).length +
    (ov.scan ? 1 : 0) +
    (ov.summaryPrompt ? 1 : 0) +
    (ov.tagsPrompt ? 1 : 0);
  const bar = $('ov-override-bar');
  if (count > 0) {
    bar.hidden = false;
    $('ov-override-text').innerHTML = `有 <b>${count} 项</b> 设置已覆盖 config.json 默认`;
  } else {
    bar.hidden = true;
  }
}

/** 系统信息：服务级只读项 + 脱敏 config.json。与其他页共用 .set-row 行式语言。 */
function renderSystem(data) {
  const c = $('system-card');
  if (!c) return;
  const sys = data.system || {};
  const rows = [
    ['版本', 'v' + (sys.version || '?')],
    ['监听地址', (sys.host || '?') + ' : ' + (sys.port ?? '?')],
    ['论文目录', sys.papersDir || '?'],
    ['论文总数', String(sys.papers ?? '?')],
    ['运行时长', sys.uptime != null ? Math.round(sys.uptime / 60) + ' 分钟' : '?'],
  ];
  c.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="set-row"><div class="sr-main"><div class="sr-label">${escapeHtml(k)}</div></div>` +
        `<div class="sr-ctl"><span class="sr-val mono">${escapeHtml(v)}</span></div></div>`,
    )
    .join('');
  $('system-raw').textContent = JSON.stringify(sys.rawConfig || {}, null, 2);
}

/** 依据后端 overrides 显隐各字段的「已覆盖」徽标。 */
function markOverrides(ov) {
  ov = ov || {};
  const show = (id, on) => {
    const el = $(id);
    if (el) el.hidden = !on;
  };
  show('ovr-ai', (ov.ai || []).length > 0);
  show('ovr-summary', !!ov.summaryPrompt);
  show('ovr-tags', !!ov.tagsPrompt);
  show('ovr-formula', !!ov.formulaPrompt);
  show('ovr-concept', !!ov.conceptPrompt);
  show('ovr-concept-map', !!ov.conceptMapPrompt);
  show('ovr-scan', !!ov.scan);
  const ax = ov.arxiv || [];
  show('ovr-arxiv-enabled', ax.includes('enabled'));
  show('ovr-arxiv-thr', ax.includes('titleSimilarityThreshold'));
  show('ovr-arxiv-interval', ax.includes('minIntervalMs'));
  const dv = ov.discover || [];
  for (const k of [
    'maxResults',
    'perAxis',
    'recencyWindowYears',
    'titleSimThreshold',
    'semanticScholar',
    'openAlex',
    'semanticScholarApiKey',
    'weights',
  ]) {
    show('ovr-discover-' + k, dv.includes(k));
  }
  // 划线翻译
  const tr = ov.translate || [];
  show('ovr-translate-engine', tr.includes('engine'));
  show('ovr-translate-lang', tr.includes('targetLang'));
  // 公式抽取引擎
  const fm = ov.formulas || [];
  // 引擎/地址各自有更精确的徽标时不再重复挂总徽标，避免同一行挂两个「已覆盖」
  show('ovr-formulas', fm.length > 0 && !fm.includes('engine') && !fm.includes('mineruUrl'));
  show('ovr-formulas-engine', fm.includes('engine'));
  show('ovr-formulas-mineruUrl', fm.includes('mineruUrl'));
  show('ovr-mineru-naming', fm.includes('namingPrompt'));
}

/** 全局 AI 参数保存。opts.auto=true 时走即时保存路径：不弹 toast，只在节标题旁显示保存态。 */
export async function saveAiConfig(opts = {}) {
  const auto = !!opts.auto;
  const btn = $('btn-ai-save');
  const payload = {
    // v3.11：输入上限按 tokens 发（OpenAI 标准）；空值 → 后端用默认 32000
    maxInputTokens: parseInt($('ai-maxinput').value, 10) || undefined,
    timeoutMs: (parseInt($('ai-timeout').value, 10) || 120) * 1000,
    // 每任务输入上限：留空 → null（跟随全局），后端按白名单校验
    taskMaxInputTokens: TASK_BUDGET_KEYS.reduce((acc, t) => {
      const el = $('tb-' + t);
      const v = el ? el.value.trim() : '';
      acc[t] = v === '' ? null : parseInt(v, 10) || null;
      return acc;
    }, {}),
  };
  // maxInputTokens 空时从 payload 删掉（undefined 不发），让后端保留原值而非覆盖成默认
  if (payload.maxInputTokens == null) delete payload.maxInputTokens;
  if (btn) setBusy(btn, true, '保存中…');
  markSaved('ai-hint', 'saving');
  try {
    const r = await PUT('/api/settings/ai', payload);
    if (r.ok) {
      await loadSettingsData(); // 刷新表单 / 概览 / 覆盖徽标
      markSaved('ai-hint', 'saved');
      if (!auto) toast('全局参数已保存，立即生效');
    } else {
      markSaved('ai-hint', 'error', r.error);
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    markSaved('ai-hint', 'error', e.message || String(e));
    toast('保存失败', 'error');
  }
  if (btn) setBusy(btn, false);
}
