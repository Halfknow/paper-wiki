#!/usr/bin/env node
'use strict';

// 全量单测（含 >5s 慢速用例：jsdom UI / scanner）。
// 默认 npm test 跳过慢速文件（tests/helpers/slow.js 守卫）；本脚本置 PW_FULL_TESTS=1 放行。
// 用法：npm run test:full [-- 额外 node --test 参数，如 --test-name-pattern=聊天]

process.env.PW_FULL_TESTS = '1';

const { spawnSync } = require('node:child_process');

// 剥离 npm 可能传入的 `--`
const args = process.argv.slice(2).filter((a) => a !== '--');
const r = spawnSync(process.execPath, ['--test', ...args], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
