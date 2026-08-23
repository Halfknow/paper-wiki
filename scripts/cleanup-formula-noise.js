'use strict';

// 公式清单噪声清理（v3.27）：删除 MinerU 引擎误入库的「记号噪声」条目。
//
// 背景：mineru.extractLatexFromMarkdown 旧版把 PDF 里每一个 $…$ 行内数学片段都当公式
// （过滤只有 <3 字符/纯数字），单符号（\tau）、下标（f_{t+1}）、序列省略（f_1, f_2, \cdots）、
// 引文标记（^66 T'）等全部入库，且 AI 命名给垃圾起了正经名字（详见 CHANGELOG v3.27）。
// 修复后的流水线用 looksLikeFormula 结构门槛在入库前拦截；本脚本负责**存量清理**。
//
// 判定：source === 'mineru' 且 !looksLikeFormula(latex) → 删除。
//   - ai 引擎的条目不动（LLM 按核心公式提示词精选过，无关系符的纯表达式可能是真公式）；
//   - 删除走 DELETE /api/formulas/:id，由 deleteFormula 同步清理各 paper.formulaIds。
//
// 走**运行中 app 的 HTTP API**而非直写 PG：app 的 manager 持有各空间 store 的内存缓存，
// 外部直改 PG 会让 GET /api/formulas 一直返回旧数据（直到重启），且绕过内存不变式。
// 用法：
//   node scripts/cleanup-formula-noise.js                     # dry-run（默认，只打印计划）
//   node scripts/cleanup-formula-noise.js --apply             # 实际删除
//   node scripts/cleanup-formula-noise.js --space default     # 只处理指定空间
//   PW_BASE_URL=http://host:port node scripts/cleanup-formula-noise.js --apply
// 环境：PW_BASE_URL（默认 http://127.0.0.1:8888）。

const { looksLikeFormula } = require('../src/core/formulas');

const APPLY = process.argv.includes('--apply');
const SPACE = (() => {
  const i = process.argv.indexOf('--space');
  return i > 0 ? process.argv[i + 1] : null;
})();
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8888';

async function jget(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error(`GET ${path} → ${JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

async function main() {
  const payload = await jget('/api/spaces');
  // 旧版镜像返回 {activeSpaceId, spaces:[...]}，新版直接返回数组——两种形状都兼容
  const spaces = Array.isArray(payload) ? payload : payload.spaces || [];
  let totalDel = 0;
  let totalKeep = 0;
  for (const sp of spaces) {
    if (SPACE && sp.id !== SPACE) continue;
    const list = await jget(`/api/formulas?space=${encodeURIComponent(sp.id)}`);
    const noise = list.filter((f) => f.source === 'mineru' && !looksLikeFormula(f.latex));
    const keptMineru = list.filter((f) => f.source === 'mineru' && looksLikeFormula(f.latex)).length;
    const aiCount = list.filter((f) => f.source !== 'mineru').length;
    console.log(`\n空间 ${sp.id}（${sp.name || ''}）：共 ${list.length} 条公式`);
    console.log(
      `  将删除 ${noise.length} 条（mineru 记号噪声）｜保留 mineru ${keptMineru} 条 + 其它来源 ${aiCount} 条（不动）`,
    );
    for (const f of noise.slice(0, 20)) {
      console.log(`    - ${f.id}  ${f.name}  $${String(f.latex).slice(0, 60)}$`);
    }
    if (noise.length > 20) console.log(`    …（其余 ${noise.length - 20} 条略）`);
    totalDel += noise.length;
    totalKeep += list.length - noise.length;

    if (APPLY) {
      let done = 0;
      for (const f of noise) {
        const res = await fetch(`${BASE}/api/formulas/${encodeURIComponent(f.id)}?space=${encodeURIComponent(sp.id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`DELETE ${f.id} → HTTP ${res.status} ${text.slice(0, 120)}`);
        }
        done++;
        if (done % 50 === 0) console.log(`    …已删除 ${done}/${noise.length}`);
      }
      console.log(`  ✅ 已删除 ${done} 条`);
    }
  }
  console.log(
    `\n合计：${APPLY ? '删除' : '计划删除'} ${totalDel} 条，保留 ${totalKeep} 条${APPLY ? '' : '（dry-run，加 --apply 执行）'}`,
  );
}

main().catch((e) => {
  console.error('清理失败：', e.message);
  process.exit(1);
});
