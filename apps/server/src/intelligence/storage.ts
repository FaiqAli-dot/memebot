/**
 * Storage monitoring + retention helpers for Railway Free tier.
 * Raw/temporary data may be deleted; permanent research records must never be.
 */
import { query } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const PERMANENT_TABLES = [
  'tokens',
  'token_discovery_events',
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_outcome_summaries',
  'positions',
  'paper_orders',
  'signals',
  'risk_decisions',
  'discovery_source_health',
] as const;

export async function getStorageMonitor(): Promise<{
  counts: Record<string, number>;
  estimatedDbBytes: number | null;
  oldestRawSnapshotAt: string | null;
  nextCleanupAt: string | null;
  softLimitBytes: number;
  approachingLimit: boolean;
  permanentTables: string[];
}> {
  const countTables = [
    'tokens',
    'token_discovery_events',
    'token_decision_audits',
    'token_decision_feature_snapshots',
    'token_outcome_checkpoints',
    'token_outcome_summaries',
    'market_snapshots',
    'liquidity_snapshots',
    'holder_snapshots',
    'feature_snapshots',
    'token_raw_feature_observations',
    'trade_events',
    'positions',
    'signals',
  ];

  const counts: Record<string, number> = {};
  for (const table of countTables) {
    try {
      const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${table}`);
      counts[table] = Number(rows[0]?.c ?? 0);
    } catch {
      counts[table] = -1;
    }
  }

  // Tracked = non-archived lifecycle
  try {
    const { rows } = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tokens
       WHERE data_mode = $1 AND lifecycle_state IN ('DISCOVERED','TRACKING','ELIGIBLE','ACTIVE','STALE')`,
      [env.DATA_MODE],
    );
    counts.active_tracked_tokens = Number(rows[0]?.c ?? 0);
  } catch {
    counts.active_tracked_tokens = -1;
  }

  let estimatedDbBytes: number | null = null;
  try {
    const { rows } = await query<{ bytes: string }>(
      `SELECT pg_database_size(current_database())::text AS bytes`,
    );
    estimatedDbBytes = Number(rows[0]?.bytes ?? 0);
  } catch {
    estimatedDbBytes = null;
  }

  let oldestRawSnapshotAt: string | null = null;
  try {
    const { rows } = await query<{ t: Date | null }>(
      `SELECT MIN(observed_at) AS t FROM (
         SELECT observed_at FROM market_snapshots
         UNION ALL
         SELECT observed_at FROM token_raw_feature_observations
       ) x`,
    );
    oldestRawSnapshotAt = rows[0]?.t?.toISOString() ?? null;
  } catch {
    oldestRawSnapshotAt = null;
  }

  let nextCleanupAt: string | null = null;
  try {
    const { rows } = await query<{ finished_at: Date | null }>(
      `SELECT finished_at FROM retention_runs WHERE status = 'DONE' ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    );
    const last = rows[0]?.finished_at?.getTime();
    nextCleanupAt = new Date((last ?? Date.now()) + 15 * 60_000).toISOString();
  } catch {
    nextCleanupAt = new Date(Date.now() + 15 * 60_000).toISOString();
  }

  const approachingLimit =
    estimatedDbBytes != null && estimatedDbBytes >= env.STORAGE_SOFT_LIMIT_BYTES * 0.8;

  return {
    counts,
    estimatedDbBytes,
    oldestRawSnapshotAt,
    nextCleanupAt,
    softLimitBytes: env.STORAGE_SOFT_LIMIT_BYTES,
    approachingLimit,
    permanentTables: [...PERMANENT_TABLES],
  };
}

export async function snapshotStorageMonitor(): Promise<void> {
  const mon = await getStorageMonitor();
  await query(
    `INSERT INTO storage_monitor_snapshots (
       counts, estimated_db_bytes, oldest_raw_snapshot_at, next_cleanup_at, details
     ) VALUES ($1,$2,$3,$4,$5)`,
    [
      JSON.stringify(mon.counts),
      mon.estimatedDbBytes,
      mon.oldestRawSnapshotAt,
      mon.nextCleanupAt,
      JSON.stringify({ approachingLimit: mon.approachingLimit }),
    ],
  );
}

/** Extra-aggressive raw prune when approaching soft limit. Never touches permanent tables. */
export async function emergencyRawPrune(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  const cutoff = new Date(Date.now() - 6 * 3_600_000); // keep only 6h when under pressure
  for (const table of [
    'token_raw_feature_observations',
    'feature_snapshots',
    'trade_events',
  ] as const) {
    const res = await query(
      `DELETE FROM ${table} WHERE observed_at < $1`,
      [cutoff],
    );
    deleted[table] = res.rowCount ?? 0;
  }
  logger.warn({ deleted }, 'Emergency raw prune due to storage pressure');
  return deleted;
}
