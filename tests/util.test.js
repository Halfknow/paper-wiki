const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTitle, titleSimilarity, cleanFilenameToTitle, sleep, createRateLimiter,
} = require('../lib/util');

test('normalizeTitle 小写化、去标点、折叠空白、去 LaTeX', () => {
  assert.strictEqual(normalizeTitle('A Survey of $L^2$ Losses!'), 'a survey of losses');
  assert.strictEqual(normalizeTitle(''), '');
});

test('titleSimilarity 用 Jaccard，相同标题=1，无关≈0', () => {
  assert.strictEqual(titleSimilarity('A Survey of LLMs', 'A Survey of LLMs'), 1);
  assert.ok(titleSimilarity('A Survey of Large Language Models', 'survey of large language models a') > 0.6);
  assert.strictEqual(titleSimilarity('cats', 'quantum gravity'), 0);
});

test('cleanFilenameToTitle 处理各种命名格式', () => {
  assert.strictEqual(cleanFilenameToTitle('2026-Zhao 等-A Survey of Large Language Models.pdf'),
    'A Survey of Large Language Models');
  assert.strictEqual(cleanFilenameToTitle('DeepSeek-AI 等 - 2024 - DeepSeek LLM Scaling Open-Source Language Models with Longtermism.pdf'),
    'DeepSeek LLM Scaling Open-Source Language Models with Longtermism');
  assert.strictEqual(cleanFilenameToTitle('Pre_2024_The Ultimate Guide to Fine-Tuning LLMs.pdf'),
    'The Ultimate Guide to Fine-Tuning LLMs');
  assert.strictEqual(cleanFilenameToTitle('JAIR_2025_A Survey on Data Selection.pdf'),
    'A Survey on Data Selection');
  assert.strictEqual(cleanFilenameToTitle('Some Paper_billingual.pdf'), 'Some Paper');
});

test('createRateLimiter 保证最小间隔', async () => {
  const lim = createRateLimiter(50);
  const t0 = Date.now();
  await lim(); await lim(); await lim();
  assert.ok(Date.now() - t0 >= 100, '三次调用至少间隔 100ms');
});
