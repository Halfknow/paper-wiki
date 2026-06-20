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
console.log('[e2e-bootstrap] done');
