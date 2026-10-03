import { query } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { emergencyRawPrune, getStorageMonitor } from '../intelligence/storage.js';

const BATCH = 20_000;

/** Retention job cadence — primary Free-tier protection (registered in scheduler). */
export const RETENTION_JOB_INTERVAL_MS = 15 * 60_000;

/**
 * Pre-existing high-frequency raw tables — RAW_DATA_RETENTION_HOURS (default 3h).
 * Latest row per token kept where keepLatestPerToken is true.
 */
export const HIGH_FREQUENCY_RAW_TABLES: Array<{
  table: string;
  time: string;
  keepLatestPerToken: boolean;
}> = [
  { table: 'market_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'liquidity_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'holder_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'safety_assessments', time: 'assessed_at', keepLatestPerToken: true },
  { table: 'feature_snapshots', time: 'observed_at', keepLatestPerToken: false },
  { table: 'trade_events', time: 'observed_at', keepLatestPerToken: false },
];

/**
 * New compact research raw tables — RESEARCH_DATA_RETENTION_HOURS (default 72h).
 * Outcome checkpoints are only pruned after compaction (24h summary written).
 */
export const RESEARCH_RAW_TABLES: Array<{ table: string; time: string }> = [
  { table: 'token_raw_feature_observations', time: 'observed_at' },
];

const EVENT_TABLES: Array<{ table: string; time: string }> = [
  { table: 'bot_events', time: 'created_at' },
  { table: 'missed_opportunities', time: 'observed_at' },
];

/** Tables that retention must never delete from (asserted in tests). */
export const PERMANENT_RETENTION_TABLES = [
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

export type RetentionPolicyRow = {
  table: string;
  retention: string;
  permanent: boolean;
};

/** Documented retention behavior for ops / final report. */
export function retentionPolicyTable(): RetentionPolicyRow[] {
  return [
    ...HIGH_FREQUENCY_RAW_TABLES.map((t) => ({
      table: t.table,
      retention: `${env.RAW_DATA_RETENTION_HOURS}h` + (t.keepLatestPerToken ? ' (keep latest/token)' : ''),
      permanent: false,
    })),
    {
      table: 'token_raw_feature_observations',
      retention: `${env.RESEARCH_DATA_RETENTION_HOURS}h`,
      permanent: false,
    },
    {
      table: 'token_outcome_checkpoints',
      retention: `${env.RESEARCH_DATA_RETENTION_HOURS}h after COMPACTED/MISSED (24h summary first)`,
      permanent: false,
    },
    ...EVENT_TABLES.map((t) => ({
      table: t.table,
      retention: `${env.EVENT_RETENTION_DAYS}d`,
      permanent: false,
    })),
    ...PERMANENT_RETENTION_TABLES.map((table) => ({
      table,
      retention: 'permanent',
      permanent: true,
    })),
  ];
}

async function deleteBatched(table: string, where: string, cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} t WHERE ${where} LIMIT ${BATCH})`,
      [cutoff],
    );
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < BATCH) return total;
  }
}

/**
 * Prunes temporary data only. Idempotent and safe to repeat.
 * - HF raw → RAW_DATA_RETENTION_HOURS (default 3h)
 * - Research raw / compacted checkpoints → RESEARCH_DATA_RETENTION_HOURS (default 72h)
 * - Logs → EVENT_RETENTION_DAYS (default 3d)
 * Permanent research records are never touched.
 */
export async function pruneOldData(now = new Date()): Promise<Record<string, number>> {
  const rawCutoff = new Date(now.getTime() - env.RAW_DATA_RETENTION_HOURS * 3_600_000);
  const researchCutoff = new Date(now.getTime() - env.RESEARCH_DATA_RETENTION_HOURS * 3_600_000);
  const eventCutoff = new Date(now.getTime() - env.EVENT_RETENTION_DAYS * 86_400_000);

  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO retention_runs (started_at, raw_cutoff, status)
     VALUES ($1, $2, 'RUNNING') RETURNING id`,
    [now, rawCutoff],
  );
  const runId = runRows[0]?.id;

  const deleted: Record<string, number> = {};

  for (const { table, time, keepLatestPerToken } of HIGH_FREQUENCY_RAW_TABLES) {
    const where = keepLatestPerToken
      ? `t.${time} < $1 AND EXISTS (SELECT 1 FROM ${table} n WHERE n.token_id = t.token_id AND n.${time} > t.${time})`
      : `t.${time} < $1`;
    deleted[table] = await deleteBatched(table, where, rawCutoff);
  }

  for (const { table, time } of RESEARCH_RAW_TABLES) {
    deleted[table] = await deleteBatched(table, `t.${time} < $1`, researchCutoff);
  }

  // Checkpoints only after 24h compaction (or MISSED). Never delete PENDING/CAPTURED
  // waiting for the 24h summary — those become COMPACTED once summarized.
  deleted.token_outcome_checkpoints = await deleteBatched(
    'token_outcome_checkpoints',
    `t.status IN ('COMPACTED','MISSED')
     AND COALESCE(t.observed_at, t.due_at) < $1
     AND (
       t.status = 'MISSED'
       OR EXISTS (
         SELECT 1 FROM token_outcome_summaries s
         WHERE s.token_id = t.token_id
           AND (s.decision_id = t.decision_id OR (s.decision_id IS NULL AND t.decision_id IS NULL))
       )
     )`,
    researchCutoff,
  );

  for (const { table, time } of EVENT_TABLES) {
    deleted[table] = await deleteBatched(table, `t.${time} < $1`, eventCutoff);
  }

  try {
    const mon = await getStorageMonitor();
    if (mon.approachingLimit) {
      Object.assign(deleted, await emergencyRawPrune());
    }
  } catch (err) {
    logger.warn({ err }, 'Storage monitor during retention failed');
  }

  if (runId) {
    await query(
      `UPDATE retention_runs SET finished_at = NOW(), deleted = $2, status = 'DONE' WHERE id = $1`,
      [runId, JSON.stringify(deleted)],
    );
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info({ deleted }, 'Pruned old raw data');
  return deleted;
}
