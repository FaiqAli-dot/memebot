-- Reality-first research foundation (additive — preserves existing data)
-- Paper trading only. No destructive drops.

-- ---------------------------------------------------------------------------
-- Token discovery / lifecycle timestamps
-- ---------------------------------------------------------------------------
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS discovery_source TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS migration_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_liquidity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_trade_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_meaningful_volume_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pool_address TEXT,
  ADD COLUMN IF NOT EXISTS quote_token TEXT,
  ADD COLUMN IF NOT EXISTS initial_liquidity_usd NUMERIC(30, 8),
  ADD COLUMN IF NOT EXISTS creator_wallet TEXT,
  ADD COLUMN IF NOT EXISTS dex_venue TEXT;

UPDATE tokens SET first_observed_at = discovered_at WHERE first_observed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_discovery_source ON tokens(discovery_source);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator_wallet) WHERE creator_wallet IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Duplicate-position bug fix: at most one OPEN position per portfolio+token
-- unless explicitly configured later via allow_duplicate (not default).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_open_portfolio_token
  ON positions (portfolio_id, token_id)
  WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- Risk / bot state expansion
-- ---------------------------------------------------------------------------
ALTER TABLE user_portfolios
  ADD COLUMN IF NOT EXISTS kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS risk_state_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portfolio_label TEXT,
  ADD COLUMN IF NOT EXISTS bankroll_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS parent_experiment_id UUID;

-- Expand bot_status check to include KILLED (drop + recreate carefully)
ALTER TABLE user_portfolios DROP CONSTRAINT IF EXISTS user_portfolios_bot_status_check;
ALTER TABLE user_portfolios
  ADD CONSTRAINT user_portfolios_bot_status_check
  CHECK (bot_status IN ('RUNNING', 'PAUSED', 'STOPPED', 'KILLED'));

-- ---------------------------------------------------------------------------
-- Trade events (event-driven market data)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_events (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  pool_address TEXT,
  side TEXT CHECK (side IN ('BUY', 'SELL', 'UNKNOWN')),
  amount_token NUMERIC(40, 18),
  amount_usd NUMERIC(30, 8),
  price_usd NUMERIC(30, 12),
  liquidity_usd NUMERIC(30, 8),
  base_reserve NUMERIC(40, 12),
  quote_reserve NUMERIC(40, 12),
  trader_wallet TEXT,
  tx_signature TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  UNIQUE (tx_signature, token_id, side)
);

CREATE INDEX IF NOT EXISTS idx_trade_events_token_time ON trade_events(token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_events_time ON trade_events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_events_wallet ON trade_events(trader_wallet) WHERE trader_wallet IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Market / token events (recorder)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_events (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID REFERENCES tokens(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_events_token_time ON market_events(token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_events_type_time ON market_events(event_type, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Feature snapshots with freshness/confidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_label TEXT,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_token_time ON feature_snapshots(token_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Safety assessments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS safety_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  score NUMERIC(8, 4) NOT NULL,
  safety_class TEXT NOT NULL,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  checks JSONB NOT NULL DEFAULT '{}'::jsonb,
  version TEXT NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_token_time ON safety_assessments(token_id, assessed_at DESC);

-- ---------------------------------------------------------------------------
-- Regime snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regime_snapshots (
  id BIGSERIAL PRIMARY KEY,
  regime TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regime_time ON regime_snapshots(observed_at DESC);

-- ---------------------------------------------------------------------------
-- Token phase history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_phases (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_phases_token_time ON token_phases(token_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Quotes (read-only Jupiter / demo) for execution realism
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quote_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  input_amount_usd NUMERIC(20, 8) NOT NULL,
  expected_output NUMERIC(40, 18),
  expected_price_usd NUMERIC(30, 12),
  route JSONB,
  price_impact_pct NUMERIC(16, 8),
  slippage_bps INT,
  liquidity_usd NUMERIC(30, 8),
  provider TEXT NOT NULL,
  quoted_at TIMESTAMPTZ NOT NULL,
  data_mode TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'MEDIUM',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_quote_snapshots_token_time ON quote_snapshots(token_id, quoted_at DESC);

-- ---------------------------------------------------------------------------
-- Shadow trades + missed opportunities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shadow_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES signals(id),
  strategy_id TEXT,
  rejection_reason TEXT NOT NULL,
  rejection_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  hypothetical_entry_price_usd NUMERIC(30, 12),
  hypothetical_size_usd NUMERIC(20, 8),
  hypothetical_cost_usd NUMERIC(20, 8),
  mfe_pct NUMERIC(16, 8),
  mae_pct NUMERIC(16, 8),
  eventual_return_pct NUMERIC(16, 8),
  time_to_peak_sec INT,
  time_to_failure_sec INT,
  liquidity_collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  hypothetical_exit_price_usd NUMERIC(30, 12),
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  journal JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_portfolio ON shadow_trades(portfolio_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_token ON shadow_trades(token_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_reason ON shadow_trades(rejection_reason);

CREATE TABLE IF NOT EXISTS missed_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  rejection_reason TEXT NOT NULL,
  filter_name TEXT,
  would_have_returned_pct NUMERIC(16, 8),
  helped BOOLEAN,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missed_opp_portfolio ON missed_opportunities(portfolio_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Orders: latency / realism audit columns
-- ---------------------------------------------------------------------------
ALTER TABLE paper_orders
  ADD COLUMN IF NOT EXISTS signal_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirm_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latency_ms INT,
  ADD COLUMN IF NOT EXISTS realism_profile TEXT,
  ADD COLUMN IF NOT EXISTS fill_probability NUMERIC(8, 6),
  ADD COLUMN IF NOT EXISTS jito_tip_usd NUMERIC(20, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_model_version TEXT;

-- Positions: journal + versions + partial exit support
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS journal JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_version TEXT,
  ADD COLUMN IF NOT EXISTS risk_version TEXT,
  ADD COLUMN IF NOT EXISTS execution_model_version TEXT,
  ADD COLUMN IF NOT EXISTS safety_version TEXT,
  ADD COLUMN IF NOT EXISTS mfe_pct NUMERIC(16, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mae_pct NUMERIC(16, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_state TEXT,
  ADD COLUMN IF NOT EXISTS remaining_quantity NUMERIC(40, 18),
  ADD COLUMN IF NOT EXISTS market_regime TEXT,
  ADD COLUMN IF NOT EXISTS token_phase TEXT;

-- Signals: EV + rejection
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS action TEXT DEFAULT 'BUY',
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS expected_value JSONB,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS strategy_id TEXT,
  ADD COLUMN IF NOT EXISTS safety_assessment_id UUID;

-- ---------------------------------------------------------------------------
-- Config registry (parameters out of code)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_registry (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  value JSONB NOT NULL,
  default_value JSONB NOT NULL,
  min_value JSONB,
  max_value JSONB,
  source TEXT NOT NULL DEFAULT 'default',
  last_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_reason TEXT
);

-- ---------------------------------------------------------------------------
-- Experiments / backtests / learning / strategy runs enrichment
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  variant_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'CREATED',
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  data_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  train_start TIMESTAMPTZ,
  train_end TIMESTAMPTZ,
  validate_start TIMESTAMPTZ,
  validate_end TIMESTAMPTZ,
  oos_start TIMESTAMPTZ,
  oos_end TIMESTAMPTZ,
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  deterministic_seed BIGINT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  data_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID REFERENCES daily_reports(id),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_vectors JSONB NOT NULL DEFAULT '[]'::jsonb,
  parameter_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  oos_evaluation JSONB,
  overfitting_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holder_details (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  balance_pct NUMERIC(12, 6),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holder_details_token ON holder_details(token_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS provider_disagreements (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID REFERENCES tokens(id) ON DELETE SET NULL,
  field_name TEXT NOT NULL,
  provider_a TEXT NOT NULL,
  provider_b TEXT NOT NULL,
  value_a JSONB,
  value_b JSONB,
  difference JSONB,
  selected_value JSONB,
  reason TEXT,
  confidence TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_health (
  id BIGSERIAL PRIMARY KEY,
  component TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_health_time ON system_health(observed_at DESC);

CREATE TABLE IF NOT EXISTS alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cooldown_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_log_cooldown ON alert_log(cooldown_key, created_at DESC);

-- Pools table for multi-DEX tracking
CREATE TABLE IF NOT EXISTS pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  dex_venue TEXT,
  quote_token TEXT,
  fee_bps INT,
  created_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (pool_address, data_mode)
);
CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token_id);

-- Simulated fills enrichment already in paper_fills; add audit cols
ALTER TABLE paper_fills
  ADD COLUMN IF NOT EXISTS latency_ms INT,
  ADD COLUMN IF NOT EXISTS quote_id UUID;

-- Idempotency keys for paper orders
ALTER TABLE paper_orders
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_orders_idempotency
  ON paper_orders (portfolio_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
