// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

/**
 * 批注全类型持久化 e2e：便签（FreeText, type=3）与手写（Ink, type=15）退出阅读器后必须存住并回显。
 * 用户报告：高亮（type=9）正常，便签/手写退出后丢失——本文件定位失败环节（保存未触发 / 序列化缺项 / 回显失败）。
 *
 * 诊断手段：监听 PATCH /api/papers/:id 请求体，区分「根本没 PATCH」「PATCH 里缺类型」「存了但不回显」。
 */

const API = 'http://127.0.0.1:9999';

async function openReader(page, hasText = 'Sample Paper') {
  await page.goto('/', { waitUntil: 'networkidle' });
  const item = page.locator('#paper-list li', { hasText }).first();
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await item.dblclick();
  await expect(page.locator('#reader-view')).toHaveClass(/active/, { timeout: 20000 });
  await expect(page.locator('#reader-loading')).toHaveClass(/done/, { timeout: 20000 });
  await expect(page.locator('#viewer canvas').first()).toBeVisible({ timeout: 20000 });
}

/** 监听 PATCH 请求体里的 annotations items */
function watchAnnotationPatches(page) {
  const patches = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/api\/papers\//.test(req.url())) {
      try {
        const body = req.postDataJSON();
        if (body && body.annotations) patches.push(body.annotations);
      } catch { /* ignore */ }
    }
  });
  return patches;
}

async function getStoredItems(request, id = 'sample') {
  const res = await request.get(`${API}/api/papers/${id}`);
  const body = await res.json();
  return (body.data && body.data.annotations && body.data.annotations.items) || [];
}

/** 造一篇无批注的新论文（避免与库内已有批注互相干扰——点中已有编辑器是选中而非新建） */
async function makeFreshPaper(request, name) {
  const dir = path.resolve(__dirname, '..', '..', 'papers', 'default');
  fs.mkdirSync(dir, { recursive: true });
  const fixture = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'sample.pdf');
  fs.writeFileSync(path.join(dir, name), Buffer.concat([fs.readFileSync(fixture), Buffer.from(`\n%${name}\n`)]));
  await request.post(`${API}/api/scan?space=default`);
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    const r = await request.get(`${API}/api/papers?space=default`);
    const list = await r.json();
    const p = (list.data || []).find((x) => x.filename === name);
    if (p) id = p.id;
    else await new Promise((res) => setTimeout(res, 500));
  }
  expect(id, name + ' 入库').toBeTruthy();
  return id;
}

test.describe('批注持久化（便签/手写）', () => {
  test('手写（Ink）：画一笔 → 退出 → 存库且重开回显', async ({ page, request }) => {
    test.setTimeout(90000);
    const patches = watchAnnotationPatches(page);
    await openReader(page);
    // 切手写工具，在首页画布上画一条斜线
    await page.locator('#reader-tool-ink').click();
    const canvas = page.locator('#viewer .page').first();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const cx = box.x + box.width / 3, cy = box.y + box.height / 3;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 60, { steps: 8 });
    await page.mouse.move(cx + 160, cy + 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    // 退出阅读器（force 保存路径：_teardown → saveAnnotations(true)）
    await page.locator('#reader-back').click();
    await page.waitForTimeout(2000);
    const items = await getStoredItems(request);
    const inkItems = items.filter((it) => Number(it.annotationType) === 15);
    console.log('[diag] PATCH次数:', patches.length, '库存 items:', items.length, 'ink:', inkItems.length);
    expect(inkItems.length, '手写应保存到库（annotationType=15）').toBeGreaterThan(0);
    // 重开回显
    await openReader(page);
    await page.waitForTimeout(2500);
    const inkEl = page.locator('#viewer .inkEditor, #viewer [data-editor-id]').first();
    await expect(inkEl).toBeVisible({ timeout: 10000 });
  });

  test('便签（FreeText）：点一下输入文字 → 退出 → 存库且重开回显', async ({ page, request }) => {
    test.setTimeout(90000);
    // 用无批注的新论文：避免点击落在已有批注上（点中已有编辑器是选中而非新建）
    const freshId = await makeFreshPaper(request, 'ft-fresh.pdf');
    const patches = watchAnnotationPatches(page);
    await openReader(page, 'ft-fresh');
    // 切便签工具，点击页面空白处放一张便签并输入文字
    await page.locator('#reader-tool-note').click();
    const pageEl = page.locator('#viewer .page').first();
    const box = await pageEl.boundingBox();
    expect(box).toBeTruthy();
    await pageEl.click({ position: { x: box.width / 2, y: box.height * 0.6 } });
    await page.waitForTimeout(600);
    // pdf.js FreeText 编辑器是 contenteditable div
    const editor = page.locator('#viewer .freeTextEditor').first();
    await expect(editor).toBeVisible({ timeout: 10000 });
    await editor.click();
    await page.keyboard.type('便签持久化测试');
    await page.waitForTimeout(300);
    // 点页面其它位置提交（blur commit）
    await pageEl.click({ position: { x: box.width / 2, y: box.height * 0.9 } });
    await page.waitForTimeout(800);
    // 退出阅读器
    await page.locator('#reader-back').click();
    await page.waitForTimeout(2000);
    const items = await getStoredItems(request, freshId);
    const ftItems = items.filter((it) => Number(it.annotationType) === 3);
    console.log('[diag] PATCH次数:', patches.length, '库存 items:', items.length, 'freetext:', ftItems.length);
    expect(ftItems.length, '便签应保存到库（annotationType=3）').toBeGreaterThan(0);
    // 重开回显
    await openReader(page, 'ft-fresh');
    await page.waitForTimeout(2500);
    await expect(page.locator('#viewer .freeTextEditor').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#viewer')).toContainText('便签持久化测试');
  });
});

