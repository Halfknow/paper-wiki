-- v3.10：concepts 表新增 category 列（概念分类：attention/loss/architecture/...）
-- 用于概念总览图按分类分组，以及概念卡片显示分类徽章。
-- 存量行 category 为 NULL，读取时 loadSpaceStore 兜底为 ''（前端再回退 'other'）。
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS category TEXT;
