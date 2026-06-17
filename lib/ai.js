const DEFAULT_PROMPT = `你是一位 AI/ML 论文研究员。阅读给定论文，输出严格的 JSON：
{
  "tldr": "一句话总结（中文，≤80字）",
  "contributions": ["关键贡献1", "关键贡献2"],
  "method": "方法简述（中文，3-5句）",
  "tags": ["lower-case-english-tag", ...],
  "metadata": { "title": "", "authors": [], "year": null }
}
要求：tags 为 3-6 个小写英文短语（用连字符）；metadata 仅在标题/作者/年份缺失时填写，否则字段留空。只输出 JSON。`;

function buildMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请按指定 JSON 格式输出。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT },
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

/** 调用 OpenAI 兼容 /chat/completions。fetchImpl 可注入。 */
async function summarize({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { baseURL, apiKey, model, maxInputChars, timeoutMs = 120000 } = config.ai;
  const messages = buildMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetchImpl(`${String(baseURL).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages, temperature: 0.3, response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseAiJson(text);
}

module.exports = { DEFAULT_PROMPT, buildMessages, parseAiJson, buildSummaryMarkdown, summarize };
