// ============================================================================
// 提示词常量
// ============================================================================
//
// v2.4 起，总结与「标签/主题」拆成两次独立 AI 调用：
//   - summarize()        走自由 Markdown（jsonMode:false），用 DEFAULT_SUMMARY_PROMPT
//   - extractTagsTopics() 走强制 JSON（jsonMode:true），用 DEFAULT_TAGS_PROMPT
// 这样用户自定义的总结提示词（可能要求 Markdown/LaTeX 章节）不再与代码的 JSON
// 硬约束冲突——历史上正是这个冲突导致空总结 + 空标签。

const { createLogger } = require('../core/logger');

// 重试/超时等可诊断事件走 warn（生产默认阈值 warn，info 级会被吞掉）。
const logger = createLogger('ai');

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

/** 默认概念抽取提示词（v3.28 优化）：对齐公式提示词质量 + 融合 ConExion/ATE 研究要点——
 *  强制抽取式（禁止编造文档外术语）、noun phrase 约束、明确排除规则、term 作为跨论文合并 key、
 *  definition 对齐公式的 description 精细度（是什么+为什么+作用，不复述 term）。
 *  v3.28 新增 importance（core/supporting，本篇视角的核心度——跨论文合并只升不降），
 *  context 强化为「章节号 + 式/图号 + 在此处干什么」（回溯价值）。
 *  可被 settings.conceptPrompt / config.conceptPrompt 覆盖（三级回退）。 */
const DEFAULT_CONCEPT_PROMPT = `你是一位跨领域的学术术语学家与本体编辑。任务：从给定论文中抽取**论文实际提出的、或为理解论文不可或缺的关键概念**，产出可直接并入跨论文术语库的规范条目。

## 通用性（领域自适应，必须遵守）
- 先判断论文所属领域；术语的**规范命名、分类、表述惯例一律采用该领域的学术规范**——不要把 AI/ML 惯例强加给数学、物理、生物、经济、法学等领域的论文。
- category 优先从下表的**广义语义**中选（小写英文，跨领域稳定）；仅当全都不贴切时，才用该领域通行的小写英文类别词（如 theory / method / metric / phenomenon / task / dataset / protocol）：
  - \`architecture\`：模型/系统结构（网络、架构、框架、构造）
  - \`attention\`：核心机制模块（信息聚合、门控、路由类机制）
  - \`loss\`：目标/损失/代价/能量函数
  - \`optimization\`：优化算法、求解器、迭代格式
  - \`regularization\`：约束、正则、稳定性条件
  - \`generative\`：生成式建模
  - \`representation\`：表示、嵌入、编码
  - \`training\`：训练/校准范式、数据到模型的流程
  - \`evaluation\`：评估指标、实验设计、检验方法
  - \`inference\`：推理、解码、判定过程
  - \`other\`：以上皆不贴切（定理、数据对象、理论分析等）

## 输出格式（严格 JSON，不要 markdown 围栏，不要任何解释文字）
{"concepts":[{"term":"Scaled Dot-Product Attention","definition":"通过查询与键的点积衡量相关度、softmax 归一化后对值加权求和的注意力计算（scaled dot-product attention）；用缩放因子 1/√d_k 抵消点积随维度增大导致的梯度消失。","category":"attention","importance":"supporting","context":"3.2.1 节，式(1)：本篇用它作为基础注意力单元"}]}

## 核心原则（必须严格遵守）
- **抽取式，禁止幻觉**：只抽取**论文中真实出现**的概念；绝不基于你的知识"补充"论文未提及的术语。每个 term 必须能在论文全文中找到出处。
- **term 必须是名词短语**：该领域学界命名的实体——方法名 / 机制名 / 模型结构 / 定理引理 / 重要度量。禁止动词短语、整句、形容词、泛指词。
- **term 是跨论文合并的唯一 key，并做同义词折叠**：命名归一化到该领域最通用的规范写法。若论文用局部别名/非规范名指称某个规范概念，输出**规范名**，并在 context 里注明论文局部名（如"论文中称为 X"）。同一概念在不同论文里必须输出相同 term，否则无法归并；已有概念清单里出现过的写法**必须复用**。

## 字段约束
- **term**：规范学术名。英文按该领域惯例（AI/ML 多用 Title Case，数学/物理惯例保留斜体名与下标语义如 L^p 空间写 "Lp Space"）；中文术语用学界通行译名。禁止缩写与全称拆成两条；优先用最通用形式。
- **definition**：按**学术综述的表述标准**写 1-3 句中文（建议 30-90 字），必须做到：
  ① **独立成立**——不使用"本文/该文/我们"等指代，脱离这篇论文也能读（综述可直接引用）；
  ② 三要素：是什么（机制/定义）＋解决什么问题/为什么存在＋在论文中的角色；
  ③ **教学自包含**：定义内首次出现的相邻子概念，用半句括号补义（如 "自注意力（序列元素两两相关度加权的聚合）"）；
  ④ 术语保留英文原文，中文表述，不复述 term 字面。
- **importance**：该概念**在本篇**中的地位：\`core\`=本篇核心创新（判断标准：拿掉它论文不成立；通常每篇 ≤2 个）；\`supporting\`=支撑技术/背景组件。
- **context**：可回溯出处——「章节号/式号/图号/定理号 + 半句话它在此处做什么」，优先**首次定义处**；论文无编号时给大致位置。禁止只写"正文"。

## 高频概念规范名对照表（AI/ML 领域；命中学名时必须用此写法；其他领域用该领域规范名，同构处理）
Transformer、Attention、Self-Attention、Multi-Head Attention、Cross-Attention、Scaled Dot-Product Attention、Flash Attention、
CNN、RNN、LSTM、GRU、ResNet、U-Net、Encoder-Decoder、Autoencoder、Mixture of Experts、State Space Model、Mamba、
KL Divergence、Cross-Entropy Loss、Contrastive Loss、Triplet Loss、MSE、CTC Loss、InfoNCE、
Adam、SGD、AdamW、Learning Rate Warmup、Cosine Learning Rate Schedule、Dropout、Batch Normalization、Layer Normalization、RMSNorm、Weight Decay、Gradient Clipping、
GAN、VAE、Diffusion Model、DDPM、Diffusion Transformer、Score-Based Model、Flow Matching、Rectified Flow、Autoregressive Model、
Embedding、Word2Vec、Contrastive Learning、Self-Supervised Learning、Metric Learning、
Pre-training、Fine-tuning、Transfer Learning、RLHF、DPO、LoRA、QLoRA、Chain-of-Thought、Instruction Tuning、Speculative Decoding、
BLEU、ROUGE、FID、IS、Perplexity、Ablation Study、Human Evaluation、
Beam Search、Top-k Sampling、Top-p Sampling、Temperature Sampling、KV Cache、Grouped Query Attention、
Data Augmentation、Backpropagation、Knowledge Distillation、Quantization、Pruning、Mixture of Experts Routing

## 抽取优先级（数量 3-12 个，宁缺毋滥）
1. 论文的核心创新/主打方法（必须抽，importance 标 core）。
2. 反复使用的、理解论文不可或缺的关键组件/机制。
3. 论文定义/提出的目标函数、度量、构造。
4. 标题/摘要里点名的核心术语。
**坚决不要抽**：过于常识的通用词；仅在 related work 一笔带过的他人方法（除非本文核心是改进它）；未实际使用的工具/库名；动词短语与整句。

## 去重
只返回**尚未出现在「已有概念」列表中的新概念**（按规范名比对，大小写/单复数/连字符不敏感）。若全部已存在，返回 \`{"concepts":[]}\`。

只输出 JSON。`;

/** 向后兼容别名（旧名 CONCEPT_PROMPT = DEFAULT_CONCEPT_PROMPT，避免破坏现有 import）。 */
const CONCEPT_PROMPT = DEFAULT_CONCEPT_PROMPT;

/** 概念地图生成提示词（v3.10）：把概念清单喂给模型，产出**单文件 HTML 全览图**。
 *  v3.16 在 v3.10 暗色版（用户反馈效果最好）的美学骨架上做**浅色化**——保留鲜艳渐变主色、
 *  玻璃拟态卡片质感、氛围光晕背景、大胆展示字体、3 视图交互与微动画，仅把深底翻成浅底。
 *  可被 settings.conceptMapPrompt 覆盖。 */
const DEFAULT_CONCEPT_MAP_PROMPT = `你是一位顶尖的前端可视化设计师 + AI/ML 知识架构师。给定一份概念清单（含术语、解释、分类、出现论文），生成一个**单文件 HTML 概念总览图**，目的是帮助用户一眼厘清这些概念之间的整体脉络与分类结构。

## 设计美学（浅色 + 玻璃拟态高级风，必须遵循）
- **浅色主题**：明亮背景（#f8fafc / #f1f5f9 / #eef2ff 系冷白/淡蓝灰），但**不是纯白死底**——叠多层 CSS 径向/线性渐变光晕（如 indigo/violet/sky 的极淡色斑，透明度 0.08-0.15）营造层次与深度。
- **玻璃拟态卡片**：卡片用半透明白底（rgba(255,255,255,.65~.8)）+ backdrop-filter: blur(12-18px) saturate(1.4) + 1px 半透明边框（rgba(255,255,255,.6)）+ 柔和投影（0 8px 32px rgba(79,70,229,.12)）。卡片浮在光晕背景上，有通透质感。
- **鲜艳渐变主色**：主色用渐变（#6366f1 indigo → #8b5cf6 violet → #ec4899 pink 系），渐变用于主标题文字（background-clip:text）、主按钮、强调连线、分类徽标。每个分类一个鲜明强调色（sky/emerald/amber/rose/violet/teal 系），分类色用于该组卡片的边框/徽标/节点。
- **大胆字体**：标题用有表现力的展示字体（Google Fonts，如 Space Grotesk / Sora / Outfit / Manrope，别用 Arial/Inter/system）；主标题用渐变文字 + 大字号（≥36px、font-weight 800）；正文清晰可读（15-16px、行高 1.6）。
- **微动画**：页面加载用 staggered reveal（animation-delay 错峰进场）；hover 有缩放(1.02-1.04)/上浮/发光/边框高亮；视图切换有过渡。CSS-only 实现优先，时长 200-400ms。

## 交互（让界面"活"起来，不要静态）
- 顶部一排**视图切换按钮**，至少提供 3 种视图，点击平滑切换：
  1. **架构图/分组视图**：按 category 分组（注意力/损失/架构/优化...），每组一个玻璃卡片，组内概念以节点/标签排布，组间用连线或层级暗示关系。
  2. **矩阵图/网格视图**：概念按 [分类 × 频次/出现论文数] 排成矩阵或 treemap，格子大小/颜色深浅反映重要性。
  3. **关系/韦恩图视图**：用重叠区域或网络图展示分类间的交集（同一论文涉及多分类时）。
- 每个概念可点击/hover 显示其 definition 与出现论文（用输入数据里的信息）。
- 提供图例（颜色 = 分类）；概念多时有搜索框或分类筛选 chips。

## 技术硬约束（必须严格遵守）
- **单个 HTML 文件**，所有 CSS/JS 内联；外部资源仅限 cdnjs.cloudflare.com（Google Fonts 经 fonts.googleapis.com 也可）。
- **禁止** localStorage / sessionStorage / cookie / 任何浏览器存储 API；状态用 JS 变量保存。
- 必须能在浏览器直接打开运行（<!DOCTYPE html> 开头，无构建步骤、无占位符）。
- 数据直接写死在 JS 变量里（从输入的概念清单映射）。

## 输入
会提供概念清单（JSON 数组，每项含 term/definition/category/paperIds 或论文标题）。

## 输出
**只输出完整的 HTML 文档**（从 <!DOCTYPE html> 到 </html>），不要 markdown 代码块围栏、不要任何解释文字。`;

/** 默认公式抽取提示词（v3.9）：强制 JSON，抽「核心公式」并**归一化到一般形式**。
 *  可被 settings.formulaPrompt / config.formulaPrompt 覆盖（三级回退，同 summaryPrompt 模式）。
 *
 *  设计要点：
 *  - `canonicalName` 是跨论文合并的唯一 key（src/core/formulas mergeFormulas），所以内置一份
 *    高频公式规范名对照表压住命名漂移——模型把 KL 散度一会儿叫 kl-divergence 一会儿叫
 *    kullback-leibler-divergence 就会合并失败。
 *  - `latex` 要求「领域通用符号」，论文的个性化记号进 rawLatex + symbolMap，
 *    否则清单页展示的不是「一般形式」而是某一篇的私有写法。
 *  - v3.28：description 升级为「三问」结构（做什么/设计直觉/适用边界）；
 *    variables.meaning 要求带维度或单位；新增 conceptTerms（与本篇概念清单对齐的显式关联，
 *    概念页与公式页由此打通——用户消息里会注入本篇概念清单供挑选）。 */
const DEFAULT_FORMULA_PROMPT = `你是一位跨领域的数学审读者。从给定论文中抽取**核心公式**，归一化到该领域**教科书式的一般形式**。

## 通用性（领域自适应）
- 先判断论文领域；**记号惯例按该领域标准**（AI/ML 矩阵与期望记号、数学的集合论/测度论记号、物理的 SI 与求和惯例……），不要把 AI/ML 记号强加给其他领域。
- canonicalName 用**该领域学界通用英文规范名**（小写连字符）；下方对照表仅是 AI/ML 高频示例，其他领域按同样构词法取规范名（如 bayes-theorem、jensen-inequality、navier-stokes-equation）。

输出严格 JSON：
{"formulas":[{
  "canonicalName": "scaled-dot-product-attention",
  "name": "缩放点积注意力",
  "latex": "\\\\mathrm{Attention}(Q,K,V)=\\\\mathrm{softmax}\\\\left(\\\\frac{QK^\\\\top}{\\\\sqrt{d_k}}\\\\right)V",
  "description": "做什么：以查询与键的相似度对值加权聚合信息。设计直觉：除以 √d_k 把点积方差拉回 1，避免 softmax 进入饱和区导致梯度消失。适用边界：适合键值无强结构先验的序列建模；O(n²) 复杂度在长序列下需近似变体。",
  "category": "attention",
  "variables": [{"symbol":"Q","meaning":"查询矩阵（行数=序列长度 n，列数=头维度 d_k）","role":"input"},
                {"symbol":"d_k","meaning":"键/查询向量维度（标量）","role":"param"}],
  "plottable": false,
  "plotHint": null,
  "rawLatex": "论文原文里的写法（保留其个性化记号）",
  "context": "式(1)，3.2 节",
  "symbolMap": {"d_k": "d"},
  "conceptTerms": ["Scaled Dot-Product Attention"]
}]}

要求：
- 只抽 **3-8 个核心公式**：论文自己提出的方法、目标/损失函数、关键度量定义、关键定理结论式。
  **不要**抽引用他人的背景公式、推导中间步骤、纯符号定义。
- **latex 是归一化的一般形式**：该领域教科书会用的记号，不照抄论文个性化写法；论文原写法放 rawLatex，差异放 symbolMap（{通用符号: 论文符号}）。**教科书式标准**：读者不翻论文也能读懂每个符号的含义。
- **description 按三问结构写**（2-4 句中文）：
  ①**做什么**——公式计算的量、输入输出关系；
  ②**设计直觉**——为什么长这样/关键项在防什么问题；
  ③**适用边界**——成立前提、失效场景或复杂度量级（若适用）。
  若是**有标准名称的经典公式/定理**（Jensen 不等式、Bayes 定理、Nash 均衡……），首句给标准名与惯常归属（如"Jensen 不等式（Jensen's inequality）"），提高教学引用价值。
  不复述符号定义（那是 variables 的事），不空泛。
- **canonicalName**：小写英文+连字符，领域通用名。AI/ML 高频对照（务必沿用这些写法）：
  scaled-dot-product-attention、multi-head-attention、softmax、sigmoid、layer-norm、batch-norm、
  rms-norm、cross-entropy-loss、kl-divergence、js-divergence、elbo、reparameterization-trick、
  mse-loss、contrastive-loss、info-nce、adam-update、sgd-momentum、cosine-lr-schedule、
  policy-gradient、ppo-clip-objective、bellman-equation、td-error、gae、q-learning-update、
  rope-positional-encoding、sinusoidal-positional-encoding、moe-gating、top-k-routing、
  perplexity、bleu、rouge、f1-score、diffusion-forward-process、diffusion-reverse-process、
  score-matching-objective、flash-attention-tiling、lora-decomposition。
- **variables**：列出公式里每个符号，role ∈ input|param|output|const；meaning 写**语义 + 形状/量纲/类型**，按该领域惯例（"查询矩阵（n×d_k）"、"步长，标量"、"概率密度，无量纲"）——只写"一个矩阵"不合格。
- **conceptTerms**：用户消息里给出「本篇概念清单」。列出与该公式**直接相关**的概念规范 term（≤3 个，写法与清单完全一致）；无则空数组。宁可少给不要硬凑。
- **plottable**：仅当可化为单变量实函数 y=f(x) 且曲线有意义时为 true，plotHint 给 {"variable":"x","range":[lo,hi],"params":{"其它符号":取值},"plotExpr":"可求值表达式（+ - * / ^ 与 sin cos exp log sqrt abs min max，常量 pi；引用 params 符号）"}，否则 null。例：衰减 e^{-γx} → plotExpr 为 "exp(-gamma*x)"，params 给 {"gamma":0.5}。
- **latex 必须是 KaTeX 可渲染子集**：禁止 \\newcommand、自定义宏；多行只用 aligned/cases。
- 已在「已有公式」列表中的**不要重复造条目**——若本篇确实用到仍要输出（canonicalName 保持一致），只需填 rawLatex / context / symbolMap，其余字段可留空。
- 只输出 JSON。`;

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

// ============================================================================
// 输入预算：每任务独立上限（v3.9）
// ============================================================================

const DEFAULT_MAX_INPUT_CHARS = 24000;
/** 默认最大输入 **tokens**（OpenAI 标准：上下文窗口以 token 计，非字符）。
 *  32000 ≈ 旧 24000 字符的 token 等价（÷3.5），对 128K 上下文模型安全；1M 模型可填 1000000。 */
const DEFAULT_MAX_INPUT_TOKENS = 32000;
/** token→字符换算系数（中英混排安全估值：英文 ~4 chars/token、中文 ~1.5，取 3.5 偏保守，宁可少喂不超限）。 */
const CHARS_PER_TOKEN = 3.5;
/** 可独立配置输入上限的任务名。新增任务要同步 public/app.js 设置页的输入项。 */
const INPUT_BUDGET_TASKS = ['summary', 'tags', 'notes', 'concepts', 'formulas', 'chat'];

/** token 数 → 字符预算（向下取整；非正/NaN → 0 表示「无效，回退」）。
 *  build*Messages 仍按字符 .slice，故 token 上限在此折算成字符预算。 */
function tokensToCharBudget(tokens) {
  const t = Number(tokens);
  return Number.isFinite(t) && t > 0 ? Math.floor(t * CHARS_PER_TOKEN) : 0;
}

/** 取某任务的全文输入上限（**返回字符预算**，供 build*Messages 的 .slice 直接用）。
 *  优先级（v3.11 起以 tokens 为准，旧 chars 字段作废弃别名向后兼容）：
 *    ai.taskMaxInputTokens[task] > ai.maxInputTokens
 *    > （旧）ai.taskMaxInputChars[task] > （旧）ai.maxInputChars
 *    > DEFAULT_MAX_INPUT_TOKENS（折算成字符）
 *  - tokens 字段命中 → tokensToCharBudget(tokens)（token×3.5）；
 *  - 仅旧 chars 字段命中 → 原值直传（兼容存量 config.json / papers.json，按字符语义不变）；
 *  - 都没设 → tokensToCharBudget(DEFAULT_MAX_INPUT_TOKENS)。
 *  null / '' / 非正数 视为「跟随全局」（设置页清空即回落），故不能简单用 `?? `。
 *  **单一入口**：ai.js 内所有 build*Messages 一律经它取值，勿再各自解构 config.ai.maxInputChars。
 *  返回值名义仍是「字符预算」——历史调用方（含聊天 maxInputChars*0.6、pickMathDenseText cap）零改动。 */
function resolveMaxInputChars(config, task) {
  const ai = (config && config.ai) || {};
  const perTok = ai.taskMaxInputTokens || {};
  const perChar = ai.taskMaxInputChars || {};
  // 1. 任务级 tokens
  const taskTok = Number(perTok[task]);
  if (Number.isFinite(taskTok) && taskTok > 0) return tokensToCharBudget(taskTok);
  // 2. 全局 tokens
  const globalTok = Number(ai.maxInputTokens);
  if (Number.isFinite(globalTok) && globalTok > 0) return tokensToCharBudget(globalTok);
  // 3. 任务级 chars（旧别名）
  const taskChar = Number(perChar[task]);
  if (Number.isFinite(taskChar) && taskChar > 0) return taskChar;
  // 4. 全局 chars（旧别名）
  const globalChar = Number(ai.maxInputChars);
  if (Number.isFinite(globalChar) && globalChar > 0) return globalChar;
  // 5. 内置默认（tokens 折算）
  return tokensToCharBudget(DEFAULT_MAX_INPUT_TOKENS);
}

// 数学密度打分用的符号集：运算符 / 关系符 / 集合符 / 希腊字母 / pdfjs 抽取残留的私有字形。
// 私有字形（U+0000-U+001F）是 pdfjs 抽 PDF 数学字体时的典型产物（如 ε → \u000f），
// 它本身就是「这段有公式」的强信号，故计入密度。
/* eslint-disable no-control-regex -- 私有字形（pdfjs 数学字体残留）正是「此处有公式」的强信号 */
const MATH_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f∑∏∫∮∇∂√∞≤≥≠≈≡∝∈∉⊂⊆∀∃⊕⊗×÷±∧∨¬→←↔⇒⇔∥⌊⌋⌈⌉αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/g;
/* eslint-enable no-control-regex */

/** 段落数学密度：数学符号数 + 等号数，按长度归一（短段不因基数小而虚高，故加平滑项）。 */
function mathDensity(s) {
  const mathHits = (s.match(MATH_CHARS_RE) || []).length;
  const eqHits = (s.match(/=/g) || []).length;
  return (mathHits + eqHits) / (s.length + 200);
}

/**
 * 全文预筛：公式散布全篇，直接 `slice(0, budget)` 会漏掉后半篇的公式。
 * - 不超预算：**原样返回**（128k 上下文模型下多数论文走这条，零信息损失）。
 * - 超预算：按空行切段，按数学密度降序选段直到填满预算，再**按原文顺序**拼回，段间插 `\n…\n`。
 * - 全篇无数学符号（密度全 0）：退化为头部截断，不返回空。
 */
function pickMathDenseText(fulltext, budget) {
  const text = String(fulltext || '');
  if (!text) return '';
  const cap = Number(budget) > 0 ? Number(budget) : DEFAULT_MAX_INPUT_CHARS;
  if (text.length <= cap) return text;

  const paras = text.split(/\n\s*\n/).map((p, i) => ({ i, p, d: mathDensity(p) }));
  if (!paras.some((x) => x.d > 0)) return text.slice(0, cap);

  const picked = [];
  let used = 0;
  for (const item of [...paras].sort((a, b) => b.d - a.d)) {
    if (item.d <= 0) break;
    const cost = item.p.length + 3; // 段间分隔符开销
    if (used + cost > cap) continue; // 跳过放不下的，继续找更小的密集段
    picked.push(item);
    used += cost;
  }
  if (!picked.length) return text.slice(0, cap);
  picked.sort((a, b) => a.i - b.i);
  return picked
    .map((x) => x.p)
    .join('\n…\n')
    .slice(0, cap);
}

/** 构造「增量抽取公式」的请求消息：把已有公式（规范名 + latex）喂给模型以避免重复造条目。
 *  conceptTerms（v3.28）：本篇概念清单（规范 term），供模型输出 conceptTerms 显式关联——
 *  公式页与概念页的知识由此打通。 */
function buildFormulaMessages({ title, abstract, fulltext, existingFormulas, conceptTerms, maxInputChars, prompt }) {
  const cap = Number(maxInputChars) > 0 ? Number(maxInputChars) : DEFAULT_MAX_INPUT_CHARS;
  const head = (abstract || '').slice(0, 4000);
  const body = pickMathDenseText(fulltext, cap);
  const have =
    (existingFormulas || [])
      .slice(0, 200)
      .map((f) => `- ${f.canonicalName}：$${f.latex || ''}$`)
      .join('\n') || '（暂无）';
  const terms = (conceptTerms || []).slice(0, 120).join('、') || '（暂无）';
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n本篇概念清单（conceptTerms 从中挑选，term 写法必须与此完全一致）：\n${terms}\n\n已有公式（沿用其 canonicalName，勿重复造条目）：\n${have}\n\n请抽取本篇的核心公式，按指定 JSON 输出。`;
  return [
    { role: 'system', content: prompt && prompt.trim() ? prompt : DEFAULT_FORMULA_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 构造「增量抽取概念」的请求消息：把已有 term 喂给模型以避免重复 */
function buildConceptMessages({ title, abstract, fulltext, existingTerms, maxInputChars = 24000, prompt }) {
  const head = (abstract || '').slice(0, 4000);
  const body = (fulltext || '').slice(0, maxInputChars);
  const have = (existingTerms || []).slice(0, 500).join('、') || '（暂无）';
  const user = `标题：${title || '（未知）'}\n摘要：${head}\n\n论文全文（节选）：\n${body}\n\n已有概念（避免重复）：${have}\n\n请抽取**新的**关键概念，按指定 JSON 输出。`;
  return [
    { role: 'system', content: prompt && String(prompt).trim() ? String(prompt).trim() : DEFAULT_CONCEPT_PROMPT },
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

/** 公式抽取输出解析：与 parseConceptResult 同款「先裸数组、再包裹对象」双路容错。
 *  裸数组优先是因为 parseAiJson 只认 `{…}`，会把 `[{…}]` 里的内层对象误抓出来。 */
function parseFormulaResult(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const aFirst = s.indexOf('[');
  const aLast = s.lastIndexOf(']');
  if (aFirst !== -1 && aLast !== -1 && aLast > aFirst) {
    try {
      const arr = JSON.parse(s.slice(aFirst, aLast + 1));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  const obj = parseAiJson(s);
  if (obj) {
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.formulas)) return obj.formulas;
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

/** 渠道全局化（v3.19）：把全局渠道（app_state['globalAi']，经 manager.getGlobalAi() 拿到）
 *  合并进 per-space settings 的 ai 段，供 applySettingsOverride 消费。
 *  全局渠道存在 → 权威替换 settings.ai.channels/activeChannelId；不存在 → 原样返回
 *  （回落 per-space channels → 旧版顶层三元组 → config 的优先级阶梯）。
 *  纯函数：返回浅拷贝，不改入参。 */
function withGlobalAi(settings, gai) {
  const s = settings || {};
  if (!gai || !Array.isArray(gai.channels) || !gai.channels.length) return s;
  return { ...s, ai: { ...(s.ai || {}), channels: gai.channels, activeChannelId: gai.activeChannelId } };
}

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
  for (const k of ['baseURL', 'apiKey', 'model', 'maxInputChars', 'maxInputTokens', 'timeoutMs']) {
    if (aiOverride[k] !== undefined && aiOverride[k] !== '') baseAi[k] = aiOverride[k];
  }
  if (Array.isArray(aiOverride.extraModels)) baseAi.extraModels = aiOverride.extraModels.slice();
  // taskMaxInputChars（旧别名）/ taskMaxInputTokens（v3.11 主字段）：每任务输入预算，**深合并**，同 discover.weights。
  // 值语义由 resolveMaxInputChars 定义（null/''/非正数 = 跟随全局），故原样写入不过滤——
  // 设置页清空某任务时正是靠写 null 回落全局。
  if (aiOverride.taskMaxInputChars !== undefined) {
    const baseT = config && config.ai && config.ai.taskMaxInputChars ? config.ai.taskMaxInputChars : {};
    baseAi.taskMaxInputChars = { ...baseT, ...(aiOverride.taskMaxInputChars || {}) };
  }
  if (aiOverride.taskMaxInputTokens !== undefined) {
    const baseT = config && config.ai && config.ai.taskMaxInputTokens ? config.ai.taskMaxInputTokens : {};
    baseAi.taskMaxInputTokens = { ...baseT, ...(aiOverride.taskMaxInputTokens || {}) };
  }
  // --- v3.13 多渠道：settings.ai.channels + activeChannelId。
  //     渠道列表非空且 activeChannelId 命中时，该渠道的 baseURL/apiKey/model/maxInputTokens
  //     权威覆盖上面合并出的单配置（渠道是单一事实源）；渠道 maxInputTokens 空 = 跟随全局。
  //     所有渠道 model 并入 extraModels（聊天切换器白名单 + listModels 候选自动包含渠道模型）。
  const chanList = Array.isArray(aiOverride.channels) ? aiOverride.channels : [];
  if (chanList.length) {
    const merged = Array.isArray(baseAi.extraModels) ? baseAi.extraModels.slice() : [];
    const seen = new Set(merged);
    for (const c of chanList) {
      if (c && c.model && !seen.has(c.model)) {
        seen.add(c.model);
        merged.push(c.model);
      }
    }
    baseAi.extraModels = merged;
    const active = chanList.find((c) => c && c.id === aiOverride.activeChannelId) || null;
    if (active) {
      if (typeof active.baseURL === 'string' && active.baseURL) baseAi.baseURL = active.baseURL;
      if (typeof active.apiKey === 'string') baseAi.apiKey = active.apiKey; // 渠道显式空 key = 无鉴权网关
      if (typeof active.model === 'string' && active.model) baseAi.model = active.model;
      if (Number(active.maxInputTokens) > 0) baseAi.maxInputTokens = Number(active.maxInputTokens);
    }
  }
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

  // formulas 段（公式抽取引擎：engine=ai|mineru，mineruUrl，namingPrompt（MinerU 命名提示词））
  const fOverride = s.formulas || {};
  const baseF = config && config.formulas ? { ...config.formulas } : {};
  if (fOverride.engine !== undefined) baseF.engine = fOverride.engine;
  if (fOverride.mineruUrl !== undefined && fOverride.mineruUrl !== '') baseF.mineruUrl = fOverride.mineruUrl;
  // namingPrompt 空串=回退默认（与 mineruUrl/apiKey 一致），!== '' 才覆盖
  if (fOverride.namingPrompt !== undefined && fOverride.namingPrompt !== '')
    baseF.namingPrompt = fOverride.namingPrompt;
  eff.formulas = baseF;

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
 *  - chatParams.timeoutMs：可选，单次调用超时覆盖（如概念地图等大产出生成远超默认 120s）。
 *  - chatParams.maxRetries：可选，重试次数覆盖（长耗时调用应调小，避免超时后反复重试白白耗时）。
 *  - chatParams.signal：可选，外部取消信号（如后台任务被用户删除时主动中断），与超时信号合并。
 *  - messages[i].content 支持数组（OpenAI 多模态：[{type:'text',text},{type:'image_url',image_url:{url}}]），
 *    原样透传给上游，用于视觉问答。 */

/** 合成请求中止信号：超时（AbortSignal.timeout）+ 外部取消信号（chatParams.signal）二合一。
 *  AbortSignal.any 需 Node 20+（项目要求 ≥20）；不可用时退化为仅超时信号。 */
function composeChatSignal(effTimeoutMs, externalSignal) {
  const timeoutSignal =
    typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(effTimeoutMs) : undefined;
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal !== 'undefined' && AbortSignal.any && timeoutSignal) {
    return AbortSignal.any([timeoutSignal, externalSignal]);
  }
  return externalSignal;
}

/** 429/5xx 指数退避等待（2s→4s→8s→16s，封顶 30s + ≤0.5s 抖动）。
 *  测试经 __setBackoffForTests 替换为零延迟——真实退避会让单测白等 ~30s。 */
const defaultBackoffWait = (attempt) => {
  const backoff = Math.min(30000, 2000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
  return new Promise((r) => setTimeout(r, backoff));
};
let backoffWait = defaultBackoffWait;
/** 测试专用：替换退避函数（传 null 还原真实退避）。生产代码勿调。 */
function __setBackoffForTests(fn) {
  backoffWait = typeof fn === 'function' ? fn : defaultBackoffWait;
}

async function callChat({ messages, config, fetchImpl = fetch, jsonMode = true, chatParams }) {
  const { baseURL, apiKey, model, timeoutMs = 120000 } = config.ai;
  const url = `${String(baseURL).replace(/\/$/, '')}/chat/completions`;
  const cp = chatParams || {};
  const effTimeoutMs = cp.timeoutMs != null ? cp.timeoutMs : timeoutMs;
  const reqBody = { model: cp.model || model, messages, temperature: cp.temperature != null ? cp.temperature : 0.3 };
  if (cp.topP != null) reqBody.top_p = cp.topP;
  if (cp.maxTokens != null) reqBody.max_tokens = cp.maxTokens;
  if (cp.thinking != null) reqBody.thinking = cp.thinking; // GLM 对象格式 {type:"enabled"|"disabled"}，由 router 解析
  if (jsonMode) reqBody.response_format = { type: 'json_object' };
  const maxRetries = cp.maxRetries != null ? cp.maxRetries : 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal = composeChatSignal(effTimeoutMs, cp.signal);
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
      const errText = await res.text().catch(() => '');
      // 锁定采样参数的模型（Kimi k3「only 1 is allowed」/ OpenAI o 系列 / gpt-5）：
      // 400 且报错提及 temperature 时剥掉 temperature/top_p 立即重发（不消耗退避重试额度）。
      if (res.status === 400 && /temperature/i.test(errText) && reqBody.temperature !== undefined) {
        delete reqBody.temperature;
        delete reqBody.top_p;
        attempt--;
        continue;
      }
      // 429 / 5xx 可重试；其它（400 鉴权/模型不存在等）直接失败
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      lastErr = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
      if (!retryable) throw lastErr;
      logger.warn('AI 请求可重试错误，退避重试', {
        model: reqBody.model,
        status: res.status,
        attempt,
        error: errText.slice(0, 120),
      });
    }
    // 外部取消（chatParams.signal，如后台任务被删除）不走退避重试，立即抛出
    if (cp.signal && cp.signal.aborted) throw lastErr || new Error('aborted');
    if (attempt < maxRetries) {
      await backoffWait(attempt);
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
  const effTimeoutMs = cp.timeoutMs != null ? cp.timeoutMs : timeoutMs;
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
  const maxRetries = cp.maxRetries != null ? cp.maxRetries : 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal = composeChatSignal(effTimeoutMs, cp.signal);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(reqBody),
        signal,
      });
    } catch (e) {
      lastErr = e;
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
        const ctrl = { abort: false }; // onToken 返回 false（如客户端断开）→ 置位，读流循环据此中断
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
            const tok = parseSseBlock(block, onToken, ctrl);
            if (ctrl.abort) break;
            if (tok) reply += tok;
          }
          if (ctrl.abort) {
            // 消费方主动中断（客户端断开）：立即取消上游流，停止 completion 计费，返回已收部分
            await reader.cancel().catch(() => {});
            return reply;
          }
        }
        // 已有输出（正常完成或中途断流）→ 返回已收部分，不重试（重试会让前端收到重复内容）
        if (reply) return reply;
        if (lastErr) {
          // 无任何输出 + 出错 → 退避重试（额度用尽则 break 抛出）
          if (attempt >= maxRetries) break;
        } else {
          // 正常结束但零内容（reasoning-only 模型 / 模型真空输出）：视为成功，返回空串，**不重试**
          // （否则一次空调用会被白重发 maxRetries 次，烧多倍 token 费用）
          return '';
        }
        continue;
      }
      // 锁定采样参数的模型（Kimi k3 / OpenAI o 系列 / gpt-5）：400 且提及 temperature → 剥参数重发（不占额度）
      const errText = await res.text().catch(() => '');
      if (res.status === 400 && /temperature/i.test(errText) && reqBody.temperature !== undefined) {
        delete reqBody.temperature;
        delete reqBody.top_p;
        attempt--;
        continue;
      }
      // 429 / 5xx 可重试；其它直接失败
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      lastErr = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 200)}`);
      if (!retryable) throw lastErr;
      logger.warn('AI 流式请求可重试错误，退避重试', {
        model: reqBody.model,
        status: res.status,
        attempt,
        error: errText.slice(0, 120),
      });
    }
    // 外部取消（chatParams.signal，如后台任务被删除）不走退避重试，立即抛出
    if (cp.signal && cp.signal.aborted) throw lastErr || new Error('aborted');
    if (attempt < maxRetries) {
      await backoffWait(attempt);
    }
  }
  throw lastErr;
}

/** 解析单个 SSE 块（形如 `data: {...}`），提取 delta.content（正文）+ delta.reasoning_content（思考过程）。
 *  onToken(text, kind) 回调：kind='reasoning'（思考）| 'content'（正文）。返回累积的 content token（供持久化）。
 *  reasoning_content（GLM/DeepSeek-R1 等模型的 think 阶段）若存在，逐 token 回调让前端实时显示思考过程，
 *  不再让用户在 think 阶段干等「思考中」。reasoning 不计入返回的 reply（只存正文）。
 *  ctrl（可选）：{abort} 输出参数——onToken 返回 false（消费方主动中断）时置 ctrl.abort=true，
 *  调用方据此中断读流循环并 cancel 上游（客户端断开后不停读会白烧 completion 费用）。 */
function parseSseBlock(block, onToken, ctrl) {
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
        if (onToken(delta.reasoning_content, 'reasoning') === false) {
          if (ctrl) ctrl.abort = true;
          return '';
        }
      }
    }
    // 正文（content）
    if (typeof delta.content === 'string' && delta.content) {
      if (typeof onToken === 'function') {
        if (onToken(delta.content, 'content') === false) {
          if (ctrl) ctrl.abort = true;
          return '';
        }
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
  const maxInputChars = resolveMaxInputChars(config, 'summary');
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
  const maxInputChars = resolveMaxInputChars(config, 'notes');
  const messages = buildNotesMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: false });
  return text;
}

/** 抽取标签/主题（+ metadata 兜底）：强制 JSON 调用。
 *  返回归一化后的 { tags:[], topics:[], metadata|null }，解析失败返回空结构（不抛）。 */
async function extractTagsTopics({ title, abstract, fulltext, config, fetchImpl = fetch, prompt }) {
  const maxInputChars = resolveMaxInputChars(config, 'tags');
  const messages = buildTagsMessages({ title, abstract, fulltext, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: true });
  return parseTagsResult(text);
}

/** 仅抽取概念（用于「对选中论文重新抽取并追加」） */
async function extractConcepts({ title, abstract, fulltext, existingTerms, config, fetchImpl = fetch, prompt }) {
  const maxInputChars = resolveMaxInputChars(config, 'concepts');
  const messages = buildConceptMessages({ title, abstract, fulltext, existingTerms, maxInputChars, prompt });
  const text = await callChat({ messages, config, fetchImpl });
  return parseConceptResult(text);
}

/** 概念地图生成（v3.10）：把概念清单喂给模型，产出单文件 HTML 全览图。
 *  - concepts：store.concepts（含 term/definition/category/paperIds）。
 *  - prompt：默认内置 DEFAULT_CONCEPT_MAP_PROMPT，可被 settings.conceptMapPrompt 覆盖。
 *  - prevHtml：优化已有制品时传入原 HTML，让模型在其基础上按新 prompt 调整（而非从零重做）。
 *  - signal：后台任务取消信号（用户在生成中删除制品时主动中断）。
 *  返回 HTML 字符串（已剥 ```html 围栏）。jsonMode:false（HTML 非 JSON）。
 *
 *  走**流式**（callChatStream）而非非流式 callChat（v3.14 根因修复）：单文件 HTML 大产出
 *  常需数十分钟（思考型模型尤甚），非流式请求首字节前完全静默，会被网关/中间代理的空闲
 *  超时掐断（且旧 10 分钟 total 预算也不够）；流式从思考阶段就有字节流动，连接保活。
 *  total 预算放宽到 30 分钟；只重试 1 次（超长生成重试代价太大）。 */
async function generateConceptMap({ concepts, config, fetchImpl = fetch, prompt, prevHtml, signal }) {
  const sys = prompt && String(prompt).trim() ? String(prompt).trim() : DEFAULT_CONCEPT_MAP_PROMPT;
  // 精简概念清单喂给模型（term/definition/category + 出现论文数；过多时截断防超长）
  const items = (Array.isArray(concepts) ? concepts : [])
    .map((c) => ({
      term: c.term || '',
      definition: (c.definition || '').slice(0, 120),
      category: c.category || 'other',
      paperCount: Array.isArray(c.paperIds) ? c.paperIds.length : 0,
    }))
    .slice(0, 400);
  const user =
    '概念清单（JSON）：\n' +
    JSON.stringify(items, null, 2) +
    (prevHtml
      ? '\n\n这是之前生成的概念地图 HTML，请在它基础上按我的新要求调整（保留好的部分，改进不足）：\n```html\n' +
        String(prevHtml).slice(0, 60000) +
        '\n```'
      : '') +
    '\n\n请生成单文件 HTML 概念地图，直接输出 HTML 文档。';
  const text = await callChatStream({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    config,
    fetchImpl,
    jsonMode: false,
    chatParams: { timeoutMs: 1800000, maxRetries: 1, signal },
  });
  // 剥 ```html / ``` 围栏（模型偶发包裹）
  let html = String(text || '').trim();
  const fence = html.match(/^```(?:html)?\s*([\s\S]*?)```\s*$/i);
  if (fence) html = fence[1].trim();
  return html;
}

/** 抽取核心公式（v3.9）：强制 JSON 调用。返回原始 item 数组（未归一化）——
 *  归一化与跨论文合并由 src/core/formulas 的 mergeFormulas 负责，本层只管拿数据。
 *  输入预算走任务级 `formulas`（默认远大于总结，因为公式散布全篇）。 */
async function extractFormulas({
  title,
  abstract,
  fulltext,
  existingFormulas,
  conceptTerms,
  config,
  fetchImpl = fetch,
  prompt,
}) {
  const maxInputChars = resolveMaxInputChars(config, 'formulas');
  const messages = buildFormulaMessages({
    title,
    abstract,
    fulltext,
    existingFormulas,
    conceptTerms,
    maxInputChars,
    prompt,
  });
  const text = await callChat({ messages, config, fetchImpl, jsonMode: true });
  return parseFormulaResult(text);
}

/** 公式抽取引擎 dispatcher（v3.9）：按 config.formulas.engine 路由到 AI 或 MinerU。
 *  - engine='mineru'：调 MinerU 解析 PDF 产高保真 LaTeX，再喂 AI 批量命名（MinerU 不给 canonicalName）。
 *  - 其余（默认 'ai'）：走原 extractFormulas（喂全文给 LLM）。
 *  scanner 两处公式调用统一走此 dispatcher，无需感知引擎。MinerU 失败抛错（不偷偷回退 AI）。
 *  lazy require mineru 避免循环依赖（mineru.js 反向 require 本模块的 callChat）。 */
async function extractFormulasViaEngine(opts) {
  const engine = opts && opts.config && opts.config.formulas && opts.config.formulas.engine;
  if (engine === 'mineru') {
    const { extractFormulas: mineruExtract } = require('./mineru');
    return mineruExtract(opts);
  }
  return extractFormulas(opts);
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
  const maxInputChars = resolveMaxInputChars(config, 'chat');
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

/** 从上游模型对象抽取上下文窗口（token 数）。
 *  OpenAI 原生 /v1/models **不返回**此字段（只 {id,object,created,owned_by}）；
 *  OpenRouter / newapi 等兼容网关扩展返回，字段名不一，按常见写法兜底：
 *    context_length（OpenRouter/one-api）> contextLength（驼峰）> max_input_tokens > top_provider.context_length。
 *  无任一字段 → null（前端不显示，回落手动配置）。 */
function extractContextLength(m) {
  if (!m || typeof m !== 'object') return null;
  const v =
    m.context_length ?? m.contextLength ?? m.max_input_tokens ?? (m.top_provider && m.top_provider.context_length);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 从上游模型对象抽取展示名（OpenRouter/Kimi 等返回 display_name，OpenAI 无 → null）。 */
function extractDisplayName(m) {
  if (!m || typeof m !== 'object') return null;
  const v = m.display_name ?? m.displayName ?? m.name;
  return typeof v === 'string' && v && v !== m.id ? v : null;
}

/** 列出可用模型（Phase 2 模型切换器用）。
 *  - 优先调上游 OpenAI 兼容 /v1/models（带 apiKey）；失败/未配置回退 config.ai.model 单条 + extraModels。
 *  - 永不抛错：上游不可达时返回静态候选，保证前端模型切换器总能渲染。
 *  - 返回 { models: [{id, owned_by?, contextLength?, displayName?}], default, current, source: 'upstream'|'config' }。
 *    contextLength（token 数，可空）来自网关扩展字段，前端模型切换器展示「模型 · 1M」用。 */
async function listModels({ config, fetchImpl = fetch, timeoutMs = 8000 }) {
  const model = config && config.ai && config.ai.model;
  const baseURL = config && config.ai && config.ai.baseURL;
  const apiKey = config && config.ai && config.ai.apiKey;
  const extra = config && config.ai && Array.isArray(config.ai.extraModels) ? config.ai.extraModels : [];
  const fallback = {
    models: [model]
      .filter(Boolean)
      .concat(extra)
      .map((id) => ({ id, contextLength: null })),
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
      ? data.data
          .map((m) => ({
            id: m.id,
            owned_by: m.owned_by,
            contextLength: extractContextLength(m),
            displayName: extractDisplayName(m),
          }))
          .filter((m) => m && m.id)
      : Array.isArray(data && data.models)
        ? data.models
            .map((m) =>
              typeof m === 'string'
                ? { id: m, contextLength: null, displayName: null }
                : {
                    id: m.id,
                    owned_by: m.owned_by,
                    contextLength: extractContextLength(m),
                    displayName: extractDisplayName(m),
                  },
            )
            .filter((m) => m && m.id)
        : [];
    if (!list.length) return fallback;
    // 合并 extraModels（用户静态补充），去重
    const seen = new Set(list.map((m) => m.id));
    for (const id of extra)
      if (id && !seen.has(id)) {
        list.push({ id, contextLength: null });
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
  DEFAULT_CONCEPT_PROMPT,
  CONCEPT_PROMPT,
  DEFAULT_CONCEPT_MAP_PROMPT,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  DEFAULT_NOTES_PROMPT,
  DEFAULT_FORMULA_PROMPT,
  // 输入预算
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  tokensToCharBudget,
  INPUT_BUDGET_TASKS,
  resolveMaxInputChars,
  pickMathDenseText,
  // 消息构造
  buildMessages, // 别名（向后兼容）= buildSummaryMessages
  buildSummaryMessages,
  buildTagsMessages,
  buildConceptMessages,
  buildChatMessages,
  buildNotesMessages,
  buildFormulaMessages,
  // 解析
  parseAiJson,
  parseConceptResult,
  parseFormulaResult,
  parseTagsResult,
  // 归一化
  buildSummaryMarkdown,
  // 配置覆盖
  applySettingsOverride,
  withGlobalAi,
  // AI 调用
  summarize,
  generateNotes,
  extractTagsTopics,
  extractConcepts,
  generateConceptMap,
  extractFormulas,
  extractFormulasViaEngine,
  chatPaper,
  callChat,
  callChatStream,
  listModels,
  // 测试钩子（生产勿用）
  __setBackoffForTests,
};
