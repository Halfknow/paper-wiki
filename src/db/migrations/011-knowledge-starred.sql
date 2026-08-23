-- v3.30 知识页重点标记：concepts / formulas 各加 starred 布尔列。
-- 场景：组会指派（「下周讨论这几个概念」）、复习清单、重点公式收藏——与论文星标同语义。
-- 存量行 NULL，读取兜底 false（布尔版陷阱 39：哈希行同样带默认值，防 load/save 幽灵重写）。
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE formulas ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;
