import { query } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { emergencyRawPrune, getStorageMonitor } from '../intelligence/storage.js';

const BATCH = 20_000;

/**
 * Temporary / high-churn tables only.
 * NEVER listed here: tokens, discovery events, decision audits, decision feature
 * snapshots, outcome summaries, positions, trades, signals, learning data.
 */
const RAW_TABLES: Array<{ table: string; time: string; keepLatestPerToken: boolean }> = [
  { table: 'market_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'liquidity_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'holder_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'safety_assessments', time: 'assessed_at', keepLatestPerToken: true },
  { table: 'feature_snapshots', time: 'observed_at', keepLatestPerToken: false },
  { table: 'trade_events', time: 'observed_at', keepLatestPerToken: false },
  { table: 'token_raw_feature_observations', time: 'observed_at', keepLatestPerToken: false },
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
 * Prunes old raw market data and logs. Idempotent and safe to repeat.
 * Permanent research records (identity, discovery history, decisions, reasons,
 * trades, summarized outcomes) are never touched.
 */
export async function pruneOldData(now = new Date()): Promise<Record<string, number>> {
  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO retention_runs (started_at, raw_cutoff, status)
     VALUES ($1, $2, 'RUNNING') RETURNING id`,
    [now, new Date(now.getTime() - env.RAW_DATA_RETENTION_HOURS * 3_600_000)],
  );
  const runId = runRows[0]?.id;

  const rawCutoff = new Date(now.getTime() - env.RAW_DATA_RETENTION_HOURS * 3_600_000);
  const eventCutoff = new Date(now.getTime() - env.EVENT_RETENTION_DAYS * 86_400_000);
  const deleted: Record<string, number> = {};

  for (const { table, time, keepLatestPerToken } of RAW_TABLES) {
    const where = keepLatestPerToken
      ? `t.${time} < $1 AND EXISTS (SELECT 1 FROM ${table} n WHERE n.token_id = t.token_id AND n.${time} > t.${time})`
      : `t.${time} < $1`;
    deleted[table] = await deleteBatched(table, where, rawCutoff);
  }
  for (const { table, time } of EVENT_TABLES) {
    deleted[table] = await deleteBatched(table, `t.${time} < $1`, eventCutoff);
  }

  // Compacted outcome checkpoint rows can be dropped after summary exists (temporary)
  deleted.token_outcome_checkpoints_compacted = await deleteBatched(
    'token_outcome_checkpoints',
    `t.status = 'COMPACTED' AND t.observed_at < $1`,
    rawCutoff,
  );

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
