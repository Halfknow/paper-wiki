/**
 * 搜索 DSL 解析器（v3.2 高级搜索）。
 *
 * 语法（GitHub 式字段前缀 + 布尔）：
 *   - 裸词：默认 AND，匹配元数据全局（title/abstract/summary/notes/tags/topics 合并）。
 *           `transformer attention` = 两词都命中（修掉旧单子串只能匹配连续短语的 bug）。
 *   - "exact phrase"：引号包短语，精确（连续）匹配。
 *   - field:value：字段限定。title/abstract/summary/notes/author/tag/topic/year/status/read/starred。
 *   - -field:value / -word：排除（NOT）。
 *   - body:phrase 或 in:body：切到正文全文检索（bodyQuery）。
 *   - AND/OR/NOT 大写关键字：显式布尔（裸词默认 AND，可省略）。
 *   - year 支持：2024 / >=2020 / <=2024 / >2020 / <2024 / 2020-2024。
 *
 * 设计：tokenizer → parser → compile。
 *   - parseSearchQuery(q) → { ast, metadata, bodyQuery }
 *   - applyMetadataQuery(list, parsed) → filteredList（供 api.js /api/papers 复用）
 *   - buildDslFromPanel(panelState) → string（供前端高级面板双向同步）
 *
 * 纯函数、零副作用；前后端共用（前端经 window 桥或直接内联）。
 * 向后兼容：无前缀纯文本 = 现有行为升级（分词 AND）。CJK 裸词不切分（沿用 hasCjk 语义）。
 */

const FIELD_ALIASES = {
  star: 'starred',
  // 其余字段名直接用
};

// 裸词匹配时合并搜的字段（顺序无关，仅用于 haystack 拼接）
const GLOBAL_FIELDS = ['title', 'abstract', 'summary', 'notes'];

/** 是否含 CJK 字符（与 lib/search.js hasCjk 同语义；这里独立避免循环依赖）。 */
function hasCjk(s) {
  return /[一-鿿぀-ヿ가-힯]/.test(String(s || ''));
}

// ============================================================================
// Tokenizer
// ============================================================================

/**
 * 把 DSL 字符串切成 token 数组。
 * token 类型：
 *   { type:'word', value:'transformer' }            裸词（无前缀）
 *   { type:'phrase', value:'vision transformer' }    引号短语
 *   { type:'field', field:'title', value:'attn', exclude:false }
 *   { type:'op', value:'AND'|'OR'|'NOT' }
 *   { type:'lparen' } / { type:'rparen' }
 */
function tokenize(input) {
  const s = String(input || '').trim();
  const tokens = [];
  let i = 0;
  const n = s.length;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < n) {
    const c = s[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    // 括号
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    // 排除前缀 -
    let exclude = false;
    if (c === '-' && i + 1 < n && !isSpace(s[i + 1]) && s[i + 1] !== '(' && s[i + 1] !== ')') {
      exclude = true;
      i++;
    }
    // 引号短语
    if (s[i] === '"' || s[i] === '“' || s[i] === '”') {
      const quote = s[i];
      let j = i + 1;
      let val = '';
      while (j < n && s[j] !== quote && s[j] !== '"' && s[j] !== '“' && s[j] !== '”') {
        val += s[j];
        j++;
      }
      // 跳过闭合引号
      if (j < n && (s[j] === '"' || s[j] === '“' || s[j] === '”')) j++;
      tokens.push({ type: 'phrase', value: val.trim(), exclude });
      i = j;
      continue;
    }
    // 读一个「原子 token」：可能是 field:value 或裸词或操作符
    // 先读连续非空白非特殊字符
    let j = i;
    let chunk = '';
    while (j < n && !isSpace(s[j]) && s[j] !== '(' && s[j] !== ')' && s[j] !== '"') {
      chunk += s[j];
      j++;
    }
    i = j;
    if (!chunk) continue;
    // 操作符（仅当整个 chunk 是 AND/OR/NOT 且未被 - 前缀）
    if (!exclude && (chunk === 'AND' || chunk === 'OR' || chunk === 'NOT')) {
      tokens.push({ type: 'op', value: chunk });
      continue;
    }
    // field:value ？（冒号必须在场，field 部分全小写字母，value 非空）
    const colonIdx = chunk.indexOf(':');
    if (colonIdx > 0) {
      const rawField = chunk.slice(0, colonIdx).toLowerCase();
      const value = chunk.slice(colonIdx + 1);
      if (rawField && /^[a-z]+$/.test(rawField) && value.length > 0) {
        tokens.push({ type: 'field', field: rawField, value, exclude });
        continue;
      }
    }
    // 裸词
    tokens.push({ type: 'word', value: chunk, exclude });
  }
  return tokens;
}

// ============================================================================
// Parser → AST
// ============================================================================

/**
 * 递归下降解析（支持 AND/OR/NOT 优先级 + 括号）。
 * 语法：
 *   expr    := orExpr
 *   orExpr  := andExpr ( OR andExpr )*
 *   andExpr := notExpr ( (AND | <implicit>) notExpr )*
 *   notExpr := NOT? atom
 *   atom    := '(' expr ')' | word | phrase | field
 *
 * AST 节点：
 *   { type:'word', value, exclude }
 *   { type:'phrase', value, exclude }
 *   { type:'field', field, value, exclude }
 *   { type:'and', children:[...] }
 *   { type:'or', children:[...] }
 *   { type:'not', child }
 */
function parse(input) {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseAtom() {
    const t = peek();
    if (!t) return null;
    if (t.type === 'lparen') {
      next();
      const e = parseOr();
      if (peek() && peek().type === 'rparen') next();
      return e;
    }
    if (t.type === 'rparen' || t.type === 'op') return null;
    next();
    // word/phrase/field 直接作为叶子
    return { type: t.type, value: t.value, field: t.field, exclude: !!t.exclude };
  }

  function parseNot() {
    // 前置 NOT 操作符
    let neg = false;
    while (peek() && peek().type === 'op' && peek().value === 'NOT') {
      neg = !neg;
      next();
    }
    // - 前缀的 token 自带 exclude，合并
    const atom = parseAtom();
    if (!atom) return null;
    if (neg) atom.exclude = !atom.exclude;
    return atom;
  }

  function parseAnd() {
    const children = [];
    const first = parseNot();
    if (!first) return null;
    children.push(first);
    // 隐式 AND：连续的 atom（无 OR）；显式 AND 关键字
    while (peek()) {
      const t = peek();
      if (t.type === 'op' && t.value === 'AND') {
        next();
        const a = parseNot();
        if (a) children.push(a);
        continue;
      }
      if (t.type === 'op' && t.value === 'OR') break;
      if (t.type === 'op' && t.value === 'NOT') {
        const a = parseNot();
        if (a) children.push(a);
        continue;
      }
      if (t.type === 'rparen') break;
      // 隐式 AND（word/phrase/field/lparen 紧跟）
      const a = parseNot();
      if (a) children.push(a);
      else break;
    }
    return children.length === 1 ? children[0] : { type: 'and', children };
  }

  function parseOr() {
    const children = [];
    const first = parseAnd();
    if (!first) return null;
    children.push(first);
    while (peek() && peek().type === 'op' && peek().value === 'OR') {
      next();
      const a = parseAnd();
      if (a) children.push(a);
    }
    return children.length === 1 ? children[0] : { type: 'or', children };
  }

  const ast = parseOr();
  return { ast, tokens };
}

// ============================================================================
// Compile → metadata + bodyQuery
// ============================================================================

/** 把 year value（如 ">=2020" / "2020-2024" / "2024"）解析成比较结构。 */
function parseYearValue(raw) {
  const v = String(raw || '').trim();
  // 范围 2020-2024
  const range = /^(\d{4})\s*-\s*(\d{4})$/.exec(v);
  if (range) return { op: 'range', from: parseInt(range[1], 10), to: parseInt(range[2], 10) };
  const ge = /^>=\s*(\d{4})$/.exec(v);
  if (ge) return { op: '>=', value: parseInt(ge[1], 10) };
  const le = /^<=\s*(\d{4})$/.exec(v);
  if (le) return { op: '<=', value: parseInt(le[1], 10) };
  const gt = /^>\s*(\d{4})$/.exec(v);
  if (gt) return { op: '>', value: parseInt(gt[1], 10) };
  const lt = /^<\s*(\d{4})$/.exec(v);
  if (lt) return { op: '<', value: parseInt(lt[1], 10) };
  const eq = /^(\d{4})$/.exec(v);
  if (eq) return { op: '=', value: parseInt(eq[1], 10) };
  return null;
}

/** 主入口：解析 DSL → { ast, metadata, bodyQuery }。
 *  metadata.flat() 把 AST 展平为字段桶（AND 语义下，同级条件全部需满足；
 *  OR 分支单独标记，applyMetadataQuery 里按 AST 求值）。 */
function parseSearchQuery(input) {
  const { ast } = parse(input);
  const metadata = {
    text: { words: [], phrases: [], excludeWords: [], excludePhrases: [] }, // 裸词/短语（全局匹配）
    fields: {}, // { title:[{value,exclude}], tag:[...], year:{...}, status:'ready', readStatus:'reading', starred:true, author:[...], notes:[...], abstract:[...], summary:[...] }
    body: null, // bodyQuery 字符串（in:body 或 body:phrase）
  };
  let bodyQuery = null;

  // 遍历 AST，收集到桶（AND 顶层展平；OR 分支保留 ast 供求值）
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'and' || node.type === 'or') {
      (node.children || []).forEach(walk);
      // OR 语义：在展平桶里无法表达，applyMetadataQuery 走 AST 求值
      return;
    }
    if (node.type === 'word') {
      const w = node.value;
      if (node.exclude) metadata.text.excludeWords.push(w.toLowerCase());
      else metadata.text.words.push(w.toLowerCase());
      return;
    }
    if (node.type === 'phrase') {
      if (node.exclude) metadata.text.excludePhrases.push(node.value.toLowerCase());
      else metadata.text.phrases.push(node.value.toLowerCase());
      return;
    }
    if (node.type === 'field') {
      const f = FIELD_ALIASES[node.field] || node.field;
      if (f === 'body' || f === 'in') {
        // body:phrase / in:body
        if (node.value && node.value !== 'body') bodyQuery = (bodyQuery ? bodyQuery + ' ' : '') + node.value;
        else if (f === 'in' && node.value === 'body') {
          /* 标记进入正文模式但无具体词 */
        }
        return;
      }
      if (f === 'year') {
        const yv = parseYearValue(node.value);
        if (yv) metadata.fields.year = yv;
        return;
      }
      if (f === 'starred' || f === 'star') {
        // star:1 / starred:1 / star:yes
        if (!node.exclude && /^(1|true|yes|on|✓)$/i.test(node.value)) metadata.fields.starred = true;
        else if (node.exclude) metadata.fields.starred = false; // -star:1 = 不要星标（通常无意义，但允许）
        return;
      }
      if (f === 'status') {
        if (!node.exclude) metadata.fields.status = node.value.toLowerCase();
        return;
      }
      if (f === 'read') {
        if (!node.exclude) metadata.fields.readStatus = node.value.toLowerCase();
        return;
      }
      // 多值桶：title/abstract/summary/notes/author/tag/topic
      const multiFields = ['title', 'abstract', 'summary', 'notes', 'author', 'tag', 'topic'];
      if (multiFields.includes(f)) {
        if (!metadata.fields[f]) metadata.fields[f] = [];
        metadata.fields[f].push({ value: node.value, exclude: !!node.exclude });
        return;
      }
      // 未知字段：当作裸词回退（更宽容）
      metadata.text.words.push((node.field + ':' + node.value).toLowerCase());
    }
  };
  walk(ast);

  // 如果有 OR 分支，标记 hasOr，applyMetadataQuery 走 AST 求值路径
  const hasOr = JSON.stringify(ast).includes('"type":"or"');
  metadata.hasOr = hasOr;
  metadata.ast = ast;

  // bodyQuery：若 in:body 出现但无 body:phrase，bodyQuery 留空字符串（标记正文模式）
  if (bodyQuery === null) {
    // 检测 in:body 单独出现
    const hasInBody = /\bin:body\b/i.test(String(input || ''));
    if (hasInBody) bodyQuery = '';
  }
  return { ast, metadata, bodyQuery };
}

// ============================================================================
// 求值：把 parsed 应用到论文列表
// ============================================================================

/** 笔记 haystack：旧 notes 文本 + noteCards 卡片的 title/body 合并（笔记卡片化后两处都要能搜到）。 */
function notesHaystackText(p) {
  const parts = [String((p && p.notes) || '')];
  if (Array.isArray(p && p.noteCards)) {
    for (const c of p.noteCards) {
      if (!c || typeof c !== 'object') continue;
      parts.push(String(c.title || ''), String(c.body || ''));
    }
  }
  return parts.join('\n').toLowerCase();
}

/** 构建论文的「全局 haystack」（裸词在此匹配）。返回小写字符串数组（每字段一个），便于 AND。 */
function globalHaystack(p) {
  const parts = [];
  for (const f of GLOBAL_FIELDS) parts.push(f === 'notes' ? notesHaystackText(p) : String((p && p[f]) || ''));
  if (Array.isArray(p && p.tags)) parts.push(p.tags.join(' '));
  if (Array.isArray(p && p.topics)) parts.push(p.topics.join(' '));
  return parts.map((s) => s.toLowerCase());
}
function fieldHaystack(p, f) {
  if (f === 'author')
    return [
      String((p && p.authors) || '').toLowerCase(),
      Array.isArray(p && p.authors) ? p.authors.join(' ').toLowerCase() : '',
    ];
  if (f === 'tag') return [(p && Array.isArray(p.tags) ? p.tags : []).map((t) => String(t).toLowerCase()).join(' ')];
  if (f === 'topic')
    return [(p && Array.isArray(p.topics) ? p.topics : []).map((t) => String(t).toLowerCase()).join(' ')];
  if (f === 'notes') return [notesHaystackText(p)];
  return [String((p && p[f]) || '').toLowerCase()];
}

/** 裸词匹配：每个 word 都须在某个全局字段命中（AND）；excludeWords 都不命中。 */
function matchGlobalText(p, text) {
  const hay = globalHaystack(p);
  // words：每个词至少一个字段命中
  for (const w of text.words) {
    if (hasCjk(w)) {
      // CJK 词：子串匹配（在任一字段）
      if (!hay.some((h) => h.includes(w))) return false;
    } else {
      // 英文：词边界匹配（避免 cat 命中 category）
      const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
      if (!hay.some((h) => re.test(h))) return false;
    }
  }
  // phrases：连续子串匹配
  for (const ph of text.phrases) {
    if (!hay.some((h) => h.includes(ph))) return false;
  }
  // excludeWords：任一字段命中即排除
  for (const w of text.excludeWords) {
    const re = hasCjk(w)
      ? null
      : new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
    const hit = re ? hay.some((h) => re.test(h)) : hay.some((h) => h.includes(w));
    if (hit) return false;
  }
  // excludePhrases
  for (const ph of text.excludePhrases) {
    if (hay.some((h) => h.includes(ph))) return false;
  }
  return true;
}

function matchField(p, f, entries) {
  // entries: [{value, exclude}]。默认 OR（任一非排除 value 命中）；排除项作 NOT
  const hay = fieldHaystack(p, f);
  const wants = entries.filter((e) => !e.exclude);
  const excludes = entries.filter((e) => e.exclude);
  // 排除项：任一命中即 false
  for (const e of excludes) {
    // 特约定：value='.' 表示「字段非空」（高级面板 hasNotes 生成 notes:.）——子串匹配 '.' 字面值
    // 会漏掉不含点号的内容（如纯中文笔记），语义必须是「非空」而非「含点」
    if (e.value === '.') {
      if (hay.some((h) => h.length > 0)) return false;
      continue;
    }
    const v = e.value.toLowerCase();
    const hit = hasCjk(v) ? hay.some((h) => h.includes(v)) : hay.some((h) => h.includes(v));
    if (hit) return false;
  }
  if (!wants.length) return true; // 仅排除项，已处理
  // 想要项 OR
  for (const e of wants) {
    if (e.value === '.') {
      if (hay.some((h) => h.length > 0)) return true;
      continue;
    }
    const v = e.value.toLowerCase();
    const hit = hay.some((h) => h.includes(v));
    if (hit) return true;
  }
  return false;
}

function matchYear(p, year) {
  const y = parseInt(p && p.year, 10);
  if (!Number.isFinite(y)) return false;
  switch (year.op) {
    case '=':
      return y === year.value;
    case '>=':
      return y >= year.value;
    case '<=':
      return y <= year.value;
    case '>':
      return y > year.value;
    case '<':
      return y < year.value;
    case 'range':
      return y >= year.from && y <= year.to;
    default:
      return true;
  }
}

/** 单条论文是否满足 metadata（无 OR 分支的展平求值）。 */
function matchPaperFlat(p, metadata) {
  const t = metadata.text;
  if (
    (t.words.length || t.phrases.length || t.excludeWords.length || t.excludePhrases.length) &&
    !matchGlobalText(p, t)
  )
    return false;
  const f = metadata.fields;
  for (const k of ['title', 'abstract', 'summary', 'notes', 'author', 'tag', 'topic']) {
    if (f[k] && f[k].length && !matchField(p, k, f[k])) return false;
  }
  if (f.year && !matchYear(p, f.year)) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.readStatus && p.readStatus !== f.readStatus) return false;
  if (f.starred === true && !p.starred) return false;
  if (f.starred === false && p.starred) return false;
  return true;
}

/** AST 求值（含 OR 分支）。 */
function evalAst(node, p) {
  if (!node) return true;
  if (node.type === 'and') return (node.children || []).every((c) => evalAst(c, p));
  if (node.type === 'or') return (node.children || []).some((c) => evalAst(c, p));
  if (node.type === 'word') {
    const hay = globalHaystack(p);
    const w = node.value.toLowerCase();
    const hit = hasCjk(w)
      ? hay.some((h) => h.includes(w))
      : hay.some((h) =>
          new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(h),
        );
    return node.exclude ? !hit : hit;
  }
  if (node.type === 'phrase') {
    const hay = globalHaystack(p);
    const hit = hay.some((h) => h.includes(node.value.toLowerCase()));
    return node.exclude ? !hit : hit;
  }
  if (node.type === 'field') {
    const f = FIELD_ALIASES[node.field] || node.field;
    // body/in 不参与元数据求值（走 bodyQuery）
    if (f === 'body' || f === 'in') return true;
    if (f === 'year') {
      const r = matchYear(p, parseYearValue(node.value) || { op: '=' });
      return node.exclude ? !r : r;
    }
    if (f === 'starred' || f === 'star') {
      const r = !!p.starred;
      return node.exclude ? !r : r;
    }
    if (f === 'status') {
      const r = p.status === node.value.toLowerCase();
      return node.exclude ? !r : r;
    }
    if (f === 'read') {
      const r = p.readStatus === node.value.toLowerCase();
      return node.exclude ? !r : r;
    }
    const hay = fieldHaystack(p, f);
    const v = node.value.toLowerCase();
    const r = hay.some((h) => h.includes(v));
    return node.exclude ? !r : r;
  }
  return true;
}

/**
 * 把 parsed.metadata 应用到论文列表，返回筛选后的列表。
 * 优先用展平求值（无 OR 时更快）；有 OR 走 AST。
 */
function applyMetadataQuery(list, parsed) {
  if (!parsed || !parsed.metadata) return list;
  const m = parsed.metadata;
  const hasContent =
    m.text.words.length ||
    m.text.phrases.length ||
    m.text.excludeWords.length ||
    m.text.excludePhrases.length ||
    Object.keys(m.fields).length;
  if (!hasContent) return list;
  if (m.hasOr && m.ast) {
    return list.filter((p) => evalAst(m.ast, p));
  }
  return list.filter((p) => matchPaperFlat(p, m));
}

// ============================================================================
// 前端镜像：buildDslFromPanel —— 高级面板状态 → DSL 字符串
// ============================================================================

/**
 * @param {object} panel {
 *   title, abstract, summary, notes, author,   // 字符串
 *   tags:[], excludeTags:[], topics:[], excludeTopics:[],
 *   yearFrom, yearTo,    // 数字或空
 *   status, readStatus, starred, hasNotes (bool),
 *   scope: 'metadata'|'body', bodyText
 * }
 * @returns {string} DSL 字符串
 */
function buildDslFromPanel(panel) {
  panel = panel || {};
  const parts = [];
  const pushField = (f, v) => {
    if (v && String(v).trim()) parts.push(f + ':' + String(v).trim());
  };
  pushField('title', panel.title);
  pushField('abstract', panel.abstract);
  pushField('summary', panel.summary);
  if (panel.hasNotes)
    parts.push('notes:.'); // notes 非空（任意字符）
  else pushField('notes', panel.notes);
  pushField('author', panel.author);
  (panel.tags || []).forEach((t) => pushField('tag', t));
  (panel.excludeTags || []).forEach((t) => parts.push('-tag:' + t));
  (panel.topics || []).forEach((t) => pushField('topic', t));
  (panel.excludeTopics || []).forEach((t) => parts.push('-topic:' + t));
  if (panel.yearFrom && panel.yearTo) parts.push('year:' + panel.yearFrom + '-' + panel.yearTo);
  else if (panel.yearFrom) parts.push('year:>=' + panel.yearFrom);
  else if (panel.yearTo) parts.push('year:<=' + panel.yearTo);
  if (panel.status) parts.push('status:' + panel.status);
  if (panel.readStatus) parts.push('read:' + panel.readStatus);
  if (panel.starred) parts.push('star:1');
  if (panel.scope === 'body') {
    if (panel.bodyText && panel.bodyText.trim()) parts.push('body:' + panel.bodyText.trim());
    else parts.push('in:body');
  }
  if (panel.text && panel.text.trim()) parts.push(panel.text.trim());
  return parts.join(' ');
}

/** 反向：DSL → 面板状态（供输入框 → 面板回填）。尽力而为；OR/复杂表达式回 text 兜底。 */
function parseToPanel(input) {
  const { metadata, bodyQuery } = parseSearchQuery(input);
  const f = metadata.fields;
  const panel = {
    title: '',
    abstract: '',
    summary: '',
    notes: '',
    author: '',
    tags: [],
    excludeTags: [],
    topics: [],
    excludeTopics: [],
    yearFrom: '',
    yearTo: '',
    status: '',
    readStatus: '',
    starred: false,
    hasNotes: false,
    scope: bodyQuery !== null ? 'body' : 'metadata',
    bodyText: '',
    text: '',
  };
  if (f.title)
    panel.title = f.title
      .filter((e) => !e.exclude)
      .map((e) => e.value)
      .join(' ');
  if (f.abstract)
    panel.abstract = f.abstract
      .filter((e) => !e.exclude)
      .map((e) => e.value)
      .join(' ');
  if (f.summary)
    panel.summary = f.summary
      .filter((e) => !e.exclude)
      .map((e) => e.value)
      .join(' ');
  if (f.notes) {
    const wants = f.notes.filter((e) => !e.exclude);
    if (wants.some((e) => e.value === '.')) panel.hasNotes = true;
    else panel.notes = wants.map((e) => e.value).join(' ');
  }
  if (f.author)
    panel.author = f.author
      .filter((e) => !e.exclude)
      .map((e) => e.value)
      .join(' ');
  if (f.tag) {
    panel.tags = f.tag.filter((e) => !e.exclude).map((e) => e.value);
    panel.excludeTags = f.tag.filter((e) => e.exclude).map((e) => e.value);
  }
  if (f.topic) {
    panel.topics = f.topic.filter((e) => !e.exclude).map((e) => e.value);
    panel.excludeTopics = f.topic.filter((e) => e.exclude).map((e) => e.value);
  }
  if (f.year) {
    if (f.year.op === 'range') {
      panel.yearFrom = f.year.from;
      panel.yearTo = f.year.to;
    } else if (f.year.op === '>=') panel.yearFrom = f.year.value;
    else if (f.year.op === '<=') panel.yearTo = f.year.value;
    else if (f.year.op === '=') {
      panel.yearFrom = f.year.value;
      panel.yearTo = f.year.value;
    }
  }
  if (f.status) panel.status = f.status;
  if (f.readStatus) panel.readStatus = f.readStatus;
  if (f.starred === true) panel.starred = true;
  if (bodyQuery) panel.bodyText = bodyQuery;
  // 裸词回填到 text
  if (metadata.text.words.length || metadata.text.phrases.length) {
    const all = metadata.text.phrases.map((p) => '"' + p + '"').concat(metadata.text.words);
    panel.text = all.join(' ');
  }
  // OR 分支无法回填到结构化字段 → 保留原文到 text
  if (metadata.hasOr) panel.text = String(input || '').trim();
  return panel;
}

module.exports = {
  tokenize,
  parse,
  parseSearchQuery,
  parseYearValue,
  applyMetadataQuery,
  matchPaperFlat,
  evalAst,
  buildDslFromPanel,
  parseToPanel,
  hasCjk,
  FIELD_ALIASES,
  GLOBAL_FIELDS,
};
