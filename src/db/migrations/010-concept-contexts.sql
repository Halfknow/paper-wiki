-- v3.29 概念「由来」补全：concepts.contexts jsonb —— 每篇论文里的出处（章节/式号）。
-- 此前概念只有单一 context（首次出现处），同一概念在 10 篇论文里各自出现在哪一节哪个式号
-- 无处可看（公式有 occurrences 承载，概念没有）。contexts = [{paperId, context}]，与
-- formulas.occurrences 的 context 呼应但更轻（概念不需要 rawLatex/symbolMap）。
-- 概念级 context 保留为「主出处」（首次定义处，向后兼容）；读取兜底 []（同 005/008/009 模式）。
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS contexts JSONB;
