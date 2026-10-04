import type { ArchiveHealth, ArchiveStatus, StorageState } from '@memebot/shared';
import { query } from '../db/client.js';
import { env } from '../config/env.js';
import { stateRank } from '../db/storage-guard.js';
import { isHeartbeatStale } from './research-archive.js';

interface RunRow {
  mode: string;
  status: string;
  started_at: Date;
  heartbeat_at: Date;
  finished_at: Date | null;
  error: string | null;
  verification: string;
  rows_exported: string;
  rows_deleted: string;
  archive_db_bytes: string | null;
  last_archived_at: Date | null;
  tables: Record<string, { exported?: number; deleted?: number }>;
}

export function archiveHealth(latest: Pick<RunRow, 'status' | 'heartbeat_at'> | undefined, now = new Date()): ArchiveHealth {
  if (!latest) return 'ARCHIVE_NEVER_CONFIGURED';
  if (latest.status === 'RUNNING') return isHeartbeatStale(latest.heartbeat_at, now) ? 'ARCHIVE_FAILED' : 'ARCHIVE_RUNNING';
  return latest.status === 'SUCCEEDED' ? 'ARCHIVE_HEALTHY' : 'ARCHIVE_FAILED';
}

export async function getArchiveStatus(state: StorageState): Promise<ArchiveStatus> {
  let runs: RunRow[] = [];
  try {
    runs = (
      await query<RunRow>(
        `SELECT mode, status, started_at, heartbeat_at, finished_at, error, verification, rows_exported::text,
                rows_deleted::text, archive_db_bytes::text, last_archived_at, tables
         FROM archive_runs ORDER BY started_at DESC LIMIT 200`,
      )
    ).rows;
  } catch {
    runs = [];
  }
  const latest = runs[0];
  const health = archiveHealth(latest);
  const success = runs.find((r) => r.status === 'SUCCEEDED' && (r.mode === 'archive' || r.mode === 'prune'));
  const lastArchive = runs.find((r) => r.status === 'SUCCEEDED' && r.mode === 'archive');
  const verification = runs.find((r) => r.verification !== 'NOT_RUN');
  const failed = runs.find((r) => r.error);
  const okRuns = runs.filter((r) => r.status === 'SUCCEEDED');
  const recommended = stateRank(state) >= stateRank('WARNING');
  const stale = !success || Date.now() - (success.finished_at ?? success.started_at).getTime() > env.ARCHIVE_STALE_AFTER_HOURS * 3_600_000;
  return {
    health,
    lastRun: latest
      ? {
          mode: latest.mode,
          status: health === 'ARCHIVE_FAILED' && latest.status === 'RUNNING' ? 'INTERRUPTED' : latest.status,
          startedAt: latest.started_at.toISOString(),
          finishedAt: latest.finished_at?.toISOString() ?? null,
          error: latest.error,
        }
      : null,
    lastSuccessAt: success ? (success.finished_at ?? success.started_at).toISOString() : null,
    lastArchivedAt: lastArchive?.last_archived_at?.toISOString() ?? null,
    rowsArchived: okRuns.filter((r) => r.mode === 'archive').reduce((a, r) => a + Number(r.rows_exported), 0),
    // Committed batches count even when a later batch failed.
    rowsDeleted: runs.reduce((a, r) => a + Number(r.rows_deleted), 0),
    tablesArchived: lastArchive
      ? Object.entries(lastArchive.tables ?? {})
          .filter(([, t]) => (t.exported ?? 0) > 0)
          .map(([k]) => k)
          .sort()
      : [],
    archiveBytes: runs.find((r) => r.archive_db_bytes != null)?.archive_db_bytes != null
      ? Number(runs.find((r) => r.archive_db_bytes != null)!.archive_db_bytes)
      : null,
    lastVerification: verification
      ? { result: verification.verification, at: (verification.finished_at ?? verification.started_at).toISOString() }
      : null,
    lastError: failed?.error ?? null,
    stale,
    archivalRecommended: recommended,
    nextEligibleRun: recommended
      ? `now (storage ${state}; run npm run archive:research)`
      : 'when storage reaches WARNING',
  };
}
