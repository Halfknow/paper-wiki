// AI 渠道卡片管理与模型选择器
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { POST, PUT, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { inlineStatus, setBusy, toast } from '../core/ui-kit.js';
import { select } from '../detail/detail.js';
import { APIKEY_MASK, loadSettingsData } from './settings.js';

// ============================================================================
// v3.13 模型渠道卡片：每个渠道 = 一个 OpenAI 兼容端点（Base URL + Key + 模型），
// activeChannelId 指向默认渠道（驱动全站 AI 能力）。列表整体 PUT 替换，
// apiKey 掩码回传 = 未改动（后端按 id 保留已存 key）。
// ============================================================================
export let channelsState = { channels: [], activeChannelId: '' };

export let editingChannelId = null; // 正在编辑的渠道 id；'__new__' = 新建草稿

/** 常用渠道快速预设（添加渠道时一键填充，可再改）。 */
const CHANNEL_PRESETS = [
  { name: 'Kimi for Coding', baseURL: 'https://api.kimi.com/coding/v1', model: 'k3', maxInputTokens: 1000000 },
  { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', maxInputTokens: 200000 },
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', maxInputTokens: 128000 },
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', maxInputTokens: 128000 },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: '', maxInputTokens: null },
];

function chHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return u || '';
  }
}

function chTokensLabel(t) {
  t = Number(t);
  if (!t) return '';
  if (t >= 1000000) return (t / 1000000).toFixed(t % 1000000 ? 1 : 0) + 'M';
  if (t >= 1000) return Math.round(t / 1000) + 'K';
  return String(t);
}

/** 渠道头像底色：按名称哈希取色相，稳定且各渠道可区分。 */
function chAvatarHue(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function chCardHtml(c, active) {
  const initial = escapeHtml((c.name || c.model || '?').trim().charAt(0).toUpperCase() || '?');
  const tokens = chTokensLabel(c.maxInputTokens);
  return (
    `<div class="ch-card${active ? ' active' : ''}" data-id="${escapeHtml(c.id)}">` +
    `<div class="ch-top">` +
    `<span class="ch-avatar" style="--hue:${chAvatarHue(c.name)}">${initial}</span>` +
    `<div class="ch-title">` +
    `<div class="ch-name">${escapeHtml(c.name || chHost(c.baseURL) || '未命名渠道')}${active ? '<span class="ch-badge">默认</span>' : ''}</div>` +
    `<div class="ch-model">${escapeHtml(c.model)}${tokens ? `<span class="ch-ctx">${tokens}</span>` : ''}</div>` +
    `</div>` +
    `<span class="ch-key${c.hasApiKey ? ' ok' : ''}" title="${c.hasApiKey ? 'API Key 已配置' : '未配置 API Key（无鉴权端点）'}"></span>` +
    `</div>` +
    `<div class="ch-url" title="${escapeHtml(c.baseURL)}">${escapeHtml(chHost(c.baseURL))}</div>` +
    `<div class="ch-actions">` +
    (active ? '' : '<button class="btn secondary sm" data-act="default">设为默认</button>') +
    `<button class="btn secondary sm" data-act="edit">编辑</button>` +
    `<button class="btn secondary sm" data-act="test">测试</button>` +
    `<span class="ch-test" aria-live="polite"></span>` +
    `<button class="ch-del" data-act="del" title="删除渠道"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>` +
    `</div></div>`
  );
}

function chEditCardHtml(c) {
  const isNew = c.id === '__new__';
  const presets = CHANNEL_PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
  return (
    `<div class="ch-card editing" data-id="${escapeHtml(c.id)}" data-tokens-for="${escapeHtml(c.model || '')}">` +
    `<div class="ch-form">` +
    `<div class="ch-form-row">` +
    `<label>渠道名称<input type="text" class="chf-name" value="${escapeHtml(c.name || '')}" placeholder="如 Kimi / 智谱 GLM" autocomplete="off" /></label>` +
    (isNew ? `<label>快速预设<select class="chf-preset"><option value="">自定义…</option>${presets}</select></label>` : '') +
    `</div>` +
    `<label>Base URL<input type="text" class="chf-baseurl" value="${escapeHtml(c.baseURL || '')}" placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck="false" /></label>` +
    `<label>API Key<input type="password" class="chf-apikey" value="${c.hasApiKey ? APIKEY_MASK : ''}" placeholder="sk-...（留空 = 无鉴权端点）" autocomplete="off" /></label>` +
    `<div class="ch-form-row">` +
    // 模型选择器（自定义下拉：聚焦/输入即按子串过滤，chevron 展开全量；选中回填上下文 tokens）
    `<label>模型<div class="chf-model-wrap">` +
    `<input type="text" class="chf-model" value="${escapeHtml(c.model || '')}" placeholder="gpt-4o / k3 / glm-4.6" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" />` +
    `<button type="button" class="chf-model-toggle" data-act="model-menu" title="显示全部已拉取模型" tabindex="-1"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>` +
    `<div class="chf-model-menu" hidden></div>` +
    `</div></label>` +
    `<label>上下文 tokens<input type="number" class="chf-tokens" min="0" step="1000" value="${c.maxInputTokens || ''}" placeholder="跟随全局" /></label>` +
    `</div>` +
    `<div class="ch-form-actions">` +
    `<button class="btn secondary sm" data-act="fetch-models" title="从上游 /v1/models 拉取可选模型与上下文长度">拉取模型</button>` +
    `<button class="btn secondary sm" data-act="test">测试连接</button>` +
    `<span class="ch-test" aria-live="polite"></span>` +
    `<span style="flex:1"></span>` +
    `<button class="btn secondary sm" data-act="cancel">取消</button>` +
    `<button class="btn sm" data-act="save">保存渠道</button>` +
    `</div></div></div>`
  );
}

export function renderChannels() {
  const grid = $('ch-grid');
  if (!grid) return;
  const { channels, activeChannelId } = channelsState;
  let html = channels
    .map((c) => (editingChannelId === c.id ? chEditCardHtml(c) : chCardHtml(c, c.id === activeChannelId)))
    .join('');
  if (editingChannelId === '__new__') html += chEditCardHtml({ id: '__new__' });
  if (!html) {
    grid.innerHTML =
      '<div class="ch-empty">还没有模型渠道。点击下方「添加渠道」配置一个 OpenAI 兼容端点（Kimi / 智谱 / DeepSeek 均可）；config.json 中的配置会作为初始渠道显示。</div>';
    return;
  }
  grid.innerHTML = html;
}

/** 当前列表 → PUT payload（apiKey 一律掩码 = 未改动，后端按 id 保留）。 */
function chPayloadList() {
  return channelsState.channels.map((c) => ({
    id: c.id,
    name: c.name,
    baseURL: c.baseURL,
    apiKey: APIKEY_MASK,
    model: c.model,
    maxInputTokens: c.maxInputTokens || null,
  }));
}

/** 整体保存渠道列表；成功后以响应刷新本地状态 + 概览。 */
async function saveChannels(channels, activeChannelId) {
  const r = await PUT('/api/settings/ai/channels', { channels, activeChannelId });
  if (!r.ok) {
    toast(r.error || '渠道保存失败', 'error');
    return false;
  }
  channelsState = { channels: r.data.ai.channels, activeChannelId: r.data.ai.activeChannelId };
  editingChannelId = null;
  chEditModels = [];
  renderChannels();
  loadSettingsData(); // 后台刷新概览 / 覆盖徽标（不 await，避免阻塞交互）
  return true;
}

async function chSetDefault(id) {
  const c = channelsState.channels.find((x) => x.id === id);
  if (await saveChannels(chPayloadList(), id)) toast(`默认模型已切换为「${(c && (c.name || c.model)) || id}」`, 'good');
}

async function chDelete(id) {
  const c = channelsState.channels.find((x) => x.id === id);
  const isActive = channelsState.activeChannelId === id;
  const ok = await PWDialog.confirm(
    `删除渠道「${(c && (c.name || c.model)) || id}」？` + (isActive ? '\n它是当前默认渠道，删除后默认将回落到列表第一个渠道。' : ''),
    { title: '删除渠道', danger: true, okText: '删除' },
  );
  if (!ok) return;
  const next = chPayloadList().filter((x) => x.id !== id);
  const nextActive = isActive ? (next[0] && next[0].id) || '' : channelsState.activeChannelId;
  if (await saveChannels(next, nextActive)) toast('渠道已删除');
}

/** 读取编辑卡片当前表单值（apiKey 掩码 = 未改动）。 */
function chFormValues(card) {
  const tokens = parseInt(card.querySelector('.chf-tokens').value, 10);
  return {
    name: card.querySelector('.chf-name').value.trim(),
    baseURL: card.querySelector('.chf-baseurl').value.trim(),
    apiKey: card.querySelector('.chf-apikey').value,
    model: card.querySelector('.chf-model').value.trim(),
    maxInputTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null,
  };
}

async function chSave(card, id) {
  const v = chFormValues(card);
  if (!v.baseURL || !v.model) {
    toast('Base URL 与模型必填', 'error');
    return;
  }
  const btn = card.querySelector('[data-act="save"]');
  setBusy(btn, true, '保存中…');
  let list;
  let active = channelsState.activeChannelId;
  if (id === '__new__') {
    list = chPayloadList().concat([{ name: v.name, baseURL: v.baseURL, apiKey: v.apiKey === APIKEY_MASK ? '' : v.apiKey, model: v.model, maxInputTokens: v.maxInputTokens }]);
    if (!active) active = ''; // 后端会回落到第一个渠道
  } else {
    list = chPayloadList().map((x) => (x.id === id ? { ...x, ...v, id } : x));
  }
  const ok = await saveChannels(list, active);
  setBusy(btn, false);
  if (ok) toast('渠道已保存', 'good');
}

async function chTest(card, id) {
  const span = card.querySelector('.ch-test');
  const btn = card.querySelector('[data-act="test"]');
  let payload;
  if (id === '__new__' || editingChannelId === id) {
    const v = chFormValues(card);
    payload = { baseURL: v.baseURL, model: v.model, apiKey: v.apiKey };
    if (id !== '__new__') payload.channelId = id; // 掩码 key 由后端按渠道解析
  } else {
    const c = channelsState.channels.find((x) => x.id === id) || {};
    payload = { channelId: id, baseURL: c.baseURL, model: c.model, apiKey: APIKEY_MASK };
  }
  setBusy(btn, true, '测试中…');
  span.textContent = '…';
  span.className = 'ch-test';
  delete span.dataset.level;
  try {
    const r = await POST('/api/settings/test', payload);
    if (r.ok) {
      inlineStatus(span, 'success', '连接成功');
      span.classList.add('good');
    } else {
      inlineStatus(span, 'danger', r.error || '失败');
      span.classList.add('bad');
    }
  } catch (e) {
    inlineStatus(span, 'danger', e.message || e);
    span.classList.add('bad');
  }
  setBusy(btn, false);
}

/** 从上游 /v1/models 拉模型列表入选择器；当前值命中 context_length 且 tokens 留空时顺手回填。 */
async function chFetchModels(card, id) {
  const btn = card.querySelector('[data-act="fetch-models"]');
  const span = card.querySelector('.ch-test');
  const v = chFormValues(card);
  setBusy(btn, true, '拉取中…');
  span.textContent = '';
  span.className = 'ch-test';
  delete span.dataset.level;
  try {
    const r = await POST('/api/settings/ai/models', {
      channelId: id === '__new__' ? undefined : id,
      baseURL: v.baseURL,
      apiKey: v.apiKey,
    });
    if (!r.ok) throw new Error(r.error || '拉取失败');
    chEditModels = ((r.data && r.data.models) || []).filter((m) => m && m.id);
    // 当前已填模型命中上游 context_length 且 tokens 留空 → 顺手回填（tokensFor 标记归属当前模型）
    const tokensInput = card.querySelector('.chf-tokens');
    const cur = chEditModels.find((m) => m.id === v.model);
    if (cur && cur.contextLength && !tokensInput.value) {
      tokensInput.value = cur.contextLength;
      card.dataset.tokensFor = v.model;
    }
    inlineStatus(span, 'success', `已拉取 ${chEditModels.length} 个模型`);
    span.classList.add('good');
    openChModelMenu(card, ''); // 展开全量列表，所见即所得
  } catch (e) {
    inlineStatus(span, 'danger', e.message || e);
    span.classList.add('bad');
  }
  setBusy(btn, false);
}

// ---- 模型选择器下拉（替代原生 datalist：全量可见 + 子串过滤 + 上下文徽标 + 键盘导航）----
export let chEditModels = []; // 当前编辑卡片已拉取的模型 [{id, contextLength?, displayName?}]

const CH_MENU_CAP = 100; // 大网关（OpenRouter 数百个）渲染上限，超出提示输入过滤

function chMenuFiltered(filter) {
  const f = (filter || '').trim().toLowerCase();
  if (!f) return chEditModels;
  return chEditModels.filter(
    (m) => m.id.toLowerCase().includes(f) || (m.displayName || '').toLowerCase().includes(f),
  );
}

function renderChModelMenu(card, filter) {
  const menu = card.querySelector('.chf-model-menu');
  if (!menu) return;
  const cur = card.querySelector('.chf-model').value.trim();
  if (!chEditModels.length) {
    menu.innerHTML =
      '<div class="chf-mm-hint">尚未拉取模型列表 <button type="button" class="btn secondary sm" data-act="fetch-models">立即拉取</button></div>';
    return;
  }
  const items = chMenuFiltered(filter);
  if (!items.length) {
    menu.innerHTML = '<div class="chf-mm-hint">无匹配模型，可直接输入自定义模型 id</div>';
    return;
  }
  const shown = items.slice(0, CH_MENU_CAP);
  menu.innerHTML =
    shown
      .map(
        (m) =>
          `<button type="button" class="chf-mm-item${m.id === cur ? ' cur' : ''}" data-m="${escapeHtml(m.id)}">` +
          `<span class="chf-mm-id">${escapeHtml(m.id)}</span>` +
          (m.displayName ? `<span class="chf-mm-name">${escapeHtml(m.displayName)}</span>` : '') +
          (m.contextLength ? `<span class="chf-mm-ctx">${chTokensLabel(m.contextLength)}</span>` : '') +
          `</button>`,
      )
      .join('') +
    (items.length > CH_MENU_CAP
      ? `<div class="chf-mm-hint">共 ${items.length} 个匹配，仅显示前 ${CH_MENU_CAP} 个——继续输入以缩小范围</div>`
      : '');
}

function openChModelMenu(card, filter) {
  const menu = card && card.querySelector('.chf-model-menu');
  if (!menu) return;
  renderChModelMenu(card, filter);
  menu.hidden = false;
  const input = card.querySelector('.chf-model');
  if (input) input.setAttribute('aria-expanded', 'true');
}

function closeChModelMenu(card) {
  const menu = card && card.querySelector('.chf-model-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const input = card.querySelector('.chf-model');
  if (input) input.setAttribute('aria-expanded', 'false');
}

/** 选中模型：回填输入框。tokens 同步规则（card.dataset.tokensFor 记录当前 tokens 值归属的模型）：
 *  值为空 / 值归属另一个模型 → 覆盖为新模型的 contextLength；归属本模型（已同步或手动自定义）→ 不碰。 */
function pickChModel(card, id) {
  const input = card.querySelector('.chf-model');
  input.value = id;
  const tokensInput = card.querySelector('.chf-tokens');
  const m = chEditModels.find((x) => x.id === id);
  if (m && m.contextLength && (!tokensInput.value || card.dataset.tokensFor !== id)) {
    tokensInput.value = m.contextLength;
    card.dataset.tokensFor = id;
  }
  closeChModelMenu(card);
  // 不再 input.focus()：键盘路径焦点本就在输入框；鼠标点选后重新 focus 会经 focusin 把菜单又打开
}

/** 键盘导航：↑/↓ 移动高亮（闭环），Enter 选中高亮项。仅在菜单关闭时才重渲染，否则会清掉高亮态。 */
function chMenuNav(card, dir) {
  const menu = card && card.querySelector('.chf-model-menu');
  if (!menu) return;
  if (menu.hidden) openChModelMenu(card, card.querySelector('.chf-model').value);
  const items = [...menu.querySelectorAll('.chf-mm-item')];
  if (!items.length) return;
  let idx = items.findIndex((el) => el.classList.contains('hover'));
  idx = (idx + dir + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('hover', i === idx));
  items[idx].scrollIntoView({ block: 'nearest' });
}

/** 渠道网格事件委托（编辑/设默认/测试/删除/保存/拉模型/预设填充 + 模型选择器）。 */
export function bindChannelGrid() {
  const grid = $('ch-grid');
  if (!grid) return;
  grid.addEventListener('click', async (e) => {
    // 模型菜单项优先（无 data-act，命中即选中）
    const mmItem = e.target.closest('.chf-mm-item');
    if (mmItem) {
      pickChModel(mmItem.closest('.ch-card'), mmItem.dataset.m);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.ch-card');
    const id = card && card.dataset.id;
    const act = btn.dataset.act;
    if (act === 'default') await chSetDefault(id);
    else if (act === 'edit') {
      chEditModels = [];
      editingChannelId = id;
      renderChannels();
    } else if (act === 'del') await chDelete(id);
    else if (act === 'test') await chTest(card, id);
    else if (act === 'cancel') {
      chEditModels = [];
      editingChannelId = null;
      renderChannels();
    } else if (act === 'save') await chSave(card, id);
    else if (act === 'fetch-models') await chFetchModels(card, id);
    else if (act === 'model-menu') {
      const menu = card.querySelector('.chf-model-menu');
      if (menu && !menu.hidden) closeChModelMenu(card);
      else openChModelMenu(card, ''); // chevron 始终展开全量列表
    }
  });
  // 输入即过滤（子串匹配 id / displayName）；手改 tokens → 归属标记为当前模型（改选不再覆盖自定义值）
  grid.addEventListener('input', (e) => {
    const inp = e.target.closest('.chf-model');
    if (inp) openChModelMenu(inp.closest('.ch-card'), inp.value);
    const tk = e.target.closest('.chf-tokens');
    if (tk) {
      const c = tk.closest('.ch-card');
      const mi = c && c.querySelector('.chf-model');
      if (c && mi) c.dataset.tokensFor = mi.value.trim();
    }
  });
  // 聚焦展开（按当前值过滤；空值 = 全量）
  grid.addEventListener('focusin', (e) => {
    const inp = e.target.closest('.chf-model');
    if (inp) openChModelMenu(inp.closest('.ch-card'), inp.value);
  });
  // 键盘导航：↑/↓ 移动高亮，Enter 选中，Esc 关闭（preventDefault 防冒泡到全局 Esc 分层）
  grid.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.chf-model');
    if (!inp) return;
    const card = inp.closest('.ch-card');
    const menu = card && card.querySelector('.chf-model-menu');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      chMenuNav(card, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && menu && !menu.hidden) {
      const hover = menu.querySelector('.chf-mm-item.hover') || menu.querySelector('.chf-mm-item.cur');
      if (hover) {
        e.preventDefault();
        pickChModel(card, hover.dataset.m);
      }
    } else if (e.key === 'Escape' && menu && !menu.hidden) {
      e.preventDefault();
      closeChModelMenu(card);
    }
  });
  grid.addEventListener('change', (e) => {
    const sel = e.target.closest('.chf-preset');
    if (!sel || sel.value === '') return;
    const p = CHANNEL_PRESETS[Number(sel.value)];
    const card = sel.closest('.ch-card');
    if (p && card) {
      card.querySelector('.chf-name').value = p.name;
      card.querySelector('.chf-baseurl').value = p.baseURL;
      card.querySelector('.chf-model').value = p.model;
      card.querySelector('.chf-tokens').value = p.maxInputTokens || '';
      card.dataset.tokensFor = p.model; // 预设 tokens 归属预设模型
    }
    sel.value = '';
  });
  // 点选择器外部 → 关闭菜单（document 级，bindChannelGrid 只挂一次）
  document.addEventListener('click', (e) => {
    if (e.target.closest('.chf-model-wrap')) return;
    document.querySelectorAll('.chf-model-menu:not([hidden])').forEach((m) => {
      m.hidden = true;
      const input = m.closest('.chf-model-wrap') && m.closest('.chf-model-wrap').querySelector('.chf-model');
      if (input) input.setAttribute('aria-expanded', 'false');
    });
  });
}

// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。
export function set_channelsState(v) {
  channelsState = v;
}
export function set_editingChannelId(v) {
  editingChannelId = v;
}
export function set_chEditModels(v) {
  chEditModels = v;
}
