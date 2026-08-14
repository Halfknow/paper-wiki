'use strict';

// 结构化日志（零外部依赖）。
//
// 此前全项目只有 core/util.js 的 `log()`（裸 console.log + ISO 时间戳）与散落各处的
// `console.error`，无 level、无模块名、无可配开关。这里补一个最小可用的 logger：
//
//   const logger = require('./logger').createLogger('store');
//   logger.info('已保存', { id, rows: 12 });
//   logger.error('写入失败', e);
//
// - level 由 env `PW_LOG_LEVEL` 控制（debug/info/warn/error）；默认 info，生产
//   （NODE_ENV=production）默认 warn 减少噪音，env 显式设置优先级最高。
// - 格式：`ISO LEVEL [module] msg {json extra}`，单行（error 额外附堆栈）。
// - error 走 console.error（stderr 语义，便于日志收集区分流），其余走 console.log。
// - 仅在此模块创建一次 root logger；createLogger(module) 返回绑定模块名的子 logger。
//
// 设计取舍：不引入 winston/pino（单容器单用户场景过重），不内置文件轮转（stdout 交给
// Docker 日志驱动/pm2 收集）。`log()`（util.js）保留以兼容现有 38 处调用，内部委托本模块。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold() {
  const env = (process.env.PW_LOG_LEVEL || '').toLowerCase();
  if (env && LEVELS[env]) return LEVELS[env];
  return process.env.NODE_ENV === 'production' ? LEVELS.warn : LEVELS.info;
}

/** 把任意「附加参数」序列化为单行 JSON 片段：对象展平，原始值用 String。 */
function formatExtra(args) {
  if (!args.length) return '';
  const objs = [];
  const rest = [];
  for (const a of args) {
    if (a && typeof a === 'object') {
      if (a instanceof Error) rest.push(a.stack || a.message || String(a));
      else objs.push(a);
    } else {
      rest.push(String(a));
    }
  }
  let out = '';
  if (rest.length) out += ' ' + rest.join(' ');
  if (objs.length) {
    try {
      out += ' ' + JSON.stringify(objs.length === 1 ? objs[0] : objs);
    } catch {
      out += ' [unserializable]';
    }
  }
  return out;
}

function emit(level, threshold, module, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase()} [${module}] ${msg}${formatExtra(extra)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function createLogger(module) {
  const name = module || 'app';
  // threshold 在调用时读（而非创建时）——测试/运行时改 env 立即生效
  return {
    debug: (msg, ...extra) => emit('debug', resolveThreshold(), name, msg, extra),
    info: (msg, ...extra) => emit('info', resolveThreshold(), name, msg, extra),
    warn: (msg, ...extra) => emit('warn', resolveThreshold(), name, msg, extra),
    error: (msg, ...extra) => emit('error', resolveThreshold(), name, msg, extra),
  };
}

// root logger：供 util.js 的 log() 委托，以及临时无模块名的调用点
const root = createLogger('app');

module.exports = { createLogger, root, LEVELS, _resolveThreshold: resolveThreshold };
