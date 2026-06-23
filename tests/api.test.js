const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const pathm = require('node:path');
const { createApiRouter } = require('../lib/api');
const arxivMod = require('../lib/arxiv');

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

function baseCtx(store, save) {
  return {
    store,
    save: save || (async () => {}),
    scanner: {
      scan: async () => ({ added: 0 }),
      enqueue: () => {},
      extractConcepts: async (ids) => ({ processed: ids.length, added: 1 }),
    },
    config: { ai: {} },
  };
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
    const ctx = {
      store,
      save: async () => {},
      scanner: { scan: async () => ({}), enqueue: (ids) => (enq = ids), extractConcepts: async () => ({}) },
      config: { ai: {}, papersDir: tmpPapers, arxiv: {} },
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
    const ctx = {
      store,
      save: async () => {},
      scanner: { scan: async () => ({}), enqueue: () => {}, extractConcepts: async () => ({}) },
      config: { ai: {}, papersDir: tmpPapers, arxiv: {} },
    };
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

test('DELETE /api/papers/:id 删除条目 + PDF + 全文，并清理概念引用', async () => {
  const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'pwdel-'));
  const pdf = pathm.join(tmp, 'p.pdf');
  const txt = pathm.join(tmp, 'p.txt');
  fs.writeFileSync(pdf, 'PDFDATA');
  fs.writeFileSync(txt, 'fulltext');
  const store = {
    version: 2,
    tags: [],
    topics: [],
    folders: [],
    concepts: [{ id: 'c1', term: 'T', paperIds: ['a', 'b'] }],
    papers: {
      a: { id: 'a', filename: 'p.pdf', filepath: pdf, fulltextPath: txt, conceptIds: ['c1'], status: 'ready' },
      b: { id: 'b', filename: 'q.pdf', filepath: pathm.join(tmp, 'q.pdf'), conceptIds: ['c1'], status: 'ready' },
    },
  };
  let saved = false;
  const ctx = {
    store,
    save: async () => {
      saved = true;
    },
    scanner: { scan: async () => ({}), enqueue: () => {}, extractConcepts: async () => ({}) },
    config: { ai: {}, papersDir: tmp },
  };
  const router = createApiRouter(ctx);
  const server = await startServer(router.handle);
  const port = server.address().port;
  const r = await call(port, 'DELETE', '/api/papers/a');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.ok(!store.papers.a, '论文条目应被删除');
  assert.ok(store.papers.b, '其它论文不受影响');
  assert.ok(!fs.existsSync(pdf), 'PDF 文件应被删除');
  assert.ok(!fs.existsSync(txt), '全文文件应被删除');
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
  const ctx = {
    store,
    save: async () => {},
    scanner: { scan: async () => ({}), enqueue: () => {} },
    config: { ai: {}, papersDir: '/tmp' },
  };
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
  const router = createApiRouter({
    ...baseCtx(store),
    config: { ai: { baseURL: 'http://config/v1', model: 'cfg-model' } },
  });
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
  const router = createApiRouter({
    ...baseCtx(store),
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
  const ctx = {
    store,
    save: async () => {},
    scanner: {
      scan: async () => ({}),
      enqueue: () => {},
      extractConcepts: async () => ({}),
      reschedule: (m) => {
        rescheduled = m;
      },
    },
    config: { ai: {}, scanIntervalMinutes: 5 },
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
  const router = createApiRouter({
    ...baseCtx(store),
    config: { ai: {}, discover: { weights: { rel: 0.45, auth: 0.35, rec: 0.2 } } },
  });
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
  const ctx = {
    store,
    save: async () => {},
    scanner: {
      scan: async () => ({}),
      enqueue: () => {},
      extractConcepts: async () => ({}),
      reschedule: (m) => {
        rescheduled = m;
      },
    },
    config: { ai: {}, scanIntervalMinutes: 5 },
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
