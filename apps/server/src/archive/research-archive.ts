/**
 * Research archive: copies production rows into a local PostgreSQL database (same schema, same
 * primary keys and values) and prunes archivable research rows from production only after the
 * exact rows have been written locally and verified.
 *
 * Per batch: SELECT (source) → UPSERT (archive) → compare full-row hashes → in one source
 * transaction lock the rows, re-check hashes and retention eligibility, DELETE, COMMIT.
 * Any failure stops the run before the next delete; a batch is never deleted unless verified.
 *
 * Eligibility is the existing retention predicates (`retentionRules`) plus the compact-research
 * floor; trading-critical, operational and permanent tables are never pruned.
 */
import pg from 'pg';
import { CRITICAL_TABLES, OPERATIONAL_TABLES } from '../db/data-classes.js';
import {
  COMPACT_RESEARCH_FLOOR_HOURS,
  COMPACT_RESEARCH_PRUNE,
  PERMANENT_RETENTION_TABLES,
  PRUNABLE_TABLES,
  TOKENS_IN_USE_SQL,
  retentionRules,
  retentionWindows,
  type RetentionRule,
} from '../db/retention.js';
import { classifyStorage, measureStorage, stateRank, type StorageMeasurement, type StorageState } from '../db/storage-guard.js';
import { migrateClient } from '../db/migrate.js';

export const ARCHIVE_LOCK_KEY = 727_002;
/** Compact research never leaves production younger than this, whatever the flag says. */
export const MIN_COMPACT_HOT_HOURS = 6;
const HEARTBEAT_STALE_MS = 15 * 60_000;
const INCREMENTAL_OVERLAP = `INTERVAL '15 minutes'`;

/** Never copied (bookkeeping that exists independently on each side). */
const COPY_EXCLUDE = new Set(['schema_migrations', 'archive_runs']);

/**
 * Insert-only tables (no UPDATE anywhere in the codebase): copied incrementally from the newest
 * archived timestamp minus an overlap. Everything else is re-copied in full each run (upsert).
 */
const APPEND_ONLY: Record<string, string> = {
  market_snapshots: 'observed_at',
  holder_snapshots: 'observed_at',
  holder_details: 'observed_at',
  safety_assessments: 'assessed_at',
  feature_snapshots: 'observed_at',
  trade_events: 'observed_at',
  token_raw_feature_observations: 'observed_at',
  token_phases: 'observed_at',
  funnel_snapshots: 'observed_at',
  opportunities: 'observed_at',
  opportunity_outcomes: 'observed_at',
  regime_snapshots: 'observed_at',
  market_events: 'observed_at',
  system_health: 'observed_at',
  bot_events: 'created_at',
  alert_log: 'created_at',
  quote_snapshots: 'observed_at',
  token_snapshots: 'observed_at',
  provider_disagreements: 'observed_at',
  storage_monitor_snapshots: 'observed_at',
  token_decision_audits: 'decided_at',
  token_decision_feature_snapshots: 'observed_at',
  token_discovery_events: 'observed_at',
  missed_opportunities: 'observed_at',
  signals: 'created_at',
  paper_fills: 'created_at',
  fee_records: 'created_at',
  portfolio_snapshots: 'observed_at',
  trade_observations: 'recorded_at',
  learning_health_checks: 'created_at',
  learning_anomalies: 'created_at',
  calibration_activations: 'created_at',
};

export type ArchiveMode = 'dry-run' | 'report' | 'archive' | 'verify' | 'prune';
export const WRITE_MODES: ArchiveMode[] = ['archive', 'verify', 'prune'];

export interface ArchiveOptions {
  mode: ArchiveMode;
  batchSize: number;
  /** Required for prune; without it nothing is ever deleted. */
  confirmDelete?: boolean;
  compactHotHours?: number;
  /** Restrict to these tables (copy and prune). */
  tables?: string[];
  /** Re-copy append-only tables in full instead of incrementally. */
  full?: boolean;
  now?: Date;
  /** Stop after this many prune batches (tests / cautious first runs). */
  maxBatches?: number;
  log?: (msg: string) => void;
}

export interface TableStats {
  dataClass: 'CRITICAL_MIRROR' | 'ARCHIVABLE';
  sourceRows?: number;
  selected: number;
  exported: number;
  verified: number;
  deleted: number;
  childrenDeleted: number;
  estimatedReclaimBytes: number;
  mismatches: number;
  skipped?: string;
}

export interface ArchiveResult {
  runId: string | null;
  mode: ArchiveMode;
  status: 'SUCCEEDED' | 'FAILED';
  verification: 'PASSED' | 'FAILED' | 'NOT_RUN';
  error: string | null;
  storageBefore: StorageMeasurement | null;
  storageAfter: StorageMeasurement | null;
  storageState: StorageState | null;
  archiveBytes: number | null;
  rowsSelected: number;
  rowsExported: number;
  rowsVerified: number;
  rowsDeleted: number;
  estimatedReclaimBytes: number;
  lastArchivedAt: string | null;
  tables: Record<string, TableStats>;
  archivalRecommended: boolean;
}

export class ArchiveSafetyError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function q(ident: string): string {
  if (!IDENT.test(ident)) throw new ArchiveSafetyError(`Unsafe identifier: ${ident}`);
  return `"${ident}"`;
}

const NEVER_PRUNE = new Set<string>([...CRITICAL_TABLES, ...OPERATIONAL_TABLES, ...PERMANENT_RETENTION_TABLES]);

/** Throws unless `table` is a research table some retention path already expires. */
export function assertArchivable(table: string): void {
  if (NEVER_PRUNE.has(table)) throw new ArchiveSafetyError(`${table} is trading-critical/permanent; never pruned`);
  if (!(PRUNABLE_TABLES as readonly string[]).includes(table)) {
    throw new ArchiveSafetyError(`${table} is not a prunable research table`);
  }
}

// ---------------------------------------------------------------------------------------------
// Connections

export function isLocalUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const socketHost = u.searchParams.get('host');
  if (host === '' && socketHost?.startsWith('/')) return true;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function dbIdentity(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`;
}

/** Source pool: TLS required for any non-local host; read-only session unless pruning/logging. */
export function connectSource(url: string, opts: { readOnly: boolean }): pg.Pool {
  const local = isLocalUrl(url);
  if (!local && /sslmode=disable/i.test(url)) {
    throw new ArchiveSafetyError('Refusing a non-local source without TLS (sslmode=disable)');
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    // Railway's proxy presents a self-signed chain: encrypted, not CA-verified (= sslmode=require).
    ssl: local ? undefined : { rejectUnauthorized: false },
    application_name: 'memebot-archive',
    options: `-c TimeZone=UTC -c statement_timeout=120000${opts.readOnly ? ' -c default_transaction_read_only=on' : ''}`,
  });
  pool.on('error', () => undefined);
  return pool;
}

/** Archive pool: localhost only (never a public or remote server). */
export function connectArchive(url: string): pg.Pool {
  if (!isLocalUrl(url)) throw new ArchiveSafetyError('ARCHIVE_DATABASE_URL must point to localhost');
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    application_name: 'memebot-archive',
    options: '-c TimeZone=UTC',
  });
  pool.on('error', () => undefined);
  return pool;
}

export function assertDistinct(sourceUrl: string, archiveUrl: string): void {
  if (dbIdentity(sourceUrl) === dbIdentity(archiveUrl)) {
    throw new ArchiveSafetyError('Source and archive must be different databases');
  }
}

/** Creates the archive database if missing (connects to the server's `postgres` database). */
export async function ensureArchiveDatabase(archiveUrl: string): Promise<void> {
  if (!isLocalUrl(archiveUrl)) throw new ArchiveSafetyError('ARCHIVE_DATABASE_URL must point to localhost');
  const u = new URL(archiveUrl);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!IDENT.test(name)) throw new ArchiveSafetyError(`Unsafe archive database name: ${name}`);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE ${q(name)}`);
  } finally {
    await admin.end();
  }
}

/**
 * Same schema as production (project migrations), minus foreign keys and secondary unique
 * constraints: the archive keeps history whose parents or natural keys may since have changed.
 * Primary keys stay, so re-runs upsert instead of duplicating.
 */
export async function prepareArchiveSchema(archive: pg.Pool): Promise<void> {
  const client = await archive.connect();
  try {
    await migrateClient(client);
    const { rows: cons } = await client.query<{ tbl: string; con: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, c.conname AS con FROM pg_constraint c
       WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('f','u')
       ORDER BY c.contype = 'u'`,
    );
    for (const r of cons) await client.query(`ALTER TABLE ${q(r.tbl)} DROP CONSTRAINT IF EXISTS ${q(r.con)}`);
    const { rows: idx } = await client.query<{ idx: string }>(
      `SELECT i.indexrelid::regclass::text AS idx FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND NOT i.indisprimary
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`,
    );
    for (const r of idx) await client.query(`DROP INDEX IF EXISTS ${q(r.idx)}`);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog

interface TableMeta {
  name: string;
  columns: Array<{ name: string; type: string }>;
  pk: Array<{ name: string; type: string }>;
  hasTokenId: boolean;
}

interface ForeignKey {
  child: string;
  parent: string;
  childCol: string;
  parentCol: string;
  onDelete: 'CASCADE' | 'SET_NULL' | 'OTHER';
  multiColumn: boolean;
}

async function loadCatalog(pool: pg.Pool): Promise<Map<string, TableMeta>> {
  const { rows: cols } = await pool.query<{ tbl: string; col: string; typ: string }>(
    `SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`,
  );
  const { rows: pks } = await pool.query<{ tbl: string; cols: string[] }>(
    `SELECT con.conrelid::regclass::text AS tbl, array_agg(a.attname::text ORDER BY k.ord) AS cols
     FROM pg_constraint con
     CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
     WHERE con.contype = 'p' AND con.connamespace = 'public'::regnamespace
     GROUP BY 1`,
  );
  const map = new Map<string, TableMeta>();
  for (const r of cols) {
    const t = map.get(r.tbl) ?? { name: r.tbl, columns: [], pk: [], hasTokenId: false };
    t.columns.push({ name: r.col, type: r.typ });
    if (r.col === 'token_id') t.hasTokenId = true;
    map.set(r.tbl, t);
  }
  for (const r of pks) {
    const t = map.get(r.tbl);
    if (!t) continue;
    t.pk = r.cols.map((c) => ({ name: c, type: t.columns.find((x) => x.name === c)!.type }));
  }
  return map;
}

async function loadForeignKeys(pool: pg.Pool): Promise<ForeignKey[]> {
  const { rows } = await pool.query<{
    child: string;
    parent: string;
    child_col: string;
    parent_col: string;
    del: string;
    n: number;
  }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
            (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS child_col,
            (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1]) AS parent_col,
            c.confdeltype::text AS del, array_length(c.conkey, 1) AS n
     FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  return rows.map((r) => ({
    child: r.child,
    parent: r.parent,
    childCol: r.child_col,
    parentCol: r.parent_col,
    onDelete: r.del === 'c' ? 'CASCADE' : r.del === 'n' ? 'SET_NULL' : 'OTHER',
    multiColumn: r.n > 1,
  }));
}

async function appliedMigrations(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
  return rows.map((r) => r.id);
}

/** Archive must have exactly the production schema for every copied table. */
export async function checkSchemaCompatible(source: pg.Pool, archive: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const [sm, am] = [await appliedMigrations(source), await appliedMigrations(archive)];
  const missing = sm.filter((m) => !am.includes(m));
  const extra = am.filter((m) => !sm.includes(m));
  if (missing.length) problems.push(`archive is missing migrations: ${missing.join(', ')}`);
  if (extra.length) problems.push(`archive has migrations production lacks: ${extra.join(', ')}`);
  const [sc, ac] = [await loadCatalog(source), await loadCatalog(archive)];
  for (const [name, meta] of sc) {
    if (COPY_EXCLUDE.has(name)) continue;
    const local = ac.get(name);
    if (!local) {
      problems.push(`archive lacks table ${name}`);
      continue;
    }
    const want = meta.columns.map((c) => `${c.name}:${c.type}`).sort().join(',');
    const have = local.columns.map((c) => `${c.name}:${c.type}`).sort().join(',');
    if (want !== have) problems.push(`column mismatch in ${name}`);
    if (meta.pk.length === 0) problems.push(`${name} has no primary key`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Row transfer + verification

interface SourceRow {
  j: string;
  h: string;
  k: string;
  ko: string;
}

const keyArray = (meta: TableMeta, alias: string) =>
  `jsonb_build_array(${meta.pk.map((c) => `${alias}.${q(c.name)}`).join(', ')})::text`;
const keyObject = (meta: TableMeta, alias: string) =>
  `jsonb_build_object(${meta.pk.map((c) => `'${c.name}', ${alias}.${q(c.name)}`).join(', ')})::text`;
const rowSelect = (meta: TableMeta, alias: string) =>
  `to_jsonb(${alias})::text AS j, md5(to_jsonb(${alias})::text) AS h, ${keyArray(meta, alias)} AS k, ${keyObject(meta, alias)} AS ko`;

async function upsertRows(archive: pg.Pool, meta: TableMeta, rows: SourceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = meta.columns.map((c) => q(c.name));
  const pkNames = new Set(meta.pk.map((c) => c.name));
  const rest = meta.columns.filter((c) => !pkNames.has(c.name)).map((c) => q(c.name));
  const conflict =
    rest.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${rest.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
         WHERE (${rest.map((c) => `a.${c}`).join(', ')}) IS DISTINCT FROM (${rest.map((c) => `EXCLUDED.${c}`).join(', ')})`;
  await archive.query(
    `INSERT INTO ${q(meta.name)} AS a (${cols.join(', ')})
     SELECT ${cols.join(', ')} FROM jsonb_populate_recordset(NULL::${q(meta.name)}, $1::jsonb)
     ON CONFLICT (${meta.pk.map((c) => q(c.name)).join(', ')}) ${conflict}`,
    [`[${rows.map((r) => r.j).join(',')}]`],
  );
}

/** Returns keys whose archived row is missing or differs from the source row. */
async function verifyRows(archive: pg.Pool, meta: TableMeta, rows: SourceRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const { rows: local } = await archive.query<{ k: string; h: string }>(
    `SELECT ${keyArray(meta, 'a')} AS k, md5(to_jsonb(a)::text) AS h
     FROM ${q(meta.name)} a
     JOIN jsonb_to_recordset($1::jsonb) AS x(${meta.pk.map((c) => `${q(c.name)} ${c.type}`).join(', ')})
       USING (${meta.pk.map((c) => q(c.name)).join(', ')})`,
    [`[${rows.map((r) => r.ko).join(',')}]`],
  );
  const have = new Map(local.map((r) => [r.k, r.h]));
  return rows.filter((r) => have.get(r.k) !== r.h).map((r) => r.k);
}

// ---------------------------------------------------------------------------------------------
// Eligibility

interface TableRules {
  table: string;
  rules: RetentionRule[];
}

/** Retention predicates + the compact-research floor, grouped per table, archivable only. */
export function archiveRules(now: Date, state: StorageState, inUse: string[], compactHotHours: number): TableRules[] {
  const hot = Math.max(MIN_COMPACT_HOT_HOURS, compactHotHours);
  const rules = retentionRules(now, retentionWindows(state), inUse);
  for (const { table, time } of COMPACT_RESEARCH_PRUNE) {
    rules.push({ table, where: `t.${time} < $1`, params: [new Date(now.getTime() - hot * 3_600_000)] });
  }
  const out: TableRules[] = [];
  for (const r of rules) {
    assertArchivable(r.table);
    const entry = out.find((x) => x.table === r.table);
    if (entry) entry.rules.push(r);
    else out.push({ table: r.table, rules: [r] });
  }
  return out;
}

/** Tokens with live trading/simulation state: none of their rows are pruned by the archive. */
export const PROTECTED_TOKENS_SQL = `${TOKENS_IN_USE_SQL}
     UNION SELECT token_id FROM paper_orders WHERE status IN ('PENDING','PARTIAL')
     UNION SELECT token_id FROM signals WHERE created_at > NOW() - INTERVAL '1 hour'
     UNION SELECT token_id FROM signal_execution_attempts WHERE last_attempt_at > NOW() - INTERVAL '1 hour'`;

interface PrunePlan {
  meta: TableMeta;
  guardSql: (offset: number) => string;
  cascadeChildren: Array<{ meta: TableMeta; fk: ForeignKey }>;
  skip?: string;
}

function planTable(table: string, catalog: Map<string, TableMeta>, fks: ForeignKey[]): PrunePlan {
  const meta = catalog.get(table);
  if (!meta) return { meta: undefined as never, guardSql: () => '', cascadeChildren: [], skip: 'table not found' };
  const plan: PrunePlan = { meta, guardSql: () => '', cascadeChildren: [] };
  if (meta.pk.length !== 1) return { ...plan, skip: 'prune requires a single-column primary key' };
  const pk = meta.pk[0]!.name;
  const blockers: string[] = [];
  for (const fk of fks.filter((f) => f.parent === table)) {
    if (fk.multiColumn) return { ...plan, skip: `multi-column FK from ${fk.child}` };
    if (fk.parentCol !== pk) return { ...plan, skip: `FK from ${fk.child} targets non-PK column` };
    if (fk.onDelete === 'CASCADE') {
      const child = catalog.get(fk.child);
      if (!child) return { ...plan, skip: `missing child ${fk.child}` };
      if (NEVER_PRUNE.has(fk.child)) return { ...plan, skip: `cascade would delete critical ${fk.child}` };
      if (fks.some((g) => g.parent === fk.child)) return { ...plan, skip: `nested cascade below ${fk.child}` };
      plan.cascadeChildren.push({ meta: child, fk });
    } else {
      // SET NULL / NO ACTION children would be modified or block: keep referenced rows.
      blockers.push(`NOT EXISTS (SELECT 1 FROM ${q(fk.child)} r WHERE r.${q(fk.childCol)} = t.${q(pk)})`);
    }
  }
  plan.guardSql = (offset: number) =>
    [meta.hasTokenId ? `NOT (t.token_id = ANY($${offset}::uuid[]))` : `cardinality($${offset}::uuid[]) >= 0`, ...blockers]
      .map((s) => `AND ${s}`)
      .join(' ');
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Run bookkeeping (archive_runs on production for the dashboard, mirrored locally)

interface RunRecord {
  id: string;
  mode: ArchiveMode;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  result: ArchiveResult;
}

async function writeRun(pool: pg.Pool, rec: RunRecord, finished: boolean): Promise<void> {
  const r = rec.result;
  await pool.query(
    `INSERT INTO archive_runs (id, mode, status, storage_state, railway_db_bytes_before, railway_db_bytes_after,
       railway_used_bytes_before, railway_used_bytes_after, archive_db_bytes, rows_selected, rows_exported,
       rows_verified, rows_deleted, estimated_reclaim_bytes, verification, last_archived_at, tables, error, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, CASE WHEN $19 THEN NOW() END)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, heartbeat_at = NOW(),
       storage_state = EXCLUDED.storage_state, railway_db_bytes_after = EXCLUDED.railway_db_bytes_after,
       railway_used_bytes_after = EXCLUDED.railway_used_bytes_after, archive_db_bytes = EXCLUDED.archive_db_bytes,
       rows_selected = EXCLUDED.rows_selected, rows_exported = EXCLUDED.rows_exported,
       rows_verified = EXCLUDED.rows_verified, rows_deleted = EXCLUDED.rows_deleted,
       estimated_reclaim_bytes = EXCLUDED.estimated_reclaim_bytes, verification = EXCLUDED.verification,
       last_archived_at = EXCLUDED.last_archived_at, tables = EXCLUDED.tables, error = EXCLUDED.error,
       finished_at = EXCLUDED.finished_at`,
    [
      rec.id,
      rec.mode,
      rec.status,
      r.storageState,
      r.storageBefore?.databaseBytes ?? null,
      r.storageAfter?.databaseBytes ?? null,
      r.storageBefore?.usedBytes ?? null,
      r.storageAfter?.usedBytes ?? null,
      r.archiveBytes,
      r.rowsSelected,
      r.rowsExported,
      r.rowsVerified,
      r.rowsDeleted,
      Math.round(r.estimatedReclaimBytes),
      r.verification,
      r.lastArchivedAt,
      JSON.stringify(r.tables),
      r.error,
      finished,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Runner

function emptyStats(dataClass: TableStats['dataClass']): TableStats {
  return { dataClass, selected: 0, exported: 0, verified: 0, deleted: 0, childrenDeleted: 0, estimatedReclaimBytes: 0, mismatches: 0 };
}

async function bytesPerRow(pool: pg.Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ b: string }>(
    `SELECT (pg_total_relation_size($1::regclass)::float8 /
             GREATEST((SELECT reltuples FROM pg_class WHERE oid = $1::regclass),
                      COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relid = $1::regclass), 0), 1))::text AS b`,
    [table],
  );
  return Number(rows[0]?.b ?? 0);
}

async function archiveSize(archive: pg.Pool): Promise<number> {
  const { rows } = await archive.query<{ b: string }>(`SELECT pg_database_size(current_database())::text AS b`);
  return Number(rows[0]?.b ?? 0);
}

export interface ArchiveConnections {
  source: pg.Pool;
  archive: pg.Pool | null;
}

/**
 * Runs one archive operation. Never throws for operational failures: the result carries
 * status FAILED and the error, and nothing is deleted after the failure point.
 */
export async function runArchive(conn: ArchiveConnections, opts: ArchiveOptions): Promise<ArchiveResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? new Date();
  const { source, archive } = conn;
  const result: ArchiveResult = {
    runId: null,
    mode: opts.mode,
    status: 'SUCCEEDED',
    verification: 'NOT_RUN',
    error: null,
    storageBefore: null,
    storageAfter: null,
    storageState: null,
    archiveBytes: null,
    rowsSelected: 0,
    rowsExported: 0,
    rowsVerified: 0,
    rowsDeleted: 0,
    estimatedReclaimBytes: 0,
    lastArchivedAt: null,
    tables: {},
    archivalRecommended: false,
  };
  const sq = <T extends pg.QueryResultRow>(text: string, params?: unknown[]) => source.query<T>(text, params);
  const writes = WRITE_MODES.includes(opts.mode);
  let lockClient: pg.PoolClient | null = null;
  let rec: RunRecord | null = null;
  const heartbeat = async () => {
    if (!rec) return;
    await writeRun(source, rec, false);
  };

  try {
    if (opts.mode === 'prune' && !opts.confirmDelete) {
      throw new ArchiveSafetyError('Prune requires --confirm-delete; nothing deleted');
    }
    result.storageBefore = await measureStorage(sq);
    result.storageState = classifyStorage(result.storageBefore.usedBytes);
    result.archivalRecommended = stateRank(result.storageState) >= stateRank('WARNING');

    if (writes) {
      lockClient = await source.connect();
      const { rows } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ARCHIVE_LOCK_KEY]);
      if (!rows[0]?.ok) {
        lockClient.release();
        lockClient = null;
        throw new ArchiveSafetyError('Another archive run holds the lock');
      }
      const { rows: idRows } = await source.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`);
      rec = { id: idRows[0]!.id, mode: opts.mode, status: 'RUNNING', result };
      result.runId = rec.id;
      await writeRun(source, rec, false);
    }

    if (opts.mode !== 'report') {
      if (!archive) throw new ArchiveSafetyError('ARCHIVE_DATABASE_URL is not configured');
      await archive.query('SELECT 1');
      const problems = await checkSchemaCompatible(source, archive);
      if (problems.length) throw new ArchiveSafetyError(`Archive schema incompatible: ${problems.join('; ')}`);
    }
    if (archive) result.archiveBytes = await archiveSize(archive).catch(() => null);

    const catalog = await loadCatalog(source);
    const fks = await loadForeignKeys(source);
    const selected = (t: string) => !opts.tables || opts.tables.includes(t);
    const inUse = (await sq<{ token_id: string }>(TOKENS_IN_USE_SQL)).rows.map((r) => r.token_id);
    const plans = archiveRules(now, result.storageState, inUse, opts.compactHotHours ?? COMPACT_RESEARCH_FLOOR_HOURS)
      .filter((t) => selected(t.table));

    if (opts.mode === 'dry-run' || opts.mode === 'report') {
      for (const { table, rules } of plans) {
        const plan = planTable(table, catalog, fks);
        const stats = emptyStats('ARCHIVABLE');
        result.tables[table] = stats;
        if (plan.skip) {
          stats.skipped = plan.skip;
          continue;
        }
        const protectedTokens = (await sq<{ token_id: string }>(PROTECTED_TOKENS_SQL)).rows.map((r) => r.token_id);
        const pk = q(plan.meta.pk[0]!.name);
        const pkType = plan.meta.pk[0]!.type;
        // Each rule numbers its own params from $1: evaluate rules separately and union the keys.
        const ids = new Set<string>();
        for (const r of rules) {
          const { rows } = await sq<{ id: string }>(
            `SELECT t.${pk}::text AS id FROM ${q(table)} t WHERE (${r.where}) ${plan.guardSql(r.params.length + 1)}`,
            [...r.params, protectedTokens],
          );
          for (const x of rows) ids.add(x.id);
        }
        stats.selected = ids.size;
        let reclaim = ids.size * (await bytesPerRow(source, table));
        for (const { meta: child, fk } of plan.cascadeChildren) {
          if (ids.size === 0) break;
          const { rows } = await sq<{ c: string }>(
            `SELECT COUNT(*)::text AS c FROM ${q(child.name)} WHERE ${q(fk.childCol)} = ANY($1::${pkType}[])`,
            [[...ids]],
          );
          reclaim += Number(rows[0]?.c ?? 0) * (await bytesPerRow(source, child.name));
        }
        stats.estimatedReclaimBytes = Math.round(reclaim);
        result.rowsSelected += ids.size;
        result.estimatedReclaimBytes += reclaim;
      }
      if (opts.mode === 'dry-run') {
        for (const [name] of catalog) {
          if (COPY_EXCLUDE.has(name) || !selected(name) || result.tables[name]) continue;
          const st = emptyStats(NEVER_PRUNE.has(name) ? 'CRITICAL_MIRROR' : 'ARCHIVABLE');
          st.skipped = NEVER_PRUNE.has(name) ? 'copy only (never pruned)' : 'copy only (no retention rule)';
          result.tables[name] = st;
        }
        for (const [name, st] of Object.entries(result.tables)) {
          const { rows } = await sq<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${q(name)}`);
          st.sourceRows = Number(rows[0]?.c ?? 0);
        }
      }
      return result;
    }

    if (opts.mode === 'archive') {
      for (const [name, meta] of catalog) {
        if (COPY_EXCLUDE.has(name) || !selected(name)) continue;
        const stats = emptyStats(NEVER_PRUNE.has(name) ? 'CRITICAL_MIRROR' : 'ARCHIVABLE');
        result.tables[name] = stats;
        const latest = await copyTable(source, archive!, meta, opts, stats);
        if (latest && (!result.lastArchivedAt || latest > result.lastArchivedAt)) result.lastArchivedAt = latest;
        result.rowsSelected += stats.selected;
        result.rowsExported += stats.exported;
        result.rowsVerified += stats.verified;
        log(`${name}: copied ${stats.exported}, verified ${stats.verified}`);
        await heartbeat();
      }
      result.verification = 'PASSED';
    }

    if (opts.mode === 'verify' || opts.mode === 'prune') {
      let batches = 0;
      for (const { table, rules } of plans) {
        const plan = planTable(table, catalog, fks);
        const stats = emptyStats('ARCHIVABLE');
        result.tables[table] = stats;
        if (plan.skip) {
          stats.skipped = plan.skip;
          continue;
        }
        const bpr = await bytesPerRow(source, table);
        for (const rule of rules) {
          let last: string | null = null;
          for (;;) {
            if (opts.maxBatches != null && batches >= opts.maxBatches) break;
            const protectedTokens = (await sq<{ token_id: string }>(PROTECTED_TOKENS_SQL)).rows.map((r) => r.token_id);
            const done = await processBatch({
              source,
              archive: archive!,
              plan,
              rule,
              protectedTokens,
              after: last,
              batchSize: opts.batchSize,
              deleteRows: opts.mode === 'prune',
              stats,
            });
            if (done.count === 0) break;
            batches += 1;
            last = done.lastKey;
            stats.estimatedReclaimBytes = Math.round(stats.deleted * bpr);
            await heartbeat();
            log(`${table}: batch ${batches} selected ${done.count}, deleted ${stats.deleted}`);
          }
        }
        result.rowsSelected += stats.selected;
        result.rowsExported += stats.exported;
        result.rowsVerified += stats.verified;
        result.rowsDeleted += stats.deleted;
        result.estimatedReclaimBytes += opts.mode === 'prune' ? stats.estimatedReclaimBytes : stats.selected * bpr;
        if (stats.mismatches > 0) {
          result.verification = 'FAILED';
          throw new ArchiveSafetyError(`${table}: ${stats.mismatches} rows not verified in archive`);
        }
      }
      result.verification = 'PASSED';

      if (opts.mode === 'prune') {
        // Plain VACUUM (no exclusive lock) so freed space is reused; never VACUUM FULL here.
        for (const [table, st] of Object.entries(result.tables)) {
          if (st.deleted + st.childrenDeleted < 1_000) continue;
          await source.query(`VACUUM (ANALYZE) ${q(table)}`).catch(() => undefined);
        }
      }
    }
  } catch (err) {
    result.status = 'FAILED';
    result.error = (err as Error).message;
    if (result.verification === 'NOT_RUN' && err instanceof VerificationError) result.verification = 'FAILED';
  } finally {
    try {
      result.storageAfter = await measureStorage(sq);
      if (archive) result.archiveBytes = await archiveSize(archive).catch(() => result.archiveBytes);
    } catch {
      /* report what we have */
    }
    if (rec) {
      rec.status = result.status;
      await writeRun(source, rec, true).catch(() => undefined);
      if (archive) await writeRun(archive, rec, true).catch(() => undefined);
    }
    if (lockClient) {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ARCHIVE_LOCK_KEY]).catch(() => undefined);
      lockClient.release();
    }
  }
  return result;
}

export class VerificationError extends ArchiveSafetyError {}

async function copyTable(
  source: pg.Pool,
  archive: pg.Pool,
  meta: TableMeta,
  opts: ArchiveOptions,
  stats: TableStats,
): Promise<string | null> {
  const time = APPEND_ONLY[meta.name];
  const incremental = !!time && !opts.full && meta.columns.some((c) => c.name === time);
  const keys = incremental ? [{ name: time!, type: 'timestamp with time zone' }, ...meta.pk] : meta.pk;
  const order = keys.map((k) => `t.${q(k.name)}`).join(', ');
  let start: string | null = null;
  if (incremental) {
    const { rows } = await archive.query<{ m: string | null }>(
      `SELECT (MAX(${q(time!)}) - ${INCREMENTAL_OVERLAP})::text AS m FROM ${q(meta.name)}`,
    );
    start = rows[0]?.m ?? null;
  }
  let last: string[] | null = null;
  let latest: string | null = null;
  for (;;) {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (start) {
      params.push(start);
      conds.push(`t.${q(time!)} >= $${params.length}::timestamptz`);
    }
    if (last) {
      const ph = keys.map((k, i) => {
        params.push(last![i]);
        return `$${params.length}::${k.type}`;
      });
      conds.push(`(${order}) > (${ph.join(', ')})`);
    }
    params.push(opts.batchSize);
    const { rows } = await source.query<SourceRow & { lk: string[] }>(
      `SELECT ${rowSelect(meta, 't')}, ARRAY[${keys.map((k) => `t.${q(k.name)}::text`).join(', ')}] AS lk
       FROM ${q(meta.name)} t ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY ${order} LIMIT $${params.length}`,
      params,
    );
    if (rows.length === 0) break;
    stats.selected += rows.length;
    await upsertRows(archive, meta, rows);
    stats.exported += rows.length;
    const bad = await verifyRows(archive, meta, rows);
    if (bad.length) {
      stats.mismatches += bad.length;
      throw new VerificationError(`${meta.name}: ${bad.length} copied rows failed verification`);
    }
    stats.verified += rows.length;
    last = rows[rows.length - 1]!.lk;
    if (incremental && last[0] && (!latest || last[0] > latest)) latest = last[0];
    if (rows.length < opts.batchSize) break;
  }
  return latest;
}

/**
 * One prune/verify batch: select eligible rows after `after`, copy them (and cascade children),
 * verify full-row hashes, then (prune only) lock, re-check and delete in one transaction.
 */
async function processBatch(args: {
  source: pg.Pool;
  archive: pg.Pool;
  plan: PrunePlan;
  rule: RetentionRule;
  protectedTokens: string[];
  after: string | null;
  batchSize: number;
  deleteRows: boolean;
  stats: TableStats;
}): Promise<{ count: number; lastKey: string | null }> {
  const { source, archive, plan, rule, protectedTokens, after, batchSize, deleteRows, stats } = args;
  const meta = plan.meta;
  const pk = meta.pk[0]!;
  const n = rule.params.length;
  const guard = plan.guardSql(n + 1);
  const afterCond = after != null ? `AND t.${q(pk.name)} > $${n + 2}::${pk.type}` : '';
  const params: unknown[] = [...rule.params, protectedTokens];
  if (after != null) params.push(after);
  params.push(batchSize);
  const { rows } = await source.query<SourceRow & { id: string }>(
    `SELECT ${rowSelect(meta, 't')}, t.${q(pk.name)}::text AS id FROM ${q(meta.name)} t
     WHERE (${rule.where}) ${guard} ${afterCond}
     ORDER BY t.${q(pk.name)} LIMIT $${params.length}`,
    params,
  );
  if (rows.length === 0) return { count: 0, lastKey: null };
  stats.selected += rows.length;
  const ids = rows.map((r) => r.id);

  const children: Array<{ meta: TableMeta; fk: ForeignKey; rows: SourceRow[] }> = [];
  for (const { meta: child, fk } of plan.cascadeChildren) {
    const { rows: crows } = await source.query<SourceRow>(
      `SELECT ${rowSelect(child, 'c')} FROM ${q(child.name)} c WHERE c.${q(fk.childCol)} = ANY($1::${pk.type}[])`,
      [ids],
    );
    children.push({ meta: child, fk, rows: crows });
  }

  if (deleteRows) {
    await upsertRows(archive, meta, rows);
    for (const c of children) await upsertRows(archive, c.meta, c.rows);
    stats.exported += rows.length;
  }

  const bad = await verifyRows(archive, meta, rows);
  let childBad = 0;
  for (const c of children) childBad += (await verifyRows(archive, c.meta, c.rows)).length;
  if (bad.length || childBad) {
    stats.mismatches += bad.length + childBad;
    if (deleteRows) throw new VerificationError(`${meta.name}: ${bad.length + childBad} rows failed verification; nothing deleted`);
    stats.verified += rows.length - bad.length;
    return { count: rows.length, lastKey: ids[ids.length - 1]! };
  }
  stats.verified += rows.length;
  if (!deleteRows) return { count: rows.length, lastKey: ids[ids.length - 1]! };

  const verified = new Map(rows.map((r) => [r.id, r.h]));
  const verifiedChildren = new Map<string, Map<string, string>>(
    children.map((c) => [c.meta.name, new Map(c.rows.map((r) => [r.k, r.h]))]),
  );
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'`);
    const fresh = (await client.query<{ token_id: string }>(PROTECTED_TOKENS_SQL)).rows.map((r) => r.token_id);
    const { rows: locked } = await client.query<{ id: string; h: string }>(
      `SELECT t.${q(pk.name)}::text AS id, md5(to_jsonb(t)::text) AS h FROM ${q(meta.name)} t
       WHERE (${rule.where}) ${guard} AND t.${q(pk.name)} = ANY($${n + 2}::${pk.type}[])
       FOR UPDATE OF t`,
      [...rule.params, fresh, ids],
    );
    for (const l of locked) {
      if (verified.get(l.id) !== l.h) throw new VerificationError(`${meta.name}: row ${l.id} changed after verification`);
    }
    const lockedIds = locked.map((l) => l.id);
    let childCount = 0;
    for (const c of children) {
      const { rows: crows } = await client.query<{ k: string; h: string }>(
        `SELECT ${keyArray(c.meta, 'c')} AS k, md5(to_jsonb(c)::text) AS h FROM ${q(c.meta.name)} c
         WHERE c.${q(c.fk.childCol)} = ANY($1::${pk.type}[]) FOR UPDATE OF c`,
        [lockedIds],
      );
      const vm = verifiedChildren.get(c.meta.name)!;
      for (const r of crows) {
        if (vm.get(r.k) !== r.h) throw new VerificationError(`${c.meta.name}: child ${r.k} not verified`);
      }
      childCount += crows.length;
    }
    if (lockedIds.length > 0) {
      const del = await client.query(
        `DELETE FROM ${q(meta.name)} t WHERE t.${q(pk.name)} = ANY($1::${pk.type}[])`,
        [lockedIds],
      );
      if ((del.rowCount ?? 0) !== lockedIds.length) {
        throw new VerificationError(`${meta.name}: delete count ${del.rowCount} != locked ${lockedIds.length}`);
      }
    }
    await client.query('COMMIT');
    stats.deleted += lockedIds.length;
    stats.childrenDeleted += childCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { count: rows.length, lastKey: ids[ids.length - 1]! };
}

export function isHeartbeatStale(heartbeatAt: Date, now = new Date()): boolean {
  return now.getTime() - heartbeatAt.getTime() > HEARTBEAT_STALE_MS;
}
