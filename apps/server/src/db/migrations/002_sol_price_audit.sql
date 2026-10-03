-- Audit SOL/USD used for fee conversion on each fee/order record
ALTER TABLE fee_records
  ADD COLUMN IF NOT EXISTS sol_price_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS sol_price_source TEXT;

ALTER TABLE paper_orders
  ADD COLUMN IF NOT EXISTS sol_price_usd NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS sol_price_source TEXT;

CREATE INDEX IF NOT EXISTS idx_fee_records_sol_price ON fee_records(sol_price_usd)
  WHERE sol_price_usd IS NOT NULL;
