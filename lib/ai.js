const DEFAULT_PROMPT = `你是一位 AI/ML 论文研究员。阅读给定论文，输出严格的 JSON：
{
  "tldr": "一句话总结（中文，≤80字）",
  "contributions": ["关键贡献1", "关键贡献2"],
  "method": "方法简述（中文，3-5句）",
  "tags": ["lower-case-english-tag", ...],
  "topics": ["中文大方向1", "中文大方向2"],
  "concepts": [{"term": "概念名（中英文均可）", "definition": "1-2 句精炼解释"}],
  "metadata": { "title": "", "authors": [], "year": null }
}
要求：
- tags：3-6 个小写英文短语（用连字符），细粒度技术词。
- topics：1-3 个**中文**大方向词（如「强化学习」「数据选择」「推理」），用于粗粒度归类，不要与 tags 重复。
- concepts：3-8 个论文中值得学习的关键概念（术语/方法/指标），term 简短，definition 精炼。
- metadata 仅在标题/作者/年份缺失时填写，否则字段留空。只输出 JSON。`;

const CONCEPT_PROMPT = `你是一位 AI/ML 论文研究员。从给定论文中抽取**值得学习的关键概念**（术语、方法、核心指标）。
- 输出严格 JSON 数组：{"concepts":[{"term":"...","definition":"1-2句精炼解释"}]}
- term 用论文原文写法（中英文均可），definition 简明。
- 只返回**尚未出现在「已有概念」列表中的新概念**，避免重复。
- 数量 3-8 个，挑最有学习价值的。只输出 JSON。`;

function buildMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请按指定 JSON 格式输出。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 构造「增量抽取概念」的请求消息：把已有 term 喂给模型以避免重复 */
function buildConceptMessages({ title, abstract, fulltext, existingTerms, maxInputChars = 24000 }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const have = (existingTerms || []).slice(0, 500).join('、') || '（暂无）';
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n已有概念（避免重复）：${have}\n\n请抽取**新的**关键概念，按指定 JSON 输出。`;
  return [
    { role: 'system', content: CONCEPT_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 从模型文本输出解析 JSON，容忍代码块/前后噪声；失败返回 null */
function parseAiJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/** 概念抽取可能返回 {concepts:[...]} 或直接 [...]，统一规整为数组。
 *  注意：parseAiJson 只认 {…}，会把 [{…}] 里的内层对象误抓出来，因此这里先尝试裸数组。 */
function parseConceptResult(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 1) 先按裸数组解析
  const aFirst = s.indexOf('[');
  const aLast = s.lastIndexOf(']');
  if (aFirst !== -1 && aLast !== -1 && aLast > aFirst) {
    try {
      const arr = JSON.parse(s.slice(aFirst, aLast + 1));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  // 2) 再按对象解析（{concepts:[...]} 或其它）
  const obj = parseAiJson(s);
  if (obj) {
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.concepts)) return obj.concepts;
  }
  return [];
}

function buildSummaryMarkdown(obj) {
  if (!obj) return '*（总结生成失败，可点击「重新总结」重试）*';
  const lines = [];
  lines.push(`## TL;DR\n${obj.tldr || ''}`);
  if (Array.isArray(obj.contributions) && obj.contributions.length) {
    lines.push('## 关键贡献\n' + obj.contributions.map((c) => `- ${c}`).join('\n'));
  }
  if (obj.method) lines.push(`## 方法\n${obj.method}`);
  return lines.join('\n\n');
}

/** 调用 OpenAI 兼容 /chat/completions。fetchImpl 可注入。
 *  对 429（限流）/ 5xx 做指数退避重试，避免批量跑被网关瞬时限流误判为 error。 */
async function callChat({ messages, config, fetchImpl = fetch }) {
  const { baseURL, apiKey, model, timeoutMs = 120000 } = config.ai;
  const url = `${String(baseURL).replace(/\/$/, '')}/chat/completions`;
  const maxRetries = 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
      ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, messages, temperature: 0.3, response_format: { type: 'json_object' },
        }),
        signal,
      });
    } catch (e) {
      lastErr = e; // 网络层错误，退避重试
    }
    if (res) {
      if (res.ok) {
        const data = await res.json();
        return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      }
      // 429 / 5xx 可重试；其它（400 鉴权/模型不存在等）直接失败
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      const errText = await res.text().catch(() => '');
      lastErr = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
      if (!retryable) throw lastErr;
    }
    if (attempt < maxRetries) {
      const backoff = Math.min(30000, 2000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function summarize({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl });
  return parseAiJson(text);
}

/** 仅抽取概念（用于「对选中论文重新抽取并追加」） */
async function extractConcepts({ title, abstract, fulltext, existingTerms, config, fetchImpl = fetch }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildConceptMessages({ title, abstract, fulltext, existingTerms, maxInputChars });
  const text = await callChat({ messages, config, fetchImpl });
  return parseConceptResult(text);
}

module.exports = {
  DEFAULT_PROMPT, CONCEPT_PROMPT,
  buildMessages, buildConceptMessages, parseAiJson, parseConceptResult,
  buildSummaryMarkdown, summarize, extractConcepts, callChat,
};
