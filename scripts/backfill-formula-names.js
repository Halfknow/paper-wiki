'use strict';

// 公式 fm_lat_* 降级名回填（v3.27）：把 AI 命名失败时入库的哈希名公式重新命名。
//
// 背景：mineru 引擎的 AI 命名整体失败时（旧版无单篇截断上限，批量过大 → 输出截断 →
// JSON 解析失败 → nameFormulasViaAi 返回 null），整篇公式以 `fm_lat_<sha1(latex)>` 作
// canonicalName 降级入库——不可读、不跨论文归并（生产 8/10-8/11 批量抽取遗留 134 条）。
//
// 动作（对每条 canonicalName 以 fm_lat_ 开头的公式）：
//   - AI 给出名字 → DELETE 旧条目 + 对其每个 occurrence 所属论文 POST /api/papers/:id/formulas/merge
//     （mergeFormulas 按 canonicalName 归并：命中已有条目只补空字段 + occurrence 覆盖）
//   - AI 输出 skip → DELETE（AI 拒判的记号噪声，与 cleanup-formula-noise 同语义）
//   - AI 漏答该序号 → 保持不变（防输出截断误删），dry-run 里报告
//
// 读取：globalAi（PG app_state，**只读**）拿活跃渠道作 AI 配置；
// 改写全部走**运行中 app 的 HTTP API**（manager 持有 store 内存缓存，直写 PG 会不一致）。
//
// 用法：
//   node scripts/backfill-formula-names.js                 # dry-run（默认，只打印计划）
//   node scripts/backfill-formula-names.js --apply         # 实际执行
//   node scripts/backfill-formula-names.js --space default --limit 10
// 环境：PW_BASE_URL（默认 http://127.0.0.1:8888）、
//       DATABASE_URL（默认 postgres://paperwiki:paperwiki-local-dev@127.0.0.1:25432/paperwiki，只读）

const { Pool } = require('pg');
const { callChat } = require('../src/services/ai');
const { DEFAULT_MINERU_NAMING_PROMPT } = require('../src/services/mineru');

const APPLY = process.argv.includes('--apply');
const SPACE = (() => {
  const i = process.argv.indexOf('--space');
  return i > 0 ? process.argv[i + 1] : null;
})();
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  const n = i > 0 ? Number(process.argv[i + 1]) : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
})();
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8888';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://paperwiki:paperwiki-local-dev@127.0.0.1:25432/paperwiki';
const CHUNK = 25; // 每次命名的条数上限（输出 token 安全边际，防截断再次降级）
const CHUNK_GAP_MS = 400;

async function jget(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error(`GET ${path} → ${JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

async function jdel(path) {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DELETE ${path} → HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return res.json();
}

async function jpost(path, payload) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 PG app_state 只读拿 globalAi 的活跃渠道 → callChat 配置 */
async function loadAiConfig() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const r = await pool.query("SELECT value FROM app_state WHERE key = 'globalAi'");
    const g = r.rows[0] && r.rows[0].value;
    const ch = g && Array.isArray(g.channels) && g.channels.find((c) => c.id === g.activeChannelId);
    if (!ch || !ch.baseURL || !ch.apiKey)
      throw new Error('globalAi 无可用渠道（app_state.globalAi.channels 为空或缺 baseURL/apiKey）');
    return { ai: { baseURL: ch.baseURL, apiKey: ch.apiKey, model: ch.model, timeoutMs: 120000 } };
  } finally {
    await pool.end();
  }
}

/** 一批 fm_lat_ 公式 → {renames: Map(id → named), skips: Set(id), misses: Set(id)} */
async function nameChunk(formulas, config) {
  const list = formulas.map((f, i) => `${i + 1}. $${f.latex}$`).join('\n');
  const text = await callChat({
    messages: [
      { role: 'system', content: DEFAULT_MINERU_NAMING_PROMPT },
      {
        role: 'user',
        content: `论文标题：（公式清单回填）\n\n公式列表：\n${list}\n\n请为每个序号输出归一化信息（不是公式的输出 skip）。`,
      },
    ],
    config,
    jsonMode: true,
  });
  let arr = null;
  const s = String(text || '').trim();
  const aFirst = s.indexOf('[');
  const aLast = s.lastIndexOf(']');
  if (aFirst !== -1 && aLast > aFirst) {
    try {
      const parsed = JSON.parse(s.slice(aFirst, aLast + 1));
      if (Array.isArray(parsed)) arr = parsed;
    } catch {}
  }
  if (!arr) throw new Error('AI 返回非 JSON 数组（疑似截断）');

  const renames = new Map();
  const skips = new Set();
  const misses = new Set(formulas.map((f) => f.id));
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const idx = Number(e.index);
    if (!(Number.isInteger(idx) && idx >= 1 && idx <= formulas.length)) continue;
    const f = formulas[idx - 1];
    misses.delete(f.id);
    if (e.skip) skips.add(f.id);
    else if (e.canonicalName) renames.set(f.id, e);
  }
  return { renames, skips, misses };
}

async function main() {
  const config = await loadAiConfig();
  const payload = await jget('/api/spaces');
  const spaces = Array.isArray(payload) ? payload : payload.spaces || [];

  for (const sp of spaces) {
    if (SPACE && sp.id !== SPACE) continue;
    // 降级名判定看 name 字段：canonicalName 经 normalizeCanonicalName 后下划线已被换成
    // 连字符（fm_lat_xxx → fm-lat-xxx），而 name 保留原始下划线写法（UI 显示的就是它）
    let fm = (await jget(`/api/formulas?space=${encodeURIComponent(sp.id)}`)).filter(
      (f) => String(f.name || '').startsWith('fm_lat_') || /^fm-lat-[\w-]+$/.test(String(f.canonicalName || '')),
    );
    if (LIMIT) fm = fm.slice(0, LIMIT);
    if (!fm.length) {
      console.log(`空间 ${sp.id}（${sp.name || ''}）：无 fm_lat_ 降级名公式`);
      continue;
    }
    console.log(`\n空间 ${sp.id}（${sp.name || ''}）：${fm.length} 条 fm_lat_ 降级名待处理`);

    // 逐块「命名 → 即时应用」：中断后重跑自动续（已改名/已删除的条目不再命中 fm_lat_ 过滤）
    let renamed = 0;
    let skipped = 0;
    let missed = 0;
    for (let i = 0; i < fm.length; i += CHUNK) {
      const chunk = fm.slice(i, i + CHUNK);
      const r = await nameChunk(chunk, config);
      for (const f of chunk) {
        const named = r.renames.get(f.id);
        if (named) {
          console.log(
            `  ✏️  ${f.id}  fm_lat_…  →  ${named.canonicalName}（${named.name || ''}）  $${String(f.latex).slice(0, 50)}$`,
          );
        } else if (r.skips.has(f.id)) {
          console.log(`  🗑  ${f.id}  AI 拒判（记号噪声）  $${String(f.latex).slice(0, 50)}$`);
        } else {
          console.log(`  ⏭  ${f.id}  AI 漏答，保持不变  $${String(f.latex).slice(0, 50)}$`);
        }
      }

      if (!APPLY) {
        renamed += r.renames.size;
        skipped += r.skips.size;
        missed += r.misses.size;
      } else {
        // 先删后并：DELETE 移除旧条目（occurrences/paperIds/paper.formulaIds 联动清理），
        // 再按 occurrence 归属逐篇 merge —— mergeFormulas 按 canonicalName 归并到已有条目
        for (const f of chunk) {
          const named = r.renames.get(f.id);
          if (!named && !r.skips.has(f.id)) {
            missed++;
            continue; // 漏答不动
          }
          const occs = (f.occurrences || []).slice();
          await jdel(`/api/formulas/${encodeURIComponent(f.id)}?space=${encodeURIComponent(sp.id)}`);
          if (named) {
            for (const o of occs) {
              await jpost(
                `/api/papers/${encodeURIComponent(o.paperId)}/formulas/merge?space=${encodeURIComponent(sp.id)}`,
                {
                  items: [
                    {
                      canonicalName: named.canonicalName,
                      name: named.name || named.canonicalName,
                      latex: f.latex,
                      description: named.description || '',
                      category: named.category || '',
                      variables: [],
                      rawLatex: o.rawLatex || f.latex,
                      context: o.context || '',
                      symbolMap: o.symbolMap || {},
                      source: 'mineru',
                    },
                  ],
                },
              );
            }
            renamed++;
          } else {
            skipped++;
          }
        }
      }
      console.log(
        `  块进度 ${Math.min(i + CHUNK, fm.length)}/${fm.length}（累计改名 ${renamed}｜删噪声 ${skipped}｜漏答 ${missed}）`,
      );
      if (i + CHUNK < fm.length) await sleep(CHUNK_GAP_MS);
    }
    console.log(
      `  ${APPLY ? `✅ 空间 ${sp.id} 完成` : '（dry-run）'}：改名 ${renamed}｜删噪声 ${skipped}｜保持 ${missed}${APPLY ? '' : '，加 --apply 执行'}`,
    );
  }
}

main().catch((e) => {
  console.error('回填失败：', e.message);
  process.exit(1);
});
