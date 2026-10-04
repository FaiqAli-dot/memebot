import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://memebot:memebot@localhost:5432/memebot_test';
const SOURCE_URL = process.env.DATABASE_URL;
const ARCHIVE_URL = (() => {
  const u = new URL(SOURCE_URL);
  u.pathname = '/memebot_archive_test';
  return u.toString();
})();

const FIXTURE_TABLES = [
  'market_events',
  'opportunities',
  'opportunity_trackers',
  'opportunity_outcomes',
  'token_decision_audits',
  'token_decision_feature_snapshots',
  'token_outcome_summaries',
  'token_outcome_checkpoints',
  'positions',
  'tokens',
  'archive_runs',
];

describe('integration: research archive (export → verify → delete)', () => {
  let db: typeof import('../../src/db/client.js');
  let ar: typeof import('../../src/archive/research-archive.js');
  let status: typeof import('../../src/archive/status.js');
  let source: pg.Pool;
  let archive: pg.Pool;
  let tokens: string[] = [];
  let protectedToken: string;

  const count = async (pool: pg.Pool | null, sql: string, params: unknown[] = []) =>
    Number(Object.values((await (pool ?? source).query(sql, params)).rows[0]!)[0]);
  const run = (opts: Partial<import('../../src/archive/research-archive.js').ArchiveOptions>, a: pg.Pool | null = archive) =>
    ar.runArchive({ source, archive: a }, { mode: 'dry-run', batchSize: 50, ...opts });

  async function seed(): Promise<void> {
    await db.query(`TRUNCATE ${FIXTURE_TABLES.join(', ')} CASCADE`);
    for (const t of FIXTURE_TABLES) await archive.query(`TRUNCATE ${t}`);
    const { upsertDiscoveredToken } = await import('../../src/services/token-service.js');
    const portfolios = await import('../../src/services/portfolio-service.js');
    const portfolioId = await portfolios.ensureDefaultPortfolio();
    tokens = [];
    for (let i = 0; i < 4; i++) {
      tokens.push(
        (await upsertDiscoveredToken({
          chain: 'solana',
          address: `ArchTok${i}1111111111111111111111111111111111`.slice(0, 44),
          symbol: `A${i}`,
          name: `Arch ${i}`,
          decimals: 9,
          createdAt: null,
        }))!,
      );
    }
    protectedToken = tokens[3]!;
    await db.query(
      `INSERT INTO positions (portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd, cost_basis_usd,
         current_value_usd, stop_loss_pct, take_profit_pct, highest_price_usd, opened_at, data_mode)
       VALUES ($1, $2, 'OPEN', 10, 1, 1, 10, 10, 0.08, 0.2, 1, NOW() - INTERVAL '1 hour', 'demo')`,
      [portfolioId, protectedToken],
    );
    // 4-day-old events (past every event window) — 3 archivable tokens × 40 + protected token × 10.
    await db.query(
      `INSERT INTO market_events (token_id, event_type, payload, observed_at, source, data_mode)
       SELECT t, 'SIM', jsonb_build_object('n', s, 'precise', 0.123456789012345678901234567890, 'nested', jsonb_build_object('k', ARRAY[1,2,3])),
              NOW() - INTERVAL '4 days' - (s * INTERVAL '1 second') + INTERVAL '0.000123 seconds', 'test', 'demo'
       FROM unnest($1::uuid[]) t, generate_series(1, 40) s`,
      [tokens.slice(0, 3)],
    );
    await db.query(
      `INSERT INTO market_events (token_id, event_type, observed_at, source, data_mode)
       SELECT $1, 'SIM', NOW() - INTERVAL '4 days', 'test', 'demo' FROM generate_series(1, 10)`,
      [protectedToken],
    );
    await db.query(
      `INSERT INTO market_events (token_id, event_type, observed_at, source, data_mode)
       SELECT $1, 'RECENT', NOW(), 'test', 'demo' FROM generate_series(1, 5)`,
      [tokens[0]],
    );
    // Completed opportunity (cascade children) and a pending one (kept).
    const opp = async (token: string, tracker: string) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO opportunities (token_id, strategy_id, decision, observed_at, price_usd, liquidity_status, data_mode)
         VALUES ($1, 'momentum', 'SKIP', NOW() - INTERVAL '3 days', 1.23456789012345678, 'OK', 'demo') RETURNING id`,
        [token],
      );
      const id = rows[0]!.id;
      await db.query(`INSERT INTO opportunity_trackers (opportunity_id, token_id, status) VALUES ($1, $2, $3)`, [id, token, tracker]);
      await db.query(
        `INSERT INTO opportunity_outcomes (opportunity_id, horizon_sec, observed_at, lag_sec, price_usd, return_pct, mfe_pct, mae_pct)
         SELECT $1, h, NOW() - INTERVAL '3 days', 1, 1, 0.1, 0.2, -0.1 FROM unnest(ARRAY[60, 300, 900]) h`,
        [id],
      );
      return id;
    };
    await opp(tokens[0]!, 'COMPLETE');
    await opp(protectedToken, 'PENDING');
    // Compact research 3 days old: one audit referenced by a permanent summary (must stay),
    // one with a cascade feature snapshot (archived with its child), one plain.
    const audit = async (token: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO token_decision_audits (token_id, stage, result, data_mode, decided_at)
           VALUES ($1, 'SIGNAL', 'FAIL', 'demo', NOW() - INTERVAL '3 days') RETURNING id`,
          [token],
        )
      ).rows[0]!.id;
    const withSummary = await audit(tokens[0]!);
    await db.query(
      `INSERT INTO token_outcome_summaries (token_id, decision_id, classification, data_mode) VALUES ($1, $2, 'X', 'demo')`,
      [tokens[0], withSummary],
    );
    const withChild = await audit(tokens[1]!);
    await db.query(
      `INSERT INTO token_decision_feature_snapshots (decision_id, token_id, stage, features, observed_at, data_mode)
       VALUES ($1, $2, 'SIGNAL', '{"f":1.000000000000000001}', NOW() - INTERVAL '3 days', 'demo')`,
      [withChild, tokens[1]],
    );
    await audit(tokens[2]!);
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(SOURCE_URL);
    ar = await import('../../src/archive/research-archive.js');
    status = await import('../../src/archive/status.js');
    await ar.ensureArchiveDatabase(ARCHIVE_URL);
    source = ar.connectSource(SOURCE_URL, { readOnly: false });
    archive = ar.connectArchive(ARCHIVE_URL);
    await ar.prepareArchiveSchema(archive);
  }, 120_000);

  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    await source?.end();
    await archive?.end();
    await db.closePool();
  });

  it('dry-run reports eligible rows and writes nothing anywhere', async () => {
    const before = await count(null, `SELECT COUNT(*) FROM market_events`);
    const r = await run({ mode: 'dry-run' });
    expect(r.status).toBe('SUCCEEDED');
    expect(r.tables.market_events!.selected).toBe(120);
    expect(r.tables.opportunities!.selected).toBe(1);
    expect(r.tables.token_decision_audits!.selected).toBe(2);
    expect(r.tables.positions?.dataClass).toBe('CRITICAL_MIRROR');
    expect(r.estimatedReclaimBytes).toBeGreaterThan(0);
    expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(before);
    expect(await count(archive, `SELECT COUNT(*) FROM market_events`)).toBe(0);
    expect(await count(null, `SELECT COUNT(*) FROM archive_runs`)).toBe(0);
  });

  it('archive copies every table verbatim (ids, µs timestamps, numeric, jsonb); rerun adds no duplicates', async () => {
    const r = await run({ mode: 'archive' });
    expect(r.status).toBe('SUCCEEDED');
    expect(r.verification).toBe('PASSED');
    const srcRows = await count(null, `SELECT COUNT(*) FROM market_events`);
    expect(await count(archive, `SELECT COUNT(*) FROM market_events`)).toBe(srcRows);
    const sig = async (pool: pg.Pool, t: string, key: string) =>
      (await pool.query<{ s: string }>(`SELECT md5(string_agg(to_jsonb(x)::text, '|' ORDER BY ${key})) AS s FROM ${t} x`)).rows[0]!.s;
    for (const [t, key] of [
      ['market_events', 'id'],
      ['opportunities', 'id'],
      ['opportunity_outcomes', 'opportunity_id, horizon_sec'],
      ['tokens', 'id'],
      ['positions', 'id'],
    ] as const) {
      expect(await sig(archive, t, key)).toBe(await sig(source, t, key));
    }
    const again = await run({ mode: 'archive', full: true });
    expect(again.status).toBe('SUCCEEDED');
    expect(await count(archive, `SELECT COUNT(*) FROM market_events`)).toBe(srcRows);
    expect(await count(archive, `SELECT COUNT(*) FROM tokens`)).toBe(await count(null, `SELECT COUNT(*) FROM tokens`));
  });

  it('verify passes when archived and fails on a tampered archive row', async () => {
    await run({ mode: 'archive' });
    expect((await run({ mode: 'verify' })).verification).toBe('PASSED');
    await archive.query(`UPDATE market_events SET payload = '{"tampered":true}' WHERE id = (SELECT MIN(id) FROM market_events)`);
    const r = await run({ mode: 'verify' });
    expect(r.status).toBe('FAILED');
    expect(r.verification).toBe('FAILED');
    expect(r.rowsDeleted).toBe(0);
  });

  it('prune refuses without --confirm-delete', async () => {
    const r = await run({ mode: 'prune' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/confirm-delete/);
    expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(135);
  });

  it('prune deletes only verified, eligible rows; protects open-position tokens, pending trackers, referenced audits', async () => {
    const r = await run({ mode: 'prune', confirmDelete: true });
    expect(r.status).toBe('SUCCEEDED');
    expect(r.verification).toBe('PASSED');
    expect(r.tables.market_events!.deleted).toBe(120);
    // Protected token's old rows and recent rows remain.
    expect(await count(null, `SELECT COUNT(*) FROM market_events WHERE token_id = $1`, [protectedToken])).toBe(10);
    expect(await count(null, `SELECT COUNT(*) FROM market_events WHERE event_type = 'RECENT'`)).toBe(5);
    // Every deleted row exists in the archive with the same id.
    expect(await count(archive, `SELECT COUNT(*) FROM market_events WHERE event_type = 'SIM' AND token_id <> $1`, [protectedToken])).toBe(120);
    // Completed opportunity + its cascade children archived then deleted; pending kept.
    expect(await count(null, `SELECT COUNT(*) FROM opportunities`)).toBe(1);
    expect(await count(null, `SELECT COUNT(*) FROM opportunity_trackers WHERE status = 'PENDING'`)).toBe(1);
    expect(await count(archive, `SELECT COUNT(*) FROM opportunity_outcomes`)).toBe(3);
    expect(await count(archive, `SELECT COUNT(*) FROM opportunity_trackers WHERE status = 'COMPLETE'`)).toBe(1);
    // Audit referenced by a permanent summary stays; summary link intact (no SET NULL).
    expect(await count(null, `SELECT COUNT(*) FROM token_outcome_summaries WHERE decision_id IS NOT NULL`)).toBe(1);
    expect(await count(null, `SELECT COUNT(*) FROM token_decision_audits`)).toBe(1);
    expect(await count(archive, `SELECT COUNT(*) FROM token_decision_feature_snapshots`)).toBe(1);
    // Critical tables untouched.
    expect(await count(null, `SELECT COUNT(*) FROM positions WHERE status = 'OPEN'`)).toBe(1);
    expect(await count(null, `SELECT COUNT(*) FROM tokens`)).toBe(4);
    // Status row recorded for the dashboard.
    const s = await status.getArchiveStatus('WARNING');
    expect(s.health).toBe('ARCHIVE_HEALTHY');
    expect(s.rowsDeleted).toBeGreaterThanOrEqual(r.rowsDeleted);
    expect(s.lastVerification?.result).toBe('PASSED');
  });

  it('an unreachable local archive fails the run before any delete', async () => {
    const dead = ar.connectArchive('postgresql://memebot:memebot@localhost:1/none');
    try {
      const r = await run({ mode: 'prune', confirmDelete: true }, dead);
      expect(r.status).toBe('FAILED');
      expect(r.rowsDeleted).toBe(0);
    } finally {
      await dead.end();
    }
    expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(135);
    expect((await status.getArchiveStatus('NORMAL')).health).toBe('ARCHIVE_FAILED');
  });

  it('a verification failure (archive alters rows on write) deletes nothing', async () => {
    await archive.query(`
      CREATE OR REPLACE FUNCTION corrupt_payload() RETURNS trigger AS $$
      BEGIN NEW.payload := '{"corrupt":true}'::jsonb; RETURN NEW; END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_corrupt ON market_events;
      CREATE TRIGGER trg_corrupt BEFORE INSERT OR UPDATE ON market_events FOR EACH ROW EXECUTE FUNCTION corrupt_payload();`);
    try {
      const r = await run({ mode: 'prune', confirmDelete: true, tables: ['market_events'] });
      expect(r.status).toBe('FAILED');
      expect(r.verification).toBe('FAILED');
      expect(r.rowsDeleted).toBe(0);
      expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(135);
    } finally {
      await archive.query(`DROP TRIGGER IF EXISTS trg_corrupt ON market_events; DROP FUNCTION IF EXISTS corrupt_payload()`);
    }
  });

  it('an interrupted prune resumes without duplicates or loss', async () => {
    const first = await run({ mode: 'prune', confirmDelete: true, tables: ['market_events'], batchSize: 25, maxBatches: 2 });
    expect(first.status).toBe('SUCCEEDED');
    expect(first.rowsDeleted).toBe(50);
    const second = await run({ mode: 'prune', confirmDelete: true, tables: ['market_events'], batchSize: 25 });
    expect(second.rowsDeleted).toBe(70);
    expect(await count(archive, `SELECT COUNT(*) FROM market_events`)).toBe(120);
    expect(await count(archive, `SELECT COUNT(DISTINCT id) FROM market_events`)).toBe(120);
    expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(15);
  });

  it('critical tables can never be selected for deletion', async () => {
    for (const t of ['positions', 'paper_orders', 'paper_fills', 'signals', 'tokens', 'risk_decisions', 'token_outcome_summaries', 'discovery_source_health', 'signal_execution_attempts']) {
      expect(() => ar.assertArchivable(t)).toThrow();
    }
    const rules = ar.archiveRules(new Date(), 'EMERGENCY_CLEANUP', [], 24);
    const { CRITICAL_TABLES } = await import('../../src/db/data-classes.js');
    for (const r of rules) expect((CRITICAL_TABLES as readonly string[]).includes(r.table)).toBe(false);
    const r = await run({ mode: 'prune', confirmDelete: true, tables: ['positions', 'tokens'] });
    expect(r.rowsDeleted).toBe(0);
    expect(Object.keys(r.tables)).toHaveLength(0);
  });

  it('copies tables with generated and identity columns (generated values recomputed, hashes match)', async () => {
    const ddl = `CREATE TABLE zz_archive_gen (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      x NUMERIC NOT NULL,
      doubled NUMERIC GENERATED ALWAYS AS (x * 2) STORED)`;
    for (const p of [source, archive]) await p.query(`DROP TABLE IF EXISTS zz_archive_gen; ${ddl}`);
    try {
      await source.query(`INSERT INTO zz_archive_gen (x) SELECT g * 1.5 FROM generate_series(1, 30) g`);
      const r = await run({ mode: 'archive', tables: ['zz_archive_gen'] });
      expect(r.status).toBe('SUCCEEDED');
      expect(r.tables.zz_archive_gen!.verified).toBe(30);
      expect(await count(archive, `SELECT COUNT(*) FROM zz_archive_gen WHERE doubled = x * 2`)).toBe(30);
    } finally {
      for (const p of [source, archive]) await p.query(`DROP TABLE IF EXISTS zz_archive_gen`);
    }
  });

  it('a second concurrent run is refused by the advisory lock', async () => {
    const holder = await source.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ar.ARCHIVE_LOCK_KEY]);
      const r = await run({ mode: 'prune', confirmDelete: true });
      expect(r.status).toBe('FAILED');
      expect(r.error).toMatch(/lock/);
      expect(await count(null, `SELECT COUNT(*) FROM market_events`)).toBe(135);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [ar.ARCHIVE_LOCK_KEY]);
      holder.release();
    }
  });
});
