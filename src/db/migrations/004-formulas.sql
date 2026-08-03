-- 004: 公式清单（v3.9）——每空间一份归一化公式表 + 论文侧反查列
-- 合并 key 是 canonical_name（归一化小写连字符英文名），id = 'fm_' + stableShortHash(canonical_name)。
-- occurrences 承载多对多附加属性：[{paperId, rawLatex, context, symbolMap}]；
-- paper_ids 是它的投影（冗余存储，让删论文/统计逻辑复用 concepts 那套）。
CREATE TABLE formulas (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  canonical_name TEXT,
  name TEXT,
  latex TEXT,
  description TEXT,
  category TEXT,
  variables jsonb,
  plottable BOOLEAN DEFAULT FALSE,
  plot_hint jsonb,
  occurrences jsonb,
  paper_ids jsonb,
  source TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (space_id, id)
);
ALTER TABLE papers ADD COLUMN formula_ids jsonb;
