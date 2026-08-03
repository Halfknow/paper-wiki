'use strict';

// 慢速测试文件守卫：本地快速迭代时（npm test）整文件跳过；
// 手动全量（npm run test:full，即 PW_FULL_TESTS=1）时才执行。
//
// 背景：jsdom UI 测试在 Docker Desktop bind mount 上仅 require('jsdom') 就要 ~20s
// （gRPC-FUSE 小文件读放大），6 个 UI 文件 + scanner（pdfjs 重依赖）单文件均 >5s。
// CI（原生 Linux fs）不受影响，故 CI 固定 PW_FULL_TESTS=1 全量跑。
//
// 用法（必须在重型 require(jsdom/helpers/ui/pdfjs) 之前调用）：
//   const { guardSlowFile } = require('./helpers/slow');
//   if (guardSlowFile('chat-ui')) return;

const test = require('node:test');

/** 返回 true 表示本文件应整文件跳过（已登记一条 skip 占位，调用方直接 return）。 */
function guardSlowFile(name) {
  if (process.env.PW_FULL_TESTS === '1') return false;
  test.skip(`${name}: 慢速测试（本地 >5s），npm run test:full 时运行`, () => {});
  return true;
}

module.exports = { guardSlowFile };
