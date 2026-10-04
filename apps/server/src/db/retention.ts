import { query } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { CRITICAL_TABLES } from './data-classes.js';
import { currentStorageState, stateRank, type StorageState } from './storage-guard.js';

/** Small batches keep each DELETE transaction short (no long locks on hot tables). */
const BATCH = 5_000;

/** Normal cleanup cadence; the storage guard triggers extra runs under pressure. */
export const RETENTION_JOB_INTERVAL_MS = 5 * 60_000;

/** Tables storage jobs never delete from (critical trading data + permanent outcome summaries). */
export const PERMANENT_RETENTION_TABLES = [
  ...CRITICAL_TABLES,
  'token_outcome_summaries',
  'discovery_source_health',
] as const;

export interface RetentionWindows {
  /** Every token keeps full-resolution market snapshots this long (strategy reads ≤ 16 min). */
  marketFullResMinutes: number;
  /** Tokens in use (open position / shadow trade / pending tracker) keep snapshots up to this. */
  inUseCapHours: number;
  holderHours: number;
  safetyMinutes: number;
  tradeEventsMinutes: number;
  featureSnapshotHours: number;
  rawFeatureHours: number;
  phaseHours: number;
  shadowClosedHours: number;
  funnelHours: number;
  eventHours: number;
  /** Research period: decision audits, decision features, discovery events, missed opportunities. */
  compactResearchDays: number;
  /** DISCOVERED/NORMALIZED/TRACKED audits duplicate tokens + discovery events; kept briefly. */
  lifecycleAuditHours: number;
  checkpointHours: number;
  /** Opportunities whose tracker is no longer PENDING (trackers/outcomes cascade). */
  opportunityHours: number;
}

/** Retention tightens as the volume fills; compact research is never cut below the research period. */
export function retentionWindows(state: StorageState = currentStorageState()): RetentionWindows {
  const base: RetentionWindows = {
    marketFullResMinutes: env.MARKET_SNAPSHOT_FULL_RES_MINUTES,
    inUseCapHours: env.RAW_DATA_RETENTION_HOURS,
    holderHours: env.RAW_DATA_RETENTION_HOURS,
    safetyMinutes: env.SAFETY_RETENTION_MINUTES,
    tradeEventsMinutes: env.TRADE_EVENTS_RETENTION_MINUTES,
    featureSnapshotHours: env.RAW_DATA_RETENTION_HOURS,
    rawFeatureHours: env.RESEARCH_DATA_RETENTION_HOURS,
    phaseHours: env.TOKEN_PHASE_RETENTION_HOURS,
    shadowClosedHours: env.SHADOW_RETENTION_DAYS * 24,
    funnelHours: 48,
    eventHours: env.EVENT_RETENTION_DAYS * 24,
    compactResearchDays: env.COMPACT_RESEARCH_RETENTION_DAYS,
    lifecycleAuditHours: env.RESEARCH_DATA_RETENTION_HOURS,
    checkpointHours: env.RESEARCH_DATA_RETENTION_HOURS,
    opportunityHours: env.OPPORTUNITY_RETENTION_HOURS,
  };
  const rank = stateRank(state);
  if (rank >= stateRank('EMERGENCY_CLEANUP')) {
    return {
      ...base,
      inUseCapHours: Math.min(base.inUseCapHours, 1),
      holderHours: 0,
      safetyMinutes: 0,
      tradeEventsMinutes: 0,
      featureSnapshotHours: 0,
      rawFeatureHours: 0,
      phaseHours: Math.min(base.phaseHours, 1),
      shadowClosedHours: Math.min(base.shadowClosedHours, 6),
      funnelHours: 2,
      eventHours: Math.min(base.eventHours, 6),
      lifecycleAuditHours: Math.min(base.lifecycleAuditHours, 1),
      checkpointHours: Math.min(base.checkpointHours, 6),
      opportunityHours: Math.min(base.opportunityHours, 6),
    };
  }
  if (rank >= stateRank('AGGRESSIVE_CLEANUP')) {
    return {
      ...base,
      inUseCapHours: Math.min(base.inUseCapHours, 1),
      holderHours: Math.min(base.holderHours, 1),
      safetyMinutes: Math.min(base.safetyMinutes, 10),
      tradeEventsMinutes: Math.min(base.tradeEventsMinutes, 10),
      featureSnapshotHours: Math.min(base.featureSnapshotHours, 1),
      rawFeatureHours: Math.min(base.rawFeatureHours, 6),
      phaseHours: Math.min(base.phaseHours, 6),
      shadowClosedHours: Math.min(base.shadowClosedHours, 24),
      funnelHours: 12,
      eventHours: Math.min(base.eventHours, 24),
      lifecycleAuditHours: Math.min(base.lifecycleAuditHours, 6),
      checkpointHours: Math.min(base.checkpointHours, 12),
      opportunityHours: Math.min(base.opportunityHours, 12),
    };
  }
  return base;
}

export type RetentionPolicyRow = { table: string; retention: string; permanent: boolean };

/** Documented retention behavior for the storage dashboard / ops. */
export function retentionPolicyTable(state: StorageState = currentStorageState()): RetentionPolicyRow[] {
  const w = retentionWindows(state);
  const rows: RetentionPolicyRow[] = [
    {
      table: 'market_snapshots',
      retention: `${w.marketFullResMinutes}m all tokens; ≤${w.inUseCapHours}h for tokens in use; latest/token kept`,
      permanent: false,
    },
    { table: 'liquidity_snapshots', retention: 'latest per token only (upsert)', permanent: false },
    { table: 'holder_snapshots', retention: `${w.holderHours}h (latest/token kept)`, permanent: false },
    { table: 'safety_assessments', retention: `${w.safetyMinutes}m (latest/token kept)`, permanent: false },
    { table: 'trade_events', retention: `${w.tradeEventsMinutes}m`, permanent: false },
    { table: 'feature_snapshots', retention: `${w.featureSnapshotHours}h (writes off by default)`, permanent: false },
    { table: 'token_raw_feature_observations', retention: `${w.rawFeatureHours}h (sampled)`, permanent: false },
    { table: 'token_phases', retention: `${w.phaseHours}h (latest/token kept)`, permanent: false },
    { table: 'shadow_trades', retention: `${w.shadowClosedHours}h after close (open kept)`, permanent: false },
    { table: 'funnel_snapshots', retention: `${w.funnelHours}h`, permanent: false },
    {
      table: 'opportunities',
      retention: `${w.opportunityHours}h once tracking completes (trackers + outcomes cascade)`,
      permanent: false,
    },
    ...EVENT_TABLES.map((t) => ({ table: t.table, retention: `${w.eventHours}h`, permanent: false })),
    {
      table: 'token_outcome_checkpoints',
      retention: `${w.checkpointHours}h after COMPACTED/MISSED (24h summary first)`,
      permanent: false,
    },
    ...COMPACT_RESEARCH_PRUNE.map((t) => ({
      table: t.table,
      retention:
        t.table === 'token_decision_audits'
          ? `${w.compactResearchDays}d (lifecycle stages ${w.lifecycleAuditHours}h); budget ${env.COMPACT_RESEARCH_BUDGET_MB} MB shared`
          : `${w.compactResearchDays}d (research period); budget ${env.COMPACT_RESEARCH_BUDGET_MB} MB shared`,
      permanent: false,
    })),
    ...PERMANENT_RETENTION_TABLES.map((table) => ({ table, retention: 'permanent', permanent: true })),
  ];
  return rows;
}

const EVENT_TABLES: Array<{ table: string; time: string }> = [
  { table: 'bot_events', time: 'created_at' },
  { table: 'regime_snapshots', time: 'observed_at' },
  { table: 'market_events', time: 'observed_at' },
  { table: 'system_health', time: 'observed_at' },
  { table: 'storage_monitor_snapshots', time: 'observed_at' },
  { table: 'retention_runs', time: 'started_at' },
  { table: 'alert_log', time: 'created_at' },
];

export const COMPACT_RESEARCH_PRUNE: Array<{ table: string; time: string }> = [
  { table: 'token_decision_audits', time: 'decided_at' },
  { table: 'token_decision_feature_snapshots', time: 'observed_at' },
  { table: 'token_discovery_events', time: 'observed_at' },
  { table: 'missed_opportunities', time: 'observed_at' },
];

/** Every table any cleanup path may delete from (tests assert none is CRITICAL). */
export const PRUNABLE_TABLES = [
  'market_snapshots',
  'liquidity_snapshots',
  'holder_snapshots',
  'safety_assessments',
  'trade_events',
  'feature_snapshots',
  'token_raw_feature_observations',
  'token_phases',
  'shadow_trades',
  'funnel_snapshots',
  'token_outcome_checkpoints',
  'opportunities',
  'opportunity_trackers',
  'opportunity_outcomes',
  ...EVENT_TABLES.map((t) => t.table),
  ...COMPACT_RESEARCH_PRUNE.map((t) => t.table),
];

async function deleteBatched(table: string, where: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} t WHERE ${where} LIMIT ${BATCH})`,
      params,
    );
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < BATCH) return total;
  }
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

function keepLatest(table: string, time: string): string {
  return `EXISTS (SELECT 1 FROM ${table} n WHERE n.token_id = t.token_id AND n.${time} > t.${time})`;
}

/** Tokens whose recent price path is still being consumed (positions, shadow sims, trackers). */
export const TOKENS_IN_USE_SQL = `SELECT token_id FROM positions WHERE status = 'OPEN'
     UNION SELECT token_id FROM shadow_trades WHERE status = 'OPEN'
     UNION SELECT token_id FROM opportunity_trackers WHERE status = 'PENDING'`;

async function tokensInUse(): Promise<string[]> {
  const { rows } = await query<{ token_id: string }>(TOKENS_IN_USE_SQL);
  return rows.map((r) => r.token_id);
}

/** One retention predicate: rows of `table` (aliased `t`) matching `where` are expired. */
export interface RetentionRule {
  table: string;
  where: string;
  params: unknown[];
}

/**
 * The time-window retention predicates, in prune order. Pure, so the research archive can
 * select exactly the rows retention would expire (the compact-research budget is separate).
 */
export function retentionRules(now: Date, w: RetentionWindows, inUse: string[]): RetentionRule[] {
  const rules: RetentionRule[] = [
    {
      table: 'market_snapshots',
      where: `t.observed_at < $1
     AND (t.observed_at < $2 OR NOT (t.token_id = ANY($3::uuid[])))
     AND ${keepLatest('market_snapshots', 'observed_at')}`,
      params: [ago(now, w.marketFullResMinutes * MIN), ago(now, w.inUseCapHours * HOUR), inUse],
    },
    { table: 'liquidity_snapshots', where: `${keepLatest('liquidity_snapshots', 'observed_at')}`, params: [] },
    {
      table: 'holder_snapshots',
      where: `t.observed_at < $1 AND ${keepLatest('holder_snapshots', 'observed_at')}`,
      params: [ago(now, w.holderHours * HOUR)],
    },
    {
      table: 'safety_assessments',
      where: `t.assessed_at < $1 AND ${keepLatest('safety_assessments', 'assessed_at')}`,
      params: [ago(now, w.safetyMinutes * MIN)],
    },
    { table: 'trade_events', where: `t.observed_at < $1`, params: [ago(now, w.tradeEventsMinutes * MIN)] },
    { table: 'feature_snapshots', where: `t.observed_at < $1`, params: [ago(now, w.featureSnapshotHours * HOUR)] },
    {
      table: 'token_raw_feature_observations',
      where: `t.observed_at < $1`,
      params: [ago(now, w.rawFeatureHours * HOUR)],
    },
    {
      table: 'token_phases',
      where: `t.observed_at < $1 AND ${keepLatest('token_phases', 'observed_at')}`,
      params: [ago(now, w.phaseHours * HOUR)],
    },
    {
      table: 'shadow_trades',
      where: `t.status <> 'OPEN' AND COALESCE(t.closed_at, t.opened_at) < $1`,
      params: [ago(now, w.shadowClosedHours * HOUR)],
    },
    { table: 'funnel_snapshots', where: `t.observed_at < $1`, params: [ago(now, w.funnelHours * HOUR)] },
    // Checkpoints only after 24h compaction (or MISSED). PENDING/CAPTURED rows waiting for the
    // 24h summary are never deleted.
    {
      table: 'token_outcome_checkpoints',
      where: `t.status IN ('COMPACTED','MISSED')
     AND COALESCE(t.observed_at, t.due_at) < $1
     AND (
       t.status = 'MISSED'
       OR EXISTS (
         SELECT 1 FROM token_outcome_summaries s
         WHERE s.token_id = t.token_id
           AND (s.decision_id = t.decision_id OR (s.decision_id IS NULL AND t.decision_id IS NULL))
       )
     )`,
      params: [ago(now, w.checkpointHours * HOUR)],
    },
    // Pending trackers are still being resolved; their opportunity rows must stay.
    {
      table: 'opportunities',
      where: `t.observed_at < $1
     AND NOT EXISTS (
       SELECT 1 FROM opportunity_trackers k WHERE k.opportunity_id = t.id AND k.status = 'PENDING'
     )`,
      params: [ago(now, w.opportunityHours * HOUR)],
    },
  ];
  for (const { table, time } of EVENT_TABLES) {
    rules.push({
      table,
      where: table === 'retention_runs' ? `t.${time} < $1 AND t.status = 'DONE'` : `t.${time} < $1`,
      params: [ago(now, w.eventHours * HOUR)],
    });
  }
  for (const { table, time } of COMPACT_RESEARCH_PRUNE) {
    rules.push({ table, where: `t.${time} < $1`, params: [ago(now, w.compactResearchDays * 24 * HOUR)] });
  }
  rules.push({
    table: 'token_decision_audits',
    where: `t.stage IN ('DISCOVERED','NORMALIZED','TRACKED') AND t.decided_at < $1`,
    params: [ago(now, w.lifecycleAuditHours * HOUR)],
  });
  return rules;
}

/** Compact research is never trimmed below this, even over budget. */
export const COMPACT_RESEARCH_FLOOR_HOURS = 24;

/**
 * Live (not on-disk) size of compact research: deletes don't shrink files, so file size can't
 * tell whether trimming worked. Uses live tuple counts × sampled row width, scaled by index ratio.
 */
export async function compactResearchLiveBytes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, time } of COMPACT_RESEARCH_PRUNE) {
    const { rows } = await query<{ live: string; heap: string; idx: string; width: string | null }>(
      `SELECT GREATEST(
                COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = $1), 0),
                (SELECT reltuples FROM pg_class WHERE oid = $1::regclass), 0)::bigint::text AS live,
              pg_relation_size($1::regclass)::text AS heap,
              pg_indexes_size($1::regclass)::text AS idx,
              (SELECT AVG(pg_column_size(s.*))
                 FROM (SELECT * FROM ${table} ORDER BY ${time} DESC LIMIT 500) s)::text AS width`,
      [table],
    );
    const r = rows[0]!;
    const heap = Number(r.heap);
    const indexRatio = heap > 0 ? Number(r.idx) / heap : 0.5;
    out[table] = Number(r.live) * (Number(r.width ?? 0) + 28) * (1 + indexRatio);
  }
  return out;
}

/** Trims the oldest compact research (never the last 24h) once it exceeds its MB budget. */
async function enforceCompactResearchBudget(now: Date): Promise<Record<string, number>> {
  const budget = env.COMPACT_RESEARCH_BUDGET_MB * 1024 * 1024;
  const live = await compactResearchLiveBytes();
  const total = Object.values(live).reduce((a, b) => a + b, 0);
  if (total <= budget) return {};
  const fraction = Math.min(1, (total - budget * 0.9) / total);
  const floor = ago(now, COMPACT_RESEARCH_FLOOR_HOURS * HOUR);
  const deleted: Record<string, number> = {};
  for (const { table, time } of COMPACT_RESEARCH_PRUNE) {
    // Cutoff stays text: JS Dates drop the microseconds Postgres timestamps carry.
    const { rows } = await query<{ cutoff: string | null; below_floor: boolean | null }>(
      `SELECT c::text AS cutoff, c < $2::timestamptz AS below_floor
       FROM (SELECT percentile_disc($1::float8) WITHIN GROUP (ORDER BY ${time}) AS c FROM ${table}) x`,
      [fraction, floor],
    );
    const cutoff = rows[0]?.cutoff;
    if (!cutoff) continue;
    deleted[table] = rows[0]!.below_floor
      ? await deleteBatched(table, `t.${time} <= $1::timestamptz`, [cutoff])
      : await deleteBatched(table, `t.${time} < $1`, [floor]);
  }
  logger.warn(
    { liveMb: Math.round(total / 1024 / 1024), budgetMb: env.COMPACT_RESEARCH_BUDGET_MB, deleted },
    'Compact research over budget; trimmed oldest rows',
  );
  return deleted;
}

let running: Promise<Record<string, number>> | null = null;

/**
 * Prunes temporary data. Idempotent, batched, never touches CRITICAL tables, and never cuts
 * compact research below the research period. Concurrent calls share one run.
 */
export function pruneOldData(now = new Date(), state: StorageState = currentStorageState()): Promise<Record<string, number>> {
  if (running) return running;
  running = runPrune(now, state).finally(() => {
    running = null;
  });
  return running;
}

async function runPrune(now: Date, state: StorageState): Promise<Record<string, number>> {
  const w = retentionWindows(state);
  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO retention_runs (started_at, raw_cutoff, status, deleted)
     VALUES ($1, $2, 'RUNNING', $3) RETURNING id`,
    [now, ago(now, w.marketFullResMinutes * MIN), JSON.stringify({ state })],
  );
  const runId = runRows[0]?.id;
  const deleted: Record<string, number> = {};

  for (const rule of retentionRules(now, w, await tokensInUse())) {
    deleted[rule.table] = (deleted[rule.table] ?? 0) + (await deleteBatched(rule.table, rule.where, rule.params));
  }
  for (const [table, n] of Object.entries(await enforceCompactResearchBudget(now))) {
    deleted[table] = (deleted[table] ?? 0) + n;
  }

  // Plain VACUUM (not FULL): no exclusive lock, makes freed space reusable so tables stop growing.
  const vacuumTables = Object.entries(deleted)
    .filter(([, n]) => n >= 1_000)
    .map(([table]) => table);
  if ((deleted.opportunities ?? 0) >= 1_000) vacuumTables.push('opportunity_trackers', 'opportunity_outcomes');
  for (const table of vacuumTables) {
    await query(`VACUUM (ANALYZE) ${table}`).catch((err) =>
      logger.warn({ err: (err as Error).message, table }, 'VACUUM after prune failed'),
    );
  }

  if (runId) {
    await query(
      `UPDATE retention_runs SET finished_at = NOW(), deleted = $2, status = 'DONE' WHERE id = $1`,
      [runId, JSON.stringify({ state, ...deleted })],
    );
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info({ state, deleted }, 'Pruned old data');
  return deleted;
}
