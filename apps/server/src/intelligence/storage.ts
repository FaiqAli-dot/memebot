/**
 * Storage monitoring + emergency prune backstop for Railway Free tier.
 * Normal protection is the 3h HF retention job (every 15 minutes).
 */
import { query } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Must match scheduler retention job interval (primary 3h HF prune cadence). */
const CLEANUP_INTERVAL_MS = 15 * 60_000;

const PERMANENT_TABLES = [
  'tokens',
  'token_discovery_events',
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_outcome_summaries',
  'positions',
  'paper_orders',
  'paper_fills',
  'signals',
  'risk_decisions',
  'discovery_source_health',
] as const;

/** ~80 MB/hour live HF raw growth (from original retention.ts). With 3h retention ≈ 240 MB SS. */
export const LIVE_RAW_GROWTH_MB_PER_HOUR = 80;

export function estimateSteadyStateRawMb(): {
  highFrequencyRawMb: number;
  researchRawNote: string;
  totalRoughMb: number;
  basis: string;
} {
  const highFrequencyRawMb = LIVE_RAW_GROWTH_MB_PER_HOUR * env.RAW_DATA_RETENTION_HOURS;
  return {
    highFrequencyRawMb,
    researchRawNote:
      `Research raw (token_raw_feature_observations + compacted checkpoints) at ${env.RESEARCH_DATA_RETENTION_HOURS}h is sparse vs HF ticks — typically low tens of MB, not another 80 MB/h.`,
    totalRoughMb: highFrequencyRawMb + 40,
    basis: `HF raw ≈ ${LIVE_RAW_GROWTH_MB_PER_HOUR} MB/h × ${env.RAW_DATA_RETENTION_HOURS}h retention (latest-row keep adds a small constant). Soft limit ${Math.round(env.STORAGE_SOFT_LIMIT_BYTES / 1e6)} MB is emergency backstop only.`,
  };
}

export async function getStorageMonitor(): Promise<{
  counts: Record<string, number>;
  estimatedDbBytes: number | null;
  oldestRawSnapshotAt: string | null;
  nextCleanupAt: string | null;
  cleanupIntervalMs: number;
  softLimitBytes: number;
  approachingLimit: boolean;
  permanentTables: string[];
  storageGrowthEstimate: ReturnType<typeof estimateSteadyStateRawMb>;
  rawRetentionHours: number;
  researchRetentionHours: number;
  eventRetentionDays: number;
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
      `SELECT MIN(observed_at) AS t FROM market_snapshots`,
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
    nextCleanupAt = new Date((last ?? Date.now()) + CLEANUP_INTERVAL_MS).toISOString();
  } catch {
    nextCleanupAt = new Date(Date.now() + CLEANUP_INTERVAL_MS).toISOString();
  }

  const approachingLimit =
    estimatedDbBytes != null && estimatedDbBytes >= env.STORAGE_SOFT_LIMIT_BYTES * 0.8;

  return {
    counts,
    estimatedDbBytes,
    oldestRawSnapshotAt,
    nextCleanupAt,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    softLimitBytes: env.STORAGE_SOFT_LIMIT_BYTES,
    approachingLimit,
    permanentTables: [...PERMANENT_TABLES],
    storageGrowthEstimate: estimateSteadyStateRawMb(),
    rawRetentionHours: env.RAW_DATA_RETENTION_HOURS,
    researchRetentionHours: env.RESEARCH_DATA_RETENTION_HOURS,
    eventRetentionDays: env.EVENT_RETENTION_DAYS,
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
      JSON.stringify({
        approachingLimit: mon.approachingLimit,
        storageGrowthEstimate: mon.storageGrowthEstimate,
        cleanupIntervalMs: mon.cleanupIntervalMs,
      }),
    ],
  );
}

/**
 * Emergency backstop only. Deletes temporary raw tables, oldest rows first.
 * Never touches permanent research tables.
 */
export async function emergencyRawPrune(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  const batch = 5_000;

  // Order: high-churn HF first (oldest), then research raw, then compacted checkpoints.
  const plans: Array<{ table: string; time: string; extraWhere?: string; keepLatest?: boolean }> = [
    { table: 'trade_events', time: 'observed_at' },
    { table: 'feature_snapshots', time: 'observed_at' },
    { table: 'token_raw_feature_observations', time: 'observed_at' },
    {
      table: 'market_snapshots',
      time: 'observed_at',
      keepLatest: true,
    },
    {
      table: 'liquidity_snapshots',
      time: 'observed_at',
      keepLatest: true,
    },
    {
      table: 'holder_snapshots',
      time: 'observed_at',
      keepLatest: true,
    },
    {
      table: 'safety_assessments',
      time: 'assessed_at',
      keepLatest: true,
    },
    {
      table: 'token_outcome_checkpoints',
      time: 'observed_at',
      extraWhere: `status IN ('COMPACTED','MISSED')`,
    },
  ];

  for (const plan of plans) {
    const keepLatestClause = plan.keepLatest
      ? ` AND EXISTS (SELECT 1 FROM ${plan.table} n WHERE n.token_id = t.token_id AND n.${plan.time} > t.${plan.time})`
      : '';
    const extra = plan.extraWhere ? ` AND ${plan.extraWhere}` : '';
    const res = await query(
      `DELETE FROM ${plan.table} WHERE ctid IN (
         SELECT ctid FROM ${plan.table} t
         WHERE TRUE${extra}${keepLatestClause}
         ORDER BY t.${plan.time} ASC NULLS FIRST
         LIMIT ${batch}
       )`,
    );
    deleted[plan.table] = (deleted[plan.table] ?? 0) + (res.rowCount ?? 0);
  }

  logger.warn({ deleted }, 'Emergency raw prune due to storage pressure (oldest temporary rows first)');
  return deleted;
}
