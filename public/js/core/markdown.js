// Markdown 渲染（含中日韩粗体修正与聊天代码块折叠）
//
// 自 public/app.js 拆出（v3.15 模块化重构）——声明体原样迁移，仅补 import/export。

import { fixCjkStrong } from './format.js';

export function renderMd(md) {
  const raw = marked.parse(md || '', { breaks: true });
  let html = DOMPurify.sanitize(raw);
  html = fixCjkStrong(html);
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => katex.renderToString(e, { displayMode: true, throwOnError: false }));
  html = html.replace(/\$([^$\n]+?)\$/g, (_, e) => katex.renderToString(e, { displayMode: false, throwOnError: false }));
  return html;
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
