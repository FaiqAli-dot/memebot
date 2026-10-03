-- 010: Token Intelligence / Discovery Observability
-- Additive only. No destructive changes to existing tables or data.
-- Permanent research ledger + temporary raw observation tables with retention.

-- ---------------------------------------------------------------------------
-- Tokens: discovery/venue/DBC intelligence columns (canonical identity stays UNIQUE)
-- ---------------------------------------------------------------------------
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS discovery_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS launch_mechanism TEXT,
  ADD COLUMN IF NOT EXISTS dbc_status TEXT,
  ADD COLUMN IF NOT EXISTS migration_status TEXT,
  ADD COLUMN IF NOT EXISTS post_migration_venue TEXT,
  ADD COLUMN IF NOT EXISTS dbc_pool_address TEXT,
  ADD COLUMN IF NOT EXISTS tracking_started BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snapshot_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS initial_price_usd NUMERIC(30, 12),
  ADD COLUMN IF NOT EXISTS initial_market_cap_usd NUMERIC(30, 8),
  ADD COLUMN IF NOT EXISTS initial_volume_usd NUMERIC(30, 8),
  ADD COLUMN IF NOT EXISTS initial_holders INT,
  ADD COLUMN IF NOT EXISTS initial_token_age_minutes NUMERIC(16, 4),
  ADD COLUMN IF NOT EXISTS intelligence_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  ADD COLUMN IF NOT EXISTS last_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_signal_score NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS last_risk_status TEXT,
  ADD COLUMN IF NOT EXISTS trade_status TEXT NOT NULL DEFAULT 'NOT_TRADED',
  ADD COLUMN IF NOT EXISTS outcome_summary JSONB;

UPDATE tokens
SET discovery_sources = CASE
  WHEN jsonb_typeof(discovery_sources) = 'array' AND jsonb_array_length(discovery_sources) > 0
    THEN discovery_sources
  WHEN discovery_source IS NOT NULL AND discovery_source <> ''
    THEN jsonb_build_array(discovery_source)
  ELSE '[]'::jsonb
END
WHERE discovery_sources = '[]'::jsonb OR discovery_sources IS NULL;

UPDATE tokens SET last_discovered_at = COALESCE(last_discovered_at, discovered_at)
WHERE last_discovered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_intelligence_status
  ON tokens (data_mode, intelligence_status);
CREATE INDEX IF NOT EXISTS idx_tokens_last_rejection
  ON tokens (data_mode, last_rejection_reason)
  WHERE last_rejection_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tokens_dex_venue
  ON tokens (data_mode, dex_venue)
  WHERE dex_venue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tokens_last_discovered
  ON tokens (data_mode, last_discovered_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Discovery events (permanent): every sighting from every source
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_discovery_events (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  discovery_source TEXT NOT NULL,
  venue TEXT,
  pool_address TEXT,
  launch_mechanism TEXT,
  dbc_status TEXT,
  migration_status TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live'))
);
CREATE INDEX IF NOT EXISTS idx_token_discovery_events_token_time
  ON token_discovery_events (token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_discovery_events_source_time
  ON token_discovery_events (discovery_source, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Decision audit trail (permanent): stage results + machine-readable reasons
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_decision_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  portfolio_id UUID REFERENCES user_portfolios(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'SKIP', 'TRADED', 'NOT_TRADED')),
  reason_code TEXT,
  actual_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategy_id TEXT,
  signal_id UUID,
  risk_decision_id UUID,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live'))
);
CREATE INDEX IF NOT EXISTS idx_token_decision_audits_token_time
  ON token_decision_audits (token_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_decision_audits_reason
  ON token_decision_audits (reason_code, decided_at DESC)
  WHERE reason_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_decision_audits_stage
  ON token_decision_audits (stage, decided_at DESC);

-- Permanent decision-time feature snapshot (NOT the high-churn feature_snapshots table)
CREATE TABLE IF NOT EXISTS token_decision_feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  decision_id UUID NOT NULL REFERENCES token_decision_audits(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live'))
);
CREATE INDEX IF NOT EXISTS idx_token_decision_features_token
  ON token_decision_feature_snapshots (token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_decision_features_decision
  ON token_decision_feature_snapshots (decision_id);

-- ---------------------------------------------------------------------------
-- Post-decision outcome checkpoints (sparse, permanent until compacted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_outcome_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES token_decision_audits(id) ON DELETE SET NULL,
  checkpoint_label TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ,
  price_usd NUMERIC(30, 12),
  market_cap_usd NUMERIC(30, 8),
  liquidity_usd NUMERIC(30, 8),
  volume_usd NUMERIC(30, 8),
  change_pct NUMERIC(16, 8),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CAPTURED', 'MISSED', 'COMPACTED')),
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  UNIQUE (token_id, decision_id, checkpoint_label)
);
-- Sparse lookups only — avoid heavy indexes on high-churn pending rows
CREATE INDEX IF NOT EXISTS idx_token_outcome_checkpoints_due
  ON token_outcome_checkpoints (status, due_at)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS token_outcome_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES token_decision_audits(id) ON DELETE SET NULL,
  decision_price NUMERIC(30, 12),
  decision_market_cap NUMERIC(30, 8),
  decision_liquidity NUMERIC(30, 8),
  price_at_1h NUMERIC(30, 12),
  price_at_6h NUMERIC(30, 12),
  price_at_24h NUMERIC(30, 12),
  peak_price_24h NUMERIC(30, 12),
  lowest_price_24h NUMERIC(30, 12),
  max_gain_24h NUMERIC(16, 8),
  max_drawdown_24h NUMERIC(16, 8),
  outcome_summary TEXT,
  classification TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  UNIQUE (token_id, decision_id)
);
CREATE INDEX IF NOT EXISTS idx_token_outcome_summaries_token
  ON token_outcome_summaries (token_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Discovery source health (permanent operational state)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_source_health (
  source_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_success_at TIMESTAMPTZ,
  last_discovery_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  tokens_discovered_approx BIGINT NOT NULL DEFAULT 0,
  polling_interval_ms INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Temporary raw intelligence snapshots (retention-pruned; no heavy indexes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_raw_feature_observations (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live'))
);
-- Single lightweight time index only (high-churn table)
CREATE INDEX IF NOT EXISTS idx_token_raw_feature_obs_time
  ON token_raw_feature_observations (observed_at);

-- Retention job bookkeeping
CREATE TABLE IF NOT EXISTS retention_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  raw_cutoff TIMESTAMPTZ,
  deleted JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'RUNNING'
);

CREATE TABLE IF NOT EXISTS storage_monitor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_db_bytes BIGINT,
  oldest_raw_snapshot_at TIMESTAMPTZ,
  next_cleanup_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
