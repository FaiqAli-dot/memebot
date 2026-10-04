/**
 * Storage report for the dashboard/API: volume usage vs the hosted limit, storage state, largest
 * tables/indexes, raw vs compact research row counts, and the last cleanup run.
 */
import { query } from '../db/client.js';
import { env } from '../config/env.js';
import type { StorageReport, TableStorageRow } from '@memebot/shared';
import { estimatedVolumePct, measureStorage, storageThresholds } from '../db/storage-guard.js';
import { dataClassOf } from '../db/data-classes.js';
import { getArchiveStatus } from '../archive/status.js';
import { AUTO_COMPACT_TABLES, TRADING_PATH_TABLES, estimateBloat } from '../db/compact.js';
import {
  PERMANENT_RETENTION_TABLES,
  RETENTION_JOB_INTERVAL_MS,
  compactResearchLiveBytes,
  retentionPolicyTable,
} from '../db/retention.js';

const RAW_TABLES = [
  'market_snapshots',
  'liquidity_snapshots',
  'holder_snapshots',
  'safety_assessments',
  'trade_events',
  'feature_snapshots',
  'token_raw_feature_observations',
  'token_phases',
];

const COMPACT_TABLES = [
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_outcome_checkpoints',
  'token_outcome_summaries',
  'token_discovery_events',
  'missed_opportunities',
];

const COUNT_TABLES = ['tokens', 'positions', 'signals', 'opportunities', ...RAW_TABLES, ...COMPACT_TABLES];

export async function getStorageMonitor(): Promise<StorageReport> {
  const m = await measureStorage();
  const t = storageThresholds();

  const { rows: tableRows } = await query<{
    relname: string;
    total: string;
    heap: string;
    idx: string;
    live: string;
    dead: string;
  }>(
    `SELECT relname, pg_total_relation_size(relid)::text AS total, pg_relation_size(relid)::text AS heap,
            pg_indexes_size(relid)::text AS idx, n_live_tup::text AS live, n_dead_tup::text AS dead
     FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 12`,
  );
  const largestTables: TableStorageRow[] = tableRows.map((r) => ({
    table: r.relname,
    totalBytes: Number(r.total),
    heapBytes: Number(r.heap),
    indexBytes: Number(r.idx),
    liveRows: Number(r.live),
    deadRows: Number(r.dead),
    dataClass: dataClassOf(r.relname),
  }));

  const { rows: indexRows } = await query<{ indexrelname: string; relname: string; bytes: string }>(
    `SELECT indexrelname, relname, pg_relation_size(indexrelid)::text AS bytes
     FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 10`,
  );

  const bloat = (await estimateBloat([...AUTO_COMPACT_TABLES, ...TRADING_PATH_TABLES]))
    .filter((b) => b.reclaimableBytes > 1024 * 1024)
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes)
    .slice(0, 8);

  const counts: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    try {
      const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${table}`);
      counts[table] = Number(rows[0]?.c ?? 0);
    } catch {
      counts[table] = -1;
    }
  }
  const sum = (tables: string[]) => tables.reduce((a, k) => a + Math.max(0, counts[k] ?? 0), 0);

  const { rows: oldest } = await query<{ t: Date | null }>(`SELECT MIN(observed_at) AS t FROM market_snapshots`);
  const oldestAt = oldest[0]?.t ?? null;

  const { rows: runRows } = await query<{ finished_at: Date | null; deleted: Record<string, unknown> }>(
    `SELECT finished_at, deleted FROM retention_runs WHERE status = 'DONE'
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
  );
  const run = runRows[0];
  let lastCleanup: StorageReport['lastCleanup'] = null;
  if (run) {
    const byTable: Record<string, number> = {};
    for (const [k, v] of Object.entries(run.deleted ?? {})) if (typeof v === 'number') byTable[k] = v;
    lastCleanup = {
      finishedAt: run.finished_at?.toISOString() ?? null,
      state: typeof run.deleted?.state === 'string' ? run.deleted.state : null,
      rowsDeleted: Object.values(byTable).reduce((a, b) => a + b, 0),
      byTable,
    };
  }
  const lastMs = run?.finished_at?.getTime() ?? Date.now();

  const { rows: prior } = await query<{ bytes: string; observed_at: Date }>(
    `SELECT estimated_db_bytes::text AS bytes, observed_at FROM storage_monitor_snapshots
     WHERE observed_at <= NOW() - INTERVAL '55 minutes' AND observed_at >= NOW() - INTERVAL '6 hours'
     ORDER BY observed_at DESC LIMIT 1`,
  );
  const p = prior[0];
  const growthMbPerHour = p
    ? (m.usedBytes - Number(p.bytes)) / (1024 * 1024) / ((Date.now() - p.observed_at.getTime()) / 3_600_000)
    : null;

  return {
    state: m.state,
    thresholdsMb: t,
    usedBytes: m.usedBytes,
    usedPct: (m.usedBytes / (t.limit * 1024 * 1024)) * 100,
    databaseBytes: m.databaseBytes,
    allDatabasesBytes: m.allDatabasesBytes,
    walBytes: m.walBytes,
    estimatedVolumeBytes: m.estimatedVolumeBytes,
    estimatedVolumePct: estimatedVolumePct(m),
    unobservedOverheadMb: env.STORAGE_UNOBSERVED_OVERHEAD_MB,
    growthMbPerHour,
    researchWritesSuppressed: m.state === 'STOP_NON_ESSENTIAL_WRITES',
    largestTables,
    largestIndexes: indexRows.map((r) => ({ index: r.indexrelname, table: r.relname, bytes: Number(r.bytes) })),
    bloat,
    rawSnapshotRows: sum(RAW_TABLES),
    compactResearchRows: sum(COMPACT_TABLES),
    compactResearchLiveBytes: Math.round(
      Object.values(await compactResearchLiveBytes()).reduce((a, b) => a + b, 0),
    ),
    compactResearchBudgetMb: env.COMPACT_RESEARCH_BUDGET_MB,
    counts,
    oldestRawSnapshotAt: oldestAt?.toISOString() ?? null,
    rawDataAgeMinutes: oldestAt ? (Date.now() - oldestAt.getTime()) / 60_000 : null,
    lastCleanup,
    nextCleanupAt: new Date(lastMs + RETENTION_JOB_INTERVAL_MS).toISOString(),
    cleanupIntervalMs: RETENTION_JOB_INTERVAL_MS,
    retention: retentionPolicyTable(m.state),
    permanentTables: [...PERMANENT_RETENTION_TABLES],
    estimatedDbBytes: m.databaseBytes,
    softLimitBytes: t.stopWrites * 1024 * 1024,
    approachingLimit: m.state !== 'NORMAL',
    rawRetentionHours: env.RAW_DATA_RETENTION_HOURS,
    researchRetentionHours: env.RESEARCH_DATA_RETENTION_HOURS,
    eventRetentionDays: env.EVENT_RETENTION_DAYS,
    archive: await getArchiveStatus(m.state),
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
      mon.usedBytes,
      mon.oldestRawSnapshotAt,
      mon.nextCleanupAt,
      JSON.stringify({
        state: mon.state,
        walBytes: mon.walBytes,
        usedPct: mon.usedPct,
        estimatedVolumeBytes: mon.estimatedVolumeBytes,
        growthMbPerHour: mon.growthMbPerHour,
        researchWritesSuppressed: mon.researchWritesSuppressed,
        compactResearchLiveBytes: mon.compactResearchLiveBytes,
      }),
    ],
  );
}
