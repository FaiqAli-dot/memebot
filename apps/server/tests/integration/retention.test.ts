import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.RAW_DATA_RETENTION_HOURS = '3';
process.env.RESEARCH_DATA_RETENTION_HOURS = '72';
process.env.EVENT_RETENTION_DAYS = '3';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

describe('integration: split retention (3h HF / 72h research / 3d logs)', () => {
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

    const snap = (tokenId: string, hoursAgo: number) =>
      db.query(
        `INSERT INTO market_snapshots (token_id, price_usd, data_mode, observed_at)
         VALUES ($1, 1, 'demo', NOW() - ($2::text || ' hours')::interval)`,
        [tokenId, String(hoursAgo)],
      );
    for (const h of [10, 5, 1]) await snap(active, h);
    for (const h of [10, 8]) await snap(dormant, h);
    for (const h of [10, 1]) {
      await db.query(
        `INSERT INTO trade_events (token_id, data_mode, observed_at, source)
         VALUES ($1, 'demo', NOW() - ($2::text || ' hours')::interval, 'test')`,
        [active, String(h)],
      );
    }

    // Research raw: mid-age (10h) must survive 3h HF prune; old (80h) must go at 72h.
    await db.query(
      `INSERT INTO token_raw_feature_observations (token_id, features, data_mode, observed_at)
       VALUES ($1, '{"mid":true}'::jsonb, 'demo', NOW() - INTERVAL '10 hours'),
              ($1, '{"old":true}'::jsonb, 'demo', NOW() - INTERVAL '80 hours')`,
      [researchToken],
    );

    // Compacted checkpoint older than 72h → prunable; PENDING old → must survive.
    const { rows: auditRows } = await db.query<{ id: string }>(
      `INSERT INTO token_decision_audits (
         token_id, stage, result, reason_code, details, data_mode, decided_at
       ) VALUES ($1, 'SIGNAL', 'FAIL', 'SCORE_BELOW_THRESHOLD', '{}'::jsonb, 'demo', NOW())
       RETURNING id`,
      [researchToken],
    );
    const decisionId = auditRows[0]!.id;
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
         ($1, $2, '24h', NOW() - INTERVAL '80 hours', NOW() - INTERVAL '80 hours', 'COMPACTED', 1.05, 'demo'),
         ($1, $2, '5m', NOW() - INTERVAL '80 hours', NULL, 'PENDING', NULL, 'demo')`,
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

  it('runs the primary cleanup job every 15 minutes', () => {
    expect(RETENTION_JOB_INTERVAL_MS).toBe(15 * 60_000);
  });

  it('documents HF 3h / research 72h / events 3d / permanent tables', () => {
    const policy = retentionPolicyTable();
    const byTable = Object.fromEntries(policy.map((p) => [p.table, p]));
    expect(byTable.market_snapshots?.retention).toMatch(/^3h/);
    expect(byTable.trade_events?.retention).toBe('3h');
    expect(byTable.token_raw_feature_observations?.retention).toBe('72h');
    expect(byTable.token_outcome_checkpoints?.retention).toMatch(/72h/);
    expect(byTable.bot_events?.retention).toBe('3d');
    expect(byTable.token_decision_audits?.permanent).toBe(true);
    expect(byTable.token_outcome_summaries?.permanent).toBe(true);
    expect(byTable.tokens?.permanent).toBe(true);
    expect(byTable.token_discovery_events?.permanent).toBe(true);
  });

  it('prunes HF raw past 3h (keep latest/token) but not research mid-age rows', async () => {
    const deleted = await pruneOldData();
    expect(deleted.market_snapshots).toBe(3);
    expect(deleted.trade_events).toBe(1);
    // 80h research row deleted; 10h research row kept
    expect(deleted.token_raw_feature_observations).toBe(1);
    // Compacted 80h checkpoint pruned; PENDING survives
    expect(deleted.token_outcome_checkpoints).toBe(1);
    // Logs older than 3 days
    expect(deleted.bot_events).toBe(1);

    const { rows: snaps } = await db.query<{ token_id: string; hours: number }>(
      `SELECT token_id, ROUND(EXTRACT(EPOCH FROM NOW() - observed_at) / 3600)::int AS hours
       FROM market_snapshots ORDER BY token_id, observed_at`,
    );
    expect(snaps.filter((r) => r.token_id === active).map((r) => r.hours)).toEqual([1]);
    expect(snaps.filter((r) => r.token_id === dormant).map((r) => r.hours)).toEqual([8]);

    const { rows: research } = await db.query<{ features: { mid?: boolean; old?: boolean } }>(
      `SELECT features FROM token_raw_feature_observations WHERE token_id = $1`,
      [researchToken],
    );
    expect(research).toHaveLength(1);
    expect(research[0]!.features.mid).toBe(true);

    const { rows: cps } = await db.query<{ status: string; checkpoint_label: string }>(
      `SELECT status, checkpoint_label FROM token_outcome_checkpoints WHERE token_id = $1`,
      [researchToken],
    );
    expect(cps).toHaveLength(1);
    expect(cps[0]!.status).toBe('PENDING');

    const { rows: logs } = await db.query<{ message: string }>(
      `SELECT message FROM bot_events WHERE category = 'test' ORDER BY created_at`,
    );
    expect(logs.map((r) => r.message)).toEqual(['recent log']);
  });

  it('keeps permanent intelligence rows through both retention windows', async () => {
    const audits = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_decision_audits WHERE token_id = $1`,
      [researchToken],
    );
    const feats = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_decision_feature_snapshots WHERE token_id = $1`,
      [researchToken],
    );
    const summaries = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_outcome_summaries WHERE token_id = $1`,
      [researchToken],
    );
    const events = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_discovery_events WHERE token_id = $1`,
      [researchToken],
    );
    const tokens = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tokens WHERE id = $1`,
      [researchToken],
    );
    expect(Number(audits.rows[0]!.c)).toBeGreaterThanOrEqual(1);
    expect(Number(feats.rows[0]!.c)).toBeGreaterThanOrEqual(1);
    expect(Number(summaries.rows[0]!.c)).toBeGreaterThanOrEqual(1);
    expect(Number(events.rows[0]!.c)).toBeGreaterThanOrEqual(1);
    expect(Number(tokens.rows[0]!.c)).toBe(1);

    expect(PERMANENT_RETENTION_TABLES).toEqual(
      expect.arrayContaining([
        'tokens',
        'token_discovery_events',
        'token_decision_audits',
        'token_decision_feature_snapshots',
        'token_outcome_summaries',
        'positions',
      ]),
    );
  });

  it('defaults match owner review: RAW=3 RESEARCH=72 EVENT=3', async () => {
    const { env } = await import('../../src/config/env.js');
    expect(env.RAW_DATA_RETENTION_HOURS).toBe(3);
    expect(env.RESEARCH_DATA_RETENTION_HOURS).toBe(72);
    expect(env.EVENT_RETENTION_DAYS).toBe(3);
  });
});
