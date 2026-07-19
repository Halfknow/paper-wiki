// e2e 测试前的数据准备（v3：PostgreSQL 版）：
// 生成最小 config.json、复制 fixture PDF 到 PAPERS_ROOT/default、经 repo 向 PG 预置一条 sample 记录。
// 幂等——upsert 语义，可重复执行。供 playwright.config.js 的 webServer.command 调用。
//
// 需要可用的 PostgreSQL：E2E_DATABASE_URL / DATABASE_URL（默认 postgres://paperwiki:dev@127.0.0.1:5433/paperwiki，
// 对应 `docker run -d -p 127.0.0.1:5433:5432 -e POSTGRES_USER=paperwiki -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=paperwiki postgres:16-alpine`）。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DB_URL =
  process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || 'postgres://paperwiki:dev@127.0.0.1:5433/paperwiki';

async function main() {
  // 1) config.json（若缺）
  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          host: '127.0.0.1',
          port: 8888,
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

  // 2) fixture PDF → PAPERS_ROOT/default/sample.pdf（default 空间绑定 'default' 子目录）
  const papersRoot = process.env.PAPERS_ROOT || path.join(root, 'papers');
  const defaultDir = path.join(papersRoot, 'default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const fixturePdf = path.join(root, 'tests', 'fixtures', 'sample.pdf');
  const destPdf = path.join(defaultDir, 'sample.pdf');
  if (fs.existsSync(fixturePdf) && !fs.existsSync(destPdf)) {
    fs.copyFileSync(fixturePdf, destPdf);
    console.log('[e2e-bootstrap] copied sample.pdf to', destPdf);
  }

  // 3) PG 预置：migrate → default 空间 → sample 记录（upsert 幂等）
  const { createDb, createRepository } = require('../src/db');
  const db = createDb({ connectionString: DB_URL });
  await db.migrate();
  const repo = createRepository(db);
  await repo.upsertSpaceMeta({
    id: 'default',
    name: '默认',
    papersDir: 'default',
    scanIntervalMinutes: 0,
    lastScanAt: 0,
    createdAt: Date.now(),
  });
  await repo.setActiveSpaceId('default');
  const store = await repo.loadSpaceStore('default');
  store.papers.sample = {
    ...(store.papers.sample || {}),
    id: 'sample',
    filename: 'sample.pdf',
    title: 'Sample Paper for E2E Testing',
    authors: ['E2E Test'],
    year: '2026',
    status: 'ready',
    readStatus: 'unread',
    tags: ['transformer'],
    topics: ['测试'],
    folders: [],
    conceptIds: [],
    annotations: (store.papers.sample && store.papers.sample.annotations) || null,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await repo.saveSpaceStore('default', store);
  await db.close();
  console.log('[e2e-bootstrap] preset sample record in PG (default space)');
  console.log('[e2e-bootstrap] done');
}

main().catch((e) => {
  console.error('[e2e-bootstrap] failed:', e.message);
  process.exit(1);
});
