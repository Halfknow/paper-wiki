// 各提示词保存
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { PUT, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { setBusy, toast } from '../core/ui-kit.js';

export async function saveSummaryPrompt() {
  const ta = $('summary-prompt-edit');
  const btn = $('btn-summary-prompt-save');
  const hint = $('summary-prompt-hint');
  setBusy(btn, true, '保存中…');
  let okSave = false;
  try {
    const r = await PUT('/api/settings/summary-prompt', { value: ta.value });
    if (r.ok) {
      okSave = true;
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString() + '（下次「重新总结」生效）';
      toast('总结提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
    setBusy(btn, false);
    return false;
  }
  setBusy(btn, false);
  return okSave;
}

export async function saveTagsPrompt() {
  const ta = $('tags-prompt-edit');
  const btn = $('btn-tags-prompt-save');
  const hint = $('tags-prompt-hint');
  setBusy(btn, true, '保存中…');
  let okSave = false;
  try {
    const r = await PUT('/api/settings/tags-prompt', { value: ta.value });
    if (r.ok) {
      okSave = true;
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('标签/主题提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
    setBusy(btn, false);
    return false;
  }
  setBusy(btn, false);
  return okSave;
}

export async function saveFormulaPrompt() {
  const ta = $('formula-prompt-edit');
  const btn = $('btn-formula-prompt-save');
  const hint = $('formula-prompt-hint');
  setBusy(btn, true, '保存中…');
  let okSave = false;
  try {
    const r = await PUT('/api/settings/formula-prompt', { value: ta.value });
    if (r.ok) {
      okSave = true;
      hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('公式提示词已保存');
    } else {
      hint.textContent = '保存失败：' + (r.error || '');
      toast(r.error || '保存失败', 'error');
    }
  } catch (e) {
    hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
    setBusy(btn, false);
    return false;
  }
  setBusy(btn, false);
  return okSave;
}

/** 概念抽取提示词保存（v3.10，仿 saveFormulaPrompt）。空串=恢复默认。 */
export async function saveConceptPrompt() {
  const ta = $('concept-prompt-edit');
  const btn = $('btn-concept-prompt-save');
  const hint = $('concept-prompt-hint');
  setBusy(btn, true, '保存中…');
  let okSave = false;
  try {
    const r = await PUT('/api/settings/concept-prompt', { value: ta.value });
    if (r.ok) { okSave = true; hint.textContent = '已保存 · ' + new Date().toLocaleTimeString(); toast('概念提示词已保存'); }
    else { hint.textContent = '保存失败：' + (r.error || ''); toast(r.error || '保存失败', 'error'); }
  } catch (e) { hint.textContent = '保存失败：' + (e.message || e); toast('保存失败', 'error'); setBusy(btn, false); return false; }
  setBusy(btn, false);
  return okSave;
}

/** 概念地图提示词保存（v3.14，仿 saveConceptPrompt）。空串=恢复默认。 */
export async function saveConceptMapPrompt() {
  const ta = $('concept-map-prompt-edit');
  const btn = $('btn-concept-map-prompt-save');
  const hint = $('concept-map-prompt-hint');
  setBusy(btn, true, '保存中…');
  let okSave = false;
  try {
    const r = await PUT('/api/settings/concept-map-prompt', { value: ta.value });
    if (r.ok) { okSave = true; hint.textContent = '已保存 · ' + new Date().toLocaleTimeString(); toast('概念地图提示词已保存'); }
    else { hint.textContent = '保存失败：' + (r.error || ''); toast(r.error || '保存失败', 'error'); }
  } catch (e) { hint.textContent = '保存失败：' + (e.message || e); toast('保存失败', 'error'); setBusy(btn, false); return false; }
  setBusy(btn, false);
  return okSave;
}

/** 笔记骨架提示词（v3.58 新开放编辑）。空串=恢复默认。 */
export async function saveNotesPrompt() {
  return savePrompt('notes-prompt', 'notes-prompt-edit', 'btn-notes-prompt-save', 'notes-prompt-hint', '笔记骨架提示词');
}

/** 论文聊天 system 提示词（v3.58 新开放编辑）。空串=恢复默认。 */
export async function saveChatPrompt() {
  return savePrompt('chat-prompt', 'chat-prompt-edit', 'btn-chat-prompt-save', 'chat-prompt-hint', '论文聊天提示词');
}

/** 划线翻译 system 提示词（v3.58 新开放编辑）。空串=恢复默认。 */
export async function saveTranslatePrompt() {
  return savePrompt('translate-prompt', 'translate-prompt-edit', 'btn-translate-prompt-save', 'translate-prompt-hint', '划线翻译提示词');
}

/** 上面三条共用的保存流程（与既有 saveXxxPrompt 行为一致：setBusy → PUT → hint + toast）。
 *  老的五个保留各自的函数体不动，避免为了「统一」去改动已经稳定的调用链。 */
async function savePrompt(endpoint, taId, btnId, hintId, label) {
  const ta = $(taId);
  const btn = $(btnId);
  const hint = $(hintId);
  if (btn) setBusy(btn, true, '保存中…');
  try {
    const r = await PUT('/api/settings/' + endpoint, { value: ta.value });
    if (btn) setBusy(btn, false);
    if (r.ok) {
      if (hint) hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast(label + '已保存');
      return true;
    }
    if (hint) hint.textContent = '保存失败：' + (r.error || '');
    toast(r.error || '保存失败', 'error');
    return false;
  } catch (e) {
    if (btn) setBusy(btn, false);
    if (hint) hint.textContent = '保存失败：' + (e.message || e);
    toast('保存失败', 'error');
    return false;
  }
}
