// e2e 测试前的数据准备：生成最小 config.json、复制 fixture PDF、预置一条 papers.json 记录。
// 幂等——已存在则跳过。供 playwright.config.js 的 webServer.command 调用。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// 1) config.json（若缺）
const configPath = path.join(root, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        host: '127.0.0.1',
        port: 8888,
        papersDir: 'papers',
        scanIntervalMinutes: 0, // e2e 不需要后台扫描
        ai: {
          baseURL: 'http://localhost:0/v1',
          apiKey: 'test-key',
          model: 'test',
          maxInputChars: 1000,
          timeoutMs: 5000,
        },
        arxiv: { enabled: false, titleSimilarityThreshold: 0.75, minIntervalMs: 3000 },
        summaryPrompt: '',
      },
      null,
      2,
    ),
  );
  console.log('[e2e-bootstrap] wrote config.json');
}

// 2) 复制 fixture PDF 到 papers/
const papersDir = path.join(root, 'papers');
fs.mkdirSync(papersDir, { recursive: true });
const fixturePdf = path.join(root, 'tests', 'fixtures', 'sample.pdf');
const destPdf = path.join(papersDir, 'sample.pdf');
if (fs.existsSync(fixturePdf) && !fs.existsSync(destPdf)) {
  fs.copyFileSync(fixturePdf, destPdf);
  console.log('[e2e-bootstrap] copied sample.pdf to papers/');
}

// 3) 预置 papers.json（若缺或不含 sample）
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const storePath = path.join(dataDir, 'papers.json');
let store = { version: 2, papers: {}, tags: [], topics: [], folders: [], concepts: [], settings: {} };
if (fs.existsSync(storePath)) {
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    /* 用空 store */
  }
}
if (!store.papers.sample) {
  store.papers.sample = {
    id: 'sample',
    filename: 'sample.pdf',
    filepath: 'papers/sample.pdf',
    title: 'Sample Paper for E2E Testing',
    authors: ['E2E Test'],
    year: '2026',
    status: 'ready',
    readStatus: 'unread',
    tags: ['transformer'],
    topics: ['测试'],
    folders: [],
    conceptIds: [],
    annotations: null,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  console.log('[e2e-bootstrap] preset sample record in papers.json');
}

// 3b) 多空间架构（v2.5+）：app 实际从 data/spaces/<active>/papers.json 读取，
//     旧的 data/papers.json 只在首次启动迁移时被读一次。已初始化多空间的本地环境里
//     上面 3) 写的 legacy 路径不会被读到 → e2e 找不到 Sample Paper。
//     这里把 sample 记录同步写入 active 空间的 store（幂等：已含 sample 则跳过），
//     并确保 sample.pdf 复制到该空间绑定的 papersDir。
const spacesRegPath = path.join(dataDir, 'spaces.json');
if (fs.existsSync(spacesRegPath)) {
  try {
    const reg = JSON.parse(fs.readFileSync(spacesRegPath, 'utf8'));
    const activeId = reg.activeSpaceId || (reg.spaces && reg.spaces[0] && reg.spaces[0].id);
    const active = reg.spaces && reg.spaces.find((s) => s.id === activeId);
    if (active) {
      // 把 sample.pdf 复制到 active 空间的 papersDir（解析相对 projectRoot）
      const spacePapersDir = path.isAbsolute(active.papersDir)
        ? active.papersDir
        : path.resolve(root, active.papersDir);
      fs.mkdirSync(spacePapersDir, { recursive: true });
      const spaceDest = path.join(spacePapersDir, 'sample.pdf');
      if (fs.existsSync(fixturePdf) && !fs.existsSync(spaceDest)) {
        fs.copyFileSync(fixturePdf, spaceDest);
      }
      // 写 sample 记录到 active 空间的 store
      const spaceStoreDir = path.join(dataDir, 'spaces', active.id);
      fs.mkdirSync(spaceStoreDir, { recursive: true });
      const spaceStorePath = path.join(spaceStoreDir, 'papers.json');
      let spaceStore = { version: 2, papers: {}, tags: [], topics: [], folders: [], concepts: [], settings: {} };
      if (fs.existsSync(spaceStorePath)) {
        try { spaceStore = JSON.parse(fs.readFileSync(spaceStorePath, 'utf8')); } catch { /* 用空 store */ }
      }
      if (!spaceStore.papers || !spaceStore.papers.sample) {
        spaceStore.papers = spaceStore.papers || {};
        spaceStore.papers.sample = {
          id: 'sample',
          filename: 'sample.pdf',
          filepath: path.relative(root, spaceDest).replace(/\\/g, '/'),
          title: 'Sample Paper for E2E Testing',
          authors: ['E2E Test'],
          year: '2026',
          status: 'ready',
          readStatus: 'unread',
          tags: ['transformer'],
          topics: ['测试'],
          folders: [],
          conceptIds: [],
          annotations: null,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        fs.writeFileSync(spaceStorePath, JSON.stringify(spaceStore, null, 2));
        console.log('[e2e-bootstrap] preset sample record in active space (' + active.id + ') store');
      }
    }
  } catch {
    /* 无 spaces.json：旧单库环境，上面 3) 已覆盖 */
  }
}
console.log('[e2e-bootstrap] done');
