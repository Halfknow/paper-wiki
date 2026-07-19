'use strict';

// PDF 批注持久化的归一化层。
//
// 根因背景：pdf.js 的 HighlightEditor.serialize() 把高亮区域几何 quadPoints 输出为
// Float32Array；手写(Ink)的坐标点同理。这些 TypedArray 一旦经过 JSON.stringify（无论是
// 浏览器 fetch 发送时，还是服务端 papers.json 落盘时）就会退化成 {"0":x,"1":y,...} 这样的
// "稠密数字键对象"。重载时 pdf.js 的 HighlightEditor.deserialize 用
//   for (let i = 0; i < quadPoints.length; i += 8) { ... }
// 重建高亮，而对象的 .length 为 undefined → 循环一次都不执行 → 高亮 boxes 为空 → 高亮消失。
// （注意：不能用 Array.from(对象) 救援——对象无 length，Array.from 会得到空数组；
//  必须按数字键重建。）
//
// 本模块在服务端的持久化边界做归一化：
//   - 写入(PATCH)时清洗，保证落盘的是真数组；
//   - 读取(detailView)时再修一遍，自愈历史上已被写坏的旧数据，无需手动迁移。

/** 是否为"被 JSON 序列化过的 TypedArray/数组"——键恰为 0..n-1 的稠密数字键对象。 */
function isDenseArrayLike(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  for (let i = 0; i < keys.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(o, String(i))) return false;
  }
  return true;
}

/** 递归修复：TypedArray → 普通数组；稠密数字键对象 → 数组；其余结构保持不变（返回新值，不就地改写）。 */
function repairArrayLike(v) {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return Array.from(v); // Float32Array 等 TypedArray
  }
  if (Array.isArray(v)) return v.map(repairArrayLike);
  if (v && typeof v === 'object') {
    if (isDenseArrayLike(v)) {
      const arr = new Array(Object.keys(v).length);
      for (let i = 0; i < arr.length; i++) arr[i] = repairArrayLike(v[i]);
      return arr;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = repairArrayLike(v[k]);
    return out;
  }
  return v;
}

/** 归一化整个 annotations 持久化对象（{ items: [...], hash?, updatedAt }），修复每条批注里的数组型字段。 */
function normalizeAnnotations(annotations) {
  if (!annotations || typeof annotations !== 'object') return annotations;
  if (!Array.isArray(annotations.items)) return annotations;
  return { ...annotations, items: annotations.items.map(repairArrayLike) };
}

module.exports = { normalizeAnnotations, repairArrayLike, isDenseArrayLike };
