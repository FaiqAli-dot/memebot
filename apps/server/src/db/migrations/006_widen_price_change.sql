-- 006: Tracking the whole universe surfaces real tokens with >1,000,000% moves from
-- near-zero bases, which overflow NUMERIC(16,8). Widening is lossless.
ALTER TABLE market_snapshots
  ALTER COLUMN price_change_5m_pct TYPE NUMERIC(24, 8),
  ALTER COLUMN price_change_1h_pct TYPE NUMERIC(24, 8);
