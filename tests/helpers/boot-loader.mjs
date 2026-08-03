// ESM resolve 钩子：把 `?boot=N` 沿依赖图向下传播 + 把 web 绝对路径（/vendor/*）
// 重定向到空 stub，让依赖 pdfjs 的 reader.js 能在 jsdom 测试里被加载而不崩。
//
// 背景：ESM 按 URL 缓存。tests/helpers/ui.js 给 app.js 加了 `?boot=N` 让同一进程里
// 多次 bootUi 各拿一份新实例，但 app.js 内部 `import './js/core/state.js'` 的子模块 URL
// 不带 query，于是 37 个模块在所有 boot 之间共享——模块级 state / DOM 句柄串味，
// 表现为「第二个 bootUi 起不来」。
//
// 这里让子模块继承父模块的 boot 号：public/ 下的每个模块在每次 boot 都是独立实例。
// 只作用于 public/ 下、且父模块已带 boot 号的解析，其余原样放行。
//
// v3.16：reader-host.js 改为静态 import reader.js（退役 window.PaperReader 桥），
// 而 reader.js 顶部 `import '/vendor/pdfjs.js'` 是 web 绝对路径（server.js VENDOR_MAP
// 动态映射到 node_modules），Node ESM 解析器把 `/vendor/...` 当文件系统根路径找不到。
// reader.js 在 jsdom 里不真正渲染 PDF（无 pdfjsLib/pdfjsViewer），把 /vendor/* 重定向到
// 一个空 data: stub 即可让模块图加载通过。

const EMPTY_MODULE = 'data:text/javascript,export{};';

export async function resolve(specifier, context, nextResolve) {
  // /vendor/* 绝对路径（reader.js 的 pdfjs 副作用 import）：测试里映射到空 stub。
  // reader.js 取 pdfjsLib/pdfjsViewer 是 globalThis 读取（测试里为 undefined），不依赖 import 绑定。
  if (typeof specifier === 'string' && specifier.startsWith('/vendor/')) {
    return { url: EMPTY_MODULE, shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  const m = /[?&]boot=(\d+)/.exec(context.parentURL || '');
  if (!m) return resolved;
  const url = resolved.url || '';
  if (!url.startsWith('file:') || !url.includes('/public/') || /[?&]boot=/.test(url)) return resolved;
  return { ...resolved, url: url + (url.includes('?') ? '&' : '?') + 'boot=' + m[1] };
}
