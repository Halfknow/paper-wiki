// DOM 取元素快捷方式
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

export const $ = (id) => document.getElementById(id);

export const PALETTE = window.READER_PALETTE || ['#4f46e5', '#7c3aed', '#0891b2', '#d97706', '#db2777', '#2563eb', '#16a34a', '#475569'];
