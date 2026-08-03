// 前端路由器（v3.15）。此前整个前端没有任何 URL 路由——视图切换靠 showView() 改 display:none，
// 刷新永远回库视图，无法深链/分享/前进后退。这里引入 History API 干净 URL：
//
//   /library                 库视图（筛选状态在 query）
//   /paper/:id[/:tab]        库视图 + 选中论文，tab ∈ summary|notes|chat|info
//   /reader/:id              阅读器全屏
//   /concepts                概念清单
//   /concepts/maps[/:id]     概念地图制品
//   /formulas                公式清单
//   /settings/:tab           设置中心
//
// 服务端配套 SPA fallback（src/server.js isAppRoute），保证刷新深链不 404。
//
// 本文件上半部分是**纯函数**（matchRoute / buildPath / parseQuery / stringifyQuery /
// normalizePath），不碰 DOM，由 tests/frontend-router.test.js 直接单测；
// 下半部分 createRouter 才有状态（popstate、链接拦截、视图切换）。

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

/** 归一化 pathname：补前导斜杠、去尾斜杠（根路径除外）。 */
export function normalizePath(pathname) {
  let p = String(pathname || '');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** 把 '/paper/:id/:tab' 切成段描述数组。 */
function compile(pattern) {
  return normalizePath(pattern)
    .split('/')
    .slice(1)
    .map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
}

/** 单条路由与实际路径段的匹配；命中返回 params，否则 null。 */
function matchSegs(segs, parts) {
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const raw = parts[i];
    if (s.literal !== undefined) {
      if (s.literal !== raw) return null;
    } else {
      if (!raw) return null; // 空段不匹配（/paper//x）
      try {
        params[s.param] = decodeURIComponent(raw);
      } catch {
        params[s.param] = raw; // 非法编码保持原样，别让整条路由挂掉
      }
    }
  }
  return params;
}

/** 在 routes 里找匹配 pathname 的一条。静态段更多者优先，不依赖数组顺序。
 *  @returns {{route: object, params: object}|null} */
export function matchRoute(routes, pathname) {
  if (typeof pathname !== 'string' || !pathname) return null;
  const parts = normalizePath(pathname).split('/').slice(1);
  let best = null;
  let bestScore = -1;
  for (const route of routes) {
    const segs = route._segs || (route._segs = compile(route.pattern));
    const params = matchSegs(segs, parts);
    if (!params) continue;
    const score = segs.filter((s) => s.literal !== undefined).length;
    if (score > bestScore) {
      best = { route, params };
      bestScore = score;
    }
  }
  return best;
}

/** '/paper/:id' + {id:'abc'} → '/paper/abc'（值做 URL 编码）。缺参抛错。 */
export function buildPath(pattern, params = {}) {
  return normalizePath(pattern)
    .split('/')
    .slice(1)
    .map((s) => {
      if (!s.startsWith(':')) return s;
      const k = s.slice(1);
      const v = params[k];
      if (v === undefined || v === null || v === '') throw new Error(`缺少路由参数 :${k}（pattern=${pattern}）`);
      return encodeURIComponent(v);
    })
    .reduce((acc, s) => acc + '/' + s, '');
}

/** '?q=x&sort=y' → { q:'x', sort:'y' }。 */
export function parseQuery(search) {
  const s = String(search || '').replace(/^\?/, '');
  const out = {};
  if (!s) return out;
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    const dec = (x) => {
      try {
        return decodeURIComponent(x.replace(/\+/g, ' '));
      } catch {
        return x;
      }
    };
    out[dec(k)] = dec(v);
  }
  return out;
}

/** { q:'x', sort:'addedDesc' } → '?q=x'（等于 defaults 的键省略，键按字母序）。
 *  数组用逗号连接，布尔 true 写作 1、false 省略——URL 只承载「偏离默认」的部分，
 *  同一筛选状态永远得到同一个 URL，利于收藏与比对。 */
export function stringifyQuery(obj, defaults = {}) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.length ? v.join(',') : '';
    if (typeof v === 'boolean') return v ? '1' : '';
    return v === undefined || v === null ? '' : String(v);
  };
  const parts = [];
  for (const k of Object.keys(obj || {}).sort()) {
    const v = norm(obj[k]);
    if (!v) continue;
    if (k in defaults && v === norm(defaults[k])) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// ---------------------------------------------------------------------------
// 有状态层
// ---------------------------------------------------------------------------

/** 创建路由器。
 *  @param routes      [{ name, pattern, enter(ctx), leave? }]
 *  @param fallback    未匹配时重定向到的路径（默认 '/library'）
 *  @param keepParams  跨导航自动携带的 query 键（如 'space'——空间是全局作用域）
 *  @param onError     enter 抛错时的回调
 */
export function createRouter({ routes, fallback = '/library', keepParams = [], onError } = {}) {
  let current = null; // { name, path, params, query, route }
  let started = false;

  const win = () => (typeof window !== 'undefined' ? window : null);

  /** 把 keepParams 里当前 URL 已有、而目标 search 未指定的键补回去。 */
  function carryParams(search) {
    const w = win();
    if (!w || !keepParams.length) return search;
    const cur = parseQuery(w.location.search);
    const next = parseQuery(search);
    let changed = false;
    for (const k of keepParams) {
      if (cur[k] && !(k in next)) {
        next[k] = cur[k];
        changed = true;
      }
    }
    return changed ? stringifyQuery(next) : search;
  }

  /** 解析当前 location 并渲染对应视图。 */
  async function resolve() {
    const w = win();
    if (!w) return;
    const path = normalizePath(w.location.pathname);
    const query = parseQuery(w.location.search);
    const hit = matchRoute(routes, path);
    if (!hit) return navigate(fallback, { replace: true });

    const prev = current;
    if (prev && prev.route.leave && prev.route !== hit.route) {
      try {
        await prev.route.leave({ to: hit });
      } catch (e) {
        if (onError) onError(e);
      }
    }
    current = { name: hit.route.name, path, params: hit.params, query, route: hit.route };
    try {
      await hit.route.enter({ params: hit.params, query, path, from: prev });
    } catch (e) {
      if (onError) onError(e);
      else throw e;
    }
  }

  /** 导航到 path。replace=true 用 replaceState（不产生历史记录）；
   *  force=true 时同址也重跑 enter（顶部「概念/公式/设置」按钮语义是「进入并刷新该区」）。 */
  function navigate(path, { replace = false, query, keepQuery = false, force = false } = {}) {
    const w = win();
    if (!w) return;
    let search = '';
    if (query !== undefined) search = typeof query === 'string' ? query : stringifyQuery(query);
    else if (keepQuery) search = w.location.search;
    search = carryParams(search);
    const url = normalizePath(path) + search;
    if (!force && url === w.location.pathname + w.location.search && current) return; // 同址不重复渲染
    w.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    return resolve();
  }

  /** 只改 query 不换视图（库视图筛选变化用）。patch 为 null 表示整体替换。 */
  function setQuery(patch, { replace = true, defaults = {} } = {}) {
    const w = win();
    if (!w) return;
    const next = { ...parseQuery(w.location.search), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k];
    const url = normalizePath(w.location.pathname) + carryParams(stringifyQuery(next, defaults));
    if (url === w.location.pathname + w.location.search) return;
    w.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    if (current) current.query = parseQuery(w.location.search);
  }

  /** 启动：绑定 popstate + 拦截站内链接点击，然后解析首个 URL。 */
  function start() {
    const w = win();
    if (!w || started) return;
    started = true;
    w.addEventListener('popstate', () => {
      resolve();
    });
    // 站内链接（<a href="/xxx"> 且非 target=_blank / 非下载 / 非修饰键）走路由，不整页刷新
    w.document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('/') || href.startsWith('//')) return;
      if (a.target || a.hasAttribute('download') || a.dataset.noRoute !== undefined) return;
      const [p, s] = href.split('?');
      if (!matchRoute(routes, p)) return; // 不是前端路由（如 /api/concepts.md 下载链接）→ 交给浏览器
      e.preventDefault();
      navigate(p, { query: s ? '?' + s : '' });
    });
    return resolve();
  }

  return {
    start,
    navigate,
    setQuery,
    resolve,
    current: () => current,
    routes: () => routes,
  };
}
