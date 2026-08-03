'use strict';

// ingest 路由。由 createApiRouter 在启动时调用 register(t, ctx) 注册到路由表。
// handler 体自 src/api/router.js 的 if 链原样迁移（v3.15 路由化重构），行为逐字不变。

const path = require('path');
const fs = require('fs');
const arxiv = require('../../services/arxiv');
const { sha1OfFile, parseArxivUrl, buildPaperFilename } = require('../../core/util');

function register(t, ctx) {
  const { ok, fail, config, manager, scanner, isProd } = ctx;

  // POST /api/scan  扫描当前空间（?space= 或 active）
  t.post('/api/scan', async ({ res, spaceId }) => {
    const r = await scanner.scanSpace(spaceId);
    return ok(res, r);
  });

  // POST /api/import  { url, meta? }  —— 从 arXiv 网址(abs/pdf/html)或 ID 导入
  //   meta（可选，来自「发现」候选）：{ title, authors, year, abstract, primaryCategory, arxivId }
  //   提供 meta 时：① 文件名用「作者 等 - 年份 - 标题.pdf」；② 预填元数据，使总结/标签直接基于真实标题摘要。
  t.post('/api/import', async ({ res, body, url, spaceId, store, save }) => {
    const op = JSON.parse(body || '{}');
    const parsed = parseArxivUrl(op.url);
    if (!parsed) return fail(res, 400, '无法识别的 arXiv 网址，请粘贴 abs/pdf/html 网址或 arXiv ID（如 2401.12345）');
    const meta = op.meta && typeof op.meta === 'object' ? op.meta : {};
    const mTitle = typeof meta.title === 'string' ? meta.title.trim() : '';
    const mAuthors = Array.isArray(meta.authors) ? meta.authors.filter((a) => typeof a === 'string' && a.trim()) : [];
    const mYear = meta.year != null && String(meta.year).trim() ? String(meta.year).slice(0, 4) : null;
    const mAbstract = typeof meta.abstract === 'string' ? meta.abstract : '';
    const mCategory = typeof meta.primaryCategory === 'string' ? meta.primaryCategory : null;

    // 1) 按 arxivId 查重：已导入过则跳过，不重复下载
    const existing = Object.values(store.papers).find((p) => p.arxivId === parsed.arxivId);
    if (existing)
      return ok(res, { id: existing.id, status: 'duplicate', arxivId: parsed.arxivId, title: existing.title });

    // 2) 下载到该空间的 papersDir。有标题元数据 → 用「作者 等 - 年份 - 标题.pdf」；否则回退 <arxivId>.pdf。
    const papersDir = manager.resolveSpacePapersDir(spaceId);
    let filename =
      buildPaperFilename({ authors: mAuthors, year: mYear, title: mTitle, arxivId: parsed.arxivId }) ||
      `${parsed.arxivId}.pdf`;
    let dest = path.resolve(papersDir, filename);
    // 撞名（不同内容的同名文件）→ 加 arxivId 区分，避免覆盖
    if (fs.existsSync(dest)) {
      filename = filename.replace(/\.pdf$/i, ` (${parsed.arxivId}).pdf`);
      dest = path.resolve(papersDir, filename);
    }
    try {
      await arxiv.downloadPaperPdf(parsed.pdfUrl, dest);
    } catch (e) {
      return fail(
        res,
        502,
        isProd
          ? '下载失败：无法从 arXiv 获取该论文（直连模式；若需代理请配置 config.proxy）'
          : `下载失败：${e.message}（直连模式；若需代理请配置 config.proxy，本功能暂不支持）`,
      );
    }

    // 3) 算 sha1 前16位作 id（与文件导入一致），写 store 条目，复用 scanner 初始化结构。
    //    预填 meta：让 processOne 的总结直接基于真实标题+摘要（避免空标题 → 空总结）。
    const stat = fs.statSync(dest);
    const id = (await sha1OfFile(dest)).slice(0, 16);
    const prev = store.papers[id];
    const hasMeta = !!(mTitle || mAuthors.length);
    store.papers[id] = {
      ...(prev || {}),
      id,
      filename,
      filepath: dest,
      fileMtime: stat.mtimeMs,
      fileSize: stat.size,
      addedAt: (prev && prev.addedAt) || Date.now(),
      title: mTitle,
      authors: mAuthors,
      year: mYear,
      abstract: mAbstract,
      arxivId: parsed.arxivId,
      arxivUrl: `https://arxiv.org/abs/${parsed.arxivId}`,
      sourceUrl: parsed.raw,
      importSource: hasMeta ? 'discover' : 'url',
      primaryCategory: mCategory,
      metaSource: hasMeta ? 'arxiv' : null,
      metaConfidence: hasMeta ? 1 : 0,
      fulltextChars: 0,
      fulltextPath: null,
      summary: '',
      summaryModel: null,
      summaryAt: null,
      tags: [],
      topics: [],
      concepts: [],
      conceptIds: [],
      folders: [],
      readProgress: null,
      notes: '',
      starred: false,
      rating: 0,
      readStatus: 'unread',
      status: 'pending',
      error: null,
      chat: [],
      updatedAt: Date.now(),
    };

    // 4) 落盘 + 入队，复用现有流水线（processOne 已支持已知 arxivId 精确查元数据）
    await save(store);
    scanner.enqueue(spaceId, [id]);
    return ok(res, { id, status: 'imported', arxivId: parsed.arxivId });
  });
}

module.exports = { register };
