'use strict';

// 元数据回填（v3.6）：为缺 year/authors 等元数据的存量论文从 arXiv 补全。
//
// 背景：早期版本/迁移数据里一批论文 title/authors 齐但 year 缺失，或整组元数据为空
// （裸 ID 文件名 ti: 搜不到、旧版不写 year 等历史原因）。当前流水线已会正确写全，
// 本脚本负责存量修复。
//
// 策略（按论文逐个尝试，命中即填）：
//   A. 已有 arxivId         → id: 精确查（直接采信）
//   B. 文件名含 arXiv ID    → id: 精确查 + 标题相似度校验（≥0.5 防文件名乱标）
//      （裸 ID / [2306.02781v4] / 括号内 / 老格式 cs.AI/0701001，extractArxivIdFromFilename）
//   C. ti: 标题搜索          → cleanFilenameToTitle + pickBest（阈值同流水线 0.75）
//   D. 全文首页标题候选       → paper_texts 首页前若干非空行逐个 ti: 搜（阈值 0.7，治怪文件名）
//
// 只填缺失字段（year/authors/title/abstract/primaryCategory/arxivId/arxivUrl），
// 不覆盖已有内容；metaSource 置 'arxiv-backfill' 便于事后审计。
//
// 用法：
//   node scripts/backfill-metadata.js              # dry-run（默认，只打印计划）
//   node scripts/backfill-metadata.js --apply      # 实际写库
//   node scripts/backfill-metadata.js --space default --limit 20
// 环境：DATABASE_URL（默认 postgres://paperwiki:dev@127.0.0.1:15432/paperwiki；容器内跑用 compose 注入值）。

const { createDb, createRepository } = require('../src/db');
const arxiv = require('../src/services/arxiv');
const { extractArxivIdFromFilename, cleanFilenameToTitle, titleSimilarity, normalizeTitle, sleep } = require('../src/core/util');

const APPLY = process.argv.includes('--apply');
const SPACE = (() => { const i = process.argv.indexOf('--space'); return i > 0 ? process.argv[i + 1] : null; })();
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? Number(process.argv[i + 1]) : 0; })();
const DB_URL = process.env.DATABASE_URL || 'postgres://paperwiki:dev@127.0.0.1:15432/paperwiki';
const ARXIV_OPTS = { minIntervalMs: 3000, timeoutMs: 15000, maxRetries: 2 }; // arXiv 礼貌限速（同流水线默认）

const stats = { scanned: 0, needFill: 0, hits: { A: 0, B: 0, C: 0, D: 0 }, skipped: [], errors: 0 };

async function fetchById(id) {
  const { entries } = await arxiv.searchArxiv(`id:${id}`, fetch, ARXIV_OPTS);
  return entries && entries[0] ? entries[0] : null;
}

async function searchByTitle(candidate, threshold) {
  if (!candidate || candidate.length < 4) return null;
  const { entries } = await arxiv.searchArxiv(`ti:"${candidate}"`, fetch, ARXIV_OPTS);
  const { best, confidence, source } = arxiv.pickBest(candidate, entries, { threshold });
  return best && source === 'arxiv' ? { best, confidence } : null;
}

// arXiv API 的 ti:"整句" 是连续短语精确匹配——长标题/含弯引号时易 0 命中；
// 而「ti:词 AND ti:词」里任何停用词项会把整个查询清零（实测：ti:Attention AND ti:Is → 0）。
// 所以整句失败后的兜底是**关键词 AND**：去停用词/短词/纯数字，取前 6 个内容词。
const STOPWORDS = new Set(
  ('a an the and or but of in on for with to from by as at is are was were be been being it its this that these those ' +
    'you your we our their his her not no do does did don via using use used how what why when where which who whom ' +
    'can could will would should may might must all any some into over under between through about against after ' +
    'before during without within among per vs etc al et an der die das les des une von dei gli').split(' '),
);
async function searchByTitleSmart(candidate, threshold) {
  // 先整句（命中时最精确），失败再关键词 AND（召回率高）
  const exact = await searchByTitle(candidate, threshold).catch(() => null);
  if (exact) return exact;
  const kws = titleKeywords(candidate);
  if (kws.length < 2) return null;
  const q = kws.map((w) => `ti:${w}`).join(' AND ');
  const { entries } = await arxiv.searchArxiv(q, fetch, { ...ARXIV_OPTS, maxResults: 10 });
  return acceptHit(candidate, entries, threshold);
}

/** 命中验收：pickBest 过阈值；否则标题互相包含（arXiv 标题与文件名截断/后缀差异）也收。 */
function acceptHit(candidate, entries, threshold) {
  const { best, confidence, source } = arxiv.pickBest(candidate, entries, { threshold });
  if (best && source === 'arxiv') return { best, confidence };
  const nc = normalizeTitle(candidate);
  for (const e of entries || []) {
    const ne = normalizeTitle(e.title || '');
    if (nc && ne && ne.length >= 12 && (nc.includes(ne) || ne.includes(nc))) return { best: e, confidence: 0.7, via: 'contain' };
  }
  return null;
}

/** 查询专用额外停用词（只影响 AND 组词，不影响标题相似度）：实测这些词作 ti: 项易把查询清零或召回过宽。 */
const QUERY_STOPWORDS = new Set(['language', 'models', 'model', 'data', 'paper', 'study']);
function titleKeywords(text, max = 6) {
  return String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/[^A-Za-z0-9-]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()) && !QUERY_STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w))
    .slice(0, max);
}

/** 英式 → 美式拼写变体（arXiv 标题多用美式，文件名混用时 AND 会全灭）。 */
function usSpelling(t) {
  return String(t)
    .replace(/behaviour/gi, 'behavior')
    .replace(/colour/gi, 'color')
    .replace(/analyse/gi, 'analyze')
    .replace(/optimis/gi, 'optimiz')
    .replace(/normalis/gi, 'normaliz')
    .replace(/organis/gi, 'organiz');
}

/** 文件名 → 搜索候选标题集合：
 *  ① cleanFilenameToTitle 全程；② 逐块砍掉「作者样」前缀（等/和/短姓氏块），治
 *  「2022-Valdenegro-Toro和Saromo-标题」「Gal和Ghahramani-标题」这类清洗不掉的作者污染；
 *  ③ 每个候选的英式→美式变体。 */
function looksAuthorish(chunk) {
  const t = chunk.trim();
  return t.length <= 20 && (/(等|和)/.test(t) || /^[A-Z][A-Za-z.']+$/.test(t));
}
function candidatesFromFilename(filename) {
  const c0 = cleanFilenameToTitle(filename);
  const out = [];
  if (c0 && c0.length >= 8) out.push(c0);
  const chunks = c0.split('-').map((s) => s.trim()).filter(Boolean);
  const rest = chunks.slice();
  for (let i = 0; i < 2 && rest.length > 1; i++) {
    if (!looksAuthorish(rest[0])) break;
    rest.shift();
    const joined = rest.join('-');
    if (joined.length >= 12) out.push(joined);
  }
  const withVariants = [...out];
  for (const c of out) {
    const us = usSpelling(c);
    if (us !== c) withVariants.push(us);
  }
  return [...new Set(withVariants)];
}

/** 首页标题候选：前 1200 字符里的非空行（去页眉页脚感明显的短行/纯数字行），取前 3 条。 */
function firstPageTitleCandidates(fulltext) {
  const head = String(fulltext || '').slice(0, 1200);
  const lines = head
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && l.length <= 200 && !/^\d+$/.test(l) && !/^(arxiv|preprint|submitted|doi)/i.test(l));
  // 去重保持顺序
  return [...new Set(lines)].slice(0, 3);
}

/** 把命中的 arXiv 条目填进论文的缺失字段。返回实际填入的字段描述（空数组=没东西可填）。 */
function fillMissing(p, best, arxivId) {
  const filled = [];
  const year = best.published ? String(best.published).slice(0, 4) : null;
  if (!p.year && year) { p.year = year; filled.push(`year=${year}`); }
  if ((!Array.isArray(p.authors) || !p.authors.length) && Array.isArray(best.authors) && best.authors.length) {
    p.authors = best.authors;
    filled.push(`authors=${best.authors.length}`);
  }
  if (!p.title && best.title) { p.title = best.title; filled.push('title'); }
  if (!p.abstract && best.summary) { p.abstract = best.summary; filled.push('abstract'); }
  if (!p.primaryCategory && best.primaryCategory) { p.primaryCategory = best.primaryCategory; filled.push(`cat=${best.primaryCategory}`); }
  const id = arxiv.extractArxivId(best) || arxivId;
  if (!p.arxivId && id) { p.arxivId = id; filled.push(`arxivId=${id}`); }
  if (!p.arxivUrl && best.id) { p.arxivUrl = best.id; }
  if (filled.length) p.metaSource = 'arxiv-backfill';
  return filled;
}

async function processPaper(repo, spaceId, p, fulltext) {
  // A. 已有 arxivId
  if (p.arxivId) {
    const best = await fetchById(p.arxivId);
    if (best) {
      const filled = fillMissing(p, best, p.arxivId);
      if (filled.length) { stats.hits.A++; return { hit: 'A', detail: `id:${p.arxivId}`, filled }; }
    }
  }
  // B. 文件名含 ID（带标题校验，防乱命名的文件）
  const fromName = extractArxivIdFromFilename(p.filename);
  if (fromName) {
    const best = await fetchById(fromName.arxivId);
    if (best) {
      const sim = titleSimilarity(cleanFilenameToTitle(p.filename), best.title);
      if (sim >= 0.5) {
        const filled = fillMissing(p, best, fromName.arxivId);
        if (filled.length) { stats.hits.B++; return { hit: 'B', detail: `id:${fromName.arxivId}(${fromName.via},sim=${sim.toFixed(2)})`, filled }; }
      }
      return { hit: null, detail: `id:${fromName.arxivId} 标题不符(sim=${sim.toFixed(2)})`, filled: [] };
    }
  }
  // C. ti: 标题搜索（多候选：清洗全程 / 去作者前缀 / 英美拼写变体；整句 → 关键词 AND → 包含兜底）
  for (const cand of candidatesFromFilename(p.filename)) {
    const hitC = await searchByTitleSmart(cand, 0.75).catch(() => null);
    if (hitC) {
      const filled = fillMissing(p, hitC.best, null);
      if (filled.length) { stats.hits.C++; return { hit: 'C', detail: `ti:"${cand.slice(0, 30)}"(sim=${hitC.confidence.toFixed(2)})`, filled }; }
    }
  }
  // D. 全文首页标题候选（怪文件名兜底）
  if (fulltext) {
    for (const cand of firstPageTitleCandidates(fulltext)) {
      const hitD = await searchByTitleSmart(cand, 0.7).catch(() => null);
      if (hitD) {
        const filled = fillMissing(p, hitD.best, null);
        if (filled.length) { stats.hits.D++; return { hit: 'D', detail: `first-page:"${cand.slice(0, 40)}"(sim=${hitD.confidence.toFixed(2)})`, filled }; }
      }
    }
  }
  return { hit: null, detail: 'arXiv 无匹配', filled: [] };
}

async function main() {
  const db = createDb({ connectionString: DB_URL });
  await db.migrate();
  const repo = createRepository(db);
  const registry = await repo.loadRegistry();
  const spaceIds = SPACE ? [SPACE] : registry.spaces.map((s) => s.id);
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} spaces=${spaceIds.join(',')}`);

  for (const spaceId of spaceIds) {
    const store = await repo.loadSpaceStore(spaceId);
    const papers = Object.values(store.papers || {});
    const needy = papers.filter((p) => !p.year || !Array.isArray(p.authors) || !p.authors.length);
    console.log(`\n== 空间 ${spaceId}：${papers.length} 篇，缺元数据 ${needy.length} 篇 ==`);
    let count = 0;
    let dirty = false;
    for (const p of needy) {
      if (LIMIT && count >= LIMIT) break;
      count++;
      stats.needFill++;
      const name = (p.filename || p.id).slice(0, 44);
      try {
        const fulltext = await repo.getPaperText(spaceId, p.id).catch(() => null);
        const r = await processPaper(repo, spaceId, p, fulltext);
        if (r.hit) {
          dirty = true;
          console.log(`  [${r.hit}] ${name}  ← ${r.detail}  填: ${r.filled.join(', ')}`);
        } else {
          stats.skipped.push(`${spaceId}/${name}（${r.detail}）`);
          console.log(`  [--] ${name}  ${r.detail}`);
        }
      } catch (e) {
        stats.errors++;
        console.log(`  [ERR] ${name}  ${e.message}`);
      }
      await sleep(300); // 叠加限速（searchArxiv 内部还有 3s minInterval）
    }
    if (APPLY && dirty) {
      await repo.saveSpaceStore(spaceId, store);
      console.log(`  → 空间 ${spaceId} 已保存`);
    }
  }

  console.log('\n==== 汇总 ====');
  console.log(`命中：A(已有ID)=${stats.hits.A}  B(文件名ID)=${stats.hits.B}  C(标题搜索)=${stats.hits.C}  D(首页候选)=${stats.hits.D}`);
  console.log(`未命中：${stats.skipped.length}  错误：${stats.errors}${APPLY ? '' : '  （DRY-RUN，未写库；加 --apply 执行）'}`);
  if (stats.skipped.length && stats.skipped.length <= 30) {
    console.log('未命中清单：');
    for (const s of stats.skipped) console.log('  -', s);
  }
  await db.close();
}

main().catch((e) => {
  console.error('[backfill] failed:', e);
  process.exit(1);
});
