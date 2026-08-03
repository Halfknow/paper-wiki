// DOM 取元素快捷方式
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

export const $ = (id) => document.getElementById(id);

// 主题调色板（v3.16 单一真相源迁到此；原 reader.js 经 window.READER_PALETTE 注入，
// 时序靠「赌 reader 先加载」不可靠。现 reader.js 反向 import 此常量）。
export const PALETTE = ['#4f46e5', '#7c3aed', '#0891b2', '#d97706', '#db2777', '#2563eb', '#16a34a', '#475569'];
