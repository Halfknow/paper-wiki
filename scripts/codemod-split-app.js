'use strict';
// ============================================================================
// 一次性 codemod：把 public/app.js（7070 行）按领域拆成 public/js/**/*.js（v3.15）
// ============================================================================
//
// ⚠️ 已执行完毕（对应提交 a434a83），**不要再跑**——它会读当前 46 行的入口 app.js，
//    按下面的行区间清单去切，结果是一堆空模块。保留在仓库里只为「重构可审计」：
//    7000 行代码是怎么被搬过去的、边界怎么定的、import 图怎么推导的，都在这里。
//    如需复现，先 `git checkout ba7ce9f -- public/app.js` 拿回拆分前的版本。
//
// 为什么用脚本而不是手搬：312 个顶层声明、258 条 import 边。手写 import/export 必然
// 漏项且无法自证；脚本让「声明体一个字符都不重打」成为可验证的事实——迁移只做四件事：
//   1. 按行区间把每条顶层声明分配到目标模块
//   2. 扫描每个模块引用到的、由别的模块拥有的顶层名 → 生成 import
//   3. 被别的模块引用的名 → 在声明前加 export
//   4. 跨模块的可变绑定（ESM import 只读）→ 宿主导出 set_xxx()，消费侧赋值包成 setter 调用
//
// 正确性由外部把关，不靠脚本自证：ESLint 的 no-undef / no-import-assign 抓漏掉的 import
// 与非法赋值；650 例测试（含 8 个 jsdom UI 文件零改动）抓行为回归。
// 迭代中脚本本身暴露过 4 个会「静默产生错误代码」的坑，均已修正，见下方各处注释。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'app.js');
const OUT = path.join(ROOT, 'public', 'js');

if (process.argv[2] !== '--i-know-this-is-one-shot') {
  console.error('这是一次性 codemod，已执行完毕。确要重跑请先恢复拆分前的 app.js，再加 --i-know-this-is-one-shot');
  process.exit(1);
}

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split('\n');

// ---------------------------------------------------------------------------
// 1. 词法扫描：括号配对 + 注释定位
// ---------------------------------------------------------------------------
// 手写扫描器而不是正则：要跳过字符串 / 模板串（含 ${} 嵌套）/ 行注释 / 块注释 / 正则字面量，
// 否则这些里面的括号会把深度带偏，语句边界全错。

const commentAt = new Set(); // 代码区 `//` 的起始下标（字符串/模板内的不算）

function scanDepth(s) {
  const depthAt = new Array(s.length).fill(0);
  let depth = 0,
    i = 0,
    prev = '';
  while (i < s.length) {
    const c = s[i],
      c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      commentAt.add(i);
      while (i < s.length && s[i] !== '\n') depthAt[i++] = depth;
      continue;
    }
    if (c === '/' && c2 === '*') {
      depthAt[i++] = depth;
      depthAt[i++] = depth;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) depthAt[i++] = depth;
      depthAt[i++] = depth;
      depthAt[i++] = depth;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      depthAt[i++] = depth;
      while (i < s.length) {
        if (s[i] === '\\') {
          depthAt[i++] = depth;
          depthAt[i++] = depth;
          continue;
        }
        if (s[i] === q) {
          depthAt[i++] = depth;
          break;
        }
        depthAt[i++] = depth;
      }
      prev = q;
      continue;
    }
    if (c === '`') {
      depthAt[i++] = depth;
      let t = 0; // 模板串里的 ${} 嵌套层数
      while (i < s.length) {
        if (s[i] === '\\') {
          depthAt[i++] = depth;
          depthAt[i++] = depth;
          continue;
        }
        if (s[i] === '$' && s[i + 1] === '{') {
          t++;
          depthAt[i++] = depth;
          depthAt[i++] = depth;
          continue;
        }
        if (s[i] === '}' && t > 0) {
          t--;
          depthAt[i++] = depth;
          continue;
        }
        if (s[i] === '`' && t === 0) {
          depthAt[i++] = depth;
          break;
        }
        depthAt[i++] = depth;
      }
      prev = '`';
      continue;
    }
    // 正则字面量：前一个有意义字符是运算符/开括号时，`/` 起的是正则而非除法
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]/.test(prev)) {
      depthAt[i++] = depth;
      let cls = false; // 是否在 [...] 字符类里（类内的 / 不是结束符）
      while (i < s.length) {
        if (s[i] === '\\') {
          depthAt[i++] = depth;
          depthAt[i++] = depth;
          continue;
        }
        if (s[i] === '[') cls = true;
        else if (s[i] === ']') cls = false;
        else if (s[i] === '/' && !cls) {
          depthAt[i++] = depth;
          break;
        }
        depthAt[i++] = depth;
      }
      prev = '/';
      continue;
    }
    // 坑 ①：只数 {} 不够。`const A = [ {..}, {..} ];` 的中间行会以 `,` 结尾且花括号深度为 0，
    // 被误判成语句结束，数组被腰斩。三种括号统一计数才对。
    if (c === '{' || c === '[' || c === '(') {
      depthAt[i] = depth;
      depth++;
      i++;
      prev = c;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      depthAt[i] = depth;
      i++;
      prev = c;
      continue;
    }
    depthAt[i] = depth;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return depthAt;
}

const depthAt = scanDepth(text);

// 坑 ②：不能用「行首字符的 depthAt」判断该行是否在顶层——扫描器对 `}` 记录的是**递减后**的值，
// 于是 `};` 这种收尾行看起来 depth=0，会被当成新的顶层语句（表现为一条声明被拆成 4-7 / 8-8 两截）。
// 改用「处理完整行之后」的深度。
const endDepth = new Array(lines.length + 2).fill(0);
{
  let d = 0,
    idx = 0;
  for (let k = 1; k <= lines.length; k++) {
    const len = lines[k - 1].length;
    for (let j = 0; j < len; j++) {
      const c = text[idx + j];
      if ((c === '{' || c === '[' || c === '(') && depthAt[idx + j] === d) d++;
      else if ((c === '}' || c === ']' || c === ')') && depthAt[idx + j] === d - 1) d--;
    }
    endDepth[k] = d;
    idx += len + 1;
  }
}
const startDepth = (ln) => endDepth[ln - 1] ?? 0;

// 坑 ③：行尾带注释的语句判不出结束。`const CODE_COLLAPSE_LINES = 20; // 说明` 不以 `;` 结尾，
// 于是它后面的几十行被吞进同一条声明，renderChatMd 等就丢了 owner，
// 结果是「引用它的模块没有 import、宿主模块也没 export」——ESLint 才把这个抓出来。
const lineStartIdx = [0];
for (let k = 0; k < lines.length; k++) lineStartIdx.push(lineStartIdx[k] + lines[k].length + 1);
function codeOf(ln) {
  const base = lineStartIdx[ln - 1];
  const raw = lines[ln - 1];
  for (let j = 0; j < raw.length - 1; j++) if (commentAt.has(base + j)) return raw.slice(0, j).trimEnd();
  return raw.trimEnd();
}

// ---------------------------------------------------------------------------
// 2. 顶层语句切分（每条声明连带它正上方的注释块一起搬）
// ---------------------------------------------------------------------------
const stmts = [];
{
  let ln = 1;
  let pendingComment = null;
  while (ln <= lines.length) {
    const raw = lines[ln - 1];
    if (startDepth(ln) !== 0) {
      ln++;
      continue;
    }
    if (/^\/\//.test(raw) || /^\/\*/.test(raw)) {
      if (pendingComment === null) pendingComment = ln;
      ln++;
      continue;
    }
    if (!raw.trim()) {
      pendingComment = null; // 空行断开注释与声明的归属
      ln++;
      continue;
    }
    if (/^\s/.test(raw)) {
      ln++;
      continue;
    }
    let end = ln;
    for (let k = ln; k <= lines.length; k++) {
      const t = codeOf(k);
      if (
        endDepth[k] === 0 &&
        t &&
        (t.endsWith('}') || t.endsWith(';') || t.endsWith(')') || t.endsWith(',') || t.endsWith(']'))
      ) {
        end = k;
        break;
      }
      end = k;
    }
    const head = raw.trim();
    const m =
      /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(head) ||
      /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(head) ||
      /^class\s+([A-Za-z_$][\w$]*)/.exec(head);
    stmts.push({ start: pendingComment !== null ? pendingComment : ln, declStart: ln, end, name: m ? m[1] : null, head });
    pendingComment = null;
    ln = end + 1;
  }
}

// ---------------------------------------------------------------------------
// 3. 模块清单：按声明所在行区间归属
// ---------------------------------------------------------------------------
// 行号对应**拆分前**的 public/app.js（提交 ba7ce9f）。区间取自该文件原有的分节结构
// （那些 `// ---- 详情 ----` 注释），上界 = 下一节起始行 - 1。
// 用「行区间」而不是「逐个点名 312 个声明」，是因为原文件本来就是按领域连续排布的。
const MODULES = [
  { file: 'core/api.js',           from: 4,    to: 45,   desc: 'HTTP 客户端与空间上下文注入（sp/jget/POST/PUT/PATCH/DEL/safeGet）' },
  { file: 'core/state.js',         from: 46,   to: 87,   desc: '全局单例状态与笔记/聊天状态句柄' },
  { file: 'core/dom.js',           from: 88,   to: 92,   desc: 'DOM 取元素快捷方式' },
  { file: 'core/format.js',        from: 93,   to: 151,  desc: '标签配色 / 状态点 / 星级 / HTML 转义' },
  { file: 'core/markdown.js',      from: 152,  to: 230,  desc: 'Markdown 渲染（含中日韩粗体修正与聊天代码块折叠）' },
  { file: 'core/stream.js',        from: 231,  to: 279,  desc: '聊天 SSE 流式请求' },
  { file: 'core/ui-kit.js',        from: 280,  to: 381,  desc: 'toast / 忙碌态 / 文案映射 / chip 列表 / 统计条' },
  { file: 'library/refresh.js',    from: 382,  to: 465,  desc: '列表数据刷新（接口级降级）' },
  { file: 'library/sidebar.js',    from: 466,  to: 568,  desc: '侧栏（收藏夹拖放 / 视图切换）' },
  { file: 'library/list.js',       from: 569,  to: 744,  desc: '论文列表与全文检索结果渲染' },
  { file: 'library/filters.js',    from: 745,  to: 969,  desc: '状态/标签/主题筛选与浮层' },
  { file: 'detail/detail.js',      from: 970,  to: 1220, desc: '详情面板（选中 / 渲染 / tab 头）' },
  { file: 'detail/notes-panel.js', from: 1221, to: 1497, desc: 'AI 笔记卡片面板' },
  { file: 'detail/tab-body.js',    from: 1498, to: 1528, desc: 'tab 内容分派' },
  { file: 'detail/chat-view.js',   from: 1529, to: 2111, desc: '聊天消息渲染 / 预置 / 模型选择 / @ 提及' },
  { file: 'detail/chat-tab.js',    from: 2112, to: 2734, desc: '聊天 tab 主体（composer / 大纲 / 重新生成）' },
  { file: 'detail/info-tab.js',    from: 2735, to: 2874, desc: '信息 tab 与字段 patch' },
  { file: 'detail/reader-host.js', from: 2875, to: 2917, desc: '阅读器接入与批注同步' },
  { file: 'views/view-switch.js',  from: 2918, to: 2928, desc: '库/概念/公式/设置 视图显隐' },
  { file: 'concepts/concepts.js',  from: 2929, to: 3248, desc: '概念清单与概念地图制品' },
  { file: 'formulas/formulas.js',  from: 3249, to: 3648, desc: '公式清单（KaTeX / 瀑布流 / 懒加载）' },
  { file: 'library/bulk.js',       from: 3649, to: 3704, desc: '多选与批量操作' },
  { file: 'library/folders.js',    from: 3705, to: 3745, desc: '收藏夹模态与首页' },
  { file: 'settings/settings.js',  from: 3746, to: 4111, desc: '设置中心骨架 / 概览 / 系统信息 / AI 配置' },
  { file: 'settings/channels.js',  from: 4112, to: 4542, desc: 'AI 渠道卡片管理与模型选择器' },
  { file: 'settings/prompts.js',   from: 4543, to: 4632, desc: '各提示词保存' },
  { file: 'settings/collect.js',   from: 4633, to: 4857, desc: '采集设置（扫描/arXiv/发现/翻译/公式引擎/重置）' },
  { file: 'settings/taxonomy.js',  from: 4858, to: 5214, desc: '主题与标签管理' },
  { file: 'views/layout.js',       from: 5215, to: 5278, desc: '系统健康刷新 / 侧栏收起 / 列表宽度分隔条' },
  { file: 'bind.js',               from: 5279, to: 6059, desc: '全局事件接线' },
  { file: 'spaces/spaces.js',      from: 6060, to: 6261, desc: '空间切换与管理模态' },
  { file: 'spaces/dir-wizard.js',  from: 6262, to: 6455, desc: 'papersDir 改绑向导' },
  { file: 'search/advanced.js',    from: 6456, to: 6699, desc: '高级搜索面板（DSL 双向同步）' },
  { file: 'search/suggest.js',     from: 6700, to: 6810, desc: '搜索框内联补全' },
  { file: 'search/help.js',        from: 6811, to: 6860, desc: '搜索语法帮助浮层' },
  { file: 'search/saved.js',       from: 6861, to: 6960, desc: '保存的搜索' },
  { file: 'core/nav.js',           from: 6961, to: 7046, desc: '路由实例与导航助手（视图 enter/leave 处理器、URL ↔ 筛选同步）' },
  // 7047 起是 boot 序列，留在入口 app.js
];

const ENTRY_FROM = 7047;

// ---------------------------------------------------------------------------
// 4. 归属：name -> 模块文件
// ---------------------------------------------------------------------------
const owner = new Map();
const buckets = new Map(MODULES.map((m) => [m.file, []]));
const entryStmts = [];
for (const s of stmts) {
  if (s.declStart >= ENTRY_FROM || s.declStart <= 2) {
    entryStmts.push(s); // <=2 是原有的两条 import
    continue;
  }
  const m = MODULES.find((x) => s.declStart >= x.from && s.declStart <= x.to);
  if (!m) {
    entryStmts.push(s);
    continue;
  }
  buckets.get(m.file).push(s);
  if (s.name) owner.set(s.name, m.file);
}

const srcOf = (s) => lines.slice(s.start - 1, s.end).join('\n');

// 已存在、不由本次拆分产生的模块（Phase 4 就写好的路由层），它们的导出也要参与 import 推导
const EXTERNAL = {
  'core/routes.js': ['createAppRouter', 'filterToQuery', 'queryToFilter', 'LIB_QUERY_DEFAULTS', 'PAPER_TABS', 'SETTINGS_TABS'],
  'core/router.js': ['buildPath', 'matchRoute', 'parseQuery', 'stringifyQuery', 'normalizePath', 'createRouter'],
};
const EXTERNAL_NAMES = new Set();
for (const [f, names] of Object.entries(EXTERNAL))
  for (const n of names) {
    owner.set(n, f);
    EXTERNAL_NAMES.add(n);
  }

// ---------------------------------------------------------------------------
// 5. 自由标识符分析 → import / export
// ---------------------------------------------------------------------------
// 「一个模块用到了别人拥有的名字」= 需要 import；反过来宿主就得 export。
// lookbehind 排除属性访问（`obj.foo` 里的 foo）和字符串内容。
const IDENT_RE = /(?<![.\w$'"`])([A-Za-z_$][\w$]*)/g;

// 坑 ④：注释里提到的函数名会被当成真引用，凭空生成 import。这些假边织出循环依赖，
// 运行期报 TDZ「Cannot access 'state' before initialization」——
// core/state.js 曾因此 import 了 detail.js / notes-panel.js / refresh.js，全来自它头部的说明注释。
// 所以扫描前先把注释内容抹成等长空白（保留偏移，不影响其它逻辑）。
function stripComments(s) {
  const out = s.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < s.length) {
    const c = s[i],
      c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      const st = i;
      while (i < s.length && s[i] !== '\n') i++;
      blank(st, i);
      continue;
    }
    if (c === '/' && c2 === '*') {
      const st = i;
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      blank(st, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

function identsIn(txt) {
  // 展开运算符 `...x` 的最后一个点会被「排除属性访问」的 lookbehind 误伤，
  // 先把 `...` 换成等长空白，这样 `{ ...queryToFilter(q) }` 里的调用也能被识别。
  const scan = stripComments(txt).replace(/\.\.\./g, '   ');
  const out = new Set();
  let m;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(scan))) out.add(m[1]);
  return out;
}

const relPath = (fromFile, toFile) => {
  let r = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!r.startsWith('.')) r = './' + r;
  return r;
};

const exportsOf = new Map(MODULES.map((m) => [m.file, new Set()]));
const importsOf = new Map(MODULES.map((m) => [m.file, new Map()])); // file -> Map(目标文件 -> Set(名字))

function collectImports(file, txt, importMap) {
  for (const id of identsIn(txt)) {
    const own = owner.get(id);
    if (!own || own === file) continue;
    if (!importMap.has(own)) importMap.set(own, new Set());
    importMap.get(own).add(id);
    if (!EXTERNAL_NAMES.has(id)) exportsOf.get(own).add(id); // 外部模块已自带 export
  }
}

// ---------------------------------------------------------------------------
// 6. 跨模块可变绑定 → setter
// ---------------------------------------------------------------------------
// ESM 的 import 是**只读绑定**：模块 A 里 `let x`、模块 B 里 `x = v` 直接报 no-import-assign。
// 处理办法：宿主导出 set_x(v)，把消费模块里的 `x = EXPR;` 整体包成 `set_x(EXPR);`。
// 只改赋值点，读取点原样——保持「声明体不重打」的原则。
// 本次命中 11 个：chatState / notesState / reader / channelsState / editingChannelId /
// chEditModels / chatPresetsOverride / _conceptSort / _conceptLayout / _formulaSort / _formulaLayout

/** 找出 txt 里对 name 的「裸赋值」位置。
 *  必须排除同名局部声明（`const name = ...`）与参数默认值——早期版本没排除，
 *  把函数体内毫不相干的局部变量当成跨模块写入，生成了 `const set_state(...)` 这种语法垃圾。
 *  判据：赋值必须位于语句开头（行首或分号后）。 */
function assignSites(txt, name) {
  const re = new RegExp(`(?<![.\\w$])${name}\\s*=(?!=)`, 'g');
  const sites = [];
  let m;
  while ((m = re.exec(txt))) {
    const before = txt.slice(0, m.index);
    if (!/(^|[\n;])[ \t]*$/.test(before)) continue;
    sites.push({ index: m.index, exprStart: m.index + m[0].length });
  }
  return sites;
}
const hasAssign = (txt, name) => assignSites(txt, name).length > 0;
const setterName = (n) => 'set_' + n.replace(/^_+/, '');

/** 把 `name = EXPR;` 包成 `set_name(EXPR);`。EXPR 可跨行，按括号配平找结尾分号。 */
function wrapAssignments(txt, name) {
  const sites = assignSites(txt, name);
  let out = '';
  let last = 0;
  for (const { index, exprStart } of sites) {
    if (index < last) continue;
    let d = 0;
    let end = -1;
    for (let i = exprStart; i < txt.length; i++) {
      const c = txt[i];
      if (c === '{' || c === '[' || c === '(') d++;
      else if (c === '}' || c === ']' || c === ')') d--;
      else if (c === ';' && d === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue; // 找不到结尾就跳过，交给 lint 兜住
    out += txt.slice(last, index) + setterName(name) + '(' + txt.slice(exprStart, end).trim() + ');';
    last = end + 1;
  }
  return out + txt.slice(last);
}

const moduleText = new Map(MODULES.map((m) => [m.file, buckets.get(m.file).map(srcOf).join('\n\n')]));
/** 名 → 宿主模块（该名在别的模块里被赋值，故宿主需要导出 setter）。 */
const needSetter = new Map();
for (const m of MODULES) {
  const txt = moduleText.get(m.file);
  for (const [name, own] of owner) {
    if (own === m.file || EXTERNAL_NAMES.has(name)) continue;
    if (hasAssign(txt, name)) needSetter.set(name, own);
  }
}

for (const m of MODULES) {
  collectImports(m.file, moduleText.get(m.file), importsOf.get(m.file));
}
// 入口 app.js 也要 import
const entryImports = new Map();
{
  const txt = entryStmts
    .filter((s) => s.declStart > 2)
    .map(srcOf)
    .join('\n\n');
  collectImports('__entry__', txt, entryImports);
  for (const [f, names] of entryImports) for (const n of names) if (exportsOf.has(f)) for (const x of [n]) exportsOf.get(f).add(x);
}

// ---------------------------------------------------------------------------
// 7. 生成
// ---------------------------------------------------------------------------
function importHeader(fromFile, importMap) {
  const out = [];
  for (const [target, names] of [...importMap].sort((a, b) => a[0].localeCompare(b[0]))) {
    const spec = fromFile === '__entry__' ? './js/' + target : relPath(fromFile, target);
    out.push(`import { ${[...names].sort().join(', ')} } from '${spec}';`);
  }
  return out.join('\n');
}

for (const m of MODULES) {
  let body = buckets
    .get(m.file)
    .map((s) => {
      let src = srcOf(s);
      if (s.name && exportsOf.get(m.file).has(s.name)) {
        // export 加在**声明行**前面，不能加在它上方的注释行前
        const rel = s.declStart - s.start;
        const arr = src.split('\n');
        arr[rel] = 'export ' + arr[rel];
        src = arr.join('\n');
      }
      return src;
    })
    .join('\n\n');

  // 消费侧：对「别的模块的可变绑定」的赋值包成 setter 调用
  for (const [name, own] of needSetter) {
    if (own === m.file) continue;
    if (!hasAssign(body, name)) continue;
    body = wrapAssignments(body, name);
    const fn = setterName(name);
    if (!importsOf.get(m.file).has(own)) importsOf.get(m.file).set(own, new Set());
    importsOf.get(m.file).get(own).add(fn);
    exportsOf.get(own).add(fn);
  }

  // 宿主侧：为自己被外部赋值的绑定补 setter
  const mine = [...needSetter].filter(([, f]) => f === m.file);
  if (mine.length) {
    body +=
      '\n\n// 跨模块可变绑定的写入口（ESM import 是只读绑定，外部模块不能直接赋值）。\n' +
      mine.map(([n]) => `export function ${setterName(n)}(v) {\n  ${n} = v;\n}`).join('\n');
  }

  const header = `// ${m.desc}\n//\n// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。\n`;
  const imp = importHeader(m.file, importsOf.get(m.file));
  const file = header + (imp ? '\n' + imp + '\n' : '') + '\n' + body + '\n';
  const abs = path.join(OUT, m.file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file, 'utf8');
}

// 入口 app.js：只留 boot 序列
const entryBody = entryStmts
  .filter((s) => s.declStart > 2)
  .map(srcOf)
  .join('\n\n');
const entryHeader = `// PaperWiki 前端入口（v3.15 模块化重构后）。
//
// 这里只保留三件事：路由接线（视图 enter/leave 处理器）、URL ↔ 筛选同步、启动序列。
// 全部视图逻辑已按领域拆到 public/js/** —— 见 AGENTS.md「前端模块结构」。
`;
const entryFile =
  entryHeader +
  "\nimport { createAppRouter, filterToQuery, queryToFilter, LIB_QUERY_DEFAULTS } from './js/core/routes.js';\n" +
  "import { buildPath } from './js/core/router.js';\n" +
  importHeader('__entry__', entryImports) +
  '\n\n' +
  entryBody +
  '\n';
fs.writeFileSync(SRC, entryFile, 'utf8');

// ---------------------------------------------------------------------------
// 8. 报告
// ---------------------------------------------------------------------------
let total = 0;
for (const m of MODULES) {
  const n = fs.readFileSync(path.join(OUT, m.file), 'utf8').split('\n').length;
  total += n;
  console.log(String(n).padStart(5), m.file);
}
console.log(String(entryFile.split('\n').length).padStart(5), 'app.js (入口)');
console.log('模块数:', MODULES.length, ' 总行数:', total);
const unexported = [...owner.keys()].filter((n) => {
  const e = exportsOf.get(owner.get(n));
  return e && !e.has(n);
});
console.log('模块私有（未被跨模块引用）:', unexported.length);
