-- 012: No query filters or sorts tokens by last_polled_at (poll order is chosen in application
-- code), yet every poll rewrites it, so this index only accumulates churn. Dropping an index does
-- not rewrite the table.
DROP INDEX IF EXISTS idx_tokens_last_polled;
