-- 005: Reality-first funnel fix
-- Token lifecycle + tracking, liquidity status, research portfolio, idempotent
-- realistic shadow trades, opportunity recorder, funnel diagnostics.
-- Additive only: no existing data is deleted.

-- ---------------------------------------------------------------------------
-- Token lifecycle / tracking
-- ---------------------------------------------------------------------------
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'DISCOVERED',
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pool_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS age_source TEXT,
  ADD COLUMN IF NOT EXISTS liquidity_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS trading_eligibility TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS eligibility_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS activity_score NUMERIC(12, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_market_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS missing_quote_count INT NOT NULL DEFAULT 0;

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_lifecycle_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_lifecycle_state_check
  CHECK (lifecycle_state IN ('DISCOVERED','TRACKING','ELIGIBLE','ACTIVE','STALE','ARCHIVED'));
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_liquidity_status_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_liquidity_status_check
  CHECK (liquidity_status IN ('KNOWN','UNKNOWN','BONDING_CURVE'));
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_trading_eligibility_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_trading_eligibility_check
  CHECK (trading_eligibility IN ('TRADING_ELIGIBLE','RESEARCH_ONLY','UNKNOWN'));

-- GeckoTerminal pool_created_at was stored in created_at_onchain
UPDATE tokens SET pool_created_at = created_at_onchain
  WHERE pool_created_at IS NULL AND created_at_onchain IS NOT NULL;
UPDATE tokens SET age_source = CASE
    WHEN pool_created_at IS NOT NULL THEN 'POOL_CREATED_AT'
    ELSE 'FIRST_OBSERVED_AT'
  END
  WHERE age_source IS NULL;
UPDATE tokens t SET last_market_at = m.last
  FROM (SELECT token_id, MAX(observed_at) AS last FROM market_snapshots GROUP BY token_id) m
  WHERE m.token_id = t.id AND t.last_market_at IS NULL;
UPDATE tokens SET lifecycle_state = 'TRACKING' WHERE last_market_at IS NOT NULL AND lifecycle_state = 'DISCOVERED';

CREATE INDEX IF NOT EXISTS idx_tokens_lifecycle ON tokens(data_mode, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_tokens_activity ON tokens(data_mode, activity_score DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_last_polled ON tokens(data_mode, last_polled_at NULLS FIRST);

-- ---------------------------------------------------------------------------
-- Market snapshots: transaction counts + liquidity status
-- ---------------------------------------------------------------------------
ALTER TABLE market_snapshots
  ADD COLUMN IF NOT EXISTS buys_5m INT,
  ADD COLUMN IF NOT EXISTS sells_5m INT,
  ADD COLUMN IF NOT EXISTS buys_1h INT,
  ADD COLUMN IF NOT EXISTS sells_1h INT,
  ADD COLUMN IF NOT EXISTS buys_24h INT,
  ADD COLUMN IF NOT EXISTS sells_24h INT,
  ADD COLUMN IF NOT EXISTS liquidity_status TEXT,
  ADD COLUMN IF NOT EXISTS venue TEXT,
  ADD COLUMN IF NOT EXISTS pool_address TEXT;

-- ---------------------------------------------------------------------------
-- Production vs research portfolios
-- ---------------------------------------------------------------------------
ALTER TABLE user_portfolios
  ADD COLUMN IF NOT EXISTS portfolio_type TEXT NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE user_portfolios DROP CONSTRAINT IF EXISTS user_portfolios_type_check;
ALTER TABLE user_portfolios ADD CONSTRAINT user_portfolios_type_check
  CHECK (portfolio_type IN ('PRODUCTION','RESEARCH'));

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS lane TEXT NOT NULL DEFAULT 'PRODUCTION',
  ADD COLUMN IF NOT EXISTS position_size_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS data_confidence TEXT;
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_lane_check;
ALTER TABLE signals ADD CONSTRAINT signals_lane_check CHECK (lane IN ('PRODUCTION','RESEARCH'));
CREATE INDEX IF NOT EXISTS idx_signals_lane_time ON signals(lane, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shadow trades: idempotent identity + realistic simulation
-- ---------------------------------------------------------------------------
ALTER TABLE shadow_trades
  ADD COLUMN IF NOT EXISTS strategy_key TEXT,
  ADD COLUMN IF NOT EXISTS opportunity_key TEXT,
  ADD COLUMN IF NOT EXISTS position_size_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(38, 12),
  ADD COLUMN IF NOT EXISTS entry_exec_price_usd NUMERIC(30, 12),
  ADD COLUMN IF NOT EXISTS cost_basis_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS entry_costs JSONB,
  ADD COLUMN IF NOT EXISTS exit_costs JSONB,
  ADD COLUMN IF NOT EXISTS stop_loss_pct NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS take_profit_pct NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS trailing_stop_pct NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS max_hold_sec INT,
  ADD COLUMN IF NOT EXISTS highest_price_usd NUMERIC(30, 12),
  ADD COLUMN IF NOT EXISTS exit_reason TEXT,
  ADD COLUMN IF NOT EXISTS gross_return_pct NUMERIC(16, 8),
  ADD COLUMN IF NOT EXISTS net_pnl_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS net_return_pct NUMERIC(16, 8),
  ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_mode TEXT,
  ADD COLUMN IF NOT EXISTS latency_ms INT,
  ADD COLUMN IF NOT EXISTS sim_version TEXT;

UPDATE shadow_trades SET strategy_key = COALESCE(strategy_id, '-') WHERE strategy_key IS NULL;

-- Legacy duplicates: keep the earliest OPEN row per token/strategy, supersede the rest
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY portfolio_id, token_id, strategy_key ORDER BY opened_at ASC, id
  ) AS rn
  FROM shadow_trades WHERE status = 'OPEN'
)
UPDATE shadow_trades s SET status = 'SUPERSEDED', closed_at = NOW()
  FROM ranked r WHERE r.id = s.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_open_identity
  ON shadow_trades (portfolio_id, token_id, strategy_key) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_shadow_identity_time
  ON shadow_trades (portfolio_id, token_id, strategy_key, opened_at DESC);

-- ---------------------------------------------------------------------------
-- Opportunity recorder (immutable snapshot) + forward outcomes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT,
  decision TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  price_usd NUMERIC(30, 12) NOT NULL,
  liquidity_usd NUMERIC(30, 8),
  liquidity_status TEXT NOT NULL,
  volume_5m_usd NUMERIC(30, 8),
  volume_1h_usd NUMERIC(30, 8),
  buys_5m INT,
  sells_5m INT,
  tx_count_5m INT,
  unique_buyers INT,
  unique_sellers INT,
  market_regime TEXT,
  token_age_min NUMERIC(12, 3),
  age_source TEXT,
  since_first_observed_sec INT,
  data_confidence TEXT,
  buy_sell_confidence TEXT,
  volume_accel_raw NUMERIC(20, 6),
  volume_accel_capped NUMERIC(12, 6),
  volume_accel_confidence TEXT,
  expected_value JSONB,
  ev_net NUMERIC(16, 8),
  ev_threshold NUMERIC(16, 8),
  execution_cost_rate NUMERIC(16, 8),
  execution_cost_usd NUMERIC(20, 8),
  position_size_usd NUMERIC(20, 8),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  sim_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_time ON opportunities(data_mode, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_identity ON opportunities(token_id, strategy_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_trackers (
  opportunity_id UUID PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  last_processed_at TIMESTAMPTZ,
  sim_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  sim_result JSONB,
  mfe_pct NUMERIC(16, 8),
  mae_pct NUMERIC(16, 8),
  time_to_mfe_sec INT,
  time_to_mae_sec INT,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_opp_trackers_pending ON opportunity_trackers(status) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS opportunity_outcomes (
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  horizon_sec INT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  lag_sec NUMERIC(10, 3) NOT NULL,
  price_usd NUMERIC(30, 12) NOT NULL,
  return_pct NUMERIC(16, 8) NOT NULL,
  liquidity_usd NUMERIC(30, 8),
  volume_5m_usd NUMERIC(30, 8),
  mfe_pct NUMERIC(16, 8) NOT NULL,
  mae_pct NUMERIC(16, 8) NOT NULL,
  time_to_mfe_sec INT,
  time_to_mae_sec INT,
  PRIMARY KEY (opportunity_id, horizon_sec)
);

-- ---------------------------------------------------------------------------
-- Funnel diagnostics (one row per signal / execution tick)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  counts JSONB NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_snapshots_time ON funnel_snapshots(data_mode, kind, observed_at DESC);
