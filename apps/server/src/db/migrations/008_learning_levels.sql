-- Three-level learning: per-trade observations, health checks, versioned calibration.
-- Additive only.

-- Entry-time inputs persisted when the position opens (never rewritten later)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_snapshot JSONB;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS mfe_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS mae_at TIMESTAMPTZ;

-- LEVEL 1: one immutable observation per completed paper/research trade
CREATE TABLE IF NOT EXISTS trade_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGSERIAL UNIQUE,
  position_id UUID NOT NULL UNIQUE REFERENCES positions(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  portfolio_type TEXT NOT NULL CHECK (portfolio_type IN ('PRODUCTION', 'RESEARCH')),
  token_id UUID NOT NULL,
  symbol TEXT,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT,
  entry_at TIMESTAMPTZ NOT NULL,
  exit_at TIMESTAMPTZ NOT NULL,
  entry_price_usd NUMERIC(30, 12) NOT NULL,
  exit_price_usd NUMERIC(30, 12),
  position_size_usd NUMERIC(20, 8) NOT NULL,
  requested_size_usd NUMERIC(20, 8),
  -- predictions (entry time)
  predicted_ev NUMERIC(12, 6),
  predicted_win_probability NUMERIC(8, 6),
  data_confidence TEXT,
  risk_tier TEXT,
  expected_return NUMERIC(12, 6),
  expected_loss NUMERIC(12, 6),
  max_planned_loss_usd NUMERIC(20, 8),
  estimated_cost_usd NUMERIC(20, 8),
  estimated_cost_rate NUMERIC(12, 6),
  estimated_slippage_rate NUMERIC(12, 6),
  estimated_impact_rate NUMERIC(12, 6),
  stop_loss_pct NUMERIC(12, 8),
  take_profit_pct NUMERIC(12, 8),
  trailing_stop_pct NUMERIC(12, 8),
  max_hold_sec INTEGER,
  -- outcome (after entry)
  actual_cost_usd NUMERIC(20, 8),
  actual_cost_rate NUMERIC(12, 6),
  actual_slippage_rate NUMERIC(12, 6),
  actual_impact_rate NUMERIC(12, 6),
  gross_pnl_usd NUMERIC(20, 8) NOT NULL,
  net_pnl_usd NUMERIC(20, 8) NOT NULL,
  net_return NUMERIC(12, 6) NOT NULL,
  win BOOLEAN NOT NULL,
  mfe_pct NUMERIC(16, 8),
  mae_pct NUMERIC(16, 8),
  time_to_mfe_sec INTEGER,
  time_to_mae_sec INTEGER,
  exit_reason TEXT,
  -- segmentation keys (entry time)
  market_regime TEXT,
  liquidity_bucket TEXT,
  -- full entry-time input features; outcome values never go here
  entry_features JSONB NOT NULL,
  snapshot_source TEXT NOT NULL CHECK (snapshot_source IN ('ENTRY_SNAPSHOT', 'SIGNAL_BACKFILL')),
  model_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_obs_type_seq ON trade_observations (portfolio_type, data_mode, seq);
CREATE INDEX IF NOT EXISTS idx_trade_obs_strategy ON trade_observations (strategy_id, portfolio_type, seq);

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trade_observations_immutable ON trade_observations;
CREATE TRIGGER trg_trade_observations_immutable BEFORE UPDATE ON trade_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- LEVEL 2: health checks (every N observations) and emitted anomaly alerts
CREATE TABLE IF NOT EXISTS learning_health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq_from BIGINT NOT NULL,
  seq_to BIGINT NOT NULL,
  new_observations INTEGER NOT NULL,
  total_observations INTEGER NOT NULL,
  metrics JSONB NOT NULL,
  anomalies JSONB NOT NULL DEFAULT '[]'::jsonb,
  warning_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  protection_action TEXT,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_checks_created ON learning_health_checks (data_mode, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  health_check_id UUID REFERENCES learning_health_checks(id) ON DELETE SET NULL,
  anomaly_key TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  scope TEXT NOT NULL,
  strategy_id TEXT,
  safety BOOLEAN NOT NULL DEFAULT false,
  message TEXT NOT NULL,
  metric NUMERIC,
  sample_size INTEGER NOT NULL,
  low_sample BOOLEAN NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anomalies_key ON learning_anomalies (anomaly_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_created ON learning_anomalies (data_mode, created_at DESC);

-- LEVEL 3: calibration evaluations (performed or skipped, with the reason)
CREATE TABLE IF NOT EXISTS calibration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision TEXT NOT NULL CHECK (decision IN (
    'PERFORMED', 'SKIPPED_INSUFFICIENT_OBSERVATIONS', 'SKIPPED_INTERVAL_NOT_REACHED', 'SKIPPED_DISABLED'
  )),
  reason TEXT NOT NULL,
  new_observations INTEGER NOT NULL,
  required_observations INTEGER NOT NULL,
  hours_since_last NUMERIC,
  required_hours NUMERIC NOT NULL,
  total_observations INTEGER NOT NULL,
  stage TEXT NOT NULL,
  cutoff_seq BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calibration_runs_created ON calibration_runs (data_mode, created_at DESC);

-- Every candidate calibration is a version; history is never overwritten
CREATE TABLE IF NOT EXISTS calibration_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  run_id UUID REFERENCES calibration_runs(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('PRODUCTION', 'RESEARCH')),
  strategy_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'EV_LINEAR',
  status TEXT NOT NULL CHECK (status IN ('CANDIDATE', 'VALIDATED', 'PROMOTED', 'REJECTED')),
  observation_count INTEGER NOT NULL,
  training_count INTEGER NOT NULL,
  validation_count INTEGER NOT NULL,
  training_window_start TIMESTAMPTZ,
  training_window_end TIMESTAMPTZ,
  validation_window_start TIMESTAMPTZ,
  validation_window_end TIMESTAMPTZ,
  previous_version_id UUID REFERENCES calibration_versions(id),
  previous_parameters JSONB NOT NULL,
  candidate_parameters JSONB NOT NULL,
  training_metrics JSONB NOT NULL,
  validation_metrics JSONB NOT NULL,
  promotion_decision TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calibration_versions_strategy ON calibration_versions (scope, strategy_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_calibration_versions_immutable ON calibration_versions;
CREATE TRIGGER trg_calibration_versions_immutable BEFORE UPDATE ON calibration_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- Append-only activation log; the latest row per (scope, strategy) is the active calibration
CREATE TABLE IF NOT EXISTS calibration_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version_id UUID REFERENCES calibration_versions(id),
  action TEXT NOT NULL CHECK (action IN ('PROMOTE', 'ROLLBACK')),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calibration_activations ON calibration_activations (scope, strategy_id, created_at DESC);
