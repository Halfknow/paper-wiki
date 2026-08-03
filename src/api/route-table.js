'use strict';

// 声明式 HTTP 路由表。替代 createApiRouter 里原先约 1800 行的
// `if (pathname === X && method === Y) { ... }` 长链。
//
// 设计取舍（迁移保真优先）：
//  - 参数段字符集固定 [\w.-]+，与被替换的旧正则 /^\/api\/papers\/([\w.-]+)$/ 逐字一致。
//    因此「今天能匹配的仍匹配、今天 404 的仍 404」——如 %XX 编码 / 空格路径继续不匹配。
//  - 不做 decodeURIComponent（旧实现直接把 url.pathname 喂给正则），保持一致。
//  - 静态段优先于参数段，与旧 if 链「/api/concepts/map 写在 /api/concepts/:name 之前」同义，
//    且不依赖注册顺序，后续新增路由不会因为写错位置而被参数路由吃掉。
//  - 重复注册同 (method, pattern) 直接抛错：迁移期最容易犯的错就是漏改一处导致静默覆盖。

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PARAM_RE = /^[\w.-]+$/;

/** 把 '/api/papers/:id/formulas/merge' 编译为段数组。 */
function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
    throw new Error(`路由 pattern 必须以 / 开头：${pattern}`);
  }
  const segs = pattern.split('/').slice(1);
  return segs.map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
}

/** 单条路由与实际 pathname 段的匹配；命中返回 params，否则 null。 */
function matchSegs(segs, parts) {
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const p = parts[i];
    if (s.literal !== undefined) {
      if (s.literal !== p) return null;
    } else {
      if (!PARAM_RE.test(p)) return null; // 与旧正则 [\w.-]+ 一致（空段 / 编码字符不匹配）
      params[s.param] = p;
    }
  }
  return params;
}

function createRouteTable() {
  /** @type {Array<{method:string,pattern:string,segs:Array,handler:Function,opts:Object,staticCount:number}>} */
  const routes = [];
  const seen = new Set();

  function add(method, pattern, handler, opts = {}) {
    const key = `${method} ${pattern}`;
    if (seen.has(key)) throw new Error(`路由重复注册：${key}`);
    seen.add(key);
    const segs = compile(pattern);
    routes.push({
      method,
      pattern,
      segs,
      handler,
      opts,
      staticCount: segs.filter((s) => s.literal !== undefined).length,
    });
    return api;
  }

  const api = {
    add,
    all(pattern, handler, opts) {
      for (const m of METHODS) add(m, pattern, handler, opts);
      return api;
    },
    /** 匹配。静态段更多者优先（/api/concepts/map 胜过 /api/concepts/:name）；
     *  同等具体度按注册顺序。未命中返回 null。 */
    match(method, pathname) {
      if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
      const parts = pathname.split('/').slice(1);
      let best = null;
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = matchSegs(r.segs, parts);
        if (!params) continue;
        if (!best || r.staticCount > best.route.staticCount) best = { route: r, params };
      }
      return best ? { handler: best.route.handler, params: best.params, opts: best.route.opts } : null;
    },
    /** 只读枚举（启动期自检 / 测试用）。 */
    routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern, opts: r.opts })),
  };

  for (const m of METHODS) {
    const name = m === 'DELETE' ? 'delete' : m.toLowerCase();
    api[name] = (pattern, handler, opts) => add(m, pattern, handler, opts);
  }

  return api;
}

module.exports = { createRouteTable, METHODS };
