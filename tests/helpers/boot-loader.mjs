// ESM resolve 钩子：把 `?boot=N` 沿依赖图向下传播。
//
// 背景：ESM 按 URL 缓存模块。tests/helpers/ui.js 给 app.js 加了 `?boot=N` 让同一进程里
// 多次 bootUi 各拿一份新实例，但 app.js 内部 `import './js/core/state.js'` 的子模块 URL
// 不带 query，于是 37 个模块在所有 boot 之间共享——模块级 state / DOM 句柄串味，
// 表现为「第二个 bootUi 起不来」。
//
// 这里让子模块继承父模块的 boot 号：public/ 下的每个模块在每次 boot 都是独立实例。
// 只作用于 public/ 下、且父模块已带 boot 号的解析，其余原样放行。

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const m = /[?&]boot=(\d+)/.exec(context.parentURL || '');
  if (!m) return resolved;
  const url = resolved.url || '';
  if (!url.startsWith('file:') || !url.includes('/public/') || /[?&]boot=/.test(url)) return resolved;
  return { ...resolved, url: url + (url.includes('?') ? '&' : '?') + 'boot=' + m[1] };
}
