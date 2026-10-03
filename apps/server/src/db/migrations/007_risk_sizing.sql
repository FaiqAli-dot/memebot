-- Risk gate / position sizing audit trail. Additive only — existing paper data untouched.

CREATE TABLE IF NOT EXISTS risk_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES signals(id) ON DELETE SET NULL,
  token_id UUID REFERENCES tokens(id) ON DELETE CASCADE,
  strategy_id TEXT,
  lane TEXT NOT NULL,
  decision TEXT NOT NULL,              -- SIZED | RESIZED | REJECTED
  rejection_reason TEXT,
  detail TEXT,
  risk_tier TEXT,
  risk_score NUMERIC(10, 4),
  base_size_usd NUMERIC(20, 8),
  requested_size_usd NUMERIC(20, 8),
  final_size_usd NUMERIC(20, 8),
  max_viable_size_usd NUMERIC(20, 8),
  position_size_multiplier NUMERIC(10, 4),
  binding_constraint TEXT,
  maximum_planned_loss_usd NUMERIC(20, 8),
  max_risk_per_trade_usd NUMERIC(20, 8),
  stop_loss_pct NUMERIC(10, 6),
  stop_loss_usd NUMERIC(20, 8),
  execution_cost_rate NUMERIC(12, 6),
  execution_cost_usd NUMERIC(20, 8),
  execution_cost_estimate JSONB,
  portfolio_exposure_before_usd NUMERIC(20, 8),
  portfolio_exposure_after_usd NUMERIC(20, 8),
  expected_net_value NUMERIC(12, 6),
  ev_threshold NUMERIC(12, 6),
  data_confidence TEXT,
  multipliers JSONB NOT NULL DEFAULT '{}'::jsonb,
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Outcome of the execution attempt after a SIZED/RESIZED decision
  execution_status TEXT,               -- EXECUTED | EV_FAILED_AT_FINAL_SIZE | EXECUTION_FAILED | LIMIT_BLOCKED
  execution_reason TEXT,
  position_id UUID REFERENCES positions(id) ON DELETE SET NULL,
  attempts INT NOT NULL DEFAULT 1,
  first_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sizing_version TEXT,
  data_mode TEXT NOT NULL
);

-- One row per (portfolio, signal); re-evaluations of a live signal update it
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_decisions_signal
  ON risk_decisions (portfolio_id, signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_risk_decisions_evaluated ON risk_decisions (evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_portfolio ON risk_decisions (portfolio_id, evaluated_at DESC);

-- Planned vs realized: what the position was sized for at entry
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS risk_decision_id UUID REFERENCES risk_decisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS strategy_key TEXT,
  ADD COLUMN IF NOT EXISTS risk_tier TEXT,
  ADD COLUMN IF NOT EXISTS requested_size_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS max_planned_loss_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS expected_net_value NUMERIC(12, 6);

-- Backfill strategy for existing open positions so strategy exposure is complete
UPDATE positions p SET strategy_key = s.strategy_name
FROM signals s
WHERE p.entry_signal_id = s.id AND p.strategy_key IS NULL;
