-- 全文检索：paper_texts 表达式 GIN 索引（english 词干化）。
-- 文件名含 .optional.：pg-mem（单测）不支持 tsvector，migrate() 对 optional 迁移失败时跳过不记账
-- （真实 PG 首次成功后记账不再重跑；查询侧 lib/db.js searchFulltext 自带 ILIKE 降级）。
CREATE INDEX IF NOT EXISTS idx_paper_texts_fulltext_tsv ON paper_texts USING gin (to_tsvector('english', fulltext));
