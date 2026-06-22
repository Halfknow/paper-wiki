# CLAUDE.md

本项目面向 AI agent / Claude Code 的指南**以 [`AGENTS.md`](./AGENTS.md) 为单一事实源**（架构、数据流、关键约定与陷阱），避免两份文档分叉。请先读它。

人类向的功能介绍见 [`README.md`](./README.md)；逐版本变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 最重要的几条（详见 AGENTS.md「关键约定 / 陷阱」）

- **改后端要重启**：`lib/*`、`server.js`、`config.json` 在启动时 `require`/读入内存，改动须 `pm2 restart paper-wiki` 才生效；前端 `public/`（html/js/css）每次请求即时读盘且 `no-cache`，改完刷新浏览器即可。
- **`deps.saveStore(store)` 单参**：误写两参会把 storePath 当 store 写坏 `papers.json`。
- **paper id = 文件内容 sha1 前 16 位**，与文件名无关：改名 / 删除文件不影响 id、`data/text/<id>.txt`、概念、批注。
- **空总结不可当成功**：模型返回空对象时存可重试占位，不写空「## TL;DR」。
- **发现的查询理解三级兜底**：`claude -p`（无头常 401，且新版输出是消息数组）→ GLM 网关 → 原始主题；排序是「相关·权威·新近」复合分，不是单引用量。
- **裸 arXiv ID 文件名**（`2012.12556.pdf`）靠 `parseArxivUrl(文件名)` 识别走 `id:` 精确查，别退回 `cleanFilenameToTitle`（会把 ID 当年份删掉）。

## 工程纪律

- 改动配套 `node --test`（当前 119 例）；`npm run lint`（ESLint）、`npm run format:check`（Prettier，仅 `lib/server/tests`）。
- 新功能优先 TDD：先写/改测试看其失败，再实现。
- 提交信息用约定式 + emoji，结尾带 `Co-Authored-By`。
