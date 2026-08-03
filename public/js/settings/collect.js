// 采集设置（扫描/arXiv/发现/翻译/公式引擎/重置）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { POST, PUT, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { setBusy, toast } from '../core/ui-kit.js';
import { APIKEY_MASK, loadSettingsData, sdRegistry } from './settings.js';

// ---- 采集：文件扫描 / arXiv / 主题发现 ----
export async function saveScan() {
  const btn = $('btn-scan-save');
  const hint = $('scan-hint');
  let n = parseInt($('scan-interval').value, 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/scan', { scanIntervalMinutes: n });
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString() + '（定时器已重置）';
      toast(n > 0 ? `扫描间隔已设为 ${n} 分钟，立即生效` : '定时扫描已关闭');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

export async function saveArxiv() {
  const btn = $('btn-arxiv-save');
  const hint = $('arxiv-hint');
  const payload = { enabled: $('arxiv-enabled').checked };
  const thr = parseFloat($('arxiv-thr').value);
  if (Number.isFinite(thr)) payload.titleSimilarityThreshold = thr;
  const intv = parseInt($('arxiv-interval').value, 10);
  if (Number.isFinite(intv)) payload.minIntervalMs = intv;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/arxiv', payload);
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('arXiv 设置已保存，立即生效');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

/** 实时权重占比条：读取三联输入，按和的比例绘制堆叠条 + 更新提示（和≠1 时提醒）。 */
export function renderWeightProp() {
  const bar = $('disc-weight-prop');
  if (!bar) return;
  const vals = {
    rel: parseFloat($('disc-w-rel').value),
    auth: parseFloat($('disc-w-auth').value),
    rec: parseFloat($('disc-w-rec').value),
  };
  const sum = (Number(vals.rel) || 0) + (Number(vals.auth) || 0) + (Number(vals.rec) || 0);
  // 全空：隐藏条，恢复默认提示
  if (!sum) { bar.innerHTML = ''; bar.style.opacity = '0'; const h = $('disc-weights-hint'); if (h) h.textContent = '建议三者之和为 1。'; return; }
  bar.style.opacity = '1';
  const pct = (k) => (sum > 0 ? ((Number(vals[k]) || 0) / sum) * 100 : 0);
  bar.innerHTML =
    `<i class="p-rel" style="width:${pct('rel')}%"></i>` +
    `<i class="p-auth" style="width:${pct('auth')}%"></i>` +
    `<i class="p-rec" style="width:${pct('rec')}%"></i>`;
  const h = $('disc-weights-hint');
  if (h) {
    const drift = Math.abs(sum - 1);
    h.textContent = drift < 0.001 ? '当前和 = 1（已归一化）。' : `当前和 = ${sum.toFixed(2)}，偏离 1。可点「归一化为 1」修正。`;
  }
}

/** 把三联权重按比例缩放为和 = 1（空值视为 0；全 0 不动）。 */
export function normalizeWeights() {
  const ids = ['disc-w-rel', 'disc-w-auth', 'disc-w-rec'];
  const vals = ids.map((id) => parseFloat($(id).value)).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (!sum) { toast('三组权重都为 0，无法归一化', 'error'); return; }
  ids.forEach((id, i) => { $(id).value = Math.round((vals[i] / sum) * 1000) / 1000; });
  renderWeightProp();
  toast('已归一化为 1');
}

export async function saveDiscover() {
  const btn = $('btn-discover-save');
  const hint = $('discover-hint');
  const payload = { semanticScholar: $('disc-s2').checked, openAlex: $('disc-openalex').checked };
  const setInt = (id, key) => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v)) payload[key] = v;
  };
  const setFloat = (id, key) => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) payload[key] = v;
  };
  setInt('disc-maxresults', 'maxResults');
  setInt('disc-peraxis', 'perAxis');
  setInt('disc-recency', 'recencyWindowYears');
  setFloat('disc-titlesim', 'titleSimThreshold');
  const weights = {};
  for (const [id, k] of [
    ['disc-w-rel', 'rel'],
    ['disc-w-auth', 'auth'],
    ['disc-w-rec', 'rec'],
  ]) {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) weights[k] = v;
  }
  if (Object.keys(weights).length) payload.weights = weights;
  // S2 key：未改（仍是掩码占位）则不传；改成新值或清空则传
  const keyVal = $('disc-s2key').value;
  if (keyVal !== APIKEY_MASK) payload.semanticScholarApiKey = keyVal;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/discover', payload);
    if (r.ok) {
      await loadSettingsData();
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('主题发现设置已保存，立即生效');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
  }
  setBusy(btn, false);
}

/** 清除某段运行时覆盖，回到 config.json 默认。 */
export async function saveTranslate() {
  const btn = $('btn-translate-save');
  const hint = $('translate-hint');
  const payload = {
    engine: (sdRegistry['sd-translate-engine-wrap'] || {}).value || 'google',
    targetLang: (sdRegistry['sd-translate-lang-wrap'] || {}).value || 'zh-CN',
  };
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/translate', payload);
    setBusy(btn, false);
    if (r.ok) { hint.textContent = '已保存，划线翻译立即生效'; hint.className = 'save-hint good'; await loadSettingsData(); toast('划线翻译配置已保存'); }
    else { hint.textContent = r.error || '保存失败'; hint.className = 'save-hint bad'; }
  } catch (e) { setBusy(btn, false); hint.textContent = '保存失败：' + (e.message || e); hint.className = 'save-hint bad'; }
}

/** 公式抽取引擎（AI | MinerU）保存。引擎选 mineru 时 mineruUrl 必填，前端预校验。 */
export async function saveFormulaEngine() {
  const btn = $('btn-formula-engine-save');
  const hint = $('formula-engine-hint-save');
  const engine = (sdRegistry['sd-formula-engine-wrap'] || {}).value || 'ai';
  const mineruUrl = $('formula-mineru-url').value.trim();
  if (engine === 'mineru' && !mineruUrl) {
    hint.textContent = '引擎选 MinerU 时必须填写 MinerU 服务地址';
    hint.className = 'save-hint bad';
    toast('请填写 MinerU 服务地址', 'error');
    return;
  }
  const payload = { engine, mineruUrl };
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/formulas', payload);
    setBusy(btn, false);
    if (r.ok) { hint.textContent = '已保存，公式抽取引擎立即生效'; hint.className = 'save-hint good'; await loadSettingsData(); toast('公式引擎配置已保存'); }
    else { hint.textContent = r.error || '保存失败'; hint.className = 'save-hint bad'; }
  } catch (e) { setBusy(btn, false); hint.textContent = '保存失败：' + (e.message || e); hint.className = 'save-hint bad'; }
}

/** MinerU 命名提示词保存（namingPrompt，单独保存按钮，与引擎配置同页）。空串=回退默认。 */
export async function saveMineruNamingPrompt() {
  const btn = $('btn-mineru-naming-save');
  const hint = $('mineru-naming-hint');
  const namingPrompt = $('mineru-naming-prompt-edit').value;
  setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/formulas', { namingPrompt });
    setBusy(btn, false);
    if (r.ok) { hint.textContent = '已保存，MinerU 命名提示词立即生效'; hint.className = 'save-hint good'; await loadSettingsData(); toast('MinerU 命名提示词已保存'); }
    else { hint.textContent = r.error || '保存失败'; hint.className = 'save-hint bad'; }
  } catch (e) { setBusy(btn, false); hint.textContent = '保存失败：' + (e.message || e); hint.className = 'save-hint bad'; }
}

export async function resetSection(section, label) {
  if (!(await PWDialog.confirm(`将「${label}」恢复为 config.json 默认？这会清除该项的运行时覆盖。`, { title: '恢复默认', okText: '恢复默认' }))) return;
  try {
    const r = await POST('/api/settings/reset', { section });
    if (r.ok) {
      await loadSettingsData();
      toast(`「${label}」已恢复默认`);
    } else toast(r.error || '操作失败', 'error');
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

/** 清空全部运行时覆盖。 */
export async function resetAllSettings() {
  if (!(await PWDialog.confirm('清空全部运行时覆盖，所有设置恢复为 config.json 默认？此操作不可撤销。', { title: '全部恢复默认', danger: true, okText: '全部恢复' }))) return;
  try {
    const r = await POST('/api/settings/reset', { all: true });
    if (r.ok) {
      await loadSettingsData();
      toast('已全部恢复为 config.json 默认');
    } else toast(r.error || '操作失败', 'error');
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

/** 设置内搜索：按标题 / 关键词过滤左侧导航条目。 */
export function filterSettingsNav(q) {
  q = (q || '').trim().toLowerCase();
  document.querySelectorAll('.settings-nav-item').forEach((el) => {
    const hay = (el.textContent + ' ' + (el.dataset.kw || '')).toLowerCase();
    el.style.display = !q || hay.includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.settings-nav-group').forEach((g) => {
    g.style.display = q ? 'none' : '';
  });
}
