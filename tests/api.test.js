const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const pathm = require('node:path');
const { createApiRouter } = require('../src/api/router');
const arxivMod = require('../src/services/arxiv');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try {
        await handler(req, res, body);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

/** 构建多空间测试 ctx（同步，伪造最小 manager）。
 *  store：测试直接读写此对象（manager.getSpaceStore 返回它，引用共享）。
 *  opts.papersDir：该空间绑定的文件夹（导入/删除测试用临时目录）；默认 'papers'。
 *  opts.config：globalConfig（默认 {ai:{}}）；扫描间隔/arxiv 等也放这里。
 *  返回的 scanner 可变：测试可后赋值 ctx.scanner.retagPapers 等；
 *  方法签名带 spaceId 首参（与 createMultiSpaceScanner 一致），stub 内忽略 spaceId。 */
function baseCtx(store, save, opts = {}) {
  const globalConfig = opts.config || { ai: {}, scanIntervalMinutes: 5 };
  const papersDir = opts.papersDir || 'papers';
  const spaceObj = { id: 'default', name: '默认', papersDir, scanIntervalMinutes: 5, lastScanAt: 0, createdAt: 0 };
  // 伪造 manager：只实现 api.js 用到的方法，store 直接用测试对象
  const manager = {
    getActiveSpaceId: () => 'default',
    getActiveSpace: () => spaceObj,
    getSpace: (id) => (id === 'default' ? spaceObj : null),
    listSpaces: () => [spaceObj],
    getStorePath: () => 'papers.json',
    getSpaceStore: async () => store,
    saveStoreBinder: () => async () => {
      if (save) await save(store);
    },
    resolveSpacePapersDir: () => papersDir,
    resolveSpaceTextDir: () => pathm.join(papersDir, 'text'),
    spacesView: async () => ({ activeSpaceId: 'default', spaces: [{ ...spaceObj, paperCount: 0 }] }),
    minScheduledIntervalMs: () => 5 * 60 * 1000,
    scheduledSpaces: () => [spaceObj],
    createSpace: async ({ name, papersDir: pd }) => ({
      id: 'new',
      name: name || 'x',
      papersDir: pd || 'papers',
      createdAt: 0,
      scanIntervalMinutes: 5,
      lastScanAt: 0,
    }),
    renameSpace: async (id, name) => ({ ...spaceObj, name }),
    changePapersDir: async (id, pd) => {
      spaceObj.papersDir = pd;
      return spaceObj;
    },
    deleteSpace: async (id) => ({ deleted: id, papersDirKept: papersDir }),
    setActiveSpace: async (id) => spaceObj,
    setScanInterval: async (id, n) => {
      spaceObj.scanIntervalMinutes = n;
      return spaceObj;
    },
    markScanned: async () => {},
    backupAllSpaces: async () => {},
  };
  const scanner = {
    scan: async () => ({ added: 0 }),
    scanSpace: async () => ({ added: 0 }),
    enqueue: () => {},
    extractConcepts: async (spaceId, ids) => ({ processed: ids.length, added: 1 }),
    retagPapers: async (spaceId, ids) => ({ processed: ids.length }),
    chatPaper: async (spaceId, id, message) => ({ reply: '', chat: [] }),
    reschedule: async () => {},
    invalidate: () => {},
  };
  return { manager, scanner, globalConfig };
}

test('GET /api/health 返回状态信息', async () => {
  const store = { papers: { a: {}, b: {} }, tags: [], topics: [], folders: [], concepts: [], settings: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.status, 'ok');
  assert.strictEqual(r.json.data.papers, 2);
  assert.strictEqual(typeof r.json.data.uptime, 'number');
  server.close();
});

test('GET /api/papers 返回列表视图', async () => {
  const store = {
    version: 1,
    tags: ['rlhf'],
    papers: {
      a: { id: 'a', title: 'T1', tags: ['rlhf'], status: 'ready', readStatus: 'unread', starred: false, addedAt: 1 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data[0].id, 'a');
  server.close();
});

test('GET /api/papers 支持标签与全文 q 筛选', async () => {
  const store = {
    version: 1,
    tags: [],
    papers: {
      a: { id: 'a', title: 'Alpha', tags: ['rlhf'], status: 'ready', addedAt: 1, summary: '', notes: '', abstract: '' },
      b: { id: 'b', title: 'Beta', tags: ['data'], status: 'ready', addedAt: 2, summary: '', notes: '', abstract: '' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byTag = await call(port, 'GET', '/api/papers?tag=rlhf');
  assert.strictEqual(byTag.json.data.length, 1);
  assert.strictEqual(byTag.json.data[0].id, 'a');
  const byQ = await call(port, 'GET', '/api/papers?q=beta');
  assert.strictEqual(byQ.json.data[0].id, 'b');
  server.close();
});

test('GET /api/papers 标签/主题多选筛选（维度内 OR、维度间 AND）', async () => {
  const store = {
    version: 2,
    tags: ['rlhf', 'data', 'cnn'],
    topics: ['推理', '视觉'],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', tags: ['rlhf'], topics: ['推理'], status: 'ready', addedAt: 1 },
      b: { id: 'b', title: 'B', tags: ['data'], topics: ['视觉'], status: 'ready', addedAt: 2 },
      c: { id: 'c', title: 'C', tags: ['cnn'], topics: ['视觉'], status: 'ready', addedAt: 3 },
      d: { id: 'd', title: 'D', tags: ['rlhf'], topics: ['视觉'], status: 'ready', addedAt: 4 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 标签多选 OR：rlhf OR cnn → a, c, d
  const byTags = await call(port, 'GET', '/api/papers?tag=rlhf&tag=cnn');
  assert.deepStrictEqual(byTags.json.data.map((p) => p.id).sort(), ['a', 'c', 'd']);
  // 单标签向后兼容：rlhf → a, d
  const byTag = await call(port, 'GET', '/api/papers?tag=rlhf');
  assert.deepStrictEqual(byTag.json.data.map((p) => p.id).sort(), ['a', 'd']);
  // 标签 + 主题 跨维度 AND：tag=rlhf & topic=视觉 → 仅 d（同时满足）
  const cross = await call(port, 'GET', '/api/papers?tag=rlhf&topic=' + encodeURIComponent('视觉'));
  assert.deepStrictEqual(
    cross.json.data.map((p) => p.id),
    ['d'],
  );
  // 主题多选 OR：推理 OR 视觉 → 全部
  const byTopics = await call(
    port,
    'GET',
    '/api/papers?topic=' + encodeURIComponent('推理') + '&topic=' + encodeURIComponent('视觉'),
  );
  assert.strictEqual(byTopics.json.data.length, 4);
  // 标签多选 AND（tagOp=and）：rlhf AND cnn → 仅同时含两者的论文（取交集）。fixture 里无论文同时含两者 → 空
  const byTagsAnd = await call(port, 'GET', '/api/papers?tag=rlhf&tag=cnn&tagOp=and');
  assert.deepStrictEqual(
    byTagsAnd.json.data.map((p) => p.id).sort(),
    [],
    'tagOp=and 应取交集（无同时含 rlhf 和 cnn 的论文）',
  );
  // tagOp=and 结果 ⊆ tagOp=or 结果（默认）：空 ⊆ [a,c,d]
  assert.ok(byTagsAnd.json.data.length <= byTags.json.data.length, 'AND 结果应 ≤ OR 结果');
  server.close();
});

test('PATCH /api/papers/:id 更新 notes/starred 并持久化', async () => {
  const store = {
    version: 1,
    tags: [],
    papers: {
      a: { id: 'a', title: 'T', notes: '', starred: false, status: 'ready', updatedAt: 0 },
    },
  };
  let saved = null;
  const router = createApiRouter(
    baseCtx(store, async (s) => {
      saved = s;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', { notes: 'my note', starred: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.papers.a.notes, 'my note');
  assert.strictEqual(store.papers.a.starred, true);
  assert.ok(saved, 'save should be called');
  server.close();
});

test('PATCH→GET 批注往返：对象型 quadPoints 被还原为真数组（高亮持久化根因修复）', async () => {
  const store = {
    version: 1,
    tags: [],
    papers: {
      a: { id: 'a', title: 'T', status: 'ready', annotations: null },
    },
  };
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 复刻浏览器：serializable 里 quadPoints 是 Float32Array，经 fetch 的 JSON.stringify 发出，
  // 到服务端已退化成 {"0":..} 对象（call() 内部 JSON.stringify 等价于这一步）。
  const payload = {
    items: [
      {
        id: null,
        annotationType: 9,
        color: [187, 247, 208],
        opacity: 1,
        thickness: 12,
        quadPoints: new Float32Array([265, 660, 329, 660, 265, 649, 329, 649]),
        pageIndex: 0,
        rect: [69, 524, 525, 664],
      },
    ],
    updatedAt: 1,
  };
  const w = await call(port, 'PATCH', '/api/papers/a', { annotations: payload });
  assert.strictEqual(w.status, 200);
  // 写入侧：落盘的 quadPoints 必须是真数组
  const storedQp = store.papers.a.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(storedQp), '落盘 quadPoints 应为数组');
  assert.strictEqual(storedQp.length, 8);
  // 读取侧：GET 详情返回的 quadPoints 可被 pdf.js 的 for(i<length;i+=8) 正常重建
  const r = await call(port, 'GET', '/api/papers/a');
  const qp = r.json.data.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(qp));
  let boxes = 0;
  for (let i = 0; i < qp.length; i += 8) boxes++;
  assert.strictEqual(boxes, 1, '高亮区域应可重建（修复前为 0）');
  server.close();
});

test('GET 详情：自愈历史脏数据（已落盘的对象型 quadPoints）', async () => {
  // 模拟历史上已被写坏的存量数据：quadPoints 已是 {"0":..} 对象
  const corrupted = JSON.parse(JSON.stringify({ q: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) })).q;
  const store = {
    version: 1,
    tags: [],
    papers: {
      a: {
        id: 'a',
        title: 'T',
        status: 'ready',
        annotations: { items: [{ annotationType: 9, quadPoints: corrupted, pageIndex: 0 }], updatedAt: 1 },
      },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers/a');
  const qp = r.json.data.annotations.items[0].quadPoints;
  assert.ok(Array.isArray(qp), '读取时应把存量脏数据还原为数组');
  assert.deepStrictEqual(qp, [1, 2, 3, 4, 5, 6, 7, 8]);
  server.close();
});

test('GET /api/tags 返回字典+计数', async () => {
  const store = {
    version: 1,
    tags: ['rlhf', 'data'],
    papers: {
      a: { id: 'a', tags: ['rlhf'], status: 'ready' },
      b: { id: 'b', tags: ['rlhf', 'data'], status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/tags');
  const counts = Object.fromEntries(r.json.data.map((t) => [t.name, t.count]));
  assert.strictEqual(counts.rlhf, 2);
  assert.strictEqual(counts.data, 1);
  server.close();
});

test('GET /api/papers 支持 topic 与 folder 筛选', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: ['推理'],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', tags: [], topics: ['推理'], folders: ['f1'], status: 'ready', addedAt: 1 },
      b: { id: 'b', title: 'B', tags: [], topics: ['数据'], folders: [], status: 'ready', addedAt: 2 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byTopic = await call(port, 'GET', '/api/papers?topic=' + encodeURIComponent('推理'));
  assert.strictEqual(byTopic.json.data.length, 1);
  assert.strictEqual(byTopic.json.data[0].id, 'a');
  const byFolder = await call(port, 'GET', '/api/papers?folder=f1');
  assert.strictEqual(byFolder.json.data.length, 1);
  assert.strictEqual(byFolder.json.data[0].id, 'a');
  server.close();
});

test('PATCH /api/papers/:id 可写入 topics/folders/readProgress', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'T', topics: [], folders: [], readProgress: null, status: 'ready', updatedAt: 0 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', {
    topics: ['推理'],
    folders: ['f1'],
    readProgress: { page: 3, scrollTop: 120 },
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(store.papers.a.topics, ['推理']);
  assert.deepStrictEqual(store.papers.a.folders, ['f1']);
  assert.strictEqual(store.papers.a.readProgress.page, 3);
  assert.ok(store.topics.includes('推理'));
  server.close();
});

test('收藏夹 CRUD：POST / PATCH / DELETE，计数随论文变化', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', folders: [], status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const create = await call(port, 'POST', '/api/folders', { name: '精读', color: '#2563eb' });
  assert.strictEqual(create.status, 200);
  const fid = create.json.data.id;
  store.papers.a.folders = [fid];
  const list = await call(port, 'GET', '/api/folders');
  assert.strictEqual(list.json.data[0].count, 1);
  const upd = await call(port, 'PATCH', '/api/folders/' + fid, { name: '已精读' });
  assert.strictEqual(upd.json.data.name, '已精读');
  const del = await call(port, 'DELETE', '/api/folders/' + fid);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(store.folders.length, 0);
  assert.deepStrictEqual(store.papers.a.folders, []); // 自动解绑
  server.close();
});

test('GET /api/concepts 与概念清单 Markdown', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [{ id: 'c1', term: 'RLHF', definition: 'd', paperIds: ['a'] }],
    papers: {
      a: { id: 'a', title: 'A 论文', conceptIds: ['c1'], status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byPaper = await call(port, 'GET', '/api/concepts?paper=a');
  assert.strictEqual(byPaper.json.data.length, 1);
  const mdRes = await fetch(`http://127.0.0.1:${port}/api/concepts.md`);
  const md = await mdRes.text();
  assert.ok(md.includes('# 概念清单'));
  assert.ok(md.includes('RLHF'));
  server.close();
});

test('POST /api/papers/concepts 对选中论文调用 scanner.extractConcepts', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', status: 'ready' },
      b: { id: 'b', title: 'B', status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/concepts', { ids: ['a', 'b'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.processed, 2);
  server.close();
});

test('GET /api/stats 含 folders/topics/concepts 计数', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: ['推理'],
    folders: [{ id: 'f1', name: 'x' }],
    concepts: [{ id: 'c1', term: 'y' }],
    papers: {
      a: { id: 'a', status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/stats');
  assert.strictEqual(r.json.data.folders, 1);
  assert.strictEqual(r.json.data.topics, 1);
  assert.strictEqual(r.json.data.concepts, 1);
  server.close();
});

test('GET /api/settings 返回 summaryPrompt 与内置默认', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: { summaryPrompt: '我的提示词' },
    papers: {},
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/settings');
  assert.strictEqual(r.json.data.summaryPrompt, '我的提示词');
  assert.ok(r.json.data.defaultPrompt && r.json.data.defaultPrompt.length > 50);
  server.close();
});

test('POST /api/import 带 meta：按「作者 等 - 年份 - 标题」命名并预填元数据', async () => {
  const tmpPapers = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwimport-'));
  const origDownload = arxivMod.downloadPaperPdf;
  arxivMod.downloadPaperPdf = async (url, dest) => {
    fs.writeFileSync(dest, Buffer.from('%PDF-1.4\n%placeholder\n'));
    return dest;
  };
  try {
    const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {} };
    let enq = null;
    const ctx = baseCtx(store, async () => {}, {
      papersDir: tmpPapers,
      config: { ai: {}, papersDir: tmpPapers, arxiv: {} },
    });
    ctx.scanner.enqueue = (spaceId, ids) => {
      enq = ids;
    };
    const router = createApiRouter(ctx);
    const server = await startServer(router.handle);
    const port = server.address().port;
    const meta = {
      title: 'DAPO: An Open-Source System',
      authors: ['Qiying Yu', 'Bob Lee'],
      year: 2025,
      abstract: 'We present DAPO.',
      primaryCategory: 'cs.LG',
      arxivId: '2503.14476',
    };
    const r = await call(port, 'POST', '/api/import', { url: 'https://arxiv.org/abs/2503.14476', meta });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.status, 'imported');
    const p = store.papers[r.json.data.id];
    assert.strictEqual(p.filename, 'Yu 等 - 2025 - DAPO An Open-Source System.pdf', '应按 作者 等 - 年份 - 标题 命名');
    assert.strictEqual(p.title, 'DAPO: An Open-Source System');
    assert.deepStrictEqual(p.authors, ['Qiying Yu', 'Bob Lee']);
    assert.strictEqual(p.year, '2025');
    assert.strictEqual(p.abstract, 'We present DAPO.');
    assert.strictEqual(p.arxivId, '2503.14476');
    assert.strictEqual(p.primaryCategory, 'cs.LG');
    assert.strictEqual(p.metaSource, 'arxiv', '预填元数据 → metaSource=arxiv，总结直接基于真实标题/摘要');
    assert.strictEqual(p.importSource, 'discover');
    assert.strictEqual(p.status, 'pending');
    assert.deepStrictEqual(enq, [p.id], '应入队等流水线总结');
    assert.ok(fs.existsSync(pathm.join(tmpPapers, p.filename)), '规范名文件应已落盘');
    server.close();
  } finally {
    arxivMod.downloadPaperPdf = origDownload;
    fs.rmSync(tmpPapers, { recursive: true, force: true });
  }
});

test('POST /api/import 不带 meta：回退 <arxivId>.pdf 且 importSource=url', async () => {
  const tmpPapers = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwimport2-'));
  const origDownload = arxivMod.downloadPaperPdf;
  arxivMod.downloadPaperPdf = async (url, dest) => {
    fs.writeFileSync(dest, Buffer.from('%PDF-1.4\n%placeholder\n'));
    return dest;
  };
  try {
    const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {} };
    const ctx = baseCtx(store, async () => {}, {
      papersDir: tmpPapers,
      config: { ai: {}, papersDir: tmpPapers, arxiv: {} },
    });
    const router = createApiRouter(ctx);
    const server = await startServer(router.handle);
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/import', { url: 'https://arxiv.org/abs/2401.99999' });
    assert.strictEqual(r.json.data.status, 'imported');
    const p = store.papers[r.json.data.id];
    assert.strictEqual(p.filename, '2401.99999.pdf', '无 meta → 回退裸ID命名（后续 processOne 会改名）');
    assert.strictEqual(p.importSource, 'url');
    assert.strictEqual(p.metaSource, null);
    server.close();
  } finally {
    arxivMod.downloadPaperPdf = origDownload;
    fs.rmSync(tmpPapers, { recursive: true, force: true });
  }
});

test('DELETE /api/papers/:id 删除条目 + PDF，并清理概念引用', async () => {
  const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwdel-'));
  const pdf = pathm.join(tmp, 'p.pdf');
  fs.writeFileSync(pdf, 'PDFDATA');
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [{ id: 'c1', term: 'T', paperIds: ['a', 'b'] }],
    papers: {
      a: { id: 'a', filename: 'p.pdf', filepath: pdf, conceptIds: ['c1'], status: 'ready' },
      b: { id: 'b', filename: 'q.pdf', filepath: pathm.join(tmp, 'q.pdf'), conceptIds: ['c1'], status: 'ready' },
    },
  };
  let saved = false;
  const ctx = baseCtx(
    store,
    async () => {
      saved = true;
    },
    { papersDir: tmp, config: { ai: {}, papersDir: tmp } },
  );
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', '/api/papers/a');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.ok(!store.papers.a, '论文条目应被删除');
  assert.ok(store.papers.b, '其它论文不受影响');
  assert.ok(!fs.existsSync(pdf), 'PDF 文件应被删除');
  // v3：全文在 PG paper_texts，由 repo.saveSpaceStore 检测论文删除时连带清理（见 tests/db.test.js）
  assert.deepStrictEqual(store.concepts[0].paperIds, ['b'], '概念里应移除该论文引用');
  assert.ok(saved, '应持久化');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('DELETE /api/papers/:id 文件缺失也能删条目（不抛）；不存在返回 404', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: { a: { id: 'a', filename: 'gone.pdf', filepath: '/no/such/gone.pdf', status: 'missing' } },
  };
  const ctx = baseCtx(store, async () => {}, { papersDir: '/tmp', config: { ai: {}, papersDir: '/tmp' } });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', '/api/papers/a');
  assert.strictEqual(r.status, 200, '文件缺失也应成功删条目');
  assert.ok(!store.papers.a);
  const r404 = await call(port, 'DELETE', '/api/papers/nope');
  assert.strictEqual(r404.status, 404);
  server.close();
});

test('POST /api/papers/bulk-delete 批量删 + 清理空 tags/topics + 孤立概念', async () => {
  const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwbulk-'));
  const pdfA = pathm.join(tmp, 'a.pdf');
  const pdfB = pathm.join(tmp, 'b.pdf');
  fs.writeFileSync(pdfA, 'A');
  fs.writeFileSync(pdfB, 'B');
  // a/b/c 三篇：a 含标签 rlhf（仅 a 有）+ 主题 推理（仅 a 有）；c 不删
  // 概念 c1 只被 a/b 引用，删 a/b 后变空应被移除；c2 被 c 引用应保留
  const store = {
    version: 2,
    tags: ['rlhf', 'data'],
    topics: ['推理', '视觉'],
    folders: [],
    papers: {
      a: {
        id: 'a',
        filename: 'a.pdf',
        filepath: pdfA,
        fulltextPath: null,
        tags: ['rlhf'],
        topics: ['推理'],
        status: 'ready',
      },
      b: {
        id: 'b',
        filename: 'b.pdf',
        filepath: pdfB,
        fulltextPath: null,
        tags: ['data'],
        topics: ['视觉'],
        status: 'ready',
      },
      c: {
        id: 'c',
        filename: 'c.pdf',
        filepath: pathm.join(tmp, 'c.pdf'),
        tags: ['data'],
        topics: ['视觉'],
        status: 'ready',
      },
    },
    concepts: [
      { id: 'c1', term: '孤儿', paperIds: ['a', 'b'] }, // 删 a/b 后空 → 移除
      { id: 'c2', term: '保留', paperIds: ['c'] }, // 被 c 引用 → 保留
    ],
  };
  const ctx = baseCtx(store, async () => {}, { papersDir: tmp, config: { ai: {}, papersDir: tmp } });
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/bulk-delete', { ids: ['a', 'b'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.deleted, 2);
  assert.deepStrictEqual(r.json.data.ids.sort(), ['a', 'b']);
  // 论文删除
  assert.ok(!store.papers.a && !store.papers.b, 'a/b 删除');
  assert.ok(store.papers.c, 'c 保留');
  // PDF 文件删除
  assert.ok(!fs.existsSync(pdfA) && !fs.existsSync(pdfB), 'PDF 删除');
  // 标签/主题聚合：rlhf/推理（仅 a/b 有）归零清除；data/视觉（c 还有）保留
  assert.deepStrictEqual(store.tags, ['data'], 'rlhf 清除');
  assert.deepStrictEqual(store.topics, ['视觉'], '推理清除');
  // 孤立概念移除；被引用的保留
  assert.deepStrictEqual(
    store.concepts.map((x) => x.id),
    ['c2'],
    'c1 移除 c2 保留',
  );
  // 空 ids / 全不存在的 id
  const r2 = await call(port, 'POST', '/api/papers/bulk-delete', { ids: [] });
  assert.strictEqual(r2.status, 400);
  const r3 = await call(port, 'POST', '/api/papers/bulk-delete', { ids: ['nope'] });
  assert.strictEqual(r3.status, 400, '全无效 id 返回 400');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('POST /api/papers/:id/retag & /api/papers/retag —— 重新打标端点', async () => {
  let retagged = null;
  const store = {
    version: 2,
    tags: ['a'],
    topics: ['X'],
    folders: [],
    concepts: [],
    papers: { p1: { id: 'p1', tags: ['a'], topics: ['X'], status: 'ready' } },
  };
  const ctx = baseCtx(store, async () => {});
  ctx.scanner.retagPapers = async (spaceId, ids) => {
    retagged = ids;
    return { processed: ids.length };
  };
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  // 单篇 retag
  const r = await call(port, 'POST', '/api/papers/p1/retag');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(retagged, ['p1']);
  assert.strictEqual(r.json.data.processed, 1);
  // 批量 retag
  const r2 = await call(port, 'POST', '/api/papers/retag', { ids: ['p1'] });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(retagged, ['p1']);
  // 空 ids → 400
  const r3 = await call(port, 'POST', '/api/papers/retag', { ids: [] });
  assert.strictEqual(r3.status, 400);
  // 不存在 → 404
  const r4 = await call(port, 'POST', '/api/papers/nope/retag');
  assert.strictEqual(r4.status, 404);
  server.close();
});

test('POST /api/papers/:id/chat —— 论文对话端点（追加消息到 chat + 落盘）', async () => {
  let chatArgs = null;
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: { p1: { id: 'p1', title: 'T', abstract: 'A', status: 'ready', chat: [] } },
  };
  const ctx = baseCtx(store, async () => {});
  ctx.scanner.chatPaper = async (spaceId, id, message) => {
    chatArgs = { id, message };
    // 模拟 scanner.chatPaper 的追加行为
    store.papers[id].chat.push({ role: 'user', content: message, ts: 1 });
    store.papers[id].chat.push({ role: 'assistant', content: '回复', ts: 1 });
    return { reply: '回复', chat: store.papers[id].chat };
  };
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  // 正常对话
  const r = await call(port, 'POST', '/api/papers/p1/chat', { message: '这篇论文的方法是什么？' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(chatArgs, { id: 'p1', message: '这篇论文的方法是什么？' });
  assert.strictEqual(r.json.data.reply, '回复');
  assert.strictEqual(r.json.data.chat.length, 2, '返回完整 chat 历史');
  // 空 message → 400
  const r2 = await call(port, 'POST', '/api/papers/p1/chat', { message: '   ' });
  assert.strictEqual(r2.status, 400);
  // 不存在 → 404
  const r3 = await call(port, 'POST', '/api/papers/nope/chat', { message: 'x' });
  assert.strictEqual(r3.status, 404);
  // detailView 回传 chat
  const r4 = await call(port, 'GET', '/api/papers/p1');
  assert.deepStrictEqual(r4.json.data.chat.length, 2, 'detailView 回传 chat 历史');
  server.close();
});

test('PUT /api/settings/summary-prompt 持久化并 trim', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let saved = null;
  const router = createApiRouter(
    baseCtx(store, async (s) => {
      saved = s;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/summary-prompt', { value: '  新提示  ' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.summaryPrompt, '新提示');
  assert.ok(saved, 'save should be called');
  // 空串 = 恢复默认
  const r2 = await call(port, 'PUT', '/api/settings/summary-prompt', { value: '   ' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.summaryPrompt, '');
  server.close();
});

test('PUT /api/settings/chat-presets 持久化预置按钮（规整：去空/截断/限20）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/chat-presets', {
    value: [
      { label: '核心方法', prompt: '这篇论文的核心方法是什么？' },
      { label: '空', prompt: '   ' }, // 空 prompt 应被过滤
      { label: '长标签'.repeat(20), prompt: '有内容' }, // label 截断到 24
    ],
  });
  assert.strictEqual(r.status, 200);
  // 过滤掉空 prompt 后剩 2 条；label 截断
  assert.strictEqual(store.settings.chatPresets.length, 2);
  assert.strictEqual(store.settings.chatPresets[0].label, '核心方法');
  assert.ok(store.settings.chatPresets[1].label.length <= 24, 'label 被截断到 24 字符');
  // GET /api/settings 回显 chatPresets
  const g = await call(port, 'GET', '/api/settings');
  assert.deepStrictEqual(g.json.data.chatPresets, store.settings.chatPresets);
  server.close();
});

test('GET /api/settings 返回新字段（tagsPrompt / ai 掩码 / defaultTagsPrompt）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {
      summaryPrompt: '总结',
      tagsPrompt: '标签',
      ai: { baseURL: 'http://x/v1', apiKey: 'sk-1234567890abcdef', model: 'glm' },
    },
    papers: {},
  };
  const ctx = baseCtx(store, async () => {}, { config: { ai: { baseURL: 'http://config/v1', model: 'cfg-model' } } });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/settings');
  assert.strictEqual(r.json.data.summaryPrompt, '总结');
  assert.strictEqual(r.json.data.tagsPrompt, '标签');
  assert.ok(r.json.data.defaultTagsPrompt && r.json.data.defaultTagsPrompt.length > 20);
  // 生效 AI 配置 = store.settings.ai 覆盖 config.ai
  assert.strictEqual(r.json.data.ai.baseURL, 'http://x/v1');
  assert.strictEqual(r.json.data.ai.model, 'glm');
  assert.strictEqual(r.json.data.ai.hasApiKey, true);
  assert.ok(r.json.data.ai.apiKeyMasked.includes('****'), 'apiKey 应掩码');
  assert.ok(!r.json.data.ai.apiKeyMasked.includes('1234567890abcdef'), '完整 key 不应泄露');
  // config.json 原值（只读参考）
  assert.strictEqual(r.json.data.configAi.baseURL, 'http://config/v1');
  assert.strictEqual(r.json.data.configAi.model, 'cfg-model');
  server.close();
});

test('PUT /api/settings/ai 持久化、白名单字段、apiKey 掩码回传不覆盖', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 首次写入
  const r1 = await call(port, 'PUT', '/api/settings/ai', {
    baseURL: 'http://new/v1',
    apiKey: 'sk-newkey123456',
    model: 'gpt-4o',
    maxInputChars: 50000,
    timeoutMs: 90000,
  });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(store.settings.ai.baseURL, 'http://new/v1');
  assert.strictEqual(store.settings.ai.apiKey, 'sk-newkey123456');
  assert.strictEqual(store.settings.ai.model, 'gpt-4o');
  assert.strictEqual(store.settings.ai.maxInputChars, 50000);
  assert.strictEqual(store.settings.ai.timeoutMs, 90000);
  assert.ok(r1.json.data.ai.apiKeyMasked.includes('****'));
  // 再次提交掩码（模拟前端回显误传）→ apiKey 不应被覆盖/清空
  const r2 = await call(port, 'PUT', '/api/settings/ai', { apiKey: '****' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.ai.apiKey, 'sk-newkey123456', '掩码回传不应覆盖原 key');
  // 显式空串 = 清空 apiKey
  const r3 = await call(port, 'PUT', '/api/settings/ai', { apiKey: '' });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(store.settings.ai.apiKey, '', '空串应清空 apiKey');
  // 未传字段保留原值
  const r4 = await call(port, 'PUT', '/api/settings/ai', { model: 'claude' });
  assert.strictEqual(r4.status, 200);
  assert.strictEqual(store.settings.ai.model, 'claude');
  assert.strictEqual(store.settings.ai.baseURL, 'http://new/v1', '未传字段保留原值');
  server.close();
});

// ---- v3.13 多渠道（模型卡片）----
test('GET /api/settings 无渠道存根时从生效配置合成单渠道视图', async () => {
  const store = {
    version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {},
    settings: { ai: { baseURL: 'http://x/v1', apiKey: 'sk-legacy', model: 'glm' } },
  };
  const router = createApiRouter(baseCtx(store, async () => {}, { config: { ai: {} } }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/settings');
  const ai = r.json.data.ai;
  assert.strictEqual(ai.channels.length, 1, '旧部署合成单渠道');
  assert.strictEqual(ai.channels[0].id, 'ch_default');
  assert.strictEqual(ai.channels[0].baseURL, 'http://x/v1');
  assert.strictEqual(ai.channels[0].model, 'glm');
  assert.strictEqual(ai.channels[0].hasApiKey, true);
  assert.strictEqual(ai.channels[0].active, true);
  assert.strictEqual(ai.activeChannelId, 'ch_default');
  server.close();
});

test('PUT /api/settings/ai/channels 全量替换、掩码保留 key、迁移删除旧顶层字段', async () => {
  const store = {
    version: 2, tags: [], topics: [], folders: [], concepts: [], papers: {},
    settings: { ai: { baseURL: 'http://legacy/v1', apiKey: 'sk-legacylegacy', model: 'legacy-model', timeoutMs: 90000 } },
  };
  const router = createApiRouter(baseCtx(store, async () => {}, { config: { ai: {} } }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 保存两个渠道：ch_default 掩码回传（应保留旧生效 key），新渠道无 id（应生成）
  const r1 = await call(port, 'PUT', '/api/settings/ai/channels', {
    channels: [
      { id: 'ch_default', name: '旧网关', baseURL: 'http://legacy/v1', apiKey: '********', model: 'legacy-model' },
      { name: 'Kimi', baseURL: 'https://api.kimi.com/coding/v1', apiKey: 'sk-kimi-abc', model: 'k3', maxInputTokens: 1000000 },
    ],
    activeChannelId: 'ch_default',
  });
  assert.strictEqual(r1.status, 200);
  const ai1 = r1.json.data.ai;
  assert.strictEqual(ai1.channels.length, 2);
  assert.strictEqual(store.settings.ai.channels[0].apiKey, 'sk-legacylegacy', '掩码回传保留旧生效 key');
  const gen = store.settings.ai.channels[1];
  assert.ok(/^ch_[0-9a-f]{8}$/.test(gen.id), '缺省 id 自动生成');
  assert.strictEqual(gen.apiKey, 'sk-kimi-abc');
  assert.strictEqual(gen.maxInputTokens, 1000000);
  assert.strictEqual(ai1.activeChannelId, 'ch_default');
  // 迁移：旧版顶层三元组删除（渠道成单一事实源），全局字段保留
  assert.strictEqual(store.settings.ai.baseURL, undefined);
  assert.strictEqual(store.settings.ai.apiKey, undefined);
  assert.strictEqual(store.settings.ai.model, undefined);
  assert.strictEqual(store.settings.ai.timeoutMs, 90000);
  // 生效配置 = 活跃渠道
  assert.strictEqual(ai1.baseURL, 'http://legacy/v1');
  assert.strictEqual(ai1.model, 'legacy-model');
  // 切换默认 → 生效配置立即切换到 Kimi（含渠道级 maxInputTokens）
  const kimiId = gen.id;
  const r2 = await call(port, 'PUT', '/api/settings/ai/channels', {
    channels: [
      { id: 'ch_default', name: '旧网关', baseURL: 'http://legacy/v1', apiKey: '********', model: 'legacy-model' },
      { id: kimiId, name: 'Kimi', baseURL: 'https://api.kimi.com/coding/v1', apiKey: '********', model: 'k3', maxInputTokens: 1000000 },
    ],
    activeChannelId: kimiId,
  });
  assert.strictEqual(r2.status, 200);
  const ai2 = r2.json.data.ai;
  assert.strictEqual(ai2.baseURL, 'https://api.kimi.com/coding/v1');
  assert.strictEqual(ai2.model, 'k3');
  assert.strictEqual(ai2.maxInputTokens, 1000000, '渠道级 tokens 生效');
  assert.strictEqual(store.settings.ai.channels[1].apiKey, 'sk-kimi-abc', '二次保存掩码仍保留新渠道 key');
  assert.strictEqual(ai2.channels.find((c) => c.id === kimiId).active, true);
  server.close();
});

test('PUT /api/settings/ai/channels 校验：缺 baseURL/model 报 400；activeChannelId 未命中回落第一个', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const bad = await call(port, 'PUT', '/api/settings/ai/channels', { channels: [{ name: 'x', model: 'm' }] });
  assert.strictEqual(bad.status, 400);
  const r = await call(port, 'PUT', '/api/settings/ai/channels', {
    channels: [{ baseURL: 'http://a/v1', model: 'ma' }, { baseURL: 'http://b/v1', model: 'mb' }],
    activeChannelId: 'ch_nope',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.ai.activeChannelId, r.json.data.ai.channels[0].id, '未命中回落第一个渠道');
  // 空列表 = 清除渠道，回落 config/旧版语义
  const r2 = await call(port, 'PUT', '/api/settings/ai/channels', { channels: [] });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.ai.channels, undefined);
  assert.strictEqual(r2.json.data.ai.channels.length, 0, 'config 无 ai 配置时无合成渠道');
  server.close();
});

test('PATCH /api/topics 主题重命名/删除（对齐标签 PATCH）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: ['强化学习', '推理', '对齐'],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', tags: [], topics: ['强化学习', '推理'], folders: [] },
      b: { id: 'b', tags: [], topics: ['强化学习'], folders: [] },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 合并：强化学习 → RL
  const r1 = await call(port, 'PATCH', '/api/topics', { merge: '强化学习', into: 'RL' });
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(store.papers.a.topics.sort(), ['RL', '推理']);
  assert.deepStrictEqual(store.papers.b.topics, ['RL']);
  assert.ok(store.topics.includes('RL'));
  assert.ok(!store.topics.includes('强化学习'));
  // 删除：推理
  const r2 = await call(port, 'PATCH', '/api/topics', { delete: '推理' });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(store.papers.a.topics, ['RL']);
  assert.ok(!store.topics.includes('推理'));
  server.close();
});

test('PATCH /api/tags 标签重命名/删除——清单删除时从所有论文剔除（与主题对称）', async () => {
  const store = {
    version: 2,
    tags: ['rlhf', 'transformer', 'fine-tuning'],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', tags: ['rlhf', 'transformer'], topics: [] },
      b: { id: 'b', tags: ['rlhf'], topics: [] },
      c: { id: 'c', tags: ['transformer', 'fine-tuning'], topics: [] },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 合并：rlhf → ppo（论文里的 rlhf 都改名为 ppo）
  const r1 = await call(port, 'PATCH', '/api/tags', { merge: 'rlhf', into: 'ppo' });
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(store.papers.a.tags.sort(), ['ppo', 'transformer']);
  assert.deepStrictEqual(store.papers.b.tags, ['ppo']);
  assert.ok(store.tags.includes('ppo'));
  assert.ok(!store.tags.includes('rlhf'));
  // 删除：transformer —— 必须从所有论文剔除（不残留）
  const r2 = await call(port, 'PATCH', '/api/tags', { delete: 'transformer' });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(store.papers.a.tags, ['ppo'], '论文 a 剔除 transformer');
  assert.deepStrictEqual(store.papers.c.tags, ['fine-tuning'], '论文 c 剔除 transformer');
  assert.ok(!store.tags.includes('transformer'), '清单不再含 transformer');
  // 删除后清单应与论文实际标签一致（聚合重建，无残留）
  const r3 = await call(port, 'GET', '/api/tags');
  const names = r3.json.data.map((t) => t.name);
  assert.ok(!names.includes('transformer'), 'GET 清单也无 transformer');
  server.close();
});

test('GET /api/settings 返回采集段（scan/arxiv/discover）+ overrides + system 只读', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {
      scanIntervalMinutes: 15,
      arxiv: { enabled: false },
      discover: { maxResults: 12, semanticScholarApiKey: 's2-secret-key-123', weights: { rec: 0.4 } },
    },
    papers: { a: {}, b: {} },
  };
  const ctx = baseCtx(store, async () => {}, {
    config: {
      host: '127.0.0.1',
      port: 8888,
      papersDir: 'papers',
      ai: { baseURL: 'http://cfg/v1', model: 'm', apiKey: 'sk-cfgsecret999' },
      scanIntervalMinutes: 5,
      arxiv: { enabled: true, titleSimilarityThreshold: 0.75, minIntervalMs: 3000 },
      discover: {
        maxResults: 40,
        perAxis: 25,
        semanticScholar: true,
        openAlex: true,
        recencyWindowYears: 8,
        titleSimThreshold: 0.85,
        weights: { rel: 0.45, auth: 0.35, rec: 0.2 },
      },
    },
  });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/settings');
  const d = r.json.data;
  // 生效值 = store.settings 覆盖 config
  assert.strictEqual(d.scan.scanIntervalMinutes, 15);
  assert.strictEqual(d.configScan.scanIntervalMinutes, 5);
  assert.strictEqual(d.arxiv.enabled, false); // 覆盖
  assert.strictEqual(d.configArxiv.enabled, true); // config 原值
  assert.strictEqual(d.discover.maxResults, 12); // 覆盖
  assert.strictEqual(d.discover.perAxis, 25); // 未覆盖透传
  assert.strictEqual(d.discover.weights.rec, 0.4); // weights 深合并
  assert.strictEqual(d.discover.weights.rel, 0.45);
  assert.strictEqual(d.configDiscover.maxResults, 40);
  // S2 key 掩码，不泄露明文
  assert.strictEqual(d.discover.hasS2Key, true);
  assert.ok(!JSON.stringify(d).includes('s2-secret-key-123'), 'S2 key 明文不应出现在响应');
  // overrides 标记（驱动前端「已覆盖」徽标）
  assert.ok(d.overrides.discover.includes('maxResults'));
  assert.ok(d.overrides.arxiv.includes('enabled'));
  assert.strictEqual(d.overrides.scan, true);
  // system 只读
  assert.strictEqual(d.system.host, '127.0.0.1');
  assert.strictEqual(d.system.port, 8888);
  assert.strictEqual(d.system.papers, 2);
  assert.ok(d.system.version, '应含版本号');
  assert.ok(!JSON.stringify(d.system.rawConfig).includes('sk-cfgsecret999'), 'config apiKey 不应明文出现在 rawConfig');
  server.close();
});

test('PUT /api/settings/scan 持久化 + 调用 scanner.reschedule（热生效，允许 0 关闭）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let rescheduled = null;
  const ctx = baseCtx(store, async () => {}, { config: { ai: {}, scanIntervalMinutes: 5 } });
  ctx.scanner.reschedule = async (spaceId, m) => {
    rescheduled = m;
  };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/scan', { scanIntervalMinutes: 30 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.scanIntervalMinutes, 30);
  assert.strictEqual(r.json.data.scan.scanIntervalMinutes, 30);
  assert.strictEqual(rescheduled, 30, '应热重置定时器');
  const r2 = await call(port, 'PUT', '/api/settings/scan', { scanIntervalMinutes: 0 });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.scanIntervalMinutes, 0, '0=关闭定时扫描应合法');
  assert.strictEqual(rescheduled, 0);
  server.close();
});

test('PUT /api/settings/arxiv 持久化（布尔 enabled / 阈值 / 间隔，未传字段保留）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/arxiv', {
    enabled: false,
    titleSimilarityThreshold: 0.9,
    minIntervalMs: 5000,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.arxiv.enabled, false);
  assert.strictEqual(store.settings.arxiv.titleSimilarityThreshold, 0.9);
  assert.strictEqual(store.settings.arxiv.minIntervalMs, 5000);
  assert.strictEqual(r.json.data.arxiv.enabled, false);
  await call(port, 'PUT', '/api/settings/arxiv', { enabled: true });
  assert.strictEqual(store.settings.arxiv.enabled, true);
  assert.strictEqual(store.settings.arxiv.titleSimilarityThreshold, 0.9, '未传字段保留');
  server.close();
});

test('PUT /api/settings/discover 持久化（白名单 + weights + S2 key 掩码保护）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const ctx = baseCtx(store, async () => {}, {
    config: { ai: {}, discover: { weights: { rel: 0.45, auth: 0.35, rec: 0.2 } } },
  });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/discover', {
    maxResults: 20,
    semanticScholar: false,
    weights: { rel: 0.6, auth: 0.3, rec: 0.1 },
    semanticScholarApiKey: 'new-s2-key',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.discover.maxResults, 20);
  assert.strictEqual(store.settings.discover.semanticScholar, false);
  assert.strictEqual(store.settings.discover.weights.rel, 0.6);
  assert.strictEqual(store.settings.discover.semanticScholarApiKey, 'new-s2-key');
  assert.strictEqual(r.json.data.discover.hasS2Key, true);
  assert.ok(!JSON.stringify(r.json.data).includes('new-s2-key'), '回显 S2 key 应掩码');
  // 掩码回传（前端回显占位）不应覆盖
  await call(port, 'PUT', '/api/settings/discover', { semanticScholarApiKey: '********' });
  assert.strictEqual(store.settings.discover.semanticScholarApiKey, 'new-s2-key', '掩码回传不应覆盖原 key');
  // 空串=清空
  await call(port, 'PUT', '/api/settings/discover', { semanticScholarApiKey: '' });
  assert.strictEqual(store.settings.discover.semanticScholarApiKey, '');
  server.close();
});

test('POST /api/settings/reset 按段清除覆盖 + all 全清 + scan 重置定时器', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {
      scanIntervalMinutes: 9,
      arxiv: { enabled: false },
      discover: { maxResults: 5 },
      summaryPrompt: 'x',
      ai: { model: 'm' },
    },
    papers: {},
  };
  let rescheduled = null;
  const ctx = baseCtx(store, async () => {}, { config: { ai: {}, scanIntervalMinutes: 5 } });
  ctx.scanner.reschedule = async (spaceId, m) => {
    rescheduled = m;
  };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  // 单段
  const r1 = await call(port, 'POST', '/api/settings/reset', { section: 'arxiv' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(store.settings.arxiv, undefined, 'arxiv 覆盖应被清除');
  assert.strictEqual(store.settings.discover.maxResults, 5, '其它段不受影响');
  // scan 段：清除并回到 config 默认间隔
  const r2 = await call(port, 'POST', '/api/settings/reset', { section: 'scan' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.scanIntervalMinutes, undefined);
  assert.strictEqual(rescheduled, 5, 'scan 重置应按 config 默认重排定时器');
  // all 全清
  const r3 = await call(port, 'POST', '/api/settings/reset', { all: true });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(store.settings.discover, undefined);
  assert.strictEqual(store.settings.ai, undefined);
  assert.strictEqual(store.settings.summaryPrompt, undefined);
  server.close();
});

test('PATCH /api/papers/:id 星级 rating：clamp 0-5 且与 starred 互为镜像', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: { a: { id: 'a', title: 'T', status: 'ready', rating: 0, starred: false, updatedAt: 0 } },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/papers/a', { rating: 4 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.papers.a.rating, 4);
  assert.strictEqual(store.papers.a.starred, true, 'rating>0 → starred true');
  assert.strictEqual(r.json.data.rating, 4, 'detailView 应回传 rating');
  await call(port, 'PATCH', '/api/papers/a', { rating: 9 });
  assert.strictEqual(store.papers.a.rating, 5, '超界 clamp 到 5');
  await call(port, 'PATCH', '/api/papers/a', { rating: 0 });
  assert.strictEqual(store.papers.a.rating, 0);
  assert.strictEqual(store.papers.a.starred, false, '0 星 → starred false');
  await call(port, 'PATCH', '/api/papers/a', { starred: true });
  assert.strictEqual(store.papers.a.rating, 5, '旧 starred:true → 5 星');
  assert.strictEqual(store.papers.a.starred, true);
  server.close();
});

test('GET /api/papers 列表含 rating，支持 ratingDesc 排序', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', status: 'ready', rating: 2, addedAt: 1 },
      b: { id: 'b', title: 'B', status: 'ready', rating: 5, addedAt: 2 },
      c: { id: 'c', title: 'C', status: 'ready', rating: 0, addedAt: 3 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers?sort=ratingDesc');
  assert.strictEqual(r.json.data[0].id, 'b');
  assert.strictEqual(r.json.data[0].rating, 5);
  assert.strictEqual(r.json.data[1].id, 'a');
  assert.strictEqual(r.json.data[2].id, 'c');
  server.close();
});

test('POST /api/papers/:id/summarize 文件缺失时返回 409 + 标 missing，不入队', async () => {
  // 真实临时目录：p.filepath 指向一个不存在的文件（模拟 PDF 被移走/删除的孤立条目）。
  const dir = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pw-missing-'));
  const ghost = pathm.join(dir, 'ghost.pdf'); // 故意不创建
  let enqueued = null;
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: { a: { id: 'a', title: 'T', filename: 'ghost.pdf', filepath: ghost, status: 'ready', updatedAt: 0 } },
  };
  const router = createApiRouter(baseCtx(store, async () => {}));
  // 替换 ctx 的 enqueue 为可观测的（baseCtx 里是 no-op）
  const ctx = baseCtx(store, async () => {});
  ctx.scanner.enqueue = (spaceId, ids) => {
    enqueued = ids;
  };
  const router2 = createApiRouter(ctx);
  const server = await startServer(router2.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/a/summarize');
  assert.strictEqual(r.status, 409, '缺失文件应返回 409');
  assert.strictEqual(r.json.ok, false);
  assert.ok(/缺失|不存在|missing/i.test(r.json.error), '错误信息应说明文件缺失');
  assert.strictEqual(store.papers.a.status, 'missing', '应把状态标为 missing 而非 error');
  assert.deepStrictEqual(enqueued, null, '不应 enqueue');
  // parse 入口同样防护
  const r2 = await call(port, 'POST', '/api/papers/a/parse');
  assert.strictEqual(r2.status, 409);
  assert.deepStrictEqual(enqueued, null, 'parse 也不应 enqueue');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST /api/papers/:id/summarize 文件存在时正常入队（不误伤）', async () => {
  const dir = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pw-ok-'));
  const real = pathm.join(dir, 'real.pdf');
  fs.writeFileSync(real, '%PDF-1.4 fake');
  let enqueued = null;
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: { a: { id: 'a', title: 'T', filename: 'real.pdf', filepath: real, status: 'ready', updatedAt: 0 } },
  };
  const ctx = baseCtx(store, async () => {});
  ctx.scanner.enqueue = (spaceId, ids) => {
    enqueued = ids;
  };
  const server = await startServer(createApiRouter(ctx).handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/papers/a/summarize');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.queued, 'a');
  assert.deepStrictEqual(enqueued, ['a'], '应正常 enqueue');
  // 立即标 pending：让串行队列里排队的论文显示为「排队」忙碌态（而非停留在 ready）
  assert.strictEqual(store.papers.a.status, 'pending', 'summarize 入队应立即标 pending');
  assert.strictEqual(store.papers.a.error, null, '清空旧错误');
  // parse 同样标 pending
  store.papers.a.status = 'ready';
  const r2 = await call(port, 'POST', '/api/papers/a/parse');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.papers.a.status, 'pending', 'parse 入队也标 pending');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 空间管理（用真实 manager，非 mock）----

/** 用真实 createSpaceManager 构建 ctx（验证完整的多空间路由链路；pg-mem 持久化） */
function realCtx(globalConfig) {
  const root = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwrealsp-'));
  const { newDb } = require('pg-mem');
  const { createDb, createRepository } = require('../src/db');
  const { createSpaceManager } = require('../src/services/spaces');
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = createDb({ createPool: () => new Pool() });
  const repo = createRepository(db);
  const manager = createSpaceManager({
    repo,
    papersRoot: root,
    globalConfig: globalConfig || { ai: {}, scanIntervalMinutes: 5 },
  });
  manager._dbMigrate = () => db.migrate();
  const scanner = {
    scan: async () => ({ added: 0 }),
    scanSpace: async () => ({ added: 0 }),
    enqueue: () => {},
    extractConcepts: async () => ({ processed: 0, added: 0 }),
    retagPapers: async () => ({ processed: 0 }),
    chatPaper: async () => ({ reply: '', chat: [] }),
    reschedule: async () => {},
    invalidate: () => {},
  };
  return { manager, scanner, globalConfig: globalConfig || { ai: {}, scanIntervalMinutes: 5 }, _root: root };
}

test('GET /api/spaces 列出空间 + activeId（真实 manager）', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const r = await call(port, 'GET', '/api/spaces');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.activeSpaceId, 'default');
    assert.ok(r.json.data.spaces.find((s) => s.id === 'default' && s.name === '默认'));
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('POST /api/spaces 创建空间', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const r = await call(port, 'POST', '/api/spaces', { name: 'AI 论文', papersDir: 'papers-ai' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.name, 'AI 论文');
    assert.ok(r.json.data.id);
    // 列表里有了
    const r2 = await call(port, 'GET', '/api/spaces');
    assert.ok(r2.json.data.spaces.find((s) => s.name === 'AI 论文'));
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('POST /api/spaces 名字为纯空白 → 400', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // 纯空白（trim 后为空）应拒绝；空串/null 会回退为「未命名」不报错
    const r = await call(port, 'POST', '/api/spaces', { name: '   ' });
    assert.strictEqual(r.status, 400);
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('PATCH /api/spaces/:id 改名 + 改绑定文件夹', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const created = await call(port, 'POST', '/api/spaces', { name: '旧名', papersDir: 'old' });
    const id = created.json.data.id;
    const r = await call(port, 'PATCH', `/api/spaces/${id}`, { name: '新名', papersDir: 'papers-new/sub' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.name, '新名');
    assert.strictEqual(r.json.data.papersDir, 'papers-new/sub');
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('DELETE /api/spaces/:id 删空间（default 拒删）', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // default 不可删
    const r1 = await call(port, 'DELETE', '/api/spaces/default');
    assert.strictEqual(r1.status, 400);
    // 建一个再删
    const created = await call(port, 'POST', '/api/spaces', { name: '临时' });
    const id = created.json.data.id;
    const r2 = await call(port, 'DELETE', `/api/spaces/${id}`);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.json.data.deleted, id);
    // 列表里没了
    const r3 = await call(port, 'GET', '/api/spaces');
    assert.ok(!r3.json.data.spaces.find((s) => s.id === id));
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('POST /api/spaces/:id/activate 切换 active', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const created = await call(port, 'POST', '/api/spaces', { name: 'B' });
    const id = created.json.data.id;
    const r = await call(port, 'POST', `/api/spaces/${id}/activate`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(ctx.manager.getActiveSpaceId(), id);
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('?space= 路由隔离：不同空间的论文互不可见', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const sp = await ctx.manager.createSpace({ name: 'B' });
    const storeA = await ctx.manager.getSpaceStore('default');
    const storeB = await ctx.manager.getSpaceStore(sp.id);
    storeA.papers.pa = { id: 'pa', title: 'A空间论文', tags: [], topics: [], status: 'ready' };
    storeB.papers.pb = { id: 'pb', title: 'B空间论文', tags: [], topics: [], status: 'ready' };
    await ctx.manager.saveSpaceStore('default', storeA);
    await ctx.manager.saveSpaceStore(sp.id, storeB);
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // 默认（active=default）只看到 pa
    const rA = await call(port, 'GET', '/api/papers');
    assert.ok(rA.json.data.find((p) => p.id === 'pa'));
    assert.ok(!rA.json.data.find((p) => p.id === 'pb'));
    // ?space=B 只看到 pb
    const rB = await call(port, 'GET', `/api/papers?space=${sp.id}`);
    assert.ok(rB.json.data.find((p) => p.id === 'pb'));
    assert.ok(!rB.json.data.find((p) => p.id === 'pa'));
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('?space= 隔离：标签/概念/收藏夹按空间独立', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const sp = await ctx.manager.createSpace({ name: 'B' });
    const storeA = await ctx.manager.getSpaceStore('default');
    const storeB = await ctx.manager.getSpaceStore(sp.id);
    storeA.tags = ['rlhf'];
    storeA.topics = ['推理'];
    storeA.concepts = [{ id: 'c1', term: '强化学习', paperIds: ['pa'] }];
    storeB.tags = ['cv'];
    storeB.topics = ['视觉'];
    storeB.concepts = [{ id: 'c2', term: '卷积', paperIds: ['pb'] }];
    await ctx.manager.saveSpaceStore('default', storeA);
    await ctx.manager.saveSpaceStore(sp.id, storeB);
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const tagsA = await call(port, 'GET', '/api/tags');
    const tagsB = await call(port, 'GET', `/api/tags?space=${sp.id}`);
    assert.ok(tagsA.json.data.find((t) => t.name === 'rlhf'));
    assert.ok(!tagsA.json.data.find((t) => t.name === 'cv'));
    assert.ok(tagsB.json.data.find((t) => t.name === 'cv'));
    assert.ok(!tagsB.json.data.find((t) => t.name === 'rlhf'));
    const conceptsA = await call(port, 'GET', '/api/concepts');
    const conceptsB = await call(port, 'GET', `/api/concepts?space=${sp.id}`);
    assert.ok(conceptsA.json.data.find((c) => c.term === '强化学习'));
    assert.ok(conceptsB.json.data.find((c) => c.term === '卷积'));
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('GET /api/settings system 段含当前空间 papersDir', async () => {
  const ctx = realCtx({ ai: {}, scanIntervalMinutes: 5, papersDir: 'papers' });
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    await ctx.manager.changePapersDir('default', 'papers-custom');
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const r = await call(port, 'GET', '/api/settings');
    assert.strictEqual(r.json.data.system.papersDir, 'papers-custom', '应展示当前空间绑定的文件夹');
    assert.strictEqual(r.json.data.system.spaceId, 'default');
    assert.strictEqual(r.json.data.system.configPapersDir, 'papers', 'config 原始值');
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

// ---- papersDir 改绑路由（v3 绑定语义重设计）----

test('POST /api/spaces/:id/dir/preview + /dir(rebind) 完整链路', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const { sha1OfFile } = require('../src/core/util');
    // 库内一篇 a.pdf；新目录放同内容改名副本
    const oldDir = ctx.manager.resolveSpacePapersDir('default');
    fs.writeFileSync(pathm.join(oldDir, 'a.pdf'), '%PDF-1.4 API-A');
    const id1 = (await sha1OfFile(pathm.join(oldDir, 'a.pdf'))).slice(0, 16);
    const store = await ctx.manager.getSpaceStore('default');
    store.papers[id1] = { id: id1, filename: 'a.pdf', title: 'A', status: 'ready' };
    await ctx.manager.saveSpaceStore('default', store);
    const newDirAbs = pathm.join(ctx.manager._papersRoot, 'newdir');
    fs.mkdirSync(newDirAbs, { recursive: true });
    fs.writeFileSync(pathm.join(newDirAbs, 'a2.pdf'), '%PDF-1.4 API-A');

    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // 预检
    const pr = await call(port, 'POST', '/api/spaces/default/dir/preview', { newDir: 'newdir' });
    assert.strictEqual(pr.status, 200);
    assert.strictEqual(pr.json.data.matched, 1);
    assert.strictEqual(pr.json.data.willMissing, 0);
    // 执行 rebind
    const ap = await call(port, 'POST', '/api/spaces/default/dir', { newDir: 'newdir', mode: 'rebind' });
    assert.strictEqual(ap.status, 200);
    assert.strictEqual(ap.json.data.papersDir, 'newdir');
    assert.strictEqual(ap.json.data.missing, 0);
    const reload = await ctx.manager.getSpaceStore('default');
    assert.strictEqual(reload.papers[id1].filename, 'a2.pdf');
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('POST /api/spaces/:id/dir 校验失败回 400（越界/非法 mode）', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const r1 = await call(port, 'POST', '/api/spaces/default/dir', { newDir: '../evil', mode: 'move' });
    assert.strictEqual(r1.status, 400);
    const r2 = await call(port, 'POST', '/api/spaces/default/dir', { newDir: 'okdir', mode: 'wat' });
    assert.strictEqual(r2.status, 400);
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('GET /api/health 暴露 missingFuse（mock scanner 无 getFuseState 时回空对象）', async () => {
  const store = { papers: {}, tags: [], topics: [], folders: [], concepts: [], settings: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/health');
  assert.deepStrictEqual(r.json.data.missingFuse, {});
  server.close();
});

// ---- 全文检索路由（GET /api/search）----

test('GET /api/search：命中 snippet 高亮 + 元数据 enrich + 空查询 400', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const store = await ctx.manager.getSpaceStore('default');
    store.papers.pA = {
      id: 'pA',
      filename: 'a.pdf',
      title: 'Attention Paper',
      authors: ['Alice'],
      year: 2024,
      status: 'ready',
      tags: ['llm'],
      topics: [],
    };
    store.papers.pB = {
      id: 'pB',
      filename: 'b.pdf',
      title: 'CNN Paper',
      authors: ['Bob'],
      year: 2020,
      status: 'ready',
      tags: [],
      topics: [],
    };
    await ctx.manager.saveSpaceStore('default', store);
    const ts = ctx.manager.textStoreBinder('default');
    await ts.save('pA', 'We study the attention mechanism in transformers. Attention scales quadratically.');
    await ts.save('pB', 'Convolutions are local operators.');

    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    const r = await call(port, 'GET', '/api/search?q=attention');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.total, 1);
    const hit = r.json.data.results[0];
    assert.strictEqual(hit.id, 'pA');
    assert.strictEqual(hit.title, 'Attention Paper');
    assert.strictEqual(hit.matches, 2);
    assert.ok(hit.snippets[0].includes('<mark>attention</mark>') || hit.snippets[0].includes('<mark>Attention</mark>'));
    const r400 = await call(port, 'GET', '/api/search?q=');
    assert.strictEqual(r400.status, 400);
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

// ==================== AI 笔记卡片（noteCards） ====================

function noteStore() {
  return {
    papers: { p1: { id: 'p1', filename: 'a.pdf', title: 'T', status: 'ready', tags: [], topics: [], folders: [], notes: '' } },
    tags: [], topics: [], folders: [], concepts: [], settings: {},
  };
}

test('PATCH noteCards：写入边界归一化（type 白名单/空卡滤除/补 id 与时间戳）+ hasNotes 联动', async () => {
  const store = noteStore();
  let saved = false;
  const router = createApiRouter(baseCtx(store, async () => { saved = true; }));
  const server = await startServer(router.handle);
  try {
    const r = await call(server.address().port, 'PATCH', '/api/papers/p1', {
      noteCards: [
        { type: 'qa', title: 'Q: x', body: 'y', meta: { question: 'x' } },
        { type: 'bogus', title: 't', body: 'b' },   // 非法 type → manual
        { title: '', body: '' },                    // 空卡 → 滤除
      ],
    });
    assert.strictEqual(r.status, 200);
    const cards = r.json.data.noteCards;
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].type, 'qa');
    assert.deepStrictEqual(cards[0].meta, { question: 'x' });
    assert.strictEqual(cards[1].type, 'manual');
    assert.ok(cards[0].id && cards[0].createdAt > 0 && cards[0].updatedAt > 0);
    assert.strictEqual(store.papers.p1.noteCards.length, 2, 'store 已落');
    assert.ok(saved, '触发了 save');
    assert.strictEqual(r.json.data.hasNotes, true, 'summaryView.hasNotes 反映 noteCards');
  } finally { await server.close(); }
});

test('PATCH noteCards 非数组输入归一为空数组（防写坏 jsonb）', async () => {
  const store = noteStore();
  store.papers.p1.noteCards = [{ id: 'nc-1', type: 'manual', title: 't', body: 'b', createdAt: 1, updatedAt: 1 }];
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  try {
    const r = await call(server.address().port, 'PATCH', '/api/papers/p1', { noteCards: 'garbage' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.data.noteCards, []);
  } finally { await server.close(); }
});

test('GET 详情：noteCards 读取时归一化自愈（存量脏数据补字段）', async () => {
  const store = noteStore();
  store.papers.p1.noteCards = [{ title: '只有标题', body: '正文' }]; // 缺 id/type/时间戳
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  try {
    const r = await call(server.address().port, 'GET', '/api/papers/p1');
    assert.strictEqual(r.status, 200);
    const c = r.json.data.noteCards[0];
    assert.strictEqual(c.type, 'manual');
    assert.ok(c.id && c.createdAt > 0);
  } finally { await server.close(); }
});

test('POST /api/papers/:id/notes/generate：200 返回骨架卡', async () => {
  const store = noteStore();
  const ctx = baseCtx(store);
  ctx.scanner.generateNoteCards = async (spaceId, id) => {
    assert.strictEqual(id, 'p1');
    return { cards: [{ id: 'nc-g', type: 'skeleton', title: '🎯 研究问题', body: 'x', createdAt: 1, updatedAt: 1 }] };
  };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  try {
    const r = await call(server.address().port, 'POST', '/api/papers/p1/notes/generate');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.cards.length, 1);
    assert.strictEqual(r.json.data.cards[0].type, 'skeleton');
  } finally { await server.close(); }
});

test('POST /api/papers/:id/notes/generate：404 无论文 / 501 无 scanner 方法', async () => {
  const store = noteStore();
  const ctx = baseCtx(store);
  delete ctx.scanner.generateNoteCards; // 模拟旧 scanner
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  try {
    const r404 = await call(server.address().port, 'POST', '/api/papers/nope/notes/generate');
    assert.strictEqual(r404.status, 404);
    const r501 = await call(server.address().port, 'POST', '/api/papers/p1/notes/generate');
    assert.strictEqual(r501.status, 501);
  } finally { await server.close(); }
});

test('POST /api/papers/:id/notes/generate：422 内容不足 / 502 AI 抛错', async () => {
  const store = noteStore();
  const ctx = baseCtx(store);
  ctx.scanner.generateNoteCards = async () => ({ cards: [], error: '全文未解析且无摘要，无法生成' });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  try {
    const r422 = await call(server.address().port, 'POST', '/api/papers/p1/notes/generate');
    assert.strictEqual(r422.status, 422);
    ctx.scanner.generateNoteCards = async () => { throw new Error('gateway down'); };
    const r502 = await call(server.address().port, 'POST', '/api/papers/p1/notes/generate');
    assert.strictEqual(r502.status, 502);
    assert.ok(r502.json.error.includes('gateway down'));
  } finally { await server.close(); }
});

// ==================== v3.2 搜索补全 / 设置 / 概念 / 排序等未覆盖路由 ====================

test('GET /api/search/suggest 各字段返回候选（按使用频次倒序）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: {
      a: {
        id: 'a',
        title: 'Alpha',
        tags: ['ml', 'rl'],
        topics: ['推理'],
        authors: ['Alice', 'Bob'],
        status: 'ready',
        readStatus: 'reading',
      },
      b: {
        id: 'b',
        title: 'Beta',
        tags: ['ml'],
        topics: ['视觉'],
        authors: ['Alice'],
        status: 'pending',
        readStatus: 'unread',
      },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // tag：ml 出现 2 次排第一
  const tag = await call(port, 'GET', '/api/search/suggest?field=tag');
  assert.strictEqual(tag.status, 200);
  assert.deepStrictEqual(tag.json.data.results, [
    { value: 'ml', count: 2 },
    { value: 'rl', count: 1 },
  ]);
  assert.strictEqual(tag.json.data.field, 'tag');
  // author
  const author = await call(port, 'GET', '/api/search/suggest?field=author');
  assert.deepStrictEqual(author.json.data.results, [
    { value: 'Alice', count: 2 },
    { value: 'Bob', count: 1 },
  ]);
  // topic / title / status / read：均计数 1，用对象断言内容（并列次序不断言）
  const topic = await call(port, 'GET', '/api/search/suggest?field=topic');
  assert.deepStrictEqual(
    Object.fromEntries(topic.json.data.results.map((r) => [r.value, r.count])),
    { 推理: 1, 视觉: 1 },
  );
  const title = await call(port, 'GET', '/api/search/suggest?field=title');
  assert.deepStrictEqual(
    Object.fromEntries(title.json.data.results.map((r) => [r.value, r.count])),
    { Alpha: 1, Beta: 1 },
  );
  const status = await call(port, 'GET', '/api/search/suggest?field=status');
  assert.deepStrictEqual(
    Object.fromEntries(status.json.data.results.map((r) => [r.value, r.count])),
    { ready: 1, pending: 1 },
  );
  const read = await call(port, 'GET', '/api/search/suggest?field=read');
  assert.deepStrictEqual(
    Object.fromEntries(read.json.data.results.map((r) => [r.value, r.count])),
    { reading: 1, unread: 1 },
  );
  server.close();
});

test('GET /api/search/suggest 非法 field → 400', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/search/suggest?field=bogus');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.ok, false);
  assert.ok(r.json.error.includes('field'));
  // 缺 field 参数同样 400
  const r2 = await call(port, 'GET', '/api/search/suggest');
  assert.strictEqual(r2.status, 400);
  server.close();
});

test('GET /api/search/suggest prefix 子串过滤 + limit clamp 上限 20', async () => {
  const tags = [];
  for (let i = 0; i < 25; i++) tags.push('t' + String(i).padStart(2, '0'));
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { a: { id: 'a', title: 'T', tags, status: 'ready' } },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // limit=999 → clamp 到 20
  const r = await call(port, 'GET', '/api/search/suggest?field=tag&limit=999');
  assert.strictEqual(r.json.data.results.length, 20, 'limit 应 clamp 到 20');
  // limit=3 → 3 条
  const r3 = await call(port, 'GET', '/api/search/suggest?field=tag&limit=3');
  assert.strictEqual(r3.json.data.results.length, 3);
  // prefix 子串过滤：'t1' 命中 t10-t19 共 10 个
  const rp = await call(port, 'GET', '/api/search/suggest?field=tag&prefix=t1&limit=20');
  assert.strictEqual(rp.json.data.results.length, 10);
  assert.strictEqual(rp.json.data.prefix, 't1');
  assert.ok(rp.json.data.results.every((x) => x.value.includes('t1')));
  server.close();
});

test('PUT /api/settings/tags-prompt 持久化 trim + 空串恢复默认 + GET 回显', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let saved = null;
  const router = createApiRouter(
    baseCtx(store, async (s) => {
      saved = s;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/tags-prompt', { value: '  我的标签提示  ' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.tagsPrompt, '我的标签提示');
  assert.strictEqual(r.json.data.tagsPrompt, '我的标签提示');
  assert.ok(saved, 'save should be called');
  const g = await call(port, 'GET', '/api/settings');
  assert.strictEqual(g.json.data.tagsPrompt, '我的标签提示', 'GET /api/settings 应回显');
  // 空串 = 恢复默认
  const r2 = await call(port, 'PUT', '/api/settings/tags-prompt', { value: '   ' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.tagsPrompt, '');
  server.close();
});

test('PUT /api/settings/saved-searches 规整：去空 dsl / 截断 name40 dsl500 / createdAt 兜底', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let saved = false;
  const router = createApiRouter(
    baseCtx(store, async () => {
      saved = true;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PUT', '/api/settings/saved-searches', {
    value: [
      { name: '高频', dsl: 'tag:rl', createdAt: 123 },
      { name: '空', dsl: '   ' }, // 空 dsl 应被过滤
      { name: 'x'.repeat(50), dsl: 'y'.repeat(600) }, // name 截 40 / dsl 截 500
    ],
  });
  assert.strictEqual(r.status, 200);
  const list = store.settings.savedSearches;
  assert.strictEqual(list.length, 2, '空 dsl 项应被滤除');
  assert.deepStrictEqual(list[0], { name: '高频', dsl: 'tag:rl', createdAt: 123 });
  assert.strictEqual(list[1].name.length, 40, 'name 截断到 40');
  assert.strictEqual(list[1].dsl.length, 500, 'dsl 截断到 500');
  assert.strictEqual(typeof list[1].createdAt, 'number');
  assert.ok(saved, 'save should be called');
  assert.deepStrictEqual(r.json.data.savedSearches, list);
  server.close();
});

test('PUT /api/settings/saved-searches 限 30 条 + 非数组清空 + GET /api/settings 回显', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const many = [];
  for (let i = 0; i < 35; i++) many.push({ name: 's' + i, dsl: 'tag:t' + i });
  const r = await call(port, 'PUT', '/api/settings/saved-searches', { value: many });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.savedSearches.length, 30, '应截断到 30 条');
  const g = await call(port, 'GET', '/api/settings');
  assert.strictEqual(g.json.data.savedSearches.length, 30, 'GET /api/settings 应回显 savedSearches');
  // 非数组输入 → 清空
  const r2 = await call(port, 'PUT', '/api/settings/saved-searches', { value: 'garbage' });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(store.settings.savedSearches, []);
  server.close();
});

test('PUT /api/settings/translate 引擎白名单（bing/google/ai/none）+ targetLang', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let saved = false;
  const router = createApiRouter(
    baseCtx(store, async () => {
      saved = true;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  for (const engine of ['bing', 'google', 'ai', 'none']) {
    const r = await call(port, 'PUT', '/api/settings/translate', { engine });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store.settings.translate.engine, engine, `engine=${engine} 应被接受`);
    assert.strictEqual(r.json.data.translate.engine, engine);
  }
  const r2 = await call(port, 'PUT', '/api/settings/translate', { targetLang: 'en' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.settings.translate.targetLang, 'en');
  assert.strictEqual(r2.json.data.translate.targetLang, 'en');
  assert.ok(saved, 'save should be called');
  server.close();
});

test('PUT /api/settings/translate 非法 engine 忽略（保留原值）+ GET overrides 标记', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store, async () => {}));
  const server = await startServer(router.handle);
  const port = server.address().port;
  await call(port, 'PUT', '/api/settings/translate', { engine: 'bing', targetLang: 'ja' });
  const r = await call(port, 'PUT', '/api/settings/translate', { engine: 'bogus', targetLang: 'fr' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.settings.translate.engine, 'bing', '非法 engine 不应覆盖');
  assert.strictEqual(store.settings.translate.targetLang, 'fr', 'targetLang 正常更新');
  assert.strictEqual(r.json.data.translate.engine, 'bing');
  const g = await call(port, 'GET', '/api/settings');
  assert.strictEqual(g.json.data.translate.engine, 'bing');
  assert.ok(g.json.data.overrides.translate.includes('engine'), 'overrides 应标记 translate.engine 已覆盖');
  assert.ok(g.json.data.overrides.translate.includes('targetLang'));
  server.close();
});

test('GET /api/translate 空文本 → 400（缺参与纯空白）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/translate');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.ok, false);
  assert.ok(r.json.error.includes('empty'));
  const r2 = await call(port, 'GET', '/api/translate?text=%20%20%20');
  assert.strictEqual(r2.status, 400, '纯空白文本同样 400');
  server.close();
});

test('PATCH /api/concepts/:id 更新 term/definition（trim + updatedAt + 落盘）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [{ id: 'c1', term: 'RL', definition: 'd', paperIds: ['a'] }],
    settings: {},
    papers: { a: { id: 'a', title: 'A', conceptIds: ['c1'], status: 'ready' } },
  };
  let saved = false;
  const router = createApiRouter(
    baseCtx(store, async () => {
      saved = true;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/concepts/c1', { term: '  RLHF  ', definition: '新定义' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.term, 'RLHF', 'term 应 trim');
  assert.strictEqual(r.json.data.definition, '新定义');
  assert.ok(r.json.data.updatedAt > 0, '应更新 updatedAt');
  assert.strictEqual(store.concepts[0].term, 'RLHF');
  assert.ok(saved, 'save should be called');
  // 显式空 definition（'definition' in op 分支）
  const r2 = await call(port, 'PATCH', '/api/concepts/c1', { definition: '' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(store.concepts[0].definition, '');
  server.close();
});

test('PATCH /api/concepts/:id 不存在 → 404', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'PATCH', '/api/concepts/nope', { term: 'x' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.ok, false);
  server.close();
});

test('DELETE /api/concepts/:id 删除并清理论文 conceptIds；不存在 → 404', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [
      { id: 'c1', term: 'RL', paperIds: ['a'] },
      { id: 'c2', term: 'CNN', paperIds: ['a'] },
    ],
    settings: {},
    papers: { a: { id: 'a', title: 'A', conceptIds: ['c1', 'c2'], status: 'ready' } },
  };
  let saved = false;
  const router = createApiRouter(
    baseCtx(store, async () => {
      saved = true;
    }),
  );
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', '/api/concepts/c1');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.data, { deleted: 'c1' });
  assert.deepStrictEqual(
    store.concepts.map((c) => c.id),
    ['c2'],
    '概念应被移除',
  );
  assert.deepStrictEqual(store.papers.a.conceptIds, ['c2'], '论文 conceptIds 应同步清理');
  assert.ok(saved, 'save should be called');
  const r404 = await call(port, 'DELETE', '/api/concepts/c1');
  assert.strictEqual(r404.status, 404, '再删一次 → 404');
  server.close();
});

test('GET /api/topics 返回主题字典 + 计数（按 count 倒序）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: ['推理', '视觉', '对齐'],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', topics: ['推理', '视觉'], status: 'ready' },
      b: { id: 'b', title: 'B', topics: ['推理'], status: 'ready' },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/topics');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.data, [
    { name: '推理', count: 2 },
    { name: '视觉', count: 1 },
    { name: '对齐', count: 0 },
  ]);
  server.close();
});

test('GET /api/papers sort=titleAsc / titleDesc 按标题排序', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'Gamma', status: 'ready', addedAt: 1 },
      b: { id: 'b', title: 'Alpha', status: 'ready', addedAt: 2 },
      c: { id: 'c', title: 'Beta', status: 'ready', addedAt: 3 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const asc = await call(port, 'GET', '/api/papers?sort=titleAsc');
  assert.deepStrictEqual(
    asc.json.data.map((p) => p.title),
    ['Alpha', 'Beta', 'Gamma'],
  );
  const desc = await call(port, 'GET', '/api/papers?sort=titleDesc');
  assert.deepStrictEqual(
    desc.json.data.map((p) => p.title),
    ['Gamma', 'Beta', 'Alpha'],
  );
  server.close();
});

test('GET /api/papers sort=yearDesc 无年份论文沉底', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', year: '2020', status: 'ready', addedAt: 1 },
      b: { id: 'b', title: 'B', year: '2024', status: 'ready', addedAt: 2 },
      c: { id: 'c', title: 'C', status: 'ready', addedAt: 3 }, // 无年份
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers?sort=yearDesc');
  assert.deepStrictEqual(
    r.json.data.map((p) => p.id),
    ['b', 'a', 'c'],
    'yearDesc：新→旧，无年份沉底',
  );
  server.close();
});

test('GET /api/papers sort=conceptDesc 按概念数倒序', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', conceptIds: ['c1', 'c2'], status: 'ready', addedAt: 1 },
      b: { id: 'b', title: 'B', conceptIds: ['c1'], status: 'ready', addedAt: 2 },
      c: { id: 'c', title: 'C', conceptIds: [], status: 'ready', addedAt: 3 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers?sort=conceptDesc');
  assert.deepStrictEqual(
    r.json.data.map((p) => p.id),
    ['a', 'b', 'c'],
  );
  server.close();
});

test('GET /api/papers sort=progressDesc 按阅读进度倒序', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', readProgress: { page: 5, total: 10 }, status: 'ready', addedAt: 1, updatedAt: 1 },
      b: { id: 'b', title: 'B', readProgress: { page: 9, total: 10 }, status: 'ready', addedAt: 2, updatedAt: 2 },
      c: { id: 'c', title: 'C', readProgress: null, status: 'ready', addedAt: 3, updatedAt: 3 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers?sort=progressDesc');
  assert.deepStrictEqual(
    r.json.data.map((p) => p.id),
    ['b', 'a', 'c'],
    '进度 0.9 > 0.5 > 无进度',
  );
  server.close();
});

test('GET /api/papers status / readStatus / starred=1 筛选', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    papers: {
      a: { id: 'a', title: 'A', status: 'ready', readStatus: 'reading', starred: true, addedAt: 1 },
      b: { id: 'b', title: 'B', status: 'pending', readStatus: 'unread', starred: false, addedAt: 2 },
      c: { id: 'c', title: 'C', status: 'ready', readStatus: 'reading', starred: true, addedAt: 3 },
    },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const byStatus = await call(port, 'GET', '/api/papers?status=ready');
  assert.deepStrictEqual(
    byStatus.json.data.map((p) => p.id).sort(),
    ['a', 'c'],
  );
  const byRead = await call(port, 'GET', '/api/papers?readStatus=reading');
  assert.deepStrictEqual(
    byRead.json.data.map((p) => p.id).sort(),
    ['a', 'c'],
  );
  const byStar = await call(port, 'GET', '/api/papers?starred=1');
  assert.deepStrictEqual(
    byStar.json.data.map((p) => p.id).sort(),
    ['a', 'c'],
  );
  // 组合：status=pending + starred=1 → 空
  const combo = await call(port, 'GET', '/api/papers?status=pending&starred=1');
  assert.deepStrictEqual(combo.json.data, []);
  server.close();
});

test('GET /api/search ?filters= 正文词与 q 元数据子集取交集', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const store = await ctx.manager.getSpaceStore('default');
    store.papers.pA = {
      id: 'pA',
      filename: 'a.pdf',
      title: 'Attention Paper',
      authors: ['Alice'],
      year: 2024,
      status: 'ready',
      tags: ['llm'],
      topics: [],
    };
    store.papers.pB = {
      id: 'pB',
      filename: 'b.pdf',
      title: 'CNN Paper',
      authors: ['Bob'],
      year: 2020,
      status: 'ready',
      tags: [],
      topics: [],
    };
    await ctx.manager.saveSpaceStore('default', store);
    const ts = ctx.manager.textStoreBinder('default');
    await ts.save('pA', 'Attention mechanisms in transformers.');
    await ts.save('pB', 'Attention in convolutional networks.');

    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // filters=attention 为正文词；q=tag:llm 提供元数据子集 → 仅 pA
    const r = await call(port, 'GET', '/api/search?q=tag%3Allm&filters=attention');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.bodyWord, 'attention');
    assert.strictEqual(r.json.data.total, 1, '正文词 ∩ tag:llm 子集 = 仅 pA');
    assert.strictEqual(r.json.data.results[0].id, 'pA');
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('GET /api/search q 内 body: 前缀走全文路径（无元数据约束时全量）', async () => {
  const ctx = realCtx();
  try {
    await ctx.manager._dbMigrate();
    await ctx.manager.ensureRegistry();
    const store = await ctx.manager.getSpaceStore('default');
    store.papers.pA = {
      id: 'pA',
      filename: 'a.pdf',
      title: 'Attention Paper',
      authors: ['Alice'],
      year: 2024,
      status: 'ready',
      tags: ['llm'],
      topics: [],
    };
    store.papers.pB = {
      id: 'pB',
      filename: 'b.pdf',
      title: 'CNN Paper',
      authors: ['Bob'],
      year: 2020,
      status: 'ready',
      tags: [],
      topics: [],
    };
    await ctx.manager.saveSpaceStore('default', store);
    const ts = ctx.manager.textStoreBinder('default');
    await ts.save('pA', 'Attention mechanisms in transformers.');
    await ts.save('pB', 'Attention in convolutional networks.');

    const server = await startServer(createApiRouter(ctx).handle);
    const port = server.address().port;
    // q 内含 body: 词 + 元数据字段：tag:llm body:attention → 仅 pA
    const r = await call(port, 'GET', '/api/search?q=' + encodeURIComponent('tag:llm body:attention'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.bodyWord, 'attention');
    assert.strictEqual(r.json.data.total, 1);
    assert.strictEqual(r.json.data.results[0].id, 'pA');
    // 纯 body: 查询（无元数据约束）→ 两篇全中
    const r2 = await call(port, 'GET', '/api/search?q=' + encodeURIComponent('body:attention'));
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.json.data.total, 2);
    server.close();
  } finally {
    fs.rmSync(ctx._root, { recursive: true, force: true });
  }
});

test('POST /api/scan 返回 scanner.scanSpace 结果（按当前空间）', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  let scannedSpace = null;
  const ctx = baseCtx(store);
  ctx.scanner.scanSpace = async (spaceId) => {
    scannedSpace = spaceId;
    return { added: 3, scanned: 5 };
  };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/scan');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.added, 3);
  assert.strictEqual(r.json.data.scanned, 5);
  assert.strictEqual(scannedSpace, 'default', '应扫描 active 空间');
  server.close();
});

test('GET /api/ai/models 无 baseURL → config 静态兜底（含 store.settings.ai 覆盖）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: { ai: { model: 'store-model' } },
    papers: {},
  };
  const ctx = baseCtx(store, async () => {}, {
    config: { ai: { model: 'cfg-model', extraModels: ['cfg-extra'] } },
  });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/ai/models');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.source, 'config', '无 baseURL 应走 config 兜底');
  assert.strictEqual(r.json.data.default, 'store-model', 'store.settings.ai.model 覆盖 config');
  const ids = r.json.data.models.map((m) => m.id);
  assert.ok(ids.includes('store-model'));
  assert.ok(ids.includes('cfg-extra'), 'config.extraModels 应并入候选');
  server.close();
});

test('GET /api/ai/models 上游不可达（127.0.0.1:1）→ 回退 config 候选不报错', async () => {
  const store = { version: 2, tags: [], topics: [], folders: [], concepts: [], settings: {}, papers: {} };
  const ctx = baseCtx(store, async () => {}, {
    config: { ai: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm1' } },
  });
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/ai/models');
  assert.strictEqual(r.status, 200, '上游失败不应 500（listModels 自带兜底）');
  assert.strictEqual(r.json.data.source, 'config');
  // v3.11：listModels fallback 也带 contextLength:null（网关不返回该字段时的占位）
  assert.deepStrictEqual(r.json.data.models, [{ id: 'm1', contextLength: null }]);
  server.close();
});

test('GET /api/papers/:id/chat 缺 message → 400；论文不存在 → 404（不进入 SSE）', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { p1: { id: 'p1', title: 'T', status: 'ready', chat: [] } },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers/p1/chat');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.ok, false);
  assert.ok(r.json.error.includes('empty message'));
  const r2 = await call(port, 'GET', '/api/papers/p1/chat?message=%20%20');
  assert.strictEqual(r2.status, 400, '纯空白 message 同样 400');
  const r404 = await call(port, 'GET', '/api/papers/nope/chat?message=hi');
  assert.strictEqual(r404.status, 404);
  server.close();
});

test('?space=no-such 容错回退 active 空间', async () => {
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [],
    settings: {},
    papers: { a: { id: 'a', title: '默认空间论文', status: 'ready', addedAt: 1 } },
  };
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'GET', '/api/papers?space=no-such');
  assert.strictEqual(r.status, 200, '不存在的空间不应报错');
  assert.strictEqual(r.json.data.length, 1);
  assert.strictEqual(r.json.data[0].id, 'a', '应回退到 active 空间的论文');
  server.close();
});


// ============================================================================
// 概念地图后台生成任务（v3.14）：POST/PUT 立即返回占位 → 后台流式生成 → 落库
// ============================================================================

/** 伪造 OpenAI 兼容上游：按 handler 定制响应（SSE 流式）。返回 { server, url }。 */
async function startFakeAi(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}
/** 立即返回完整 HTML 的 SSE 响应体 */
function sseHtml(html) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`);
  };
}
/** 延迟 ms 才响应（模拟慢生成，用于取消/冲突测试） */
function sseSlow(html, ms) {
  return (req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: html } }] })}\n\ndata: [DONE]\n\n`);
      } catch { /* 客户端已 abort */ }
    }, ms);
  };
}
async function waitForCond(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitForCond timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
function conceptMapTestStore() {
  return {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [{ id: 'c1', term: 'Attention', definition: 'd', category: 'model', paperIds: ['p1'], source: 'ai', createdAt: 0, updatedAt: 0 }],
    settings: {},
    papers: {},
  };
}

test('POST /api/concepts/map：后台任务占位 → 完成落库 → 可取 html', async () => {
  const ai = await startFakeAi(sseHtml('<html><body>MAP</body></html>'));
  const store = conceptMapTestStore();
  const config = { ai: { baseURL: ai.url, apiKey: 'k', model: 'm', timeoutMs: 4000 }, scanIntervalMinutes: 5 };
  const router = createApiRouter(baseCtx(store, async () => {}, { config }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  // POST 立即返回占位（不等 AI）
  const r = await call(port, 'POST', '/api/concepts/map', { prompt: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.status, 'generating', 'POST 应立即返回 generating 占位');
  assert.strictEqual(r.json.data.hasHtml, false);
  const id = r.json.data.id;
  // 后台任务完成 → settings 元信息翻 ready
  await waitForCond(async () => {
    const s = await call(port, 'GET', '/api/settings');
    const m = (s.json.data.conceptMaps || []).find((x) => x.id === id);
    return m && m.status === 'ready' ? m : null;
  });
  // 单个制品取回完整 html
  const one = await call(port, 'GET', '/api/concepts/map/' + id);
  assert.strictEqual(one.json.data.html, '<html><body>MAP</body></html>');
  assert.strictEqual(store.settings.conceptMaps[0].status, 'ready', '落库的制品应为 ready');
  server.close();
  ai.server.close();
});

test('POST /api/concepts/map：输出截断（无 </html>）标 error 但保留半成品', async () => {
  const ai = await startFakeAi(sseHtml('<html><body>UNFINISHED'));
  const store = conceptMapTestStore();
  const config = { ai: { baseURL: ai.url, apiKey: 'k', model: 'm', timeoutMs: 4000 }, scanIntervalMinutes: 5 };
  const router = createApiRouter(baseCtx(store, async () => {}, { config }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts/map', {});
  const id = r.json.data.id;
  const m = await waitForCond(async () => {
    const s = await call(port, 'GET', '/api/settings');
    const x = (s.json.data.conceptMaps || []).find((y) => y.id === id);
    return x && x.status !== 'generating' ? x : null;
  });
  assert.strictEqual(m.status, 'error', '截断产出应标 error');
  assert.ok(m.error.includes('截断') || m.error.includes('不完整'), '错误信息应说明截断');
  assert.strictEqual(m.hasHtml, true, '半成品 html 应保留（可查看/再优化）');
  server.close();
  ai.server.close();
});

test('DELETE /api/concepts/map/:id：生成中删除=取消后台任务', async () => {
  const ai = await startFakeAi(sseSlow('<html>slow</html>', 3000));
  const store = conceptMapTestStore();
  const config = { ai: { baseURL: ai.url, apiKey: 'k', model: 'm', timeoutMs: 10000 }, scanIntervalMinutes: 5 };
  const router = createApiRouter(baseCtx(store, async () => {}, { config }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts/map', {});
  const id = r.json.data.id;
  const d = await call(port, 'DELETE', '/api/concepts/map/' + id);
  assert.strictEqual(d.json.ok, true);
  assert.strictEqual(store.settings.conceptMaps.length, 0, '删除后制品应立即从 store 移除');
  // 等被取消的任务收尾（abort → catch → save），确认不会复活制品
  await new Promise((r2) => setTimeout(r2, 300));
  assert.strictEqual(store.settings.conceptMaps.length, 0, '被取消的任务收尾后制品不得复活');
  server.close();
  ai.server.close();
});

test('PUT /api/concepts/map：生成中重复优化返回 409', async () => {
  const ai = await startFakeAi(sseSlow('<html>slow</html>', 2000));
  const store = conceptMapTestStore();
  const config = { ai: { baseURL: ai.url, apiKey: 'k', model: 'm', timeoutMs: 10000 }, scanIntervalMinutes: 5 };
  const router = createApiRouter(baseCtx(store, async () => {}, { config }));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'POST', '/api/concepts/map', {});
  const id = r.json.data.id;
  const put = await call(port, 'PUT', '/api/concepts/map', { id, prompt: '改成矩阵图' });
  assert.strictEqual(put.status, 409, '生成中的制品再次优化应 409');
  // 清理：取消任务
  await call(port, 'DELETE', '/api/concepts/map/' + id);
  server.close();
  ai.server.close();
});

test('僵尸 generating 制品（无任务句柄=服务重启）读路径解析为 error', async () => {
  const store = conceptMapTestStore();
  store.settings.conceptMaps = [
    { id: 'cm_zombie', name: '概念地图', html: '', prompt: '', status: 'generating', error: '', createdAt: 1, updatedAt: 1 },
  ];
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const s = await call(port, 'GET', '/api/settings');
  const m = s.json.data.conceptMaps.find((x) => x.id === 'cm_zombie');
  assert.strictEqual(m.status, 'error', '无任务句柄的 generating 应解析为 error（服务重启中断）');
  assert.ok(m.error.includes('重启'));
  server.close();
});

test('PUT /api/settings/concept-map-prompt：保存/回显/重置', async () => {
  const store = conceptMapTestStore();
  const router = createApiRouter(baseCtx(store));
  const server = await startServer(router.handle);
  const port = server.address().port;
  const put = await call(port, 'PUT', '/api/settings/concept-map-prompt', { value: '  我的自定义地图提示词  ' });
  assert.strictEqual(put.json.ok, true);
  let s = await call(port, 'GET', '/api/settings');
  assert.strictEqual(s.json.data.conceptMapPrompt, '我的自定义地图提示词');
  assert.strictEqual(s.json.data.overrides.conceptMapPrompt, true, 'overrides 应含 conceptMapPrompt');
  assert.ok(s.json.data.defaultConceptMapPrompt.length > 100, '内置默认应回显供参考');
  // 空串恢复默认
  await call(port, 'PUT', '/api/settings/concept-map-prompt', { value: '' });
  s = await call(port, 'GET', '/api/settings');
  assert.strictEqual(s.json.data.conceptMapPrompt, '');
  assert.strictEqual(s.json.data.overrides.conceptMapPrompt, false);
  // reset section 也认 conceptMapPrompt
  await call(port, 'PUT', '/api/settings/concept-map-prompt', { value: 'x' });
  const rst = await call(port, 'POST', '/api/settings/reset', { section: 'conceptMapPrompt' });
  assert.strictEqual(rst.json.ok, true);
  s = await call(port, 'GET', '/api/settings');
  assert.strictEqual(s.json.data.conceptMapPrompt, '');
  server.close();
});
