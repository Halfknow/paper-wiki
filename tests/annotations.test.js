const test = require('node:test');
const assert = require('node:assert');
const { normalizeAnnotations, repairArrayLike, isDenseArrayLike } = require('../lib/annotations');

// 复刻 pdf.js HighlightEditor.deserialize 的关键循环：for (i=0;i<quadPoints.length;i+=8)
// 用它来证明"修复前循环 0 次 → 高亮消失"，"修复后循环正常 → 高亮重建"。
function deserializeBoxCount(quadPoints) {
  let n = 0;
  for (let i = 0; i < quadPoints.length; i += 8) n++;
  return n;
}

test('前提复现：Float32Array 经 JSON 往返退化为对象，pdf.js 循环 0 次（高亮消失）', () => {
  const corrupted = JSON.parse(JSON.stringify(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])));
  assert.strictEqual(Array.isArray(corrupted), false);
  assert.strictEqual(corrupted.length, undefined);
  assert.strictEqual(deserializeBoxCount(corrupted), 0); // ← 这就是 bug
});

test('isDenseArrayLike：识别 {0:..,1:..} 稠密数字键对象', () => {
  assert.strictEqual(isDenseArrayLike({ 0: 1, 1: 2, 2: 3 }), true);
  assert.strictEqual(isDenseArrayLike({}), false);
  assert.strictEqual(isDenseArrayLike([1, 2, 3]), false); // 真数组不算
  assert.strictEqual(isDenseArrayLike({ 0: 1, 2: 3 }), false); // 有空洞不算
  assert.strictEqual(isDenseArrayLike({ id: 1 }), false); // 非数字键不算
  assert.strictEqual(isDenseArrayLike(null), false);
});

test('repairArrayLike：把已损坏的对象型 quadPoints 还原为真数组', () => {
  const corrupted = JSON.parse(JSON.stringify(new Float32Array([10, 20, 30, 40, 50, 60, 70, 80])));
  const fixed = repairArrayLike(corrupted);
  assert.ok(Array.isArray(fixed));
  assert.deepStrictEqual(fixed, [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.strictEqual(deserializeBoxCount(fixed), 1); // ← 修复后循环正常
});

test('repairArrayLike：直接把 TypedArray 转普通数组（序列化侧）', () => {
  assert.deepStrictEqual(repairArrayLike(new Float32Array([1, 2, 3])), [1, 2, 3]);
});

test('repairArrayLike：递归修复嵌套（手写 inkLists / 嵌套坐标）', () => {
  const corrupted = JSON.parse(JSON.stringify({ points: [new Float32Array([1, 2]), new Float32Array([3, 4])] }));
  const fixed = repairArrayLike(corrupted);
  assert.deepStrictEqual(fixed, {
    points: [
      [1, 2],
      [3, 4],
    ],
  });
});

test('normalizeAnnotations：修复 highlight item 使 deserialize 循环可执行', () => {
  const stored = {
    items: [
      {
        id: null,
        annotationType: 9,
        color: [187, 247, 208],
        opacity: 1,
        thickness: 12,
        quadPoints: JSON.parse(
          JSON.stringify(
            new Float32Array([
              265.7, 660.4, 329.3, 660.4, 265.7, 649.5, 329.3, 649.5, 236.6, 626.8, 358.2, 626.8, 236.6, 614.3, 358.2,
              614.3,
            ]),
          ),
        ),
        pageIndex: 0,
        rect: [69.6, 524.2, 525.4, 664.1],
      },
    ],
    updatedAt: 123,
  };
  const out = normalizeAnnotations(stored);
  const qp = out.items[0].quadPoints;
  assert.ok(Array.isArray(qp), 'quadPoints 应被还原为数组');
  assert.strictEqual(qp.length, 16);
  assert.strictEqual(deserializeBoxCount(qp), 2, '两段高亮区域应可重建');
  assert.strictEqual(out.updatedAt, 123, '其余字段保持不变');
});

test('normalizeAnnotations：不破坏普通字段、空 items、null', () => {
  assert.deepStrictEqual(normalizeAnnotations({ items: [], updatedAt: 1 }), { items: [], updatedAt: 1 });
  assert.strictEqual(normalizeAnnotations(null), null);
  const item = { id: null, annotationType: 9, color: [1, 2, 3], rect: [0, 0, 1, 1], pageIndex: 0, value: 'note' };
  assert.deepStrictEqual(normalizeAnnotations({ items: [item] }).items[0], item);
});

test('normalizeAnnotations：不修改入参（纯函数）', () => {
  const stored = { items: [{ quadPoints: JSON.parse(JSON.stringify(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]))) }] };
  const before = JSON.stringify(stored);
  normalizeAnnotations(stored);
  assert.strictEqual(JSON.stringify(stored), before, '原对象不应被就地改写');
});
