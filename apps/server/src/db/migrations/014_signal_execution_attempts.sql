-- 014: One row per (portfolio, signal) describing every execution attempt of a BUY signal:
-- the execution-time strategy revalidation, the risk result and the final outcome.
-- Repeated execution ticks update the row (attempts + 1) instead of inserting.
-- Signal-time features stay on signals.market_state; this row holds the execution-time view.
CREATE TABLE IF NOT EXISTS signal_execution_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  signal_id UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  token_address TEXT,
  strategy_id TEXT,
  lane TEXT NOT NULL,
  signal_created_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 1,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_age_ms BIGINT,
  market_observed_at TIMESTAMPTZ,
  revalidation_result TEXT,
  revalidation_reason TEXT,
  revalidation_reasons JSONB,
  revalidation_confidence NUMERIC,
  revalidated_at TIMESTAMPTZ,
  revalidation_features JSONB,
  strategy_pass_count INT NOT NULL DEFAULT 0,
  strategy_fail_count INT NOT NULL DEFAULT 0,
  risk_decision_id UUID REFERENCES risk_decisions(id) ON DELETE SET NULL,
  risk_result TEXT,
  risk_reason TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  order_id UUID REFERENCES paper_orders(id) ON DELETE SET NULL,
  position_id UUID REFERENCES positions(id) ON DELETE SET NULL,
  data_mode TEXT NOT NULL,
  UNIQUE (portfolio_id, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_execution_attempts_token
  ON signal_execution_attempts (token_id, last_attempt_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_execution_attempts_status
  ON signal_execution_attempts (status, last_attempt_at DESC);
