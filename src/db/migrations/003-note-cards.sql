-- 003: 结构化笔记卡片列（AI 笔记：问答卡/骨架卡/自由卡）
-- 旧 notes TEXT 列保留（前端首开自动拆卡迁移后退役），不删数据。
ALTER TABLE papers ADD COLUMN note_cards jsonb;
