-- Research archive runs (written by the local `archive:research` CLI, read by the dashboard).
CREATE TABLE IF NOT EXISTS archive_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  storage_state TEXT,
  railway_db_bytes_before BIGINT,
  railway_db_bytes_after BIGINT,
  railway_used_bytes_before BIGINT,
  railway_used_bytes_after BIGINT,
  archive_db_bytes BIGINT,
  rows_selected BIGINT NOT NULL DEFAULT 0,
  rows_exported BIGINT NOT NULL DEFAULT 0,
  rows_verified BIGINT NOT NULL DEFAULT 0,
  rows_deleted BIGINT NOT NULL DEFAULT 0,
  estimated_reclaim_bytes BIGINT NOT NULL DEFAULT 0,
  verification TEXT NOT NULL DEFAULT 'NOT_RUN',
  last_archived_at TIMESTAMPTZ,
  tables JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_archive_runs_started ON archive_runs (started_at DESC);
