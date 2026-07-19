/**
 * 搜索 DSL 解析器（浏览器镜像版，v3.2 高级搜索）。
 * 与 lib/search-query.js 同构——前后端共用同一份语法。
 * 零构建：直接 <script> 加载，挂到 window.PaperWikiSearch。
 *
 * 用途（前端）：
 *   - 检测 DSL 是否含 body:（决定走 /api/search 还是 /api/papers）
 *   - 高级面板双向同步：DSL ↔ 面板字段
 *   - 内联补全：检测光标前最近的 field: 前缀
 *
 * 注意：applyMetadataQuery（服务端在 /api/papers 用）前端不需要——筛选都由后端做。
 */
(function () {
  const FIELD_ALIASES = { star: 'starred' };
  const GLOBAL_FIELDS = ['title', 'abstract', 'summary', 'notes'];
  function hasCjk(s) { return /[一-鿿぀-ヿ가-힯]/.test(String(s || '')); }

  // ---- tokenizer（与 lib/search-query.js 完全一致）----
  function tokenize(input) {
    const s = String(input || '').trim();
    const tokens = [];
    let i = 0;
    const n = s.length;
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    while (i < n) {
      const c = s[i];
      if (isSpace(c)) { i++; continue; }
      if (c === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
      if (c === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
      let exclude = false;
      if (c === '-' && i + 1 < n && !isSpace(s[i + 1]) && s[i + 1] !== '(' && s[i + 1] !== ')') { exclude = true; i++; }
      if (s[i] === '"' || s[i] === '“' || s[i] === '”') {
        const quote = s[i]; let j = i + 1; let val = '';
        while (j < n && s[j] !== quote && s[j] !== '"' && s[j] !== '“' && s[j] !== '”') { val += s[j]; j++; }
        if (j < n && (s[j] === '"' || s[j] === '“' || s[j] === '”')) j++;
        tokens.push({ type: 'phrase', value: val.trim(), exclude }); i = j; continue;
      }
      let j = i; let chunk = '';
      while (j < n && !isSpace(s[j]) && s[j] !== '(' && s[j] !== ')' && s[j] !== '"') { chunk += s[j]; j++; }
      i = j;
      if (!chunk) continue;
      if (!exclude && (chunk === 'AND' || chunk === 'OR' || chunk === 'NOT')) { tokens.push({ type: 'op', value: chunk }); continue; }
      const colonIdx = chunk.indexOf(':');
      if (colonIdx > 0) {
        const rawField = chunk.slice(0, colonIdx).toLowerCase();
        const value = chunk.slice(colonIdx + 1);
        if (rawField && /^[a-z]+$/.test(rawField) && value.length > 0) { tokens.push({ type: 'field', field: rawField, value, exclude }); continue; }
      }
      tokens.push({ type: 'word', value: chunk, exclude });
    }
    return tokens;
  }

  function parse(input) {
    const tokens = tokenize(input);
    let pos = 0;
    const peek = () => tokens[pos];
    const parseAtom = () => {
      const t = peek(); if (!t) return null;
      if (t.type === 'lparen') { pos++; const e = parseOr(); if (peek() && peek().type === 'rparen') pos++; return e; }
      if (t.type === 'rparen' || t.type === 'op') return null;
      pos++; return { type: t.type, value: t.value, field: t.field, exclude: !!t.exclude };
    };
    const parseNot = () => {
      let neg = false;
      while (peek() && peek().type === 'op' && peek().value === 'NOT') { neg = !neg; pos++; }
      const atom = parseAtom(); if (!atom) return null;
      if (neg) atom.exclude = !atom.exclude;
      return atom;
    };
    const parseAnd = () => {
      const children = [];
      const first = parseNot(); if (!first) return null;
      children.push(first);
      while (peek()) {
        const t = peek();
        if (t.type === 'op' && t.value === 'AND') { pos++; const a = parseNot(); if (a) children.push(a); continue; }
        if (t.type === 'op' && t.value === 'OR') break;
        if (t.type === 'op' && t.value === 'NOT') { const a = parseNot(); if (a) children.push(a); continue; }
        if (t.type === 'rparen') break;
        const a = parseNot(); if (a) children.push(a); else break;
      }
      return children.length === 1 ? children[0] : { type: 'and', children };
    };
    const parseOr = () => {
      const children = [];
      const first = parseAnd(); if (!first) return null;
      children.push(first);
      while (peek() && peek().type === 'op' && peek().value === 'OR') { pos++; const a = parseAnd(); if (a) children.push(a); }
      return children.length === 1 ? children[0] : { type: 'or', children };
    };
    return { ast: parseOr(), tokens };
  }

  function parseYearValue(raw) {
    const v = String(raw || '').trim();
    const range = /^(\d{4})\s*-\s*(\d{4})$/.exec(v);
    if (range) return { op: 'range', from: parseInt(range[1], 10), to: parseInt(range[2], 10) };
    const ge = /^>=\s*(\d{4})$/.exec(v); if (ge) return { op: '>=', value: parseInt(ge[1], 10) };
    const le = /^<=\s*(\d{4})$/.exec(v); if (le) return { op: '<=', value: parseInt(le[1], 10) };
    const gt = /^>\s*(\d{4})$/.exec(v); if (gt) return { op: '>', value: parseInt(gt[1], 10) };
    const lt = /^<\s*(\d{4})$/.exec(v); if (lt) return { op: '<', value: parseInt(lt[1], 10) };
    const eq = /^(\d{4})$/.exec(v); if (eq) return { op: '=', value: parseInt(eq[1], 10) };
    return null;
  }

  function parseSearchQuery(input) {
    const { ast } = parse(input);
    const metadata = { text: { words: [], phrases: [], excludeWords: [], excludePhrases: [] }, fields: {}, body: null };
    let bodyQuery = null;
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'and' || node.type === 'or') { (node.children || []).forEach(walk); return; }
      if (node.type === 'word') { (node.exclude ? metadata.text.excludeWords : metadata.text.words).push(node.value.toLowerCase()); return; }
      if (node.type === 'phrase') { (node.exclude ? metadata.text.excludePhrases : metadata.text.phrases).push(node.value.toLowerCase()); return; }
      if (node.type === 'field') {
        const f = FIELD_ALIASES[node.field] || node.field;
        if (f === 'body' || f === 'in') { if (node.value && node.value !== 'body') bodyQuery = (bodyQuery ? bodyQuery + ' ' : '') + node.value; return; }
        if (f === 'year') { const yv = parseYearValue(node.value); if (yv) metadata.fields.year = yv; return; }
        if (f === 'starred' || f === 'star') { if (!node.exclude && /^(1|true|yes|on)$/i.test(node.value)) metadata.fields.starred = true; return; }
        if (f === 'status') { if (!node.exclude) metadata.fields.status = node.value.toLowerCase(); return; }
        if (f === 'read') { if (!node.exclude) metadata.fields.readStatus = node.value.toLowerCase(); return; }
        if (['title', 'abstract', 'summary', 'notes', 'author', 'tag', 'topic'].includes(f)) { if (!metadata.fields[f]) metadata.fields[f] = []; metadata.fields[f].push({ value: node.value, exclude: !!node.exclude }); return; }
        metadata.text.words.push((node.field + ':' + node.value).toLowerCase());
      }
    };
    walk(ast);
    metadata.hasOr = JSON.stringify(ast).includes('"type":"or"'); metadata.ast = ast;
    if (bodyQuery === null && /\bin:body\b/i.test(String(input || ''))) bodyQuery = '';
    return { ast, metadata, bodyQuery };
  }

  function buildDslFromPanel(panel) {
    panel = panel || {};
    const parts = [];
    const pushField = (f, v) => { if (v && String(v).trim()) parts.push(f + ':' + String(v).trim()); };
    pushField('title', panel.title); pushField('abstract', panel.abstract); pushField('summary', panel.summary);
    if (panel.hasNotes) parts.push('notes:.'); else pushField('notes', panel.notes);
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
    if (panel.scope === 'body') { if (panel.bodyText && panel.bodyText.trim()) parts.push('body:' + panel.bodyText.trim()); else parts.push('in:body'); }
    if (panel.text && panel.text.trim()) parts.push(panel.text.trim());
    return parts.join(' ');
  }

  function parseToPanel(input) {
    const { metadata, bodyQuery } = parseSearchQuery(input);
    const f = metadata.fields;
    const panel = { title: '', abstract: '', summary: '', notes: '', author: '', tags: [], excludeTags: [], topics: [], excludeTopics: [], yearFrom: '', yearTo: '', status: '', readStatus: '', starred: false, hasNotes: false, scope: bodyQuery !== null ? 'body' : 'metadata', bodyText: '', text: '' };
    if (f.title) panel.title = f.title.filter((e) => !e.exclude).map((e) => e.value).join(' ');
    if (f.abstract) panel.abstract = f.abstract.filter((e) => !e.exclude).map((e) => e.value).join(' ');
    if (f.summary) panel.summary = f.summary.filter((e) => !e.exclude).map((e) => e.value).join(' ');
    if (f.notes) { const w = f.notes.filter((e) => !e.exclude); if (w.some((e) => e.value === '.')) panel.hasNotes = true; else panel.notes = w.map((e) => e.value).join(' '); }
    if (f.author) panel.author = f.author.filter((e) => !e.exclude).map((e) => e.value).join(' ');
    if (f.tag) { panel.tags = f.tag.filter((e) => !e.exclude).map((e) => e.value); panel.excludeTags = f.tag.filter((e) => e.exclude).map((e) => e.value); }
    if (f.topic) { panel.topics = f.topic.filter((e) => !e.exclude).map((e) => e.value); panel.excludeTopics = f.topic.filter((e) => e.exclude).map((e) => e.value); }
    if (f.year) { if (f.year.op === 'range') { panel.yearFrom = f.year.from; panel.yearTo = f.year.to; } else if (f.year.op === '>=') panel.yearFrom = f.year.value; else if (f.year.op === '<=') panel.yearTo = f.year.value; else if (f.year.op === '=') { panel.yearFrom = f.year.value; panel.yearTo = f.year.value; } }
    if (f.status) panel.status = f.status;
    if (f.readStatus) panel.readStatus = f.readStatus;
    if (f.starred === true) panel.starred = true;
    if (bodyQuery) panel.bodyText = bodyQuery;
    if (metadata.text.words.length || metadata.text.phrases.length) panel.text = metadata.text.phrases.map((p) => '"' + p + '"').concat(metadata.text.words).join(' ');
    if (metadata.hasOr) panel.text = String(input || '').trim();
    return panel;
  }

  /** 检测光标位置前的 field: 前缀（内联补全用）。
   *  返回 { field, prefix, valueStart } 或 null。valueStart = value 在输入框文本中的起始索引。 */
  function detectFieldAtCursor(text, cursorPos) {
    const before = text.slice(0, cursorPos);
    // 找最后一个未闭合的 field: 模式：(\s|^)([a-z]+):([^ ]*)$
    const m = /(?:^|\s)([a-z]+):([^ \n]*)$/.exec(before);
    if (!m) return null;
    const field = m[1];
    const valueStart = before.length - m[2].length;
    return { field, prefix: m[2], valueStart };
  }

  /** DSL 是否触发正文检索模式（含 body: 或 in:body）。 */
  function isBodySearch(input) {
    const p = parseSearchQuery(input);
    return p.bodyQuery !== null;
  }

  window.PaperWikiSearch = {
    tokenize, parse, parseSearchQuery, parseYearValue,
    buildDslFromPanel, parseToPanel, detectFieldAtCursor, isBodySearch, hasCjk,
    FIELD_ALIASES, GLOBAL_FIELDS,
  };
})();
