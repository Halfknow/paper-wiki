-- PaperWiki v3 初始 schema
-- 约定：时间戳/文件大小用 DOUBLE PRECISION（ms 时间戳 < 2^53 精确；避免 BIGINT 经 pg 驱动变字符串）；
--       嵌套结构用 JSONB；papers.extra 为未知字段兜底列（row 映射未覆盖的字段进 extra，防静默丢失）。

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value JSONB
);

CREATE TABLE IF NOT EXISTS spaces (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  papers_dir            TEXT NOT NULL DEFAULT '.',
  scan_interval_minutes DOUBLE PRECISION NOT NULL DEFAULT 5,
  last_scan_at          DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at            DOUBLE PRECISION NOT NULL DEFAULT 0,
  tags                  JSONB NOT NULL DEFAULT '[]',
  topics                JSONB NOT NULL DEFAULT '[]',
  settings              JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS papers (
  space_id         TEXT NOT NULL,
  id               TEXT NOT NULL,
  filename         TEXT,
  file_mtime       DOUBLE PRECISION,
  file_size        DOUBLE PRECISION,
  added_at         DOUBLE PRECISION,
  updated_at       DOUBLE PRECISION,
  title            TEXT,
  year             DOUBLE PRECISION,
  abstract         TEXT,
  arxiv_id         TEXT,
  arxiv_url        TEXT,
  primary_category TEXT,
  meta_source      TEXT,
  meta_confidence  DOUBLE PRECISION,
  fulltext_chars   DOUBLE PRECISION,
  summary          TEXT,
  summary_model    TEXT,
  summary_at       DOUBLE PRECISION,
  notes            TEXT,
  rating           DOUBLE PRECISION,
  starred          BOOLEAN,
  read_status      TEXT,
  status           TEXT,
  error            TEXT,
  authors          JSONB,
  tags             JSONB,
  topics           JSONB,
  concept_ids      JSONB,
  folders          JSONB,
  read_progress    JSONB,
  annotations      JSONB,
  chat             JSONB,
  extra            JSONB,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS paper_texts (
  space_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  fulltext TEXT,
  PRIMARY KEY (space_id, paper_id)
);

CREATE TABLE IF NOT EXISTS concepts (
  space_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  term       TEXT,
  definition TEXT,
  paper_ids  JSONB,
  created_at DOUBLE PRECISION,
  updated_at DOUBLE PRECISION,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS folders (
  space_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT,
  color      TEXT,
  created_at DOUBLE PRECISION,
  PRIMARY KEY (space_id, id)
);
