-- v3.28 知识联动字段：
-- 1) concepts.importance —— 概念的「核心度」（'core' | 'supporting' | ''）。
--    概念抽取提示词新增 importance 输出（core=本篇核心创新，supporting=支撑技术）；
--    跨论文合并时 core 只升不降（任一篇标 core 即 core）。存量行 NULL，读取兜底 ''（同 005/008 模式）。
-- 2) formulas.concept_terms —— 公式 ↔ 概念显式关联（jsonb 字符串数组，本篇概念清单里的规范 term）。
--    公式抽取提示词新增 conceptTerms 输出，合并时取并集；MinerU/框选路径无此字段（空数组兜底，
--    前端另有名称匹配 fallback）。两页知识（概念/公式）由此打通。
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS importance TEXT;
ALTER TABLE formulas ADD COLUMN IF NOT EXISTS concept_terms JSONB;
