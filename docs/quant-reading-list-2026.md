# Quant 论文阅读清单（2026 版）

> 面向**有 AI / 计算机背景的量化新手**精选的 36 篇 arXiv 论文，已全部导入本库的 **Quant 空间**（`papers/quant/`）。
>
> 选题原则：**优先高被引里程碑 + 高质量综述**——新手最需要的是一张「地图」，而不是钻进某篇方法细节。
> 所有 arXiv ID 均经官方 API 复核（标题 / 作者 / 年份匹配），剔除了 1 个误判 ID（`0709.1140` 实为物理论文，非 Avellaneda-Stoikov）。
>
> 建议按下面**五阶段学习路径**推进，每个阶段先读综述建立框架，再读里程碑论文深入。

---

## 📚 推荐学习路径（5 阶段）

```
阶段一 建立全景    → 先读 3 篇总览综述，知道「量化投资」全貌
阶段二 基础理论    → 组合优化 + 因子 + 回测过拟合批判
阶段三 序列预测    → 深度学习预测金融序列（LOB / Transformer）
阶段四 决策与执行  → 强化学习做交易 / 做市
阶段五 前沿表示    → GNN 选股 + LLM 在金融的应用（2026 最热）
```

---

## 阶段一：建立全景（先读这 3 篇综述，强烈推荐）

这三篇覆盖「传统量化 → 深度学习 → LLM」的完整脉络，**建议第一周通读**，建立整个领域的认知地图。

| # | arXiv | 标题 | 为什么必读 |
|---|-------|------|-----------|
| 1 | `2503.21422` | **From Deep Learning to LLMs: A Survey of AI in Quantitative Investment** (Cao 等, 2025) | ⭐**最佳起点**。从深度学习一路梳理到 LLM 的量化投资全景综述，覆盖 alpha 全流程（数据→因子→选股→组合→风控），2026 年最合适的总览地图 |
| 2 | `2411.12747` | **A Survey of Financial AI: Architectures, Advances and Open Challenges** (Liu 等, 2024) | 聚焦 AI/LLM 在金融的架构、进展与开放挑战，补足最新视野 |
| 3 | `2403.06779` | **From Factor Models to Deep Learning: ML in Reshaping Empirical Asset Pricing** (Ye 等, 2024) | 从经典因子模型到深度学习的资产定价全景，理解「为什么用 ML 做选股」 |

---

## 阶段二：基础理论（组合优化 / 因子 / 回测批判）

> ⚠️ **重要说明**：量化领域最经典的几篇（Marcos López de Prado 的 *Deflated Sharpe Ratio* / *Probability of Backtest Overfitting*、Harvey-Liu-Zhu 的 *...and the Cross-Section of Expected Returns*、Gu-Kelly-Xiu 的 *Empirical Asset Pricing via ML*、Avellaneda-Stoikov 的做市论文）**均未在 arXiv 发布**（只在 SSRN / NBER / 期刊）。本库的导入接口仅支持 arXiv，故用同主题且在 arXiv 的高质量论文替代。若需这些真正的开山之作，建议手动从 SSRN/NBER 下载 PDF 放入 `papers/quant/`。

### A. 组合优化与风险

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 4 | `2401.05080` | **Markowitz Portfolio Construction at Seventy** (Boyd 等, 2024) | Boyd 组对马科维茨框架的现代重写，把交易成本、持仓约束、估计不确定性全部纳入凸优化——组合优化最现代、最工程化的入门 |
| 5 | `1408.1159` | **Determining Optimal Trading Rules without Backtesting** (Carr & López de Prado, 2014) | López de Prado 在 arXiv 少数可查的论文，提出绕过回测直接确定最优交易规则——「反回测过拟合」思想的入口 |
| 6 | `2005.13665` | **Deep Learning for Portfolio Optimization** (Zhang & Zohren, 2020) | 用深度网络直接优化组合夏普比率，「深度学习 + 组合优化」方向高被引入门作 |
| 7 | `2307.05048` | **Portfolio Optimization: A Comparative Study** (Sen, 2023) | 系统比较均值-方差、层次风险平价（HRP）等方法，理解风险平价 / HRP 流派 |

### B. 因子投资 / 横截面收益 / 回测批判

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 8 | `2209.13623` | **Publication Bias in Asset Pricing Research** (Chen, 2022) | 用大样本量化「因子动物园」的发表偏倚与复制衰减——Harvey-Liu-Zhu、McLean-Pontiff 批判精神的 arXiv 延续 |
| 9 | `1805.01104` | **Deep Learning in Characteristics-Sorted Factor Models** (Feng & He 等, 2018, RFS 2023) | 把企业特征排序与深度学习结构化结合，「用 DL 做横截面因子定价」高被引里程碑 |
| 10 | `2402.06635` | **Large and Deep Factor Models** (2024) | 连接特征学习与资产定价，因子挖掘深度学习化的最新方法 |

---

## 阶段三：序列预测（深度学习预测金融序列）

### C. 市场微观结构 / 限价指令簿（LOB）

> 这是「AI + 金融」最成熟、最容易出成果的切入点，适合有 CV/NLP 基础的人快速迁移。

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 11 | `1601.01987` | **Deep Learning for Limit Order Books** (Sirignano, 2016) | ⭐首个把深度学习大规模应用于限价指令簿建模，高频预测方向开山之作 |
| 12 | `1808.03668` | **DeepLOB: Deep CNN for Limit Order Books** (Zhang 等, 2018) | ⭐CNN 处理订单簿的标准基准（~490 引），几乎所有后续 LOB 深度学习论文都以它为对比 |
| 13 | `1803.06917` | **Universal Features of Price Formation** (Sirignano & Cont, 2018) | ⭐用深度学习发现跨市场通用的价格形成特征，「AI + 微观结构」里程碑 |
| 14 | `2105.10430` | **Multi-Horizon Forecasting for LOB (DeepLOB-Attention)** (Zhang & Zohren, 2021) | 在 DeepLOB 基础上引入 Attention 做多时间跨度预测 |
| 15 | `2403.09267` | **Deep Limit Order Book Forecasting: A Microstructural Guide** (Briola 等, 2024) | ⭐**最新 LOB 深度学习综述 + benchmark**，打通微观结构理论与现代 DL 方法 |
| 16 | `2308.01915` | **LOB-Based DL Models: A Benchmark Study** (Prata 等, 2023) | 15 个 SOTA 深度模型在 LOB 上的基准对比，选模型直接参考 |

### E. 通用时间序列预测（Transformer 时代）

> 这几篇虽非金融专属，但金融时序预测的基础设施，必读。

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 17 | `2202.07125` | **Transformers in Time Series: A Survey** (Wen 等, 2022) | ⭐系统综述 Transformer 在时序的应用地图（IJCAI 2023，2300+ 引） |
| 18 | `1912.09363` | **Temporal Fusion Transformers (TFT)** (Lim 等, 2019) | ⭐可解释多步时序预测的经典架构，金融预测工程应用极广（4500+ 引） |
| 19 | `2012.07436` | **Informer: Long Sequence Time-Series Forecasting** (Zhou 等, 2020) | ⭐长序列时序预测代表作（AAAI 2021 杰出论文，11700+ 引），ProbSparse 注意力 |
| 20 | `2407.13278` | **Deep Time Series Models: A Comprehensive Survey and Benchmark** (Wang 等, 2024) | 2024 最新深度时序模型综合综述 + 基准 |

---

## 阶段四：决策与执行（强化学习做交易 / 做市）

### F. 强化学习

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 21 | `2011.09607` | **FinRL: A DRL Library for Automated Trading** (Liu & Yang 等, 2020) | ⭐量化 RL 入门第一站，模块化三层架构 + 主流 DRL 算法（PPO/A2C/DQN），生态最活跃 |
| 22 | `2211.03107` | **FinRL-Meta: Market Environments and Benchmarks** (Liu 等, 2022, NeurIPS D&B) | FinRL 的数据与环境层，DataOp 范式提供可复现的动态市场环境 |
| 23 | `1911.10107` | **Deep Reinforcement Learning for Trading** (Zhang, Zohren & Roberts, 2019) | ⭐DRL 用于连续期货合约交易策略设计的里程碑（460+ 引） |
| 24 | `1804.04216` | **Market Making via Reinforcement Learning** (Spooner, Fearnley & Savani, 2018) | RL 做市经典工作（210+ 引），构建高保真 LOB 模拟器训练做市商 |
| 25 | `2408.10932` | **The Evolution of RL in Quantitative Finance: A Survey** (Pippas, 2024) | ⭐2024 综述，批判性梳理 167 篇量化金融 RL 应用，给发展脉络图 |
| 26 | `2411.12746` | **A Review of Reinforcement Learning in Financial Applications** (2024) | 较全面的金融市场 RL 综述，涵盖 bandit 与 DRL 在交易/做市/组合的应用 |
| 27 | `1907.04373` | **Capturing Financial Markets to Apply DRL** (Chakraborty, 2019) | 早期系统讨论 DRL 用于金融交易，理解其真实能力边界 |

---

## 阶段五：前沿表示学习（GNN 选股 + LLM，2026 最热）

### G. 图神经网络 / 关系建模选股

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 28 | `1809.09441` | **Temporal Relational Ranking for Stock Prediction (RSR)** (Feng & He 等, 2018) | ⭐GNN 选股奠基之作（700+ 引），时序图卷积联合建模股票时序与关系网络 |
| 29 | `1908.07999` | **HATS: Hierarchical Graph Attention for Stock Movement** (Kim 等, 2019) | 分层图注意力网络，利用公司间关系图（270+ 引） |
| 30 | `1909.10660` | **Exploring GNN for Stock Market Predictions** (Matsunaga & Suzumura, 2019) | 基于排序关系构建股票图的早期代表作（170+ 引） |
| 31 | `2306.03763` | **ChatGPT Informed GNN for Stock Movement** (Chen 等, 2023) | 用 ChatGPT 推断股票关系（动态构图）再喂给 GNN——LLM + GNN 交叉前沿 |
| 32 | `2401.01846` | **DGDNN: Decoupled Graph Diffusion NN for Stock** (Xiang 等, 2024) | 无需专家知识即可从数据学股票关系图，GNN 选股最新进展 |

### H. LLM / 大语言模型在金融（2026 必读前沿）

| # | arXiv | 标题 | 要点 |
|---|-------|------|------|
| 33 | `2303.17564` | **BloombergGPT: A LLM for Finance** (Wu 等, 2023) | ⭐金融领域首个 500 亿参数级专有大模型，定义「金融基础模型」范式 |
| 34 | `2306.06031` | **FinGPT: Open-Source Financial LLMs** (Yang & Liu 等, 2023) | ⭐开源金融 LLM 框架代表作（AI4Finance），以数据为中心的五层全栈架构（830+ 引） |
| 35 | `2311.10723` | **Large Language Models in Finance: A Survey** (Li 等, 2023) | ⭐金融 LLM 最被广泛引用的综述（700+ 引），梳理各方案并给选型框架——**新手建图首选** |
| 36 | `2006.08097` | **FinBERT: A Pretrained LM for Financial Communications** (Liu, Huang & Wang, 2020) | 金融领域 BERT 预训练代表作，金融情感/文本分类基线（640+ 引） |

---

## 🗺️ 一张图：领域与技术的关系

```
                  ┌─────────────────────────────────────┐
                  │   阶段一 全景综述（#1 #2 #3）        │  ← 先读
                  └───────────────┬─────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  ┌──────────┐            ┌──────────────┐          ┌──────────────┐
  │ 基础理论  │            │   序列预测    │          │  决策与执行   │
  │ #4–#10   │            │  #11–#20     │          │  #21–#27     │
  │ 组合/因子 │            │ LOB/Transformer│        │  强化学习     │
  └────┬─────┘            └──────┬───────┘          └──────┬───────┘
       │                         │                         │
       └─────────────┬───────────┴─────────────────────────┘
                     ▼
            ┌──────────────────┐
            │  前沿表示学习     │  ← 2026 最热
            │  GNN #28–#32    │
            │  LLM #33–#36    │
            └──────────────────┘
```

---

## 💡 给 AI 背景读者的特别提示

1. **最快上手路径**：你已有深度学习基础，**阶段三的 LOB 预测**（#11–#16）是最容易迁移出成果的方向——把订单簿当成「多通道图像/序列」用 CNN/Transformer 处理，与 CV/NLP 任务高度同构。建议从 #12 DeepLOB 复现起手。

2. **避坑**：**阶段四强化学习**陷阱最多。务必先读 #25、#26 两篇综述理解「为什么大多数 RL 交易策略在回测里赚钱、实盘亏钱」（回测过拟合）。配合 #5（López de Prado 反回测）一起看。

3. **因子 vs ML 的争论**：#8（发表偏倚）+ #9（DL 特征排序）+ #3（因子→DL 综述）三篇连读，能帮你建立「传统因子派」与「ML 选股派」的完整判断框架，避免站队。

4. **2026 前沿**：#31（ChatGPT+GNN）、#34 FinGPT、#33 BloombergGPT 是当前最热的三个方向。如果只读一篇，选 **#35（金融 LLM 综述）** 作为这个领域的地图。

5. **本库的使用**：每篇论文导入后会自动生成中文总结、英文细粒度标签、中文主题。建议在 Quant 空间用「主题」侧栏按阶段筛选，用「概念」清单积累术语。

---

## 📌 已知限制

- **未收录的非 arXiv 经典**（本接口仅支持 arXiv 导入；如需补充，可手动下载 PDF 放入 `papers/quant/` 后触发扫描）：
  - López de Prado《Deflated Sharpe Ratio》《Probability of Backtest Overfitting》《Advances in Financial Machine Learning》（教科书）
  - Harvey, Liu, Zhu《...and the Cross-Section of Expected Returns》(2016)
  - Gu, Kelly, Xiu《Empirical Asset Pricing via Machine Learning》(RFS 2020)
  - McLean & Pontiff《Does Academic Research Destroy Stock Return Predictability?》
  - Avellaneda & Stoikov《High-frequency trading in a limit order book》(Quant Finance 2008) — [Cornell ORIE PDF](https://people.orie.cornell.edu/sfs33/LimitOrderBook.pdf)
  - Ledoit & Wolf 协方差估计系列

- **处理进度**：36 篇已全部入库并自动入队；PDF 解析 + arXiv 元数据 + 中文总结 / 标签 / 主题会在后台串行生成（每篇约 1–2 分钟）。可在 Quant 空间列表查看实时状态。

---

*清单生成于 2026-07-14。arXiv ID 全部经官方 API 复核。*
