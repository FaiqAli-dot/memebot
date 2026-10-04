-- 011: Storage footprint for small hosted volumes (Railway trial: 0.5GB).
-- No trading data is removed: only redundant liquidity history and unused indexes.

-- liquidity_snapshots is only ever read as "latest per token": keep one row per token (upsert).
DELETE FROM liquidity_snapshots l
USING liquidity_snapshots n
WHERE n.token_id = l.token_id
  AND (n.observed_at > l.observed_at OR (n.observed_at = l.observed_at AND n.id > l.id));
DROP INDEX IF EXISTS idx_liquidity_snapshots_token_time;
CREATE UNIQUE INDEX IF NOT EXISTS uq_liquidity_snapshots_token ON liquidity_snapshots (token_id);

-- Indexes no query uses, paid on every high-frequency insert.
DROP INDEX IF EXISTS idx_market_snapshots_mode;
DROP INDEX IF EXISTS idx_trade_events_wallet;

-- Compact-research pruning by age.
CREATE INDEX IF NOT EXISTS idx_token_decision_audits_time ON token_decision_audits (decided_at);

-- Vacuum churned tables early so freed space is reused instead of growing the files.
ALTER TABLE market_snapshots SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
ALTER TABLE liquidity_snapshots SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE safety_assessments SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05
);
ALTER TABLE trade_events SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05
);
ALTER TABLE token_raw_feature_observations SET (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05
);
ALTER TABLE token_phases SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE shadow_trades SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE opportunity_trackers SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE token_outcome_checkpoints SET (autovacuum_vacuum_scale_factor = 0.05);
-- tokens is updated every market tick: leave page room for HOT updates.
ALTER TABLE tokens SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02);
