-- 013: Repeated failed sells for the same position + reason are one order row with an attempt
-- count, instead of one row per retry. Fees are summed so cash/cost totals are unchanged.
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 1;
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Keep the row a closed position points at (exit_order_id), otherwise the first attempt.
CREATE TEMP TABLE failed_sell_groups ON COMMIT DROP AS
SELECT o.position_id, o.failure_reason,
       (array_agg(o.id ORDER BY (p.id IS NOT NULL) DESC, o.created_at ASC))[1] AS keep_id,
       COUNT(*)::int AS attempts,
       MAX(o.created_at) AS last_at,
       SUM(o.network_fee_usd) AS network_fee_usd,
       SUM(o.priority_fee_usd) AS priority_fee_usd,
       SUM(o.total_cost_usd) AS total_cost_usd
FROM paper_orders o
LEFT JOIN positions p ON p.exit_order_id = o.id
WHERE o.side = 'SELL' AND o.status = 'FAILED' AND o.position_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM fee_records f WHERE f.order_id = o.id)
GROUP BY o.position_id, o.failure_reason
HAVING COUNT(*) > 1;

UPDATE paper_orders o
SET attempt_count = g.attempts,
    last_attempt_at = g.last_at,
    network_fee_usd = g.network_fee_usd,
    priority_fee_usd = g.priority_fee_usd,
    total_cost_usd = g.total_cost_usd
FROM failed_sell_groups g
WHERE o.id = g.keep_id;

DELETE FROM paper_orders o
USING failed_sell_groups g
WHERE o.side = 'SELL' AND o.status = 'FAILED'
  AND o.position_id = g.position_id
  AND o.failure_reason IS NOT DISTINCT FROM g.failure_reason
  AND o.id <> g.keep_id
  AND NOT EXISTS (SELECT 1 FROM fee_records f WHERE f.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.exit_order_id = o.id OR p.entry_order_id = o.id);

CREATE INDEX IF NOT EXISTS idx_paper_orders_failed_sell
  ON paper_orders (position_id, failure_reason) WHERE side = 'SELL' AND status = 'FAILED';
