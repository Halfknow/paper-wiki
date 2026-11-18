// papersDir 改绑向导
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { POST, api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { escapeHtml } from '../core/format.js';
import { state } from '../core/state.js';
import { toast } from '../core/ui-kit.js';
import { hideModal, showModal } from '../core/layers.js';
import { refresh } from '../library/refresh.js';
import { closeSpaceMenu, closeSpaceModal, loadSpaces, openSpaceModal, renderSpaceAdmin, toggleSpaceMenu } from './spaces.js';

let dirWizardSpace = null; // 当前向导操作的空间对象

function dwShow(step) {
  for (const id of ['dw-step-input', 'dw-step-report', 'dw-step-result']) $(id).hidden = id !== step;
}

function dwError(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.hidden = !msg;
}

export function openDirWizard(s) {
  dirWizardSpace = s;
  $('dw-title').textContent = `更改文件夹 — ${s.name}`;
  $('dw-dir-input').value = s.papersDir || '';
  dwError('dw-input-error', '');
  dwError('dw-report-error', '');
  dwShow('dw-step-input');
  showModal($('dir-wizard'), { onClose: closeDirWizard, initialFocus: false });
  setTimeout(() => { $('dw-dir-input').focus(); $('dw-dir-input').select(); }, 20);
}

function closeDirWizard() {
  hideModal($('dir-wizard'));
  dirWizardSpace = null;
}

/** 步骤 1 → 2：调预检接口并渲染对账报告。 */
async function dwPreview() {
  const s = dirWizardSpace;
  const newDir = $('dw-dir-input').value.trim();
  if (!newDir) { dwError('dw-input-error', '文件夹路径不能为空'); return; }
  if (newDir === s.papersDir) { dwError('dw-input-error', '与当前绑定相同，无需更改'); return; }
  const btn = $('dw-preview-btn');
  btn.disabled = true;
  dwError('dw-input-error', '');
  try {
    const r = await POST(`/api/spaces/${encodeURIComponent(s.id)}/dir/preview`, { newDir });
    if (!r || !r.ok) { dwError('dw-input-error', (r && r.error) || '预检失败'); return; }
    const d = r.data;
    const rows = [
      ['新目录中的 PDF', `${d.pdfCount} 个`],
      ['与本库匹配（内容指纹）', `${d.matched} 篇`],
      ['将标记缺失', `${d.willMissing} 篇`, d.willMissing > 0 ? 'warn' : ''],
      ['新文件（将入库处理）', `${d.newFiles} 个`],
    ];
    let html = `<div class="dw-report-grid">${rows
      .map(([k, v, cls]) => `<span class="dw-rk">${k}</span><span class="dw-rv ${cls || ''}">${v}</span>`)
      .join('')}</div>`;
    if (d.willMissing > 0) {
      const items = d.missingList
        .slice(0, 10)
        .map((m) => `<li>${escapeHtml(m.title || m.filename || m.id)}</li>`)
        .join('');
      html += `<details class="dw-missing"><summary>将缺失的论文（前 ${Math.min(10, d.missingList.length)} 篇）</summary><ul>${items}</ul></details>`;
      html += `<p class="dw-note">缺失只是标记，数据（总结/批注/笔记）都还在；选「移动文件」可把旧目录里仍存在的文件一并搬过去。</p>`;
    }
    $('dw-report').innerHTML = html;
    $('dw-report').dataset.newDir = newDir;
    dwShow('dw-step-report');
  } catch (e) {
    dwError('dw-input-error', e.message || '预检失败');
  } finally {
    btn.disabled = false;
  }
}

/** 步骤 2 → 3：执行 move / rebind，渲染结果。执行期间后端会暂停扫描并在完成后补扫一轮。 */
async function dwApply() {
  const s = dirWizardSpace;
  const newDir = $('dw-report').dataset.newDir;
  const mode = document.querySelector('input[name="dw-mode"]:checked').value;
  const btn = $('dw-apply-btn');
  btn.disabled = true;
  btn.textContent = '执行中…';
  dwError('dw-report-error', '');
  try {
    const r = await POST(`/api/spaces/${encodeURIComponent(s.id)}/dir`, { newDir, mode });
    if (!r || !r.ok) { dwError('dw-report-error', (r && r.error) || '执行失败'); return; }
    const d = r.data;
    let html = `<p class="dw-ok">已${mode === 'move' ? '移动文件并' : ''}重新绑定到 <b>${escapeHtml(d.papersDir)}</b></p>`;
    html += `<div class="dw-report-grid">`;
    html += `<span class="dw-rk">当前缺失</span><span class="dw-rv ${d.missing > 0 ? 'warn' : ''}">${d.missing} 篇</span>`;
    if (d.errors && d.errors.length) {
      html += `<span class="dw-rk">搬移失败</span><span class="dw-rv warn">${d.errors.length} 篇</span>`;
    }
    html += `</div>`;
    if (d.errors && d.errors.length) {
      html += `<details class="dw-missing"><summary>失败明细</summary><ul>${d.errors
        .map((e2) => `<li>${escapeHtml(e2.id)}: ${escapeHtml(e2.error)}</li>`)
        .join('')}</ul></details>`;
    }
    html += `<p class="dw-note">已触发一轮扫描收尾；新文件会自动入库处理。</p>`;
    $('dw-result').innerHTML = html;
    dwShow('dw-step-result');
    await loadSpaces();
    renderSpaceAdmin();
    if (state.space === s.id) await refresh();
  } catch (e) {
    dwError('dw-report-error', e.message || '执行失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '执行';
  }
}

function bindDirWizard() {
  $('dw-preview-btn').onclick = dwPreview;
  $('dw-apply-btn').onclick = dwApply;
  $('dw-back').onclick = () => dwShow('dw-step-input');
  $('dw-cancel-1').onclick = closeDirWizard;
  $('dw-cancel-2').onclick = closeDirWizard;
  $('dw-done').onclick = closeDirWizard;
  $('dw-dir-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dwPreview(); }
  });
  $('dir-wizard').onclick = (e) => { if (e.target === $('dir-wizard')) closeDirWizard(); };
}

/** 折叠新建表单（回到「+ 新建空间」按钮态）。 */
export function resetSpaceCreateForm() {
  $('space-create-form').hidden = true;
  $('space-create-toggle').hidden = false;
  $('space-create-name').value = '';
  $('space-create-dir').value = '';
}

/** 新建空间（内联表单替代原双 prompt()）：名称 + 可选文件夹 → 创建 → 刷新列表。 */
async function createSpaceInline() {
  const name = $('space-create-name').value.trim();
  const dir = $('space-create-dir').value.trim();
  if (!name) { toast('空间名不能为空', 'error'); return; }
  const submitBtn = $('space-create-submit');
  submitBtn.disabled = true;
  try {
    const body = { name };
    if (dir) body.papersDir = dir;
    const r = await POST('/api/spaces', body);
    if (r && r.ok) {
      toast('已创建空间：' + name, 'success');
      await loadSpaces();
      resetSpaceCreateForm();
      renderSpaceAdmin();
    } else {
      toast((r && r.error) || '创建失败', 'error');
    }
  } catch (e) { toast(e.message || '创建失败', 'error'); }
  submitBtn.disabled = false;
}

/** 展开新建表单（点「+ 新建空间」按钮 → 显出名称/文件夹输入框）。 */
function openSpaceCreateForm() {
  $('space-create-toggle').hidden = true;
  $('space-create-form').hidden = false;
  // 预填默认文件夹名（留空也可，后端会自动生成）
  $('space-create-dir').value = '';
  setTimeout(() => $('space-create-name').focus(), 20);
}

function bindSpaceSwitcher() {
  // 启动即回显上次空间名（loadSpaces 网络返回前），避免刷新时闪硬编码占位
  $('space-name').textContent = localStorage.getItem('pw-space-name') || '空间';
  $('space-current').onclick = (e) => { e.stopPropagation(); toggleSpaceMenu(); };
  // 下拉菜单里的「+ 新建空间」：打开管理弹窗并聚焦新建表单
  $('space-new').onclick = () => { closeSpaceMenu(); openSpaceModal(); openSpaceCreateForm(); };
  $('space-manage').onclick = () => { openSpaceModal(); };
  $('space-modal-done').onclick = closeSpaceModal;
  // 新建表单交互
  $('space-create-toggle').onclick = openSpaceCreateForm;
  $('space-create-submit').onclick = createSpaceInline;
  const createName = $('space-create-name');
  const createDir = $('space-create-dir');
  const onCreateKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); createSpaceInline(); } };
  createName.addEventListener('keydown', onCreateKey);
  createDir.addEventListener('keydown', onCreateKey);
  // 点外部关下拉
  document.addEventListener('click', (e) => {
    if (!$('space-switcher').contains(e.target)) closeSpaceMenu();
  });
  // 点遮罩关模态
  $('space-modal').onclick = (e) => { if (e.target === $('space-modal')) closeSpaceModal(); };
}

bindSpaceSwitcher();

bindDirWizard();
