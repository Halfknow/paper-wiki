// 库/概念/公式/设置 视图显隐
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { $ } from '../core/dom.js';

// ---- 视图切换：library / concepts / settings ----
export function showView(name) {
  $('library-view').style.display = (name === 'library') ? '' : 'none';
  $('concepts-view').style.display = (name === 'concepts') ? '' : 'none';
  $('formulas-view').style.display = (name === 'formulas') ? '' : 'none';
  $('settings-view').style.display = (name === 'settings') ? '' : 'none';
  document.body.dataset.view = name;
  $('btn-concepts').classList.toggle('active', name === 'concepts');
  $('btn-formulas').classList.toggle('active', name === 'formulas');
}
