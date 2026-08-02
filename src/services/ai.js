// ============================================================================
// 提示词常量
// ============================================================================
//
// v2.4 起，总结与「标签/主题」拆成两次独立 AI 调用：
//   - summarize()        走自由 Markdown（jsonMode:false），用 DEFAULT_SUMMARY_PROMPT
//   - extractTagsTopics() 走强制 JSON（jsonMode:true），用 DEFAULT_TAGS_PROMPT
// 这样用户自定义的总结提示词（可能要求 Markdown/LaTeX 章节）不再与代码的 JSON
// 硬约束冲突——历史上正是这个冲突导致空总结 + 空标签。

/** 默认总结提示词：直接输出 Markdown，不包裹 JSON、不包代码块。
 *  产物结构与下方 buildSummaryMarkdown 兼容（接收原始 Markdown 字符串）。 */
const DEFAULT_SUMMARY_PROMPT = `你是一位 AI/ML 论文研究员。阅读给定论文，输出结构化的 Markdown 总结，包含以下章节：

## TL;DR
一句话总结（中文，≤80字）。

## 关键贡献
- 贡献 1
- 贡献 2
（列出 2-4 条核心贡献，每条一句话）

## 方法
方法简述（中文，3-5 句）。

要求：
- 直接输出 Markdown 正文，不要包裹在代码块里，不要输出 JSON。
- 内容基于论文实际内容，不要编造。
- 中文为主，专有名词 / 术语保留英文。`;

/** 默认标签/主题提示词：强制 JSON，只负责结构化分类信息（tags/topics/metadata）。
 *  - tags：细粒度英文技术标签；topics：粗粒度中文大方向。两者职责分离。
 *  - metadata 仅在标题/作者/年份缺失时回填，作为 arxiv 查不到时的兜底。 */
const DEFAULT_TAGS_PROMPT = `你是一位 AI/ML 论文分类专家。阅读给定论文，输出严格的 JSON：
{
  "tags": ["lower-case-english-tag", "..."],
  "topics": ["中文大方向1", "中文大方向2"],
  "metadata": { "title": "", "authors": [], "year": null }
}
要求：
- tags：3-6 个小写英文短语（用连字符），细粒度技术词（如 in-context-learning、mixture-of-experts）。
- topics：1-3 个**中文**大方向词（如「强化学习」「数据选择」「推理」），用于粗粒度归类，不要与 tags 重复。
- metadata 仅在标题/作者/年份缺失时填写，否则字段留空。只输出 JSON。`;

/** 向后兼容别名：旧代码引用 DEFAULT_PROMPT（现等价于总结提示词）。 */
const DEFAULT_PROMPT = DEFAULT_SUMMARY_PROMPT;

const CONCEPT_PROMPT = `你是一位 AI/ML 论文研究员。从给定论文中抽取**值得学习的关键概念**（术语、方法、核心指标）。
- 输出严格 JSON 数组：{"concepts":[{"term":"...","definition":"1-2句精炼解释"}]}
- term 用论文原文写法（中英文均可），definition 简明。
- 只返回**尚未出现在「已有概念」列表中的新概念**，避免重复。
- 数量 3-8 个，挑最有学习价值的。只输出 JSON。`;

/** 聊天系统提示词（角色=论文研究助手）。可被 settings.chatSystemPrompt / config.chatSystemPrompt 覆盖。 */
const DEFAULT_CHAT_SYSTEM_PROMPT = `你是一位 AI/ML 论文研究助手。用户正在就一篇论文向你提问，论文的标题、摘要和全文已作为上下文提供。
要求：
- 基于论文实际内容回答，不要编造论文未涉及的内容。
- 回答用 Markdown，以中文为主，专有名词/术语保留英文。
- 引用论文具体细节（方法、公式、数据、结论）时尽量给出出处或原文片段。
- 如问题超出论文范围，明确说明并尽量给出有依据的相关知识。
- 与已有多轮历史保持连贯，必要时回指上文。`;

/** 划线翻译系统提示词（engine=ai 时用）。无论文上下文，纯翻译用户选中的片段。
 *  保留专有名词/术语/公式/代码原文，只输出译文（不加解释、不加前后缀），便于就地阅读。 */
const TRANSLATE_SYSTEM_PROMPT = `你是一名专业学术翻译。将用户给出的文本翻译为指定目标语言。
要求：
- 只输出译文，不要加任何解释、注释、前后缀或引号。
- 专有名词、技术术语、模型/数据集名称保留原文（如 Transformer、BERT、ImageNet）。
- 数学公式（$...$ 或 $$...$$）、代码片段保持原样不翻译。
- 保留原文的换行与段落结构。
- 若原文已是目标语言，原样返回。`;

/** 默认笔记骨架提示词：基于全文生成结构化笔记初稿（六段式），输出自由 Markdown。
 *  章节用 ## 二级标题——前端/后端按 ^## 拆成骨架卡（src/core/notes.splitMarkdownToCards）。
 *  可被 settings.notesPrompt / config.notesPrompt 覆盖（三级回退，同 summaryPrompt 模式）。 */
const DEFAULT_NOTES_PROMPT = `你是一位 AI/ML 论文研究员。阅读给定论文，输出一份结构化读书笔记（Markdown），包含以下六个章节（## 二级标题，标题文字保持完全一致）：

## 🎯 研究问题
这篇论文要解决什么问题？为什么重要？（2-4 句）

## 💡 核心贡献
- 贡献 1
- 贡献 2
（2-4 条，每条一句话，突出「新在哪」）

## 🔧 方法拆解
方法的关键步骤与设计动机，必要时给公式（$...$）。分 3-5 点写清「怎么做的、为什么这样做」。

## 📊 实验与结果
关键实验设置与最重要的量化结果（带数字），以及与基线的对比结论。

## ⚠️ 局限与开放问题
论文自己承认的局限 + 你读出的潜在问题/未回答的疑问（2-4 条）。

## 🔁 可复用想法
这篇论文的哪些技巧/视角可以迁移到其它工作？（1-3 条）

要求：
- 直接输出 Markdown 正文，不要包裹代码块，不要输出 JSON。
- 六个章节标题原样保留（含 emoji），顺序不变；某章节论文确实未涉及时，正文写「（论文未提及）」。
- 内容必须基于论文实际内容，不要编造；数字/公式以原文为准。
- 中文为主，专有名词/术语保留英文。`;

// ============================================================================
// 消息构造
// ============================================================================

function buildSummaryMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请输出 Markdown 总结。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_SUMMARY_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 构造「论文聊天」请求消息：
 *  system = 聊天系统提示词（三级回退）；
 *  第一条 user = 论文上下文（标题/摘要/全文截断到 maxInputChars）——让模型掌握论文；
 *  随后追加历史多轮（history: [{role,content}]）；
 *  末尾追加本轮用户问题。
 *  全文为空（论文未解析）时退化为仅摘要，仍可问答。
 *
 *  extraPapers（v2.6 多论文 @ 引用）：用户在输入框用 @ 引用了其它论文联合问答时，
 *  每篇额外论文作为一个独立 context 块拼到主论文之后、history 之前。
 *  上下文预算：额外论文全文合计上限 = maxInputChars*0.6（保证主论文优先），按顺序分配超 budget 截断。
 *  每篇额外论文：摘要≤1500 + 全文≤6000（单篇上限，再受总 budget 约束）。 */
function buildChatMessages({
  title,
  abstract,
  fulltext,
  history,
  message,
  maxInputChars = 24000,
  systemPrompt,
  extraPapers,
}) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  let ctx = `以下是用户想要讨论的论文：\n标题：${title || '（未知）'}\n摘要：${head}${body ? `\n\n论文全文（节选）：\n${body}` : ''}\n\n请基于以上论文内容回答用户后续问题。`;
  // 额外论文（@ 引用）：按顺序分配全文 budget，超 budget 截断
  const extraList = Array.isArray(extraPapers)
    ? extraPapers.filter((x) => x && (x.title || x.abstract || x.fulltext))
    : [];
  if (extraList.length) {
    const SINGLE_FULLTEXT = 6000; // 单篇额外论文全文上限
    const SINGLE_ABSTRACT = 1500; // 单篇额外论文摘要上限
    const totalBudget = Math.floor(maxInputChars * 0.6); // 额外论文全文合计预算
    let used = 0;
    const blocks = [];
    extraList.forEach((ep, idx) => {
      const remain = Math.max(0, totalBudget - used);
      const cap = Math.min(SINGLE_FULLTEXT, remain);
      const epBody = (ep.fulltext || '').slice(0, cap);
      used += epBody.length;
      const epHead = (ep.abstract || '').slice(0, SINGLE_ABSTRACT);
      blocks.push(
        `=== 引用论文 ${idx + 1}：${ep.title || '（未知）'} ===\n摘要：${epHead}${epBody ? `\n\n全文（节选）：\n${epBody}` : ''}`,
      );
    });
    ctx += `\n\n${blocks.join('\n\n')}\n\n用户还引用了以上 ${extraList.length} 篇相关论文，回答时可跨论文对比、印证或引用。`;
  }
  const msgs = [
    { role: 'system', content: systemPrompt && systemPrompt.trim() ? systemPrompt : DEFAULT_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: ctx },
  ];
  // 历史轮次：紧接论文上下文，保持 assistant/user 交替（丢弃空 content）
  for (const m of history || []) {
    if ((m.role === 'user' || m.role === 'assistant') && m.content) msgs.push({ role: m.role, content: m.content });
  }
  // 本轮问题
  msgs.push({ role: 'user', content: message || '' });
  return msgs;
}

function buildTagsMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请按指定 JSON 格式输出 tags / topics / metadata。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_TAGS_PROMPT },
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

/** 向后兼容别名（旧测试/调用方引用 buildMessages）。 */
const buildMessages = buildSummaryMessages;

// ============================================================================
// JSON 容错解析
// ============================================================================

/** 从模型文本输出解析 JSON，容忍代码块/前后噪声；失败返回 null */
function parseAiJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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

/** 解析 extractTagsTopics 的输出，保证结构稳定：{ tags:[], topics:[], metadata|null }。
 *  解析失败时返回空结构（不抛），由 scanner 判定是否写入。 */
function parseTagsResult(text) {
  const obj = parseAiJson(text);
  if (!obj) return { tags: [], topics: [], metadata: null };
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t) => t != null) : [];
  const topics = Array.isArray(obj.topics) ? obj.topics.filter((t) => t != null) : [];
  const metadata = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : null;
  return { tags, topics, metadata };
}

// ============================================================================
// Markdown 归一化
// ============================================================================

/** 把模型返回的总结文本规整为可直接存储/渲染的 Markdown。
 *  - v2.4 起入参是**字符串**（summarize 不再返回 JSON 对象）。
 *  - 剥首尾空白与偶发的 ```markdown 围栏。
 *  - 空 / null 返回可重试占位，便于「重新总结」识别。 */
function buildSummaryMarkdown(md) {
  if (!md) return '*（总结生成失败，可点击「重新总结」重试）*';
  let s = String(md).trim();
  if (!s) return '*（总结生成失败，可点击「重新总结」重试）*';
  const fence = s.match(/^```(?:markdown|md)?\s*([\s\S]*?)```\s*$/i);
  if (fence) s = fence[1].trim();
  return s;
}

// ============================================================================
// 配置覆盖：store.settings.ai 运行时覆盖 config.ai
// ============================================================================

/** 把 store.settings.ai（用户在设置面板改的）合并到 config.ai 之上，返回**新的**
 *  effectiveConfig，不修改原 config（保持 config 只读语义，避免污染内存映像）。
 *  - 仅覆盖明确设置过的字段（undefined 的不覆盖）。
 *  - 空字符串视为「显式清空」（如 apiKey 清空）——由 PUT 端点决定是否允许。 */
function applySettingsOverride(config, settings) {
  const s = settings || {};
  const eff = { ...config };

  // --- ai 段：保持历史行为（白名单字段，!== undefined && !== '' 才覆盖；
  //     apiKey 空串视为「未设置」（如 apiKey 清空）——由 PUT 端点决定是否允许。
  //     extraModels（Phase 2 模型切换器静态候选列表）特殊：数组类型，!== undefined 即覆盖。---
  const aiOverride = s.ai || {};
  const baseAi = config && config.ai ? { ...config.ai } : {};
  for (const k of ['baseURL', 'apiKey', 'model', 'maxInputChars', 'timeoutMs']) {
    if (aiOverride[k] !== undefined && aiOverride[k] !== '') baseAi[k] = aiOverride[k];
  }
  if (Array.isArray(aiOverride.extraModels)) baseAi.extraModels = aiOverride.extraModels.slice();
  eff.ai = baseAi;

  // --- 以下新增段统一规则：!== undefined 即覆盖（正确处理布尔 false / 数值 0）。
  //     密钥类字符串沿用 ai.apiKey 语义：空串=未设置→回退 config。---

  // scanIntervalMinutes（顶层数值，0=关闭定时扫描）
  if (s.scanIntervalMinutes !== undefined) eff.scanIntervalMinutes = s.scanIntervalMinutes;

  // arxiv 段
  const arxivOverride = s.arxiv || {};
  const baseArxiv = config && config.arxiv ? { ...config.arxiv } : {};
  for (const k of ['enabled', 'titleSimilarityThreshold', 'minIntervalMs']) {
    if (arxivOverride[k] !== undefined) baseArxiv[k] = arxivOverride[k];
  }
  eff.arxiv = baseArxiv;

  // discover 段（weights 深合并，semanticScholarApiKey 空串回退 config）
  const discOverride = s.discover || {};
  const baseDisc = config && config.discover ? { ...config.discover } : {};
  for (const k of [
    'claudeTimeoutMs',
    'maxResults',
    'perAxis',
    'semanticScholar',
    'semanticScholarApiKey',
    'openAlex',
    'recencyWindowYears',
    'titleSimThreshold',
  ]) {
    if (discOverride[k] === undefined) continue;
    if (k === 'semanticScholarApiKey' && discOverride[k] === '') continue; // 密钥空串=未设置
    baseDisc[k] = discOverride[k];
  }
  if (discOverride.weights !== undefined) {
    const baseW = config && config.discover && config.discover.weights ? config.discover.weights : {};
    baseDisc.weights = { ...baseW, ...discOverride.weights };
  }
  eff.discover = baseDisc;

  // translate 段（划线翻译：engine / targetLang，`!== undefined` 即覆盖，与 arxiv/scan 同规则）
  const trOverride = s.translate || {};
  const baseTr = config && config.translate ? { ...config.translate } : {};
  if (trOverride.engine !== undefined) baseTr.engine = trOverride.engine;
  if (trOverride.targetLang !== undefined) baseTr.targetLang = trOverride.targetLang;
  eff.translate = baseTr;

  return eff;
}

// ============================================================================
// OpenAI 兼容 /chat/completions 调用
// ============================================================================

/** 调用 OpenAI 兼容 /chat/completions。fetchImpl 可注入。
 *  对 429（限流）/ 5xx 做指数退避重试，避免批量跑被网关瞬时限流误判为 error。
 *  - jsonMode=true（默认）：强制 response_format: json_object，用于结构化抽取。
 *  - jsonMode=false：不设 response_format，允许模型自由输出 Markdown / 纯文本（用于总结）。
 *  - chatParams.model：可选，覆盖 config.ai.model（前端模型切换器用，须经白名单校验）。
 *  - messages[i].content 支持数组（OpenAI 多模态：[{type:'text',text},{type:'image_url',image_url:{url}}]），
 *    原样透传给上游，用于视觉问答。 */
async function callChat({ messages, config, fetchImpl = fetch, jsonMode = true, chatParams }) {
  const { baseURL, apiKey, model, timeoutMs = 120000 } = config.ai;
  const url = `${String(baseURL).replace(/\/$/, '')}/chat/completions`;
  const cp = chatParams || {};
  const reqBody = { model: cp.model || model, messages, temperature: cp.temperature != null ? cp.temperature : 0.3 };
  if (cp.topP != null) reqBody.top_p = cp.topP;
  if (cp.maxTokens != null) reqBody.max_tokens = cp.maxTokens;
  if (cp.thinking != null) reqBody.thinking = cp.thinking; // GLM 对象格式 {type:"enabled"|"disabled"}，由 router 解析
  if (jsonMode) reqBody.response_format = { type: 'json_object' };
  const maxRetries = 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
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

/** 流式调用 OpenAI 兼容 /chat/completions（stream:true）。逐 token 经 onToken 回调下发，
 *  累积全部 token 后返回完整 reply 字符串（供持久化）。
 *  - 与 callChat 共享 429/5xx 指数退避重试，但**一旦首个 token 已下发就不再重试**（已部分输出，
 *    重试会导致前端收到重复内容）；仅连接层失败 / 429 / 5xx 在首 token 前重试。
 *  - onToken(text, kind) 回调：kind='reasoning'（思考过程）| 'content'（正文）；返回 false 可主动中断。
 *    reasoning_content（GLM/DeepSeek-R1 等 think 模型）也逐 token 回调，让前端实时显示思考过程。
 *  - 块解析：OpenAI SSE 响应体是 `data: {...}\n\n` 序列，每块 JSON 含 choices[0].delta.content / .reasoning_content；
 *    末块为 `data: [DONE]`。用 TextDecoder 解码 + 按 \n\n 分块累积。返回值仅累积 content（不含 reasoning）。 */
async function callChatStream({ messages, config, fetchImpl = fetch, jsonMode = false, onToken, chatParams }) {
  const { baseURL, apiKey, model, timeoutMs = 120000 } = config.ai;
  const url = `${String(baseURL).replace(/\/$/, '')}/chat/completions`;
  const cp = chatParams || {};
  const reqBody = {
    model: cp.model || model,
    messages,
    temperature: cp.temperature != null ? cp.temperature : 0.3,
    stream: true,
  };
  if (cp.topP != null) reqBody.top_p = cp.topP;
  if (cp.maxTokens != null) reqBody.max_tokens = cp.maxTokens;
  if (cp.thinking != null) reqBody.thinking = cp.thinking; // GLM 对象格式 {type:"enabled"|"disabled"}，由 router 解析
  if (jsonMode) reqBody.response_format = { type: 'json_object' };
  const maxRetries = 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
        signal,
      });
    } catch (e) {
      lastErr = e; // 网络层错误，退避重试
    }
    if (res) {
      if (res.ok) {
        // 消费 SSE 流：res.body 是 Web ReadableStream（Node 18+ fetch 原生支持）
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) {
          // 回退：个别实现无 body.getReader，按非流式读全文解析
          const text = await res.text();
          return parseSseBody(text, onToken);
        }
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let reply = '';
        let firstToken = true;
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (e) {
            lastErr = e;
            break;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          // 按 \n\n 分块，逐块解析
          let sep;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const tok = parseSseBlock(block, onToken);
            if (tok) {
              if (firstToken) firstToken = false;
              reply += tok;
            }
          }
        }
        if (!firstToken && lastErr) break; // 中途读流出错且已有输出 → 不重试，返回已收部分
        if (reply) return reply; // 正常完成
        if (lastErr && attempt < maxRetries) {
          // 无任何输出 + 出错 → 退避重试
        } else if (lastErr) {
          break;
        }
        continue;
      }
      // 429 / 5xx 可重试；其它直接失败
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

/** 解析单个 SSE 块（形如 `data: {...}`），提取 delta.content（正文）+ delta.reasoning_content（思考过程）。
 *  onToken(text, kind) 回调：kind='reasoning'（思考）| 'content'（正文）。返回累积的 content token（供持久化）。
 *  reasoning_content（GLM/DeepSeek-R1 等模型的 think 阶段）若存在，逐 token 回调让前端实时显示思考过程，
 *  不再让用户在 think 阶段干等「思考中」。reasoning 不计入返回的 reply（只存正文）。 */
function parseSseBlock(block, onToken) {
  const line = block.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const obj = JSON.parse(payload);
    const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (!delta) return '';
    let contentTok = '';
    // 思考过程（reasoning）：先于 content 到达，实时回调让前端显示
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (typeof onToken === 'function') {
        if (onToken(delta.reasoning_content, 'reasoning') === false) return '';
      }
    }
    // 正文（content）
    if (typeof delta.content === 'string' && delta.content) {
      if (typeof onToken === 'function') {
        if (onToken(delta.content, 'content') === false) return '';
      }
      contentTok = delta.content;
    }
    return contentTok;
  } catch {
    /* 非 JSON 行忽略 */
  }
  return '';
}

/** 解析整段 SSE 文本（无 body.getReader 时的回退路径）。返回累积 reply。 */
function parseSseBody(text, onToken) {
  let reply = '';
  for (const block of text.split('\n\n')) {
    reply += parseSseBlock(block, onToken);
  }
  return reply;
}

/** 生成总结：自由 Markdown 调用（jsonMode:false）。
 *  返回模型原文字符串（未解析 JSON）。调用方用 buildSummaryMarkdown 归一化后存储。 */
async function summarize({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildSummaryMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: false });
  return text;
}

/** 构造「笔记骨架」请求消息：与总结同构（标题/摘要/全文截断），system 用笔记提示词三级回退。 */
function buildNotesMessages({ title, abstract, fulltext, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n请输出结构化读书笔记。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_NOTES_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 生成笔记骨架：自由 Markdown 调用（jsonMode:false），返回六段式 Markdown 原文。
 *  调用方用 splitMarkdownToCards 拆成骨架卡。 */
async function generateNotes({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildNotesMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: false });
  return text;
}

/** 抽取标签/主题（+ metadata 兜底）：强制 JSON 调用。
 *  返回归一化后的 { tags:[], topics:[], metadata|null }，解析失败返回空结构（不抛）。 */
async function extractTagsTopics({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildTagsMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: true });
  return parseTagsResult(text);
}

/** 仅抽取概念（用于「对选中论文重新抽取并追加」） */
async function extractConcepts({ title, abstract, fulltext, existingTerms, config, fetchImpl = fetch }) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildConceptMessages({ title, abstract, fulltext, existingTerms, maxInputChars });
  const text = await callChat({ messages, config, fetchImpl });
  return parseConceptResult(text);
}

/** 论文聊天：注入论文上下文 + 历史 + 本轮问题，返回 AI 回复（自由 Markdown）。
 *  传 onToken 回调则走流式（callChatStream，逐 token 下发），否则走非流式 callChat（向后兼容）。
 *  extraPapers（v2.6 @ 引用）：用户 @ 引用的其它论文，作为额外 context 块注入（见 buildChatMessages）。 */
async function chatPaper({
  title,
  abstract,
  fulltext,
  history,
  message,
  config,
  systemPrompt,
  fetchImpl = fetch,
  onToken,
  chatParams,
  extraPapers,
  images,
}) {
  const { maxInputChars = 24000 } = config.ai;
  const messages = buildChatMessages({
    title,
    abstract,
    fulltext,
    history,
    message,
    maxInputChars,
    systemPrompt,
    extraPapers,
  });
  // 视觉问答（Phase 3）：把附图作为多模态 content 追加到末尾 user 消息。
  // OpenAI 兼容格式：content 从字符串升级为 [{type:'text',text}, {type:'image_url',image_url:{url}}]。
  // images = ['data:image/png;base64,...', ...]（前端框选 PDF 区域截图）。
  if (Array.isArray(images) && images.length) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const textPart = typeof last.content === 'string' ? last.content : '';
      last.content = [{ type: 'text', text: textPart }].concat(
        images.filter(Boolean).map((url) => ({ type: 'image_url', image_url: { url } })),
      );
    }
  }
  const reply = onToken
    ? await callChatStream({ messages, config, fetchImpl, jsonMode: false, onToken, chatParams })
    : await callChat({ messages, config, fetchImpl, jsonMode: false, chatParams });
  return reply;
}

/** 列出可用模型（Phase 2 模型切换器用）。
 *  - 优先调上游 OpenAI 兼容 /v1/models（带 apiKey）；失败/未配置回退 config.ai.model 单条 + extraModels。
 *  - 永不抛错：上游不可达时返回静态候选，保证前端模型切换器总能渲染。
 *  - 返回 { models: [{id, owned_by?}], default, current, source: 'upstream'|'config' }。 */
async function listModels({ config, fetchImpl = fetch, timeoutMs = 8000 }) {
  const model = config && config.ai && config.ai.model;
  const baseURL = config && config.ai && config.ai.baseURL;
  const apiKey = config && config.ai && config.ai.apiKey;
  const extra = config && config.ai && Array.isArray(config.ai.extraModels) ? config.ai.extraModels : [];
  const fallback = {
    models: [model]
      .filter(Boolean)
      .concat(extra)
      .map((id) => ({ id })),
    default: model,
    current: model,
    source: 'config',
  };
  if (!baseURL) return fallback;
  const url = `${String(baseURL).replace(/\/$/, '')}/models`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal });
    if (!res.ok) return fallback;
    const data = await res.json();
    const list = Array.isArray(data && data.data)
      ? data.data.map((m) => ({ id: m.id, owned_by: m.owned_by })).filter((m) => m && m.id)
      : Array.isArray(data && data.models)
        ? data.models
            .map((m) => (typeof m === 'string' ? { id: m } : { id: m.id, owned_by: m.owned_by }))
            .filter((m) => m && m.id)
        : [];
    if (!list.length) return fallback;
    // 合并 extraModels（用户静态补充），去重
    const seen = new Set(list.map((m) => m.id));
    for (const id of extra)
      if (id && !seen.has(id)) {
        list.push({ id });
        seen.add(id);
      }
    return { models: list, default: model, current: model, source: 'upstream' };
  } catch {
    return fallback;
  }
}

module.exports = {
  // 提示词常量
  DEFAULT_PROMPT, // 别名（向后兼容）
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TAGS_PROMPT,
  CONCEPT_PROMPT,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  DEFAULT_NOTES_PROMPT,
  // 消息构造
  buildMessages, // 别名（向后兼容）= buildSummaryMessages
  buildSummaryMessages,
  buildTagsMessages,
  buildConceptMessages,
  buildChatMessages,
  buildNotesMessages,
  // 解析
  parseAiJson,
  parseConceptResult,
  parseTagsResult,
  // 归一化
  buildSummaryMarkdown,
  // 配置覆盖
  applySettingsOverride,
  // AI 调用
  summarize,
  generateNotes,
  extractTagsTopics,
  extractConcepts,
  chatPaper,
  callChat,
  callChatStream,
  listModels,
};
