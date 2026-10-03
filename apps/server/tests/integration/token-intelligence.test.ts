import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.RAW_DATA_RETENTION_HOURS = '72';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

/** SPEC-like Meteora DBC fixture — tests only. */
const SPEC_LIKE = {
  address: '2AVjqmGbMqg7rSyHVv2deVdggsBgBtu1Bi69BUvE5WRv',
  pool: '6V4y6MoSGgaF8d5Hew49RxQ8qE1XLVXBtxfee24w8VWq',
  symbol: 'SPECL',
  name: 'SpecLikeFixture',
};

describe('integration: token intelligence + meteora discovery ledger', () => {
  let db: typeof import('../../src/db/client.js');
  let upsertDiscoveredToken: typeof import('../../src/services/token-service.js').upsertDiscoveredToken;
  let onTokenDiscovered: typeof import('../../src/intelligence/hooks.js').onTokenDiscovered;
  let auditSignalRejection: typeof import('../../src/intelligence/hooks.js').auditSignalRejection;
  let auditRiskDecision: typeof import('../../src/intelligence/hooks.js').auditRiskDecision;
  let scheduleOutcomeCheckpoints: typeof import('../../src/intelligence/outcomes.js').scheduleOutcomeCheckpoints;
  let captureDueOutcomeCheckpoints: typeof import('../../src/intelligence/outcomes.js').captureDueOutcomeCheckpoints;
  let pruneOldData: typeof import('../../src/db/retention.js').pruneOldData;
  let PERMANENT_RETENTION_TABLES: typeof import('../../src/db/retention.js').PERMANENT_RETENTION_TABLES;
  let getStorageMonitor: typeof import('../../src/intelligence/storage.js').getStorageMonitor;
  let recordSourceSuccess: typeof import('../../src/intelligence/source-health.js').recordSourceSuccess;
  let recordSourceFailure: typeof import('../../src/intelligence/source-health.js').recordSourceFailure;
  let listSourceHealth: typeof import('../../src/intelligence/source-health.js').listSourceHealth;
  let AggregatedDiscoveryProvider: typeof import('../../src/providers/discovery/multi-source.js').AggregatedDiscoveryProvider;
  let tokenId: string;

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    ({ upsertDiscoveredToken } = await import('../../src/services/token-service.js'));
    ({
      onTokenDiscovered,
      auditSignalRejection,
      auditRiskDecision,
    } = await import('../../src/intelligence/hooks.js'));
    ({ scheduleOutcomeCheckpoints, captureDueOutcomeCheckpoints } = await import(
      '../../src/intelligence/outcomes.js'
    ));
    ({ pruneOldData, PERMANENT_RETENTION_TABLES } = await import('../../src/db/retention.js'));
    ({ getStorageMonitor } = await import('../../src/intelligence/storage.js'));
    ({ recordSourceSuccess, recordSourceFailure, listSourceHealth } = await import(
      '../../src/intelligence/source-health.js'
    ));
    ({ AggregatedDiscoveryProvider } = await import('../../src/providers/discovery/multi-source.js'));

    await db.query(`
      TRUNCATE token_outcome_checkpoints, token_outcome_summaries,
               token_decision_feature_snapshots, token_decision_audits,
               token_discovery_events, token_raw_feature_observations,
               market_snapshots, tokens, discovery_source_health, retention_runs
      CASCADE`);
  }, 60_000);

  afterAll(async () => {
    await db.closePool();
  });

  it('1-3: records Meteora DBC discovery before and after migration semantics', async () => {
    const pre = {
      chain: 'solana' as const,
      address: SPEC_LIKE.address,
      symbol: SPEC_LIKE.symbol,
      name: SPEC_LIKE.name,
      decimals: 6,
      createdAt: new Date(),
      discoverySource: 'METEORA_DBC' as const,
      poolAddress: SPEC_LIKE.pool,
      dexVenue: 'meteora_dbc',
      metadata: {
        launchMechanism: 'meteora_dbc',
        dbcStatus: 'PRE_BONDING_CURVE',
        migrationStatus: 'NOT_MIGRATED',
        preMigration: true,
      },
    };
    tokenId = (await upsertDiscoveredToken(pre))!;
    await onTokenDiscovered(pre, tokenId, true);

    const { rows } = await db.query<{
      discovery_source: string;
      dex_venue: string;
      dbc_status: string;
      migration_status: string;
      discovery_sources: string[];
    }>(`SELECT discovery_source, dex_venue, dbc_status, migration_status, discovery_sources FROM tokens WHERE id = $1`, [
      tokenId,
    ]);
    expect(rows[0]!.discovery_source).toBe('METEORA_DBC');
    expect(rows[0]!.dex_venue).toBe('meteora_dbc');
    expect(rows[0]!.dbc_status).toBe('PRE_BONDING_CURVE');
    expect(rows[0]!.migration_status).toBe('NOT_MIGRATED');

    // After migration: same mint, venue becomes meteora_damm
    const post = {
      ...pre,
      dexVenue: 'meteora_damm',
      migrationAt: new Date(),
      metadata: {
        launchMechanism: 'meteora_dbc',
        dbcStatus: 'CREATED_POOL',
        migrationStatus: 'MIGRATED',
        postMigrationVenue: 'meteora_damm',
      },
    };
    await upsertDiscoveredToken(post);
    await onTokenDiscovered(post, tokenId, false);
    const after = await db.query<{ dex_venue: string; migration_status: string }>(
      `SELECT dex_venue, migration_status FROM tokens WHERE id = $1`,
      [tokenId],
    );
    expect(after.rows[0]!.dex_venue).toBe('meteora_damm');
    expect(after.rows[0]!.migration_status).toBe('MIGRATED');
  });

  it('4-7: deduplicates multi-source discovery and persists all sources + venue', async () => {
    const gecko = {
      chain: 'solana' as const,
      address: SPEC_LIKE.address,
      symbol: SPEC_LIKE.symbol,
      name: SPEC_LIKE.name,
      decimals: 6,
      createdAt: new Date(),
      discoverySource: 'GECKO_NEW_POOL' as const,
      poolAddress: SPEC_LIKE.pool,
      dexVenue: 'meteora_damm',
      metadata: { gecko: true },
    };
    const boost = {
      ...gecko,
      discoverySource: 'DEXSCREENER_BOOST' as const,
      dexVenue: null,
      metadata: { paidBoost: true },
    };
    await upsertDiscoveredToken(gecko);
    await onTokenDiscovered(gecko, tokenId, false);
    await upsertDiscoveredToken(boost);
    await onTokenDiscovered(boost, tokenId, false);

    const { rows } = await db.query<{ discovery_sources: string[]; c: string }>(
      `SELECT discovery_sources,
              (SELECT COUNT(*)::text FROM token_discovery_events WHERE token_id = $1) AS c
       FROM tokens WHERE id = $1`,
      [tokenId],
    );
    const sources = rows[0]!.discovery_sources;
    expect(sources).toEqual(expect.arrayContaining(['METEORA_DBC', 'GECKO_NEW_POOL', 'DEXSCREENER_BOOST']));
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(3);

    // Only one token row for the mint
    const uniq = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tokens WHERE address = $1 AND data_mode = 'demo'`,
      [SPEC_LIKE.address],
    );
    expect(Number(uniq.rows[0]!.c)).toBe(1);
  });

  it('8-12: persists eligibility/signal/risk/position-cap reasons + feature snapshots', async () => {
    const features = {
      liquidity: 17400,
      marketCap: 3_440_000,
      ageMinutes: 219,
      modelScore: 0.41,
      price: 0.003439,
    };
    await auditSignalRejection({
      tokenId,
      funnelCategory: 'lowLiquidity',
      score: 0.41,
      threshold: 0.6,
      features,
    });
    await auditSignalRejection({
      tokenId,
      strategyReasons: ['overall_score_low'],
      score: 0.35,
      features,
    });
    await auditRiskDecision({
      tokenId,
      rejected: true,
      riskReason: 'maxOpenPositions',
      actual: { openPositions: 5 },
      required: { maxOpenPositions: 5 },
      features,
    });

    const { rows } = await db.query<{ stage: string; reason_code: string }>(
      `SELECT stage, reason_code FROM token_decision_audits
       WHERE token_id = $1 AND result = 'FAIL' ORDER BY decided_at`,
      [tokenId],
    );
    const codes = rows.map((r) => r.reason_code);
    expect(codes).toContain('LIQUIDITY_TOO_LOW');
    expect(codes).toContain('SCORE_BELOW_THRESHOLD');
    expect(codes).toContain('MAX_OPEN_POSITIONS');
    expect(rows.some((r) => r.stage === 'POSITION_CAPACITY')).toBe(true);

    const feats = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_decision_feature_snapshots WHERE token_id = $1`,
      [tokenId],
    );
    expect(Number(feats.rows[0]!.c)).toBeGreaterThanOrEqual(3);
  });

  it('13: stores post-decision outcome checkpoints', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM token_decision_audits WHERE token_id = $1 ORDER BY decided_at DESC LIMIT 1`,
      [tokenId],
    );
    const decisionId = rows[0]!.id;
    // Hooks already schedule checkpoints on reject; force a subset due now for capture.
    const n = await scheduleOutcomeCheckpoints({
      tokenId,
      decisionId,
      decisionPrice: 0.003439,
      decisionMarketCap: 3_440_000,
      decisionLiquidity: 17400,
      now: new Date(),
    });
    expect(n).toBe(8);
    await db.query(
      `UPDATE token_outcome_checkpoints
       SET due_at = NOW() - INTERVAL '1 minute', status = 'PENDING'
       WHERE token_id = $1 AND decision_id = $2
         AND checkpoint_label IN ('5m','15m','30m')`,
      [tokenId, decisionId],
    );

    // Seed a market snapshot so capture can succeed for due checkpoints
    await db.query(
      `INSERT INTO market_snapshots (token_id, price_usd, market_cap_usd, liquidity_usd, volume_24h_usd, data_mode, observed_at)
       VALUES ($1, 0.01, 10000000, 500000, 1000000, 'demo', NOW())`,
      [tokenId],
    );
    const captured = await captureDueOutcomeCheckpoints(new Date());
    expect(captured).toBeGreaterThan(0);
  });

  it('14-15: raw snapshot cleanup preserves permanent intelligence records', async () => {
    await db.query(
      `INSERT INTO token_raw_feature_observations (token_id, features, data_mode, observed_at)
       VALUES ($1, '{"x":1}'::jsonb, 'demo', NOW() - INTERVAL '100 hours')`,
      [tokenId],
    );
    await db.query(
      `INSERT INTO market_snapshots (token_id, price_usd, data_mode, observed_at)
       VALUES ($1, 1, 'demo', NOW() - INTERVAL '100 hours'),
              ($1, 2, 'demo', NOW() - INTERVAL '1 hours')`,
      [tokenId],
    );

    const beforeDecisions = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_decision_audits WHERE token_id = $1`,
      [tokenId],
    );
    const beforeEvents = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_discovery_events WHERE token_id = $1`,
      [tokenId],
    );
    const beforeToken = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tokens WHERE id = $1`,
      [tokenId],
    );

    const deleted = await pruneOldData();
    expect(deleted.token_raw_feature_observations).toBeGreaterThanOrEqual(1);
    expect(deleted.market_snapshots).toBeGreaterThanOrEqual(1);

    const afterDecisions = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_decision_audits WHERE token_id = $1`,
      [tokenId],
    );
    const afterEvents = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM token_discovery_events WHERE token_id = $1`,
      [tokenId],
    );
    const afterToken = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tokens WHERE id = $1`,
      [tokenId],
    );
    expect(afterDecisions.rows[0]!.c).toBe(beforeDecisions.rows[0]!.c);
    expect(afterEvents.rows[0]!.c).toBe(beforeEvents.rows[0]!.c);
    expect(afterToken.rows[0]!.c).toBe(beforeToken.rows[0]!.c);
    expect(PERMANENT_RETENTION_TABLES).toContain('token_decision_audits');
    expect(PERMANENT_RETENTION_TABLES).toContain('tokens');
  });

  it('16-17: source failure isolation + aggregated polling still returns other sources', async () => {
    const okProvider = {
      name: 'dexscreener-boosts',
      dataMode: 'live' as const,
      async subscribe() {},
      async getRecentTokens() {
        return [
          {
            chain: 'solana' as const,
            address: 'BoostAddr11111111111111111111111111111111',
            symbol: 'BST',
            name: 'Boost',
            decimals: 9,
            createdAt: null,
            discoverySource: 'DEXSCREENER_BOOST' as const,
          },
        ];
      },
    };
    const badProvider = {
      name: 'meteora-dbc',
      dataMode: 'live' as const,
      async subscribe() {},
      async getRecentTokens() {
        throw new Error('simulated meteora outage');
      },
    };
    const agg = new AggregatedDiscoveryProvider([okProvider, badProvider]);
    const tokens = await agg.getRecentTokens();
    expect(tokens.some((t) => t.discoverySource === 'DEXSCREENER_BOOST')).toBe(true);

    await recordSourceSuccess('dexscreener-boosts', 1);
    await recordSourceFailure('meteora-dbc', new Error('simulated meteora outage'));
    const health = await listSourceHealth();
    const meteora = health.find((h) => h.sourceKey === 'meteora_dbc');
    const boosts = health.find((h) => h.sourceKey === 'dexscreener_boosts');
    expect(meteora?.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(boosts?.consecutiveFailures).toBe(0);
  });

  it('19: storage/record-count monitoring reports major tables', async () => {
    const mon = await getStorageMonitor();
    expect(mon.counts.tokens).toBeGreaterThanOrEqual(1);
    expect(mon.counts.token_decision_audits).toBeGreaterThanOrEqual(1);
    expect(mon.softLimitBytes).toBeGreaterThan(0);
    expect(mon.permanentTables).toContain('token_discovery_events');
  });

  it('max open positions remains exactly 5', async () => {
    const { env } = await import('../../src/config/env.js');
    expect(env.MAX_SIMULTANEOUS_POSITIONS).toBe(5);
  });
});
