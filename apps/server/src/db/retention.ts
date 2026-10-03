import { query } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const BATCH = 20_000;

/**
 * Raw tables grow ~80 MB/hour in live mode. Nothing reads them further back than the
 * 30-minute research horizons and 1-hour flow windows, except "latest row per token"
 * lookups — so those keep each token's newest row regardless of age.
 */
const RAW_TABLES: Array<{ table: string; time: string; keepLatestPerToken: boolean }> = [
  { table: 'market_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'liquidity_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'holder_snapshots', time: 'observed_at', keepLatestPerToken: true },
  { table: 'safety_assessments', time: 'assessed_at', keepLatestPerToken: true },
  { table: 'feature_snapshots', time: 'observed_at', keepLatestPerToken: false },
  { table: 'trade_events', time: 'observed_at', keepLatestPerToken: false },
];

const EVENT_TABLES: Array<{ table: string; time: string }> = [
  { table: 'bot_events', time: 'created_at' },
  { table: 'missed_opportunities', time: 'observed_at' },
];

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

/** Prunes old raw market data and logs. Trades, positions, signals and learning data are never touched. */
export async function pruneOldData(now = new Date()): Promise<Record<string, number>> {
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

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info({ deleted }, 'Pruned old raw data');
  return deleted;
}
