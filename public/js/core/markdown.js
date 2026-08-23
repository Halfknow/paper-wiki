// Markdown 渲染（含中日韩粗体修正与聊天代码块折叠）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { fixCjkStrong, escapeHtml } from './format.js';

export function renderMd(md) {
  // 公式必须在 marked 之前抽走（protectMath）：旧管线先跑 marked/DOMPurify 再抽 $…$，
  // LaTeX 源被污染——`<`/`>` 实体化成 &lt;/&gt;（KaTeX 见 & 即错）、`\{`/`\_` 被 CommonMark
  // 反斜杠转义吃掉、`_` 被配成 <em>、多行 $$ 被插 <br>，表现为总结里成片红字公式。
  const { text, spans } = protectMath(md);
  let html = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
  html = fixCjkStrong(html);
  for (const s of spans) html = html.split(s.ph).join(renderTex(s.tex, s.display));
  return html;
}

// ---------------------------------------------------------------------------
// 数学公式保护层（v3.53）：marked 之前把 $…$ / $$…$$ 段换成占位符，最后回填。
// ---------------------------------------------------------------------------

/** 标记 fenced code / 行内码区间（公式扫描跳过，代码里的 $ 是字面量）。 */
function buildSkipMask(text) {
  const mask = new Uint8Array(text.length);
  const mark = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      for (let k = m.index; k < m.index + m[0].length; k++) mask[k] = 1;
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  mark(/```[\s\S]*?(?:```|$)/g);
  mark(/~~~[\s\S]*?(?:~~~|$)/g);
  mark(/`[^`\n]*`/g);
  return mask;
}

/** 从未转义的 `$`（open 起）找数学闭合端：display 找下一个未转义 `$$`，
 *  inline 找下一个未转义 `$`（不跨行，与旧正则一致）。跨入代码区/找不到返回 -1。 */
function findMathClose(text, mask, start, display) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (mask[i]) return -1;
    const ch = text[i];
    if (ch === '$') {
      if (display) {
        if (text[i + 1] === '$' && !mask[i + 1]) return i;
        i++;
      } else return i;
    } else {
      if (!display && ch === '\n') return -1;
      i++;
    }
  }
  return -1;
}

/** 把 raw markdown 里的 $…$ / $$…$$ 段替换为占位符（每次调用随机 tag，防与正文撞词）。
 *  返回 { text, spans: [{ph, tex, display}] }；`\$` 转义与不成对的 $ 保持字面量。 */
export function protectMath(md) {
  const text = String(md || '');
  const mask = buildSkipMask(text);
  const tag = 'pwMth' + Math.random().toString(36).slice(2, 8);
  const spans = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] !== '$' || mask[i]) { out += text[i]; i++; continue; }
    const display = text[i + 1] === '$' && !mask[i + 1];
    const openLen = display ? 2 : 1;
    const close = findMathClose(text, mask, i + openLen, display);
    if (close < 0) { out += text[i]; i++; continue; }
    const ph = tag + spans.length + 'x';
    spans.push({ ph, tex: text.slice(i + openLen, close), display });
    out += ph;
    i = close + openLen;
  }
  return { text: out, spans };
}

/** 双下标/双上标自动修复：`h_d_i` / `x^a^b` 这类模型笔误是恒定的 KaTeX 报错
 *  （LaTeX 语义下本就不合法），补上花括号 `h_{d_i}` 是唯一合理释义。仅失败重试时使用。 */
function repairTexSubSup(tex) {
  let out = String(tex);
  for (let k = 0; k < 3; k++) {
    const next = out
      .replace(/([A-Za-z0-9])_([A-Za-z0-9]+)_([A-Za-z0-9]+)/g, '$1_{$2_$3}')
      .replace(/([A-Za-z0-9])\^([A-Za-z0-9]+)\^([A-Za-z0-9]+)/g, '$1^{$2^$3}');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** LaTeX → KaTeX HTML 的单一入口（总结/聊天经 renderMd，公式卡直调）。
 *  三级尝试：原样 → 双上下标修复 → 红字降级（throwOnError:false，KaTeX 把源码染 #cc0000）。
 *  strict:false 只关 console 告警（CJK/奇异记号），渲染结果不变。无 katex 全局（jsdom）回退 code。 */
export function renderTex(tex, display) {
  const src = String(tex == null ? '' : tex);
  if (typeof katex === 'undefined' || !katex) return '<code>' + escapeHtml(src) + '</code>';
  const opts = { displayMode: !!display, strict: false };
  try {
    return katex.renderToString(src, { ...opts, throwOnError: true });
  } catch { /* 落到修复重试 */ }
  const fixed = repairTexSubSup(src);
  if (fixed !== src) {
    try {
      return katex.renderToString(fixed, { ...opts, throwOnError: true });
    } catch { /* 落到红字降级 */ }
  }
  try {
    return katex.renderToString(src, { ...opts, throwOnError: false });
  } catch {
    return '<code>' + escapeHtml(src) + '</code>';
  }
}

/** 聊天专用 Markdown 渲染：renderMd 之上加代码块强化（语言标签 + 复制按钮 + 超长折叠）。
 *  final=true（完成态）才对 >20 行的代码块应用折叠（流式中 final=false 不折叠，避免半截 fence 抖动）。
 *  用 DOMParser 做后处理（比正则可靠），每段 <pre><code class="language-xx"> 改写成 .cb-card 结构。
 *  复制按钮经事件委托（.cb-copy 点击 → 读同卡片 pre.textContent → clipboard），无需内联 onclick。 */
const CODE_COLLAPSE_LINES = 20; // 超过此行数的代码块在完成态默认折叠

export function renderChatMd(md, opts) {
  opts = opts || {};
  const html = renderMd(md || '');
  try {
    const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    const root = doc.getElementById('r');
    const pres = root.querySelectorAll('pre');
    pres.forEach((pre) => {
      const code = pre.querySelector('code');
      const cls = (code && code.className) || '';
      const lm = /language-([\w+-]+)/.exec(cls);
      const lang = lm ? lm[1] : '';
      const text = (code ? code.textContent : pre.textContent) || '';
      const lineCount = text.split('\n').length;
      const card = doc.createElement('div');
      card.className = 'cb-card' + (opts.final && lineCount > CODE_COLLAPSE_LINES ? ' collapsed' : '');
      // 头部：语言标签 + 复制按钮
      const head = doc.createElement('div');
      head.className = 'cb-head';
      const langEl = doc.createElement('span');
      langEl.className = 'cb-lang';
      langEl.textContent = lang || 'text';
      const copyBtn = doc.createElement('button');
      copyBtn.className = 'cb-copy';
      copyBtn.type = 'button';
      copyBtn.title = '复制代码';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制</span>';
      head.appendChild(langEl);
      head.appendChild(copyBtn);
      // 正文：保留原 pre/code（含 class 供后续高亮）
      pre.parentNode.replaceChild(card, pre);
      card.appendChild(head);
      card.appendChild(pre);
      // 折叠态：加展开遮罩按钮
      if (card.classList.contains('collapsed')) {
        const exp = doc.createElement('button');
        exp.className = 'cb-expand';
        exp.type = 'button';
        exp.textContent = '展开 ' + lineCount + ' 行';
        exp.onclick = () => {}; // 委托：见 CSS .cb-card:not(.collapsed) .cb-expand 隐藏 + JS toggle
        card.appendChild(exp);
      }
    });
    return root.innerHTML;
  } catch {
    return html; // DOMParser 失败回退原样
  }
}

/** 截取问答大纲条目标题：去首尾空白/换行，按字符截断到 max 字符 + 省略号（供 AI 对话大纲用）。 */
export function truncateChatTitle(s, max = 24) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（空问题）';
  return t.length > max ? t.slice(0, max) + '…' : t;
}
