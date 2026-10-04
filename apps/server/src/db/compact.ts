/**
 * Returns space freed by DELETE back to the volume. Plain VACUUM only makes freed space reusable
 * inside the table file; VACUUM FULL rewrites the table (exclusive lock for the rewrite).
 *
 * Automatic compaction (emergency only) is limited to research tables the trading path never
 * reads, with a short lock timeout. Trading-path tables are compacted only via the manual CLI:
 *   npm run db:compact -w @memebot/server            (research tables)
 *   npm run db:compact -w @memebot/server -- --all   (also trading-path tables; pause the bot first)
 */
import { getPool, closePool } from './client.js';
import { logger } from '../utils/logger.js';

/** Research tables with no reader on the trading path. */
export const AUTO_COMPACT_TABLES = [
  'trade_events',
  'feature_snapshots',
  'token_raw_feature_observations',
  'token_phases',
  'funnel_snapshots',
  'bot_events',
  'regime_snapshots',
  'market_events',
  'system_health',
  'missed_opportunities',
  'shadow_trades',
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_discovery_events',
  'token_outcome_checkpoints',
];

/** Read every tick by signals/execution: never rewritten automatically. */
export const TRADING_PATH_TABLES = [
  'market_snapshots',
  'liquidity_snapshots',
  'holder_snapshots',
  'safety_assessments',
  'tokens',
];

export interface BloatRow {
  table: string;
  heapBytes: number;
  estimatedLiveBytes: number;
  reclaimableBytes: number;
}

/**
 * Table + index size vs live rows × average row width (from ANALYZE statistics) plus ~40 B per
 * row per index. Indexes count because high-churn tables bloat their btrees far more than the heap.
 */
export async function estimateBloat(tables: string[]): Promise<BloatRow[]> {
  const { rows } = await getPool().query<{
    relname: string;
    total: string;
    live: string;
    width: string | null;
    indexes: string;
  }>(
    `SELECT s.relname, pg_total_relation_size(s.relid)::text AS total, s.n_live_tup::text AS live,
            (SELECT SUM(avg_width) FROM pg_stats p WHERE p.schemaname = 'public' AND p.tablename = s.relname)::text AS width,
            (SELECT COUNT(*) FROM pg_index i WHERE i.indrelid = s.relid)::text AS indexes
     FROM pg_stat_user_tables s WHERE s.relname = ANY($1::text[])`,
    [tables],
  );
  return rows.map((r) => {
    const heapBytes = Number(r.total);
    const live = Number(r.live);
    const estimatedLiveBytes =
      live * ((r.width != null ? Number(r.width) : 200) + 32) + live * 40 * Number(r.indexes);
    return {
      table: r.relname,
      heapBytes,
      estimatedLiveBytes,
      reclaimableBytes: Math.max(0, heapBytes - estimatedLiveBytes),
    };
  });
}

export async function compactTables(opts: {
  tables: string[];
  minReclaimBytes?: number;
  lockTimeoutMs?: number;
}): Promise<Array<{ table: string; beforeBytes: number; afterBytes: number; skipped?: string }>> {
  const minReclaim = opts.minReclaimBytes ?? 16 * 1024 * 1024;
  const results: Array<{ table: string; beforeBytes: number; afterBytes: number; skipped?: string }> = [];
  const candidates = (await estimateBloat(opts.tables)).filter(
    (b) => b.reclaimableBytes >= minReclaim && b.reclaimableBytes > b.heapBytes * 0.5,
  );
  if (candidates.length === 0) return results;

  const client = await getPool().connect();
  try {
    await client.query(`SET lock_timeout = '${Math.max(100, Math.round(opts.lockTimeoutMs ?? 2_000))}ms'`);
    for (const c of candidates) {
      const size = async () =>
        Number((await client.query<{ b: string }>(`SELECT pg_total_relation_size($1::regclass)::text AS b`, [c.table])).rows[0]?.b ?? 0);
      const beforeBytes = await size();
      try {
        await client.query(`VACUUM (FULL, ANALYZE) ${c.table}`);
        results.push({ table: c.table, beforeBytes, afterBytes: await size() });
      } catch (err) {
        results.push({ table: c.table, beforeBytes, afterBytes: beforeBytes, skipped: (err as Error).message });
      }
    }
    await client.query('RESET lock_timeout');
  } finally {
    client.release();
  }
  if (results.length > 0) logger.warn({ results }, 'Compacted bloated tables (VACUUM FULL)');
  return results;
}

if (process.argv[1]?.endsWith('compact.ts') || process.argv[1]?.endsWith('compact.js')) {
  const all = process.argv.includes('--all');
  compactTables({
    tables: all ? [...AUTO_COMPACT_TABLES, ...TRADING_PATH_TABLES] : AUTO_COMPACT_TABLES,
    minReclaimBytes: 1024 * 1024,
    lockTimeoutMs: 10_000,
  })
    .then(async (r) => {
      for (const x of r) {
        console.log(`${x.table}: ${(x.beforeBytes / 1e6).toFixed(1)}MB -> ${(x.afterBytes / 1e6).toFixed(1)}MB${x.skipped ? ` (skipped: ${x.skipped})` : ''}`);
      }
      if (r.length === 0) console.log('Nothing worth compacting.');
      await closePool();
    })
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
