const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright 配置：e2e 测试 reader 关键路径（PDF 渲染、高亮往返）。
 * webServer 自动 spawn server.js + 预置 fixture PDF 与 papers.json。
 */
module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // 单 server 实例，避免写冲突
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:9999',
    trace: 'on-first-retry',
    actionTimeout: 15000,
  },
  webServer: {
    command: 'node scripts/e2e-bootstrap.js && node src/server.js',
    port: 9999,
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      PORT: '9999',
      NODE_ENV: 'test',
      // v3：需要 PostgreSQL（本地默认连 5433 的开发实例，CI 由 services.postgres 提供并覆盖此值）
      DATABASE_URL:
        process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || 'postgres://paperwiki:dev@127.0.0.1:5433/paperwiki',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } }],
});
