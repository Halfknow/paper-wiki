-- 修复：concepts 表补 context / source 列。mergeConcepts 生成的 context（概念出处，如
-- 「3.2.1 节，式(1)」）与 source（'ai'）之前无列可落：papers 有 extra JSONB 兜底列，
-- concepts 没有——这两个字段每次重启即丢，前端概念页的「context:」过滤恒为空。
-- 存量行 NULL，读取时 loadSpaceStore 兜底 ''（与 category 同模式，见 005）。
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS source TEXT;
