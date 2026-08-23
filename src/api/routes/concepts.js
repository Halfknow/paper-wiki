'use strict';

// concepts 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。
// v3.29 新增：POST /api/concepts（手动录入）+ POST /api/concepts/bulk（批量删除/改分类/改核心度）。
// v3.30 新增：POST /api/concepts/merge（重复条目合并）+ POST /api/concepts.md（按 ids 子集导出）
//   + PATCH starred + POST /api/concepts/:id/explain（AI 综合解读，SSE 流式）。

const {
  deleteConcept,
  conceptsToMarkdown,
  normalizeImportance,
  conceptIdFor,
  mergeConcepts,
  mergeConceptInto,
} = require('../../core/store');
// 命名空间访问（可测试性）：测试 monkey-patch aiSvc.callChatStream 即可拦截 explain 的 AI 调用
const aiSvc = require('../../services/ai');

function register(t, ctx) {
  const { ok, fail, config } = ctx;

  // ---- 概念清单 ----
  // GET /api/concepts (?q= / ?paper=)
  t.get('/api/concepts', async ({ res, q, store }) => {
    let list = (store.concepts || []).slice();
    if (q.paper) list = list.filter((c) => (c.paperIds || []).includes(q.paper));
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      list = list.filter((c) => (c.term + ' ' + (c.definition || '')).toLowerCase().includes(needle));
    }
    return ok(res, list);
  });

  // GET /api/concepts.md  纯 Markdown 文档（全量）
  t.get('/api/concepts.md', async ({ res, store }) => {
    const md = conceptsToMarkdown(store);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  // POST /api/concepts.md —— 按当前筛选导出子集（v3.30，备课/综述讲义）：body {ids}
  t.post('/api/concepts.md', async ({ res, body, store }) => {
    const op = JSON.parse(body || '{}');
    const ids = Array.isArray(op.ids) ? op.ids.map((x) => String(x)) : [];
    const md = conceptsToMarkdown(store, { ids });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  });

  // POST /api/concepts/merge —— 重复条目合并（v3.30 治理）：{sourceId, targetId}
  // source 并入 target（paperIds/contexts 并集、空缺补齐、papers 反向替换），source 删除。
  t.post('/api/concepts/merge', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const merged = mergeConceptInto(store, String(op.sourceId || ''), String(op.targetId || ''));
    if (!merged) return fail(res, 400, 'invalid source/target');
    await save(store);
    return ok(res, { concept: merged });
  });

  // POST /api/concepts —— 手动录入（v3.29）：纸面/组会/其它来源的术语补进知识库。
  // term 命中已有概念（按归一化 term）时走合并语义：补 paperIds / per-paper 由来，
  // 不覆盖已有 definition（要改走 PATCH）。返回合并后的概念对象 + merged 标记。
  t.post('/api/concepts', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const term = String(op.term || '').trim();
    if (!term) return fail(res, 400, 'term required');
    const item = {
      term,
      definition: String(op.definition || '').trim(),
      category: String(op.category || '')
        .trim()
        .toLowerCase(),
      importance: normalizeImportance(op.importance),
      context: String(op.context || '').trim(),
      source: 'manual',
    };
    // 关联论文：逐篇 merge（不存在的 id 直接忽略）；不挂论文也允许（独立条目）
    const paperIds = Array.isArray(op.paperIds)
      ? op.paperIds.map((x) => String(x)).filter((id) => store.papers[id])
      : [];
    const before = (store.concepts || []).find((c) => c.id === conceptIdFor(term));
    const targets = paperIds.length ? paperIds : [null];
    for (const pid of targets) mergeConcepts(store, [item], pid);
    await save(store);
    const c = (store.concepts || []).find((x) => x.id === conceptIdFor(term));
    if (!c) return fail(res, 500, 'merge failed');
    return ok(res, { concept: c, merged: !!before });
  });

  t.patch('/api/concepts/:name', async ({ res, body, params, store, save }) => {
    const c = (store.concepts || []).find((x) => x.id === params.name);
    if (!c) return fail(res, 404, 'Not found');
    const op = JSON.parse(body || '{}');
    if (op.term) c.term = String(op.term).trim();
    if ('definition' in op) c.definition = String(op.definition).trim();
    if ('category' in op)
      c.category =
        String(op.category || '')
          .trim()
          .toLowerCase() || 'other';
    if ('importance' in op) c.importance = normalizeImportance(op.importance);
    if ('starred' in op) c.starred = !!op.starred; // v3.30 重点标记
    c.updatedAt = Date.now();
    await save(store);
    return ok(res, c);
  });

  // POST /api/concepts/:id/explain —— AI 综合解读（v3.30，SSE 流式）：基于概念与出现论文
  // 生成「是什么/演化脉络/各论文用法差异」的综合讲解。不落库（按需生成，抽屉内临时展示）。
  // 上下文预算走 chat 任务档；陷阱 42：中等产出走流式防代理空闲超时。
  t.post('/api/concepts/:id/explain', async ({ res, params, store, gai, config }) => {
    const c = (store.concepts || []).find((x) => x.id === params.id);
    if (!c) return fail(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) =>
      res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    try {
      const papers = (c.paperIds || [])
        .map((pid) => store.papers[pid])
        .filter(Boolean)
        .slice(0, 12);
      const ctxBy = new Map((c.contexts || []).map((x) => [x.paperId, x.context]));
      const paperBlocks = papers
        .map((p) => {
          const ctx = ctxBy.get(p.id) ? `（该篇出处：${ctxBy.get(p.id)}）` : '';
          const summ = String(p.summary || '').slice(0, 600);
          return `## ${p.title || p.filename}（${p.year || '年份未知'}）${ctx}\n${summ}`;
        })
        .join('\n\n');
      const system = [
        '你是一位 AI/ML 领域的资深研究者，正在为一位进入新领域的博士/教授综合讲解一个概念。',
        '基于给定的概念信息与它出现的论文（标题/年份/总结摘录），输出结构化中文 Markdown 讲解：',
        '',
        '## 是什么',
        '概念的准确定义与机制（如库里已有定义，在其基础上深化而非重复）。',
        '',
        '## 演化脉络',
        '按年份梳理该概念在上述论文中的出现与演进（谁提出/谁改进/用法如何变化）。可引用论文标题与年份。',
        '',
        '## 各论文中的用法与差异',
        '对比它在不同论文里的具体用法、变体或记号差异（结合各篇总结，有出入就明说）。',
        '',
        '## 与相关概念的边界',
        '它容易与哪些概念混淆、边界在哪里。',
        '',
        '要求：只基于给定材料，不要编造论文里没有的内容；材料不足的段落如实说明；',
        '专有名词保留英文；总长控制在 400-800 字。',
      ].join('\n');
      const user = `概念：${c.term}\n库内定义：${c.definition || '（缺）'}\n核心度：${c.importance === 'core' ? '核心创新（至少一篇）' : c.importance || '未知'}\n\n出现论文材料：\n${paperBlocks || '（无关联论文——基于术语本身与你的领域知识谨慎讲解，并明确标注这一点）'}`;
      const effConfig = aiSvc.applySettingsOverride(config, aiSvc.withGlobalAi(store.settings, gai));
      await aiSvc.callChatStream({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        config: effConfig,
        chatParams: { timeoutMs: 180000 }, // 中等产出放宽单次超时（陷阱 42 流式保活）
        onToken: (tok) => send('token', { tok }),
      });
      send('done', {});
    } catch (e) {
      send('fail', { error: e && e.message ? e.message : '生成失败' });
    }
    return res.end();
  });

  // DELETE /api/concepts/:id
  t.delete('/api/concepts/:name', async ({ res, params, store, save }) => {
    const removed = deleteConcept(store, params.name);
    if (!removed) return fail(res, 404, 'Not found');
    await save(store);
    return ok(res, { deleted: params.name });
  });

  // POST /api/concepts/bulk —— 批量管理（v3.29）：{ids, delete:true} 或 {ids, category}
  // 或 {ids, importance}（三者互斥，delete 优先）。清理噪声/批量归类的原子入口。
  t.post('/api/concepts/bulk', async ({ res, body, store, save }) => {
    const op = JSON.parse(body || '{}');
    const ids = new Set(Array.isArray(op.ids) ? op.ids.map((x) => String(x)) : []);
    if (!ids.size) return fail(res, 400, 'ids required');
    let n = 0;
    if (op.delete) {
      for (const id of ids) if (deleteConcept(store, id)) n++;
    } else if (typeof op.category === 'string') {
      const category = op.category.trim().toLowerCase() || 'other';
      for (const c of store.concepts || []) {
        if (ids.has(c.id)) {
          c.category = category;
          c.updatedAt = Date.now();
          n++;
        }
      }
    } else if (op.importance !== undefined) {
      const importance = normalizeImportance(op.importance);
      for (const c of store.concepts || []) {
        if (ids.has(c.id)) {
          c.importance = importance;
          c.updatedAt = Date.now();
          n++;
        }
      }
    } else return fail(res, 400, 'nothing to do (delete | category | importance)');
    await save(store);
    return ok(res, { updated: n });
  });
}

module.exports = { register };
