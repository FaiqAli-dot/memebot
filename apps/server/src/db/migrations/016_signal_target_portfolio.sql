-- 016: The paper portfolio a signal is meant for. Lanes alone don't identify it: two research
-- portfolios share lane = 'RESEARCH'. Older rows stay NULL and keep their lane-only routing.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS target_portfolio_id UUID;
CREATE INDEX IF NOT EXISTS idx_signals_target_portfolio
  ON signals (target_portfolio_id, created_at DESC)
  WHERE target_portfolio_id IS NOT NULL;
