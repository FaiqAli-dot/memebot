-- Daily learning reports: nightly trade review + guarded settings adjustments
CREATE TABLE IF NOT EXISTS daily_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  important_trades JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings_before JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings_after JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (portfolio_id, report_date, data_mode)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_portfolio_date
  ON daily_reports(portfolio_id, report_date DESC);
