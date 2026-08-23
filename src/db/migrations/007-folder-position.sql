-- 修复（v3.22 遗留）：folders 表新增 position 列，持久化收藏夹手动排序。
-- PUT /api/folders/order 只重排内存数组；buildSnapshot 的 folder 哈希按 id 键、不含顺序，
-- 重排后 per-id 哈希全不变 → hash-diff 判定「无变化」不写库，重启后 ORDER BY created_at
-- 恢复旧序。现保存时把数组下标写入 position，读取按 position 升序（存量 NULL 行由
-- loadSpaceStore 的 JS 侧排序兜底在最后，避免依赖 pg-mem 不一定支持的 NULLS LAST）。
ALTER TABLE folders ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION;
