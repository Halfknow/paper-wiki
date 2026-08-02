// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

/**
 * 阅读器聊天抽屉 e2e（依赖真实 pdf.js 运行时，jsdom 覆盖不到的行为）：
 *  1) Esc 分层：先关抽屉再关阅读器
 *  2) 点击 PDF 关闭未钉住的抽屉；pin 钉住后点击 PDF 不关
 *  3) pdf.js KeyboardManager 不抢 textarea 的键（Backspace 可删、Ctrl+A 全选输入框）
 *  4) 换论文后聊天历史正确加载（dataset.loaded 一次性标记 bug 回归）
 *  5) 「聊天 | 笔记」segmented 笔记侧栏
 *
 * 前置：webServer 已 spawn server.js（scripts/e2e-bootstrap.js 预置 sample 记录）。
 */

const SAMPLE = 'sample';
const API = 'http://127.0.0.1:9999'; // APIRequestContext 不继承 use.baseURL，显式拼绝对地址

/** 经 API 直接写聊天历史（绕开 AI，确定性数据） */
async function seedChat(request, id, chat) {
  const r = await request.patch(`${API}/api/papers/${id}?space=default`, { data: { chat } });
  expect(r.ok()).toBeTruthy();
}

async function openReader(page, hasText) {
  await page.goto('/', { waitUntil: 'networkidle' });
  const item = page.locator('#paper-list li', { hasText }).first();
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await item.dblclick();
  await expect(page.locator('#reader-view')).toHaveClass(/active/, { timeout: 20000 });
  await expect(page.locator('#reader-loading')).toHaveClass(/done/, { timeout: 20000 });
}

async function openDrawer(page) {
  await page.locator('#reader-chat').click();
  await expect(page.locator('#reader-chat-drawer')).toBeVisible({ timeout: 10000 });
}

test.describe('阅读器聊天抽屉', () => {
  test('Esc 分层：先关抽屉，再关阅读器；历史消息已加载', async ({ page, request }) => {
    await seedChat(request, SAMPLE, [
      { role: 'user', content: '问题Alpha', ts: 1 },
      { role: 'assistant', content: '回答Alpha', ts: 2 },
    ]);
    await openReader(page, 'Sample Paper');
    await openDrawer(page);
    await expect(page.locator('#reader-chat-list')).toContainText('回答Alpha', { timeout: 10000 });
    // 第一次 Esc：只关抽屉，阅读器保留
    await page.keyboard.press('Escape');
    await expect(page.locator('#reader-chat-drawer')).toBeHidden();
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
    // 第二次 Esc：关阅读器
    await page.keyboard.press('Escape');
    await expect(page.locator('#reader-view')).not.toHaveClass(/active/);
  });

  test('点击 PDF 关闭未钉住的抽屉；pin 钉住后不关', async ({ page }) => {
    await openReader(page, 'Sample Paper');
    await expect(page.locator('#viewer canvas').first()).toBeVisible({ timeout: 20000 });
    await openDrawer(page);
    // 未钉住：点击 PDF 画布 → 抽屉关闭
    await page.locator('#viewer .page').first().click({ position: { x: 120, y: 120 } });
    await expect(page.locator('#reader-chat-drawer')).toBeHidden();
    // 重新打开 + 钉住
    await openDrawer(page);
    await page.locator('#rcd-pin-btn').click();
    await expect(page.locator('#rcd-pin-btn')).toHaveClass(/pinned/);
    await page.locator('#viewer .page').first().click({ position: { x: 120, y: 120 } });
    await expect(page.locator('#reader-chat-drawer')).toBeVisible();
    // 钉住状态下 Esc 仍可关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('#reader-chat-drawer')).toBeHidden();
  });

  test('textarea 按键不被 pdf.js 抢走：Backspace 可删、Ctrl+A 全选输入框', async ({ page }) => {
    test.setTimeout(90000);
    await openReader(page, 'Sample Paper');
    // 创建一个高亮批注（制造批注编辑器活跃态——修复前此态下 pdf.js 会抢键）
    await expect(page.locator('#viewer .textLayer').first()).toBeVisible({ timeout: 20000 });
    await page.locator('#reader-tool-highlight').click();
    const span = page.locator('#viewer .textLayer span').first();
    await span.waitFor({ timeout: 15000 });
    const box = await span.boundingBox();
    test.skip(!box, '文本层不可用');
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(Math.max(box.width - 4, 10), 80), box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    // 打开抽屉聚焦输入框：删除/全选必须作用于输入框而非 PDF 批注
    await openDrawer(page);
    const input = page.locator('#reader-chat-input');
    await input.click();
    await input.pressSequentially('abcd', { delay: 30 });
    await input.press('Backspace');
    await expect(input).toHaveValue('abc', { timeout: 5000 });
    await input.press('Control+a');
    const selected = await input.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected).toBe('abc');
  });

  test('换论文后聊天抽屉加载新论文的历史（不串台）', async ({ page, request }) => {
    test.setTimeout(90000);
    // 造第二篇论文：sample2.pdf（改尾部字节让 sha1 不同 → 不同 id）。
    // 注意从 fixture 复制而非 sample.pdf——扫描流水线会把 sample.pdf 规范改名（裸 ID 改名逻辑），
    // 磁盘上的原始文件名不稳定，fixture 才是唯一可靠来源。
    const dir = path.resolve(__dirname, '..', '..', 'papers', 'default');
    fs.mkdirSync(dir, { recursive: true });
    const fixture = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'sample.pdf');
    const dst = path.join(dir, 'sample2.pdf');
    fs.writeFileSync(dst, Buffer.concat([fs.readFileSync(fixture), Buffer.from('\n%e2e-second-copy\n')]));
    await request.post(`${API}/api/scan?space=default`);
    // 等新记录入库（scan 先入 pending 记录，无需等 AI 流水线）
    let secondId = null;
    for (let i = 0; i < 60 && !secondId; i++) {
      const r = await request.get(`${API}/api/papers?space=default`);
      const list = await r.json();
      const p2 = (list.data || []).find((p) => p.filename === 'sample2.pdf');
      if (p2) secondId = p2.id;
      else await page.waitForTimeout(500);
    }
    expect(secondId, 'sample2 入库').toBeTruthy();
    // 两篇各写不同聊天历史
    await seedChat(request, SAMPLE, [
      { role: 'user', content: '问题第一', ts: 1 },
      { role: 'assistant', content: '回答第一', ts: 2 },
    ]);
    await seedChat(request, secondId, [
      { role: 'user', content: '问题第二', ts: 1 },
      { role: 'assistant', content: '回答第二', ts: 2 },
    ]);
    // 第一篇：抽屉显示「回答第一」
    await openReader(page, 'Sample Paper');
    await openDrawer(page);
    await expect(page.locator('#reader-chat-list')).toContainText('回答第一', { timeout: 10000 });
    await page.keyboard.press('Escape'); // 关抽屉
    await page.keyboard.press('Escape'); // 关阅读器
    // 第二篇：必须显示「回答第二」而非第一篇的残留（dataset.loaded 回归）
    await openReader(page, 'sample2');
    await openDrawer(page);
    await expect(page.locator('#reader-chat-list')).toContainText('回答第二', { timeout: 10000 });
    await expect(page.locator('#reader-chat-list')).not.toContainText('回答第一');
    // 清理
    fs.rmSync(dst, { force: true });
  });

  test('「聊天 | 笔记」segmented：笔记侧栏显示卡片并可切回聊天', async ({ page, request }) => {
    const r = await request.patch(`${API}/api/papers/${SAMPLE}?space=default`, {
      data: { noteCards: [{ type: 'manual', title: '笔记卡一', body: '侧栏正文一', createdAt: 1, updatedAt: 1 }] },
    });
    expect(r.ok()).toBeTruthy();
    await openReader(page, 'Sample Paper');
    await openDrawer(page);
    await page.locator('.rcd-seg button[data-seg="notes"]').click();
    await expect(page.locator('.rcd-notes-view')).toBeVisible();
    await expect(page.locator('.rcd-notes-view')).toContainText('笔记卡一', { timeout: 10000 });
    await expect(page.locator('.rcd-notes-view')).toContainText('侧栏正文一');
    // 切回聊天
    await page.locator('.rcd-seg button[data-seg="chat"]').click();
    await expect(page.locator('#reader-chat-list')).toBeVisible();
  });
});
