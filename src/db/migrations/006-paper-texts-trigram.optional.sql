-- 全文检索：paper_texts 的 trigram GIN 索引（加速 ILIKE '%中文%' 路径）。
--
-- 背景：002 的 tsvector GIN 索引只服务英文词干化路径（to_tsvector('english', fulltext) @@ tsquery）。
-- 中文查询（lib/db.js searchFulltext 中 hasCjk(q) 为真）永远走 `fulltext ILIKE '%q%'` 降级路径，
-- 该路径无 tsvector 索引可用 → 全表顺序扫描大文本字段。pg_trgm 的 GIN 索引让 ILIKE 也能走索引
-- （PG 用 trigram 匹配定位，非全扫），中文搜索性能随库增大显著改善。
--
-- 文件名含 .optional.（同 002）：pg-mem（单测）不支持 CREATE EXTENSION，migrate() 对 optional
-- 迁移失败时跳过不记账（下次仍尝试）；真实 PG 首次成功后记账。查询侧 searchFulltext 零改动——
-- PG 查询优化器自动选用此索引，无索引时仍走原 ILIKE 全扫（不比现状差）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_paper_texts_fulltext_trgm
  ON paper_texts USING gin (fulltext gin_trgm_ops);
