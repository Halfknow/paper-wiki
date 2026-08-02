'use strict';

// 结构化笔记卡片（AI 笔记）的纯逻辑层，零 IO 依赖，可独立单测。
//
// 背景：旧笔记是 papers.notes 单一 TEXT（textarea 自由 Markdown）。v4 起笔记改为
// 卡片流——聊天问答一键存卡、AI 生成骨架卡、手动自由卡——存储迁到 papers.note_cards
// jsonb 列。卡片形状：
//   { id: 'nc-xxx', type: 'qa'|'skeleton'|'manual', title, body(markdown),
//     meta?: { question?, mi? }, createdAt, updatedAt }
//
// 本模块提供：
//   - normalizeNoteCards：PATCH 写入边界 + load 自愈的归一化（限量/补字段/剥非法）
//   - splitMarkdownToCards：把「## 标题」结构的 Markdown 拆成卡片（旧 notes 迁移 + AI 骨架输出共用）
// 卡片 id 无需跨论文归并（与 conceptIdFor 的稳定 hash 不同），随机即可。

const CARD_TYPES = new Set(['qa', 'skeleton', 'manual']);
const MAX_CARDS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 50000;

/** 生成卡片 id：nc- + 时间基 36 进制 + 随机后缀（同 ms 内连建不撞）。 */
function newCardId(now) {
  const t = (now == null ? Date.now() : now).toString(36);
  return 'nc-' + t + Math.random().toString(36).slice(2, 8);
}

/** 归一化单张卡片；非法（无正文且无标题 / type 不在白名单）返回 null。now 用于补时间戳。 */
function normalizeCard(c, now) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const type = CARD_TYPES.has(c.type) ? c.type : 'manual';
  const title = String(c.title == null ? '' : c.title).slice(0, MAX_TITLE_CHARS).trim();
  const body = String(c.body == null ? '' : c.body).slice(0, MAX_BODY_CHARS);
  if (!title && !body.trim()) return null;
  const ts = now == null ? Date.now() : now;
  const createdAt = Number.isFinite(c.createdAt) && c.createdAt > 0 ? c.createdAt : ts;
  const meta = c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta) ? c.meta : undefined;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newCardId(ts),
    type,
    title,
    body,
    ...(meta ? { meta } : {}),
    createdAt,
    updatedAt: Number.isFinite(c.updatedAt) && c.updatedAt > 0 ? c.updatedAt : createdAt,
  };
}

/** 归一化卡片数组（PATCH 写入 + load 自愈共用）：非数组回 []，逐卡清洗，限 MAX_CARDS 张。 */
function normalizeNoteCards(input, now) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const c of input) {
    const n = normalizeCard(c, now);
    if (!n) continue;
    if (seen.has(n.id)) n.id = newCardId(now); // id 撞车（复制卡/客户端 bug）→ 重发，不丢内容
    seen.add(n.id);
    out.push(n);
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

/** 把「## 标题」结构的 Markdown 拆成卡片数组。
 *  - 无 ## 标题：非空则整体成一张卡（标题用 fallbackTitle）。
 *  - 标题前的导语（preamble）并入第一张卡正文之前会丢失结构感，故并入第一张卡的 body 开头。
 *  - type 由调用方定：旧 notes 迁移传 'manual'，AI 骨架输出传 'skeleton'。 */
function splitMarkdownToCards(md, type, now, fallbackTitle) {
  const text = String(md == null ? '' : md).trim();
  if (!text) return [];
  const lines = text.split('\n');
  const sections = [];
  const preambleLines = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1], bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    } else {
      preambleLines.push(line); // 首个 ## 之前的导语：并入第一张卡正文开头
    }
  }
  if (cur) sections.push(cur);
  const preamble = preambleLines.join('\n').trim();
  if (!sections.length) {
    if (!text) return [];
    return normalizeNoteCards([{ type, title: fallbackTitle || '笔记', body: text, createdAt: now, updatedAt: now }], now);
  }
  const cards = sections.map((s, i) => ({
    type,
    title: s.title,
    body: (i === 0 && preamble ? preamble + '\n\n' : '') + s.bodyLines.join('\n').trim(),
    createdAt: now,
    updatedAt: now,
  }));
  return normalizeNoteCards(cards, now);
}

module.exports = {
  CARD_TYPES,
  MAX_CARDS,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  newCardId,
  normalizeCard,
  normalizeNoteCards,
  splitMarkdownToCards,
};
