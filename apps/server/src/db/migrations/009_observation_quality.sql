-- Week-1: explicit observation quality. Derived (generated) from data already stored, so
-- immutable observations are never updated and the classification is reproducible.
-- Mirrors learning/observations.ts::observationQuality.
ALTER TABLE trade_observations
  ADD COLUMN IF NOT EXISTS observation_quality TEXT GENERATED ALWAYS AS (
    CASE
      WHEN snapshot_source <> 'ENTRY_SNAPSHOT' THEN 'SIGNAL_BACKFILL'
      WHEN entry_features->>'observedAt' IS NOT NULL
       AND entry_features->>'quoteAgeMs' IS NOT NULL
       AND entry_features->>'liquidityUsd' IS NOT NULL
       AND entry_features->>'priceChange5mPct' IS NOT NULL
       AND entry_features->>'volume5mUsd' IS NOT NULL
        THEN 'TRUE_ENTRY_SNAPSHOT'
      ELSE 'PARTIAL_ENTRY_SNAPSHOT'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_trade_observations_quality
  ON trade_observations (data_mode, portfolio_type, observation_quality, seq);
