import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
delete process.env.RAW_DATA_RETENTION_HOURS;
delete process.env.RESEARCH_DATA_RETENTION_HOURS;
delete process.env.EVENT_RETENTION_DAYS;
delete process.env.COMPACT_RESEARCH_RETENTION_DAYS;
delete process.env.MARKET_SNAPSHOT_FULL_RES_MINUTES;
delete process.env.TRADE_EVENTS_RETENTION_MINUTES;
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

describe('integration: tiered retention (raw minutes/hours, research 24h, compact research 8d)', () => {
  let db: typeof import('../../src/db/client.js');
  let pruneOldData: typeof import('../../src/db/retention.js').pruneOldData;
  let PERMANENT_RETENTION_TABLES: typeof import('../../src/db/retention.js').PERMANENT_RETENTION_TABLES;
  let RETENTION_JOB_INTERVAL_MS: typeof import('../../src/db/retention.js').RETENTION_JOB_INTERVAL_MS;
  let retentionPolicyTable: typeof import('../../src/db/retention.js').retentionPolicyTable;
  let active: string;
  let dormant: string;
  let researchToken: string;

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    ({
      pruneOldData,
      PERMANENT_RETENTION_TABLES,
      RETENTION_JOB_INTERVAL_MS,
      retentionPolicyTable,
    } = await import('../../src/db/retention.js'));
    const { upsertDiscoveredToken } = await import('../../src/services/token-service.js');
    await migrate(process.env.DATABASE_URL);
    await db.query(`
      TRUNCATE market_snapshots, trade_events, feature_snapshots,
               token_raw_feature_observations, token_outcome_checkpoints,
               token_outcome_summaries, token_decision_feature_snapshots,
               token_decision_audits, token_discovery_events, bot_events,
               missed_opportunities, tokens, retention_runs
      CASCADE`);

    const token = (address: string) =>
      upsertDiscoveredToken({
        chain: 'solana',
        address,
        symbol: 'R',
        name: 'R',
        decimals: 9,
        createdAt: null,
      });
    active = (await token('Retain111111111111111111111111111111111111'))!;
    dormant = (await token('Retain222222222222222222222222222222222222'))!;
    researchToken = (await token('Retain333333333333333333333333333333333333'))!;

    const snap = (tokenId: string, minutesAgo: number) =>
      db.query(
        `INSERT INTO market_snapshots (token_id, price_usd, data_mode, observed_at)
         VALUES ($1, 1, 'demo', NOW() - ($2::text || ' minutes')::interval)`,
        [tokenId, String(minutesAgo)],
      );
    for (const m of [600, 300, 60, 10]) await snap(active, m);
    for (const m of [600, 480]) await snap(dormant, m);
    for (const m of [600, 10]) {
      await db.query(
        `INSERT INTO trade_events (token_id, data_mode, observed_at, source)
         VALUES ($1, 'demo', NOW() - ($2::text || ' minutes')::interval, 'test')`,
        [active, String(m)],
      );
    }

    // Sampled raw research: 10h survives the 24h window, 30h does not.
    await db.query(
      `INSERT INTO token_raw_feature_observations (token_id, features, data_mode, observed_at)
       VALUES ($1, '{"mid":true}'::jsonb, 'demo', NOW() - INTERVAL '10 hours'),
              ($1, '{"old":true}'::jsonb, 'demo', NOW() - INTERVAL '30 hours')`,
      [researchToken],
    );

    const { rows: auditRows } = await db.query<{ id: string }>(
      `INSERT INTO token_decision_audits (
         token_id, stage, result, reason_code, details, data_mode, decided_at
       ) VALUES ($1, 'SIGNAL', 'FAIL', 'SCORE_BELOW_THRESHOLD', '{}'::jsonb, 'demo', NOW())
       RETURNING id`,
      [researchToken],
    );
    const decisionId = auditRows[0]!.id;
    // Past the research period (8d) → prunable compact research.
    await db.query(
      `INSERT INTO token_decision_audits (
         token_id, stage, result, reason_code, details, data_mode, decided_at
       ) VALUES ($1, 'SIGNAL', 'FAIL', 'SCORE_BELOW_THRESHOLD', '{}'::jsonb, 'demo', NOW() - INTERVAL '10 days')`,
      [researchToken],
    );
    await db.query(
      `INSERT INTO token_decision_feature_snapshots (
         token_id, decision_id, stage, features, data_mode, observed_at
       ) VALUES ($1, $2, 'SIGNAL', '{"keep":true}'::jsonb, 'demo', NOW() - INTERVAL '100 hours')`,
      [researchToken, decisionId],
    );
    await db.query(
      `INSERT INTO token_outcome_summaries (
         token_id, decision_id, classification, decision_price,
         peak_price_24h, lowest_price_24h, payload, data_mode
       ) VALUES ($1, $2, 'SUCCESSFUL_REJECTION', 1, 1.1, 0.9, '{}'::jsonb, 'demo')`,
      [researchToken, decisionId],
    );
    await db.query(
      `INSERT INTO token_outcome_checkpoints (
         token_id, decision_id, checkpoint_label, due_at, observed_at, status, price_usd, data_mode
       ) VALUES
         ($1, $2, '24h', NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours', 'COMPACTED', 1.05, 'demo'),
         ($1, $2, '5m', NOW() - INTERVAL '30 hours', NULL, 'PENDING', NULL, 'demo')`,
      [researchToken, decisionId],
    );

    await db.query(
      `INSERT INTO token_discovery_events (
         token_id, discovery_source, observed_at, payload, data_mode
       ) VALUES ($1, 'METEORA_DBC', NOW() - INTERVAL '100 hours', '{"keep":true}'::jsonb, 'demo')`,
      [researchToken],
    );

    await db.query(
      `INSERT INTO bot_events (level, category, message, created_at, data_mode)
       VALUES ('info', 'test', 'old log', NOW() - INTERVAL '4 days', 'demo'),
              ('info', 'test', 'recent log', NOW() - INTERVAL '1 days', 'demo')`,
    );
  }, 60_000);

  afterAll(async () => {
    await db.closePool();
  });

  it('runs the primary cleanup job every 5 minutes', () => {
    expect(RETENTION_JOB_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('documents raw / research / compact-research / permanent windows', () => {
    const policy = retentionPolicyTable('NORMAL');
    const byTable = Object.fromEntries(policy.map((p) => [p.table, p]));
    expect(byTable.market_snapshots?.retention).toMatch(/^20m/);
    expect(byTable.trade_events?.retention).toBe('30m');
    expect(byTable.token_raw_feature_observations?.retention).toMatch(/^24h/);
    expect(byTable.token_outcome_checkpoints?.retention).toMatch(/24h/);
    expect(byTable.bot_events?.retention).toBe('72h');
    expect(byTable.token_decision_audits?.retention).toMatch(/^8d/);
    expect(byTable.token_discovery_events?.retention).toMatch(/^8d/);
    expect(byTable.token_outcome_summaries?.permanent).toBe(true);
    expect(byTable.tokens?.permanent).toBe(true);
    expect(byTable.positions?.permanent).toBe(true);
  });

  it('prunes raw data by its short window (keep latest/token), research by 24h, compact by 8d', async () => {
    const deleted = await pruneOldData(new Date(), 'NORMAL');
    expect(deleted.market_snapshots).toBe(4);
    expect(deleted.trade_events).toBe(1);
    expect(deleted.token_raw_feature_observations).toBe(1);
    expect(deleted.token_outcome_checkpoints).toBe(1);
    expect(deleted.bot_events).toBe(1);
    expect(deleted.token_decision_audits).toBe(1);

    const { rows: snaps } = await db.query<{ token_id: string; minutes: number }>(
      `SELECT token_id, ROUND(EXTRACT(EPOCH FROM NOW() - observed_at) / 60)::int AS minutes
       FROM market_snapshots ORDER BY token_id, observed_at`,
    );
    expect(snaps.filter((r) => r.token_id === active).map((r) => r.minutes)).toEqual([10]);
    expect(snaps.filter((r) => r.token_id === dormant).map((r) => r.minutes)).toEqual([480]);

    const { rows: research } = await db.query<{ features: { mid?: boolean; old?: boolean } }>(
      `SELECT features FROM token_raw_feature_observations WHERE token_id = $1`,
      [researchToken],
    );
    expect(research).toHaveLength(1);
    expect(research[0]!.features.mid).toBe(true);

    const { rows: cps } = await db.query<{ status: string }>(
      `SELECT status FROM token_outcome_checkpoints WHERE token_id = $1`,
      [researchToken],
    );
    expect(cps.map((c) => c.status)).toEqual(['PENDING']);

    const { rows: logs } = await db.query<{ message: string }>(
      `SELECT message FROM bot_events WHERE category = 'test' ORDER BY created_at`,
    );
    expect(logs.map((r) => r.message)).toEqual(['recent log']);
  });

  it('keeps compact research inside the research period and permanent rows forever', async () => {
    const count = async (sql: string) =>
      Number((await db.query<{ c: string }>(sql, [researchToken])).rows[0]!.c);
    expect(await count(`SELECT COUNT(*)::text AS c FROM token_decision_audits WHERE token_id = $1`)).toBe(1);
    expect(
      await count(`SELECT COUNT(*)::text AS c FROM token_decision_feature_snapshots WHERE token_id = $1`),
    ).toBe(1);
    expect(await count(`SELECT COUNT(*)::text AS c FROM token_outcome_summaries WHERE token_id = $1`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::text AS c FROM token_discovery_events WHERE token_id = $1`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::text AS c FROM tokens WHERE id = $1`)).toBe(1);

    expect(PERMANENT_RETENTION_TABLES).toEqual(
      expect.arrayContaining(['tokens', 'positions', 'token_outcome_summaries', 'paper_orders']),
    );
  });

  it('defaults: RAW=3h RESEARCH=24h EVENT=3d COMPACT=8d', async () => {
    const { env } = await import('../../src/config/env.js');
    expect(env.RAW_DATA_RETENTION_HOURS).toBe(3);
    expect(env.RESEARCH_DATA_RETENTION_HOURS).toBe(24);
    expect(env.EVENT_RETENTION_DAYS).toBe(3);
    expect(env.COMPACT_RESEARCH_RETENTION_DAYS).toBe(8);
  });
});
