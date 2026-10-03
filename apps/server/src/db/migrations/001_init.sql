-- MemeBot schema v1
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'Demo Portfolio',
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  starting_balance_usd NUMERIC(20, 8) NOT NULL DEFAULT 100,
  cash_usd NUMERIC(20, 8) NOT NULL DEFAULT 100,
  peak_equity_usd NUMERIC(20, 8) NOT NULL DEFAULT 100,
  max_drawdown_pct NUMERIC(12, 8) NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_fees_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_network_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_slippage_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_price_impact_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  bot_status TEXT NOT NULL DEFAULT 'PAUSED' CHECK (bot_status IN ('RUNNING', 'PAUSED', 'STOPPED')),
  risk_state TEXT NOT NULL DEFAULT 'OK',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolios_data_mode ON user_portfolios(data_mode);
CREATE INDEX IF NOT EXISTS idx_portfolios_user ON user_portfolios(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INT NOT NULL DEFAULT 9,
  created_at_onchain TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  watchlisted BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (chain, address, data_mode)
);

CREATE INDEX IF NOT EXISTS idx_tokens_address ON tokens(address);
CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);
CREATE INDEX IF NOT EXISTS idx_tokens_discovered ON tokens(discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_data_mode ON tokens(data_mode);

CREATE TABLE IF NOT EXISTS token_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_token_snapshots_token_time ON token_snapshots(token_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  price_usd NUMERIC(30, 12) NOT NULL,
  market_cap_usd NUMERIC(30, 8),
  volume_5m_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  volume_1h_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  volume_24h_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  buy_volume_5m_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  sell_volume_5m_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  tx_count_5m INT NOT NULL DEFAULT 0,
  price_change_5m_pct NUMERIC(16, 8) NOT NULL DEFAULT 0,
  price_change_1h_pct NUMERIC(16, 8) NOT NULL DEFAULT 0,
  liquidity_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL,
  stale BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_token_time ON market_snapshots(token_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_time ON market_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_mode ON market_snapshots(data_mode);

CREATE TABLE IF NOT EXISTS liquidity_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  pool_address TEXT,
  venue TEXT,
  liquidity_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  base_reserve NUMERIC(40, 12),
  quote_reserve NUMERIC(40, 12),
  fee_bps INT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liquidity_snapshots_token_time ON liquidity_snapshots(token_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  holder_count INT,
  top_holder_pct NUMERIC(10, 4),
  top10_holder_pct NUMERIC(10, 4),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holder_snapshots_token_time ON holder_snapshots(token_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  strategy_id UUID REFERENCES strategies(id),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  momentum_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  liquidity_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  volume_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  holder_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  risk_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  overall_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  risk_label TEXT NOT NULL,
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_token_time ON signals(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_mode ON signals(data_mode);

CREATE TABLE IF NOT EXISTS paper_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id),
  signal_id UUID REFERENCES signals(id),
  position_id UUID,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PARTIAL', 'FILLED', 'FAILED', 'CANCELLED')),
  requested_price_usd NUMERIC(30, 12) NOT NULL,
  executed_price_usd NUMERIC(30, 12),
  requested_amount_usd NUMERIC(20, 8) NOT NULL,
  filled_amount_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  token_quantity NUMERIC(40, 18) NOT NULL DEFAULT 0,
  dex_fee_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  network_fee_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  priority_fee_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  slippage_pct NUMERIC(16, 8) NOT NULL DEFAULT 0,
  slippage_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  price_impact_pct NUMERIC(16, 8) NOT NULL DEFAULT 0,
  price_impact_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  execution_record JSONB NOT NULL,
  failure_reason TEXT,
  data_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paper_orders_portfolio ON paper_orders(portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_token ON paper_orders(token_id);

CREATE TABLE IF NOT EXISTS paper_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES paper_orders(id) ON DELETE CASCADE,
  price_usd NUMERIC(30, 12) NOT NULL,
  amount_usd NUMERIC(20, 8) NOT NULL,
  token_quantity NUMERIC(40, 18) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paper_fills_order ON paper_fills(order_id);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id),
  entry_signal_id UUID REFERENCES signals(id),
  exit_signal_id UUID REFERENCES signals(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  quantity NUMERIC(40, 18) NOT NULL,
  entry_price_usd NUMERIC(30, 12) NOT NULL,
  current_price_usd NUMERIC(30, 12) NOT NULL,
  cost_basis_usd NUMERIC(20, 8) NOT NULL,
  current_value_usd NUMERIC(20, 8) NOT NULL,
  unrealized_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  gross_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  net_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  stop_loss_pct NUMERIC(12, 8) NOT NULL,
  take_profit_pct NUMERIC(12, 8) NOT NULL,
  trailing_stop_pct NUMERIC(12, 8),
  highest_price_usd NUMERIC(30, 12) NOT NULL,
  entry_costs JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_costs JSONB,
  entry_order_id UUID REFERENCES paper_orders(id),
  exit_order_id UUID REFERENCES paper_orders(id),
  close_reason TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_portfolio_status ON positions(portfolio_id, status);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);
CREATE INDEX IF NOT EXISTS idx_positions_opened ON positions(opened_at DESC);

ALTER TABLE paper_orders
  DROP CONSTRAINT IF EXISTS paper_orders_position_fk;
DO $$ BEGIN
  ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_position_fk
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS fee_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  order_id UUID REFERENCES paper_orders(id),
  fee_type TEXT NOT NULL,
  amount_usd NUMERIC(20, 8) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_records_portfolio ON fee_records(portfolio_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  equity_usd NUMERIC(20, 8) NOT NULL,
  cash_usd NUMERIC(20, 8) NOT NULL,
  invested_value_usd NUMERIC(20, 8) NOT NULL,
  unrealized_pnl_usd NUMERIC(20, 8) NOT NULL,
  realized_pnl_usd NUMERIC(20, 8) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_time ON portfolio_snapshots(portfolio_id, observed_at ASC);

CREATE TABLE IF NOT EXISTS bot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID REFERENCES user_portfolios(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_events_time ON bot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_portfolio ON bot_events(portfolio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_message ON bot_events USING gin (to_tsvector('english', message));

CREATE TABLE IF NOT EXISTS strategy_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID REFERENCES strategies(id),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  portfolio_id UUID REFERENCES user_portfolios(id),
  tokens_evaluated INT NOT NULL DEFAULT 0,
  signals_generated INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  data_mode TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
