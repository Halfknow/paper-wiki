/**
 * 开发用种子脚本：往测试 PG 的 default 空间塞几篇论文 + 一组公式，
 * 供公式清单页做真实浏览器验证（跨论文合并、符号表、跳转都能看到效果）。
 *
 * 仅用于本地开发，**不要连生产 PG**（会往真实库注入假数据）：
 *   DATABASE_URL=postgres://paperwiki:dev@127.0.0.1:15432/paperwiki node scripts/seed-formulas-dev.js
 */
const { createDb, createRepository } = require('../src/db');
const { mergeFormulas } = require('../src/core/formulas');

const url = process.env.DATABASE_URL || '';
if (!/15432/.test(url)) {
  console.error('拒绝执行：DATABASE_URL 必须指向测试 PG（端口 15432），当前=', url || '(未设置)');
  process.exit(1);
}

const PAPERS = [
  { id: 'seedpaper000001', title: 'Attention Is All You Need', year: 2017, authors: ['Vaswani'] },
  { id: 'seedpaper000002', title: 'Auto-Encoding Variational Bayes', year: 2014, authors: ['Kingma'] },
  { id: 'seedpaper000003', title: 'Proximal Policy Optimization Algorithms', year: 2017, authors: ['Schulman'] },
];

const EXTRACTIONS = [
  [
    'seedpaper000001',
    [
      {
        canonicalName: 'scaled-dot-product-attention',
        name: '缩放点积注意力',
        latex: '\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V',
        description:
          '把查询与所有键做点积得到相关性打分，除以 $\\sqrt{d_k}$ 抑制高维下点积方差过大导致 softmax 饱和，再用归一化后的权重对值向量加权求和。缩放因子是这个式子相对朴素点积注意力的关键改动。',
        category: 'attention',
        variables: [
          { symbol: 'Q', meaning: '查询矩阵', role: 'input' },
          { symbol: 'K', meaning: '键矩阵', role: 'input' },
          { symbol: 'V', meaning: '值矩阵', role: 'input' },
          { symbol: 'd_k', meaning: '键向量维度', role: 'param' },
        ],
        rawLatex: '\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(\\frac{QK^T}{\\sqrt{d_k}})V',
        context: '式(1)，3.2.1 节',
      },
      {
        canonicalName: 'softmax',
        name: '归一化指数函数',
        latex: '\\sigma(z)_i=\\frac{e^{z_i}}{\\sum_{j} e^{z_j}}',
        description: '把任意实向量映射为和为 1 的概率分布，指数保证非负、分母保证归一。',
        category: 'activation',
        variables: [
          { symbol: 'z', meaning: '输入 logit 向量', role: 'input' },
          { symbol: 'i', meaning: '分量下标', role: 'param' },
        ],
        plottable: true,
        plotHint: { variable: 'z', range: [-6, 6], params: {} },
        context: '3.2 节',
      },
    ],
  ],
  [
    'seedpaper000002',
    [
      {
        canonicalName: 'elbo',
        name: '证据下界（ELBO）',
        latex:
          '\\mathcal{L}(\\theta,\\phi;x)=\\mathbb{E}_{q_\\phi(z|x)}[\\log p_\\theta(x|z)]-D_{\\mathrm{KL}}(q_\\phi(z|x)\\,\\|\\,p(z))',
        description:
          '边际似然 $\\log p(x)$ 不可解，转而优化它的下界：重构项要求解码器还原输入，KL 项把近似后验拉向先验。两项之差即证据下界。',
        category: 'variational-inference',
        variables: [
          { symbol: 'x', meaning: '观测数据', role: 'input' },
          { symbol: 'z', meaning: '隐变量', role: 'input' },
          { symbol: '\\phi', meaning: '编码器参数', role: 'param' },
          { symbol: '\\theta', meaning: '解码器参数', role: 'param' },
        ],
        rawLatex: '\\mathcal{L}(\\theta,\\phi;x^{(i)})',
        context: '式(3)，2.2 节',
      },
      {
        canonicalName: 'kl-divergence',
        name: 'KL 散度',
        latex: 'D_{\\mathrm{KL}}(P\\,\\|\\,Q)=\\sum_{x} P(x)\\log\\frac{P(x)}{Q(x)}',
        description: '衡量用分布 $Q$ 编码来自 $P$ 的样本时多付出的比特数。非负、不对称，故不是距离。',
        category: 'information-theory',
        variables: [
          { symbol: 'P', meaning: '真实分布', role: 'input' },
          { symbol: 'Q', meaning: '近似分布', role: 'input' },
        ],
        rawLatex: 'D_{KL}(q_\\phi(z|x)\\|p_\\theta(z))',
        context: '附录 B',
        symbolMap: { P: 'q_\\phi', Q: 'p_\\theta' },
      },
      {
        canonicalName: 'reparameterization-trick',
        name: '重参数化技巧',
        latex: 'z=\\mu+\\sigma\\odot\\epsilon,\\quad \\epsilon\\sim\\mathcal{N}(0,I)',
        description:
          '把「从 $q_\\phi(z|x)$ 采样」改写成「对确定性函数施加与参数无关的噪声」，从而让梯度能穿过采样步骤反传到 $\\mu,\\sigma$。',
        category: 'variational-inference',
        variables: [
          { symbol: '\\mu', meaning: '后验均值', role: 'input' },
          { symbol: '\\sigma', meaning: '后验标准差', role: 'input' },
          { symbol: '\\epsilon', meaning: '标准正态噪声', role: 'const' },
        ],
        context: '式(10)，2.4 节',
      },
    ],
  ],
  [
    'seedpaper000003',
    [
      {
        canonicalName: 'ppo-clip-objective',
        name: 'PPO 裁剪目标',
        latex:
          'L^{\\mathrm{CLIP}}(\\theta)=\\hat{\\mathbb{E}}_t\\left[\\min\\left(r_t(\\theta)\\hat{A}_t,\\ \\mathrm{clip}(r_t(\\theta),1-\\epsilon,1+\\epsilon)\\hat{A}_t\\right)\\right]',
        description:
          '重要性比 $r_t$ 越界时把目标裁平，取裁剪前后的较小值形成悲观下界——新策略偏离旧策略太远时不再获得收益，从而无需 TRPO 的二阶约束也能稳定更新。',
        category: 'reinforcement-learning',
        variables: [
          { symbol: 'r_t', meaning: '新旧策略概率比', role: 'input' },
          { symbol: '\\hat{A}_t', meaning: '优势估计', role: 'input' },
          { symbol: '\\epsilon', meaning: '裁剪幅度（常取 0.2）', role: 'param' },
        ],
        rawLatex: 'L^{CLIP}(\\theta)',
        context: '式(7)，3 节',
      },
      {
        canonicalName: 'kl-divergence',
        latex: 'D_{\\mathrm{KL}}',
        rawLatex: 'KL[\\pi_{\\theta_{old}}, \\pi_\\theta]',
        context: '式(8)，自适应 KL 惩罚变体',
        symbolMap: { P: '\\pi_{\\theta_{old}}', Q: '\\pi_\\theta' },
      },
    ],
  ],
];

(async () => {
  const db = createDb({ connectionString: url });
  await db.migrate();
  const repo = createRepository(db);
  const store = await repo.loadSpaceStore('default');
  const now = Date.now();
  for (const p of PAPERS) {
    store.papers[p.id] = {
      ...(store.papers[p.id] || {}),
      id: p.id,
      filename: p.id + '.pdf',
      title: p.title,
      year: p.year,
      authors: p.authors,
      abstract: '（开发种子数据）',
      tags: [],
      topics: [],
      conceptIds: [],
      formulaIds: [],
      folders: [],
      status: 'ready',
      error: null,
      addedAt: now,
      updatedAt: now,
      chat: [],
    };
  }
  for (const [paperId, items] of EXTRACTIONS) mergeFormulas(store, items, paperId);
  for (const p of PAPERS) {
    store.papers[p.id].formulaIds = store.formulas
      .filter((f) => (f.occurrences || []).some((o) => o.paperId === p.id))
      .map((f) => f.id);
  }
  await repo.saveSpaceStore('default', store);
  console.log('seeded：', PAPERS.length, '篇论文 /', store.formulas.length, '个公式');
  console.log(store.formulas.map((f) => `  ${f.canonicalName} → ${f.paperIds.length} 篇`).join('\n'));
  await db.close();
})();
