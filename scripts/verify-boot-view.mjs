// 一次性验证脚本：确认深链首帧不闪现论文页（v3.17 导航重构）。
//
// jsdom 测不了这个——它不加载外部 CSS，而首帧选择完全由 styles.css 的
// [data-boot-path^="/concepts"] 一族规则决定。这里用真实浏览器：
// 阻断 app.js（module）加载，让页面停在「HTML + CSS 已就绪、JS 尚未接管」的那一瞬，
// 再读各视图的 computed display —— 正是用户在慢网络下会看到的首帧。
//
// 用法：node scripts/verify-boot-view.mjs [baseUrl]

import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:8888';
const browser = await chromium.launch();
const page = await browser.newPage();

// 掐掉 app.js，把页面钉在首帧
await page.route('**/app.js', (r) => r.abort());

const views = ['library-view', 'concepts-view', 'formulas-view', 'settings-view'];
let failed = 0;

// expected：期望首帧可见的**内容视图**；ctx：期望可见的侧栏上下文区块；
// overlay：设置覆盖层是否该出现（覆盖层不遮蔽底下的内容视图，故 /settings 期望两个都可见）。
for (const { path, expected, ctx, overlay } of [
  { path: '/library', expected: 'library-view', ctx: 'library' },
  { path: '/concepts', expected: 'concepts-view', ctx: 'concepts' },
  { path: '/concepts/maps', expected: 'concepts-view', ctx: 'concepts' },
  { path: '/formulas', expected: 'formulas-view', ctx: 'formulas' },
  { path: '/settings/overview', expected: 'library-view', ctx: 'library', overlay: true },
  { path: '/paper/abc', expected: 'library-view', ctx: 'library' },
  { path: '/reader/abc', expected: 'library-view', ctx: 'library' },
]) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  const shown = [];
  for (const v of views) {
    const d = await page.$eval('#' + v, (el) => getComputedStyle(el).display);
    if (d !== 'none') shown.push(`${v}:${d}`);
  }
  const ctxShown = await page.$$eval('#sidebar .side-ctx', (els) =>
    els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.dataset.ctx));

  const want = overlay ? [expected, 'settings-view'] : [expected];
  const viewOk = shown.length === want.length && want.every((w) => shown.some((s) => s.startsWith(w)));
  const ctxOk = ctxShown.length === 1 && ctxShown[0] === ctx;
  const ok = viewOk && ctxOk;
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${path.padEnd(18)} 视图: ${shown.join(', ') || '(无)'} | 侧栏: ${ctxShown.join(', ') || '(无)'}` +
    (ok ? '' : `  期望视图 ${want.join(' + ')} / 侧栏 ${ctx}`),
  );
}

// ---------------------------------------------------------------------------
// 第二遍：让 app.js 正常跑，点导航切页后再看 computed display。
// 光断言 class 抓不到这类问题——.view-hidden 与 .layout 特异性相同，靠先后顺序定胜负，
// 类加上了但 display 没变（曾表现为概念页左上角还挂着论文页的列表工具条）。
// ---------------------------------------------------------------------------
const live = await browser.newPage();
await live.goto(base + '/library', { waitUntil: 'networkidle' });

for (const [nav, expected] of [['concepts', 'concepts-view'], ['formulas', 'formulas-view'], ['library', 'library-view']]) {
  await live.click(`#view-nav [data-view="${nav}"]`);
  await live.waitForTimeout(900);
  const shown = [];
  for (const v of views) {
    const d = await live.$eval('#' + v, (el) => getComputedStyle(el).display);
    if (d !== 'none') shown.push(`${v}:${d}`);
  }
  const ok = shown.length === 1 && shown[0].startsWith(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} 点击导航 → ${nav.padEnd(9)} 可见: ${shown.join(', ') || '(无)'}  期望: ${expected}`);
}

await browser.close();
console.log(failed ? `\n${failed} 条不符` : '\n首帧与运行时切换均正确');
process.exit(failed ? 1 : 0);
