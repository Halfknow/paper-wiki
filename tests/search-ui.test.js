// 高级搜索面板 UI 测试（jsdom 驱动真实 app.js，共享 tests/helpers/ui.js 启动器）。
// 覆盖：面板开合 / 字段→DSL→搜索框→触发搜索（双向同步之一）/ 搜索框 DSL→面板回填 /
//       hasNotes/星标/年份/scope=body 各字段 DSL 生成 / 标签 chips / 清空 / 保存的搜索全流程。
// 注意：window.PaperWikiSearch（public/search-dsl.js，classic script）在 boot 后手动注入沙箱。

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootUi } = require('./helpers/ui');

let ui;
const $ = (id) => ui.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST = [
  {
    id: 'p1', filename: 'a.pdf', title: 'Attention Paper', authors: ['Vaswani'], year: '2017', abstract: '',
    arxivId: null, arxivUrl: null, primaryCategory: null, metaSource: null, metaConfidence: 0,
    fulltextChars: 100, summaryExcerpt: '', status: 'ready', error: null,
    tags: ['transformer'], topics: ['NLP'], folders: [], rating: 0, starred: false, readStatus: 'unread',
    readProgress: null, addedAt: 1, updatedAt: 1, hasSummary: true, hasNotes: false, conceptCount: 0,
  },
];

let getUrls;
before(async () => {
  ui = await bootUi({
    listItems: LIST,
    details: {},
    routes: {
      '/api/settings/saved-searches': ({ body, backend }) => {
        backend._saved = body ? body.value : [];
        return {
          ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => ({ ok: true, data: { savedSearches: backend._saved } }),
        };
      },
      '/api/search': () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, data: { results: [], query: 'x', citationsAvailable: false } }),
      }),
    },
  });
  // 注入 classic script search-dsl.js（index.html 里由 <script> 加载，harness 剥掉了）
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'search-dsl.js'), 'utf8'), { window: ui.window });
  assert.ok(ui.window.PaperWikiSearch, 'PaperWikiSearch 注入成功');
  // GET 请求记录（helper 只记非 GET）
  getUrls = [];
  const origFetch = ui.backend.fetch;
  globalThis.fetch = ui.window.fetch = async (url, opts) => {
    if (!opts || !opts.method || opts.method === 'GET') getUrls.push(String(url));
    return origFetch(url, opts);
  };
  assert.ok(ui.document.querySelector('.paper-item'), 'boot 成功');
});

const panel = () => $('advanced-search');
const searchBox = () => $('search');
const dslPreview = () => $('sf-dsl-preview').textContent;
const lastGetMatch = (needle) => getUrls.filter((u) => u.includes(needle)).pop();

function setInput(el, v) {
  el.value = v;
  el.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}
function change(el, v) {
  if (v !== undefined) el.value = v;
  el.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}
async function openPanel() {
  if (panel().hidden) $('search-advanced-toggle').click();
  await sleep(30);
  assert.strictEqual(panel().hidden, false, '面板打开');
}

test('面板开合：toggle 按钮切换 hidden + aria-expanded', async () => {
  assert.strictEqual(panel().hidden, true, '初始关闭');
  $('search-advanced-toggle').click();
  await sleep(20);
  assert.strictEqual(panel().hidden, false, '点击后打开');
  assert.strictEqual($('search-advanced-toggle').getAttribute('aria-expanded'), 'true');
  $('search-advanced-toggle').click();
  await sleep(20);
  assert.strictEqual(panel().hidden, true, '再点关闭');
});

test('标题字段 → 生成 DSL 回填搜索框并触发搜索', async () => {
  await openPanel();
  getUrls.length = 0;
  setInput($('sf-title'), 'attention');
  await sleep(350); // syncSearchBoxFromPanel 200ms 防抖 + 余量
  assert.strictEqual(searchBox().value, 'title:attention', '搜索框回填 DSL');
  assert.strictEqual(dslPreview(), 'title:attention', '预览行同步');
  const hit = lastGetMatch('/api/papers?q=');
  assert.ok(hit && hit.includes('q=' + encodeURIComponent('title:attention')), '触发元数据搜索: ' + hit);
});

test('仅含笔记 → DSL 含 notes:.（字段非空语义）', async () => {
  await openPanel();
  change($('sf-has-notes'), true);
  $('sf-has-notes').checked = true;
  change($('sf-has-notes'));
  await sleep(250);
  assert.ok(searchBox().value.includes('notes:.'), 'DSL 含 notes:.: ' + searchBox().value);
  change($('sf-has-notes'));
  $('sf-has-notes').checked = false;
  change($('sf-has-notes'));
});

test('年份区间 → year:FROM-TO 范围语法', async () => {
  await openPanel();
  $('sf-clear').click(); // 面板状态跨用例共享，先清掉上一用例的标题
  await sleep(30);
  setInput($('sf-year-from'), '2020');
  setInput($('sf-year-to'), '2022');
  await sleep(250);
  assert.strictEqual(searchBox().value, 'year:2020-2022', '双边界合成范围语法');
});

test('搜正文 scope：body: 路由到 /api/search 全文检索', async () => {
  await openPanel();
  const bodyRadio = ui.document.querySelector('input[name="sf-scope"][value="body"]');
  bodyRadio.checked = true;
  bodyRadio.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await sleep(20);
  assert.strictEqual($('sf-body-text').disabled, false, '正文输入框解锁');
  getUrls.length = 0;
  setInput($('sf-body-text'), 'gradient descent');
  await sleep(400);
  assert.ok(searchBox().value.includes('body:gradient'), 'DSL 含 body 词: ' + searchBox().value);
  assert.ok(lastGetMatch('/api/search?'), '走了全文检索端点');
  // 还原 metadata scope
  const metaRadio = ui.document.querySelector('input[name="sf-scope"][value="metadata"]');
  metaRadio.checked = true;
  metaRadio.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  setInput($('sf-body-text'), '');
});

test('标签 chips：回车添加进 DSL，× 移除', async () => {
  await openPanel();
  const input = $('sf-tag-input');
  setInput(input, 'moe');
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(250);
  assert.ok(searchBox().value.includes('tag:moe'), 'DSL 含 tag:moe: ' + searchBox().value);
  const chip = $('sf-tags-row').querySelector('.adv-chip-x, [data-i]');
  assert.ok(chip, 'chip 渲染');
  chip.click();
  await sleep(250);
  assert.ok(!searchBox().value.includes('tag:moe'), '移除后 DSL 不含 tag:moe');
});

test('搜索框输入 DSL → 面板字段回填（双向同步之二）', async () => {
  await openPanel();
  setInput(searchBox(), 'title:attention author:Vaswani year:>=2017');
  await sleep(60);
  assert.strictEqual($('sf-title').value, 'attention', '标题回填');
  assert.strictEqual($('sf-author').value, 'Vaswani', '作者回填');
  assert.strictEqual($('sf-year-from').value, '2017', '年份起回填');
});

test('清空按钮：字段与搜索框全部重置', async () => {
  await openPanel();
  setInput($('sf-title'), 'attention');
  await sleep(250);
  $('sf-clear').click();
  await sleep(60);
  assert.strictEqual($('sf-title').value, '', '标题清空');
  assert.strictEqual(searchBox().value, '', '搜索框清空');
  assert.strictEqual(dslPreview(), '（无筛选）', '预览重置');
});

test('保存的搜索：命名 → PUT → chip 出现 → 点击应用 DSL 并触发搜索', async () => {
  await openPanel();
  globalThis.prompt = ui.window.prompt = () => '注意力论文'; // app.js 用裸 prompt（node 下解析到 globalThis）
  setInput(searchBox(), 'title:attention');
  $('sf-save').click();
  await sleep(60);
  const chip = $('saved-searches').querySelector('.saved-chip');
  assert.ok(chip, 'chip 渲染');
  assert.ok(chip.textContent.includes('注意力论文'), 'chip 用命名');
  // 清空搜索框后点击 chip → 应用
  setInput(searchBox(), '');
  getUrls.length = 0;
  chip.click();
  await sleep(60);
  assert.strictEqual(searchBox().value, 'title:attention', 'chip 应用 DSL 到搜索框');
  await sleep(300);
  assert.ok(lastGetMatch(encodeURIComponent('title:attention')), 'chip 触发搜索');
});
