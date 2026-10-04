import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
for (const k of [
  'RAW_DATA_RETENTION_HOURS',
  'RESEARCH_DATA_RETENTION_HOURS',
  'EVENT_RETENTION_DAYS',
  'COMPACT_RESEARCH_RETENTION_DAYS',
  'MARKET_SNAPSHOT_FULL_RES_MINUTES',
  'TRADE_EVENTS_RETENTION_MINUTES',
  'SAFETY_RETENTION_MINUTES',
  'STORAGE_LIMIT_MB',
  'STORAGE_WARNING_MB',
  'STORAGE_AGGRESSIVE_MB',
  'STORAGE_EMERGENCY_MB',
  'STORAGE_STOP_WRITES_MB',
]) {
  delete process.env[k];
}
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

const TOKENS = 20;
const SIM_HOURS = 12;
/** One market tick per token every 30s, matching the live tracker cadence. */
const TICKS_PER_HOUR = 120;

describe('integration: storage retention under simulated high-frequency writes', () => {
  let db: typeof import('../../src/db/client.js');
  let retention: typeof import('../../src/db/retention.js');
  let guard: typeof import('../../src/db/storage-guard.js');
  let classes: typeof import('../../src/db/data-classes.js');
  let tokenIds: string[] = [];
  let inUseToken: string;
  let portfolioId: string;
  let closedPositionId: string;

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query<{ c: string }>(sql, params)).rows[0]!.c);

  /** Writes SIM_HOURS of raw history for every token, timestamps relative to NOW(). */
  async function simulateHighFrequencyWrites(offsetHours = 0): Promise<void> {
    await db.query(
      `INSERT INTO market_snapshots (token_id, price_usd, liquidity_usd, volume_5m_usd, data_mode, observed_at)
       SELECT t, 1 + random(), 50000, 1000, 'demo', NOW() + ($3::int * INTERVAL '1 hour') - (s * INTERVAL '30 seconds')
       FROM unnest($1::uuid[]) AS t, generate_series(1, $2::int) AS s`,
      [tokenIds, SIM_HOURS * TICKS_PER_HOUR, offsetHours],
    );
    await db.query(
      `INSERT INTO trade_events (token_id, data_mode, observed_at, source)
       SELECT t, 'demo', NOW() + ($3::int * INTERVAL '1 hour') - (s * INTERVAL '1 minute'), 'sim'
       FROM unnest($1::uuid[]) AS t, generate_series(1, $2::int) AS s`,
      [tokenIds, SIM_HOURS * 60, offsetHours],
    );
    await db.query(
      `INSERT INTO safety_assessments (token_id, score, safety_class, version, data_mode, assessed_at)
       SELECT t, 0.5, 'OK', 'sim', 'demo', NOW() + ($3::int * INTERVAL '1 hour') - (s * INTERVAL '2 minutes')
       FROM unnest($1::uuid[]) AS t, generate_series(1, $2::int) AS s`,
      [tokenIds, SIM_HOURS * 30, offsetHours],
    );
    await db.query(
      `INSERT INTO token_raw_feature_observations (token_id, features, data_mode, observed_at)
       SELECT t, '{"sim":true}'::jsonb, 'demo', NOW() + ($3::int * INTERVAL '1 hour') - (s * INTERVAL '15 minutes')
       FROM unnest($1::uuid[]) AS t, generate_series(1, $2::int) AS s`,
      [tokenIds, 4 * 30, offsetHours],
    );
    await db.query(
      `INSERT INTO token_phases (token_id, phase, data_mode, observed_at)
       SELECT t, 'SIM', 'demo', NOW() + ($3::int * INTERVAL '1 hour') - (s * INTERVAL '10 minutes')
       FROM unnest($1::uuid[]) AS t, generate_series(1, $2::int) AS s`,
      [tokenIds, 6 * 30, offsetHours],
    );
  }

  const rawRows = () =>
    count(
      `SELECT (SELECT COUNT(*) FROM market_snapshots) + (SELECT COUNT(*) FROM trade_events)
            + (SELECT COUNT(*) FROM safety_assessments) + (SELECT COUNT(*) FROM token_phases)
            + (SELECT COUNT(*) FROM token_raw_feature_observations) AS c`,
    );

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    retention = await import('../../src/db/retention.js');
    guard = await import('../../src/db/storage-guard.js');
    classes = await import('../../src/db/data-classes.js');
    const { upsertDiscoveredToken } = await import('../../src/services/token-service.js');
    const portfolios = await import('../../src/services/portfolio-service.js');

    await db.query(`
      TRUNCATE market_snapshots, trade_events, safety_assessments, token_phases,
               token_raw_feature_observations, token_decision_audits, token_decision_feature_snapshots,
               token_discovery_events, token_outcome_checkpoints, token_outcome_summaries,
               missed_opportunities, shadow_trades, opportunity_trackers, positions, tokens, retention_runs
      CASCADE`);
    portfolioId = await portfolios.ensureDefaultPortfolio();

    tokenIds = [];
    for (let i = 0; i < TOKENS; i++) {
      const id = await upsertDiscoveredToken({
        chain: 'solana',
        address: `StorSim${String(i).padStart(2, '0')}11111111111111111111111111111111`.slice(0, 44),
        symbol: `S${i}`,
        name: `Sim ${i}`,
        decimals: 9,
        createdAt: null,
      });
      tokenIds.push(id!);
    }
    inUseToken = tokenIds[0]!;

    const position = (status: 'OPEN' | 'CLOSED', tokenId: string, hoursAgo: number) =>
      db.query<{ id: string }>(
        `INSERT INTO positions (
           portfolio_id, token_id, status, quantity, entry_price_usd, current_price_usd, cost_basis_usd,
           current_value_usd, stop_loss_pct, take_profit_pct, highest_price_usd, opened_at, closed_at, data_mode
         ) VALUES ($1, $2, $3, 10, 1, 1, 10, 10, 0.08, 0.2, 1,
                   NOW() - ($4::text || ' hours')::interval,
                   CASE WHEN $3 = 'CLOSED' THEN NOW() - ($4::text || ' hours')::interval + INTERVAL '5 minutes' END,
                   'demo')
         RETURNING id`,
        [portfolioId, tokenId, status, String(hoursAgo)],
      );
    await position('OPEN', inUseToken, 2);
    closedPositionId = (await position('CLOSED', tokenIds[1]!, 200)).rows[0]!.id;

    // Compact research from earlier in the research period.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO token_decision_audits (token_id, stage, result, reason_code, details, data_mode, decided_at)
       SELECT t, 'RISK', 'FAIL', 'EV_TOO_LOW', '{}'::jsonb, 'demo', NOW() - INTERVAL '3 days'
       FROM unnest($1::uuid[]) AS t RETURNING id`,
      [tokenIds],
    );
    await db.query(
      `INSERT INTO token_outcome_summaries (token_id, decision_id, classification, decision_price,
         peak_price_24h, lowest_price_24h, payload, data_mode)
       SELECT a.token_id, a.id, 'SUCCESSFUL_REJECTION', 1, 1.2, 0.8, '{}'::jsonb, 'demo'
       FROM token_decision_audits a WHERE a.id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    await db.query(
      `INSERT INTO token_discovery_events (token_id, discovery_source, observed_at, payload, data_mode)
       SELECT t, 'METEORA_DBC', NOW() - INTERVAL '5 days', '{}'::jsonb, 'demo' FROM unnest($1::uuid[]) AS t`,
      [tokenIds],
    );
  }, 120_000);

  afterEach(() => {
    guard.setStorageStateForTests(null);
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('classifies every table into exactly one data class; cleanup never touches CRITICAL', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const all = [
      ...classes.CRITICAL_TABLES,
      ...classes.COMPACT_RESEARCH_TABLES,
      ...classes.RESEARCH_TABLES,
      ...classes.OPERATIONAL_TABLES,
    ] as string[];
    expect(new Set(all).size).toBe(all.length);
    const unclassified = rows.map((r) => r.table_name).filter((t) => !all.includes(t));
    expect(unclassified).toEqual([]);

    for (const t of retention.PRUNABLE_TABLES) {
      expect(classes.dataClassOf(t)).not.toBe('CRITICAL');
    }
    for (const t of classes.CRITICAL_TABLES) {
      expect(retention.PERMANENT_RETENTION_TABLES as readonly string[]).toContain(t);
    }
  });

  it('raw data expires while compact research and critical data remain', async () => {
    await simulateHighFrequencyWrites();
    const before = await rawRows();
    expect(before).toBeGreaterThan(TOKENS * SIM_HOURS * TICKS_PER_HOUR);
    // Lifecycle audits duplicate the tokens table; they only live for the 24h research window.
    await db.query(
      `INSERT INTO token_decision_audits (token_id, stage, result, details, data_mode, decided_at)
       VALUES ($1, 'TRACKED', 'PASS', '{}'::jsonb, 'demo', NOW() - INTERVAL '30 hours')`,
      [tokenIds[2]],
    );

    await retention.pruneOldData(new Date(), 'NORMAL');
    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE stage = 'TRACKED'`)).toBe(0);

    // Idle tokens: only the 20-minute strategy window survives (≈ 40 ticks).
    const idleMax = await count(
      `SELECT COALESCE(MAX(c), 0) AS c FROM (
         SELECT COUNT(*) AS c FROM market_snapshots WHERE token_id <> $1 GROUP BY token_id) x`,
      [inUseToken],
    );
    expect(idleMax).toBeLessThanOrEqual(41);
    expect(
      await count(`SELECT COUNT(*) AS c FROM market_snapshots WHERE observed_at < NOW() - INTERVAL '21 minutes' AND token_id <> $1`, [inUseToken]),
    ).toBe(0);

    // A token with an open position keeps its recent path (≤ 3h), but not the full 12h.
    const inUseRows = await count(`SELECT COUNT(*) AS c FROM market_snapshots WHERE token_id = $1`, [inUseToken]);
    expect(inUseRows).toBeGreaterThan(3 * TICKS_PER_HOUR - 5);
    expect(inUseRows).toBeLessThanOrEqual(3 * TICKS_PER_HOUR + 1);

    expect(await count(`SELECT COUNT(*) AS c FROM trade_events WHERE observed_at < NOW() - INTERVAL '31 minutes'`)).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS c FROM token_raw_feature_observations WHERE observed_at < NOW() - INTERVAL '24 hours 1 minute'`),
    ).toBe(0);
    expect(await count(`SELECT COUNT(*) AS c FROM token_raw_feature_observations`)).toBeGreaterThan(0);

    // Latest safety / phase per token is kept even past the window.
    expect(await count(`SELECT COUNT(DISTINCT token_id) AS c FROM safety_assessments`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(DISTINCT token_id) AS c FROM token_phases`)).toBe(TOKENS);

    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM token_outcome_summaries`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM token_discovery_events`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM tokens WHERE id = ANY($1::uuid[])`, [tokenIds])).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM positions`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS c FROM positions WHERE id = $1`, [closedPositionId])).toBe(1);

    expect(await rawRows()).toBeLessThan(before / 5);
  }, 120_000);

  it('repeated write/prune cycles reach a steady state (no unbounded growth)', async () => {
    const rowCounts: number[] = [];
    const sizes: number[] = [];
    // Each cycle is the next SIM_HOURS of wall-clock time; prune runs "at" the end of the cycle.
    for (let cycle = 1; cycle <= 3; cycle++) {
      const offsetHours = cycle * SIM_HOURS;
      await simulateHighFrequencyWrites(offsetHours);
      await retention.pruneOldData(new Date(Date.now() + offsetHours * 3_600_000), 'NORMAL');
      rowCounts.push(await rawRows());
      sizes.push(await count(`SELECT pg_total_relation_size('market_snapshots') AS c`));
    }
    expect(rowCounts[2]!).toBeLessThanOrEqual(rowCounts[0]! * 1.1);
    // Plain VACUUM after large deletes makes space reusable, so the file stops growing.
    expect(sizes[2]!).toBeLessThanOrEqual(sizes[0]! * 1.5);

    await db.query(
      `TRUNCATE market_snapshots, trade_events, safety_assessments, token_phases, token_raw_feature_observations`,
    );
  }, 180_000);

  it('emergency cleanup activates well before the volume limit', () => {
    const t = guard.storageThresholds();
    expect(t.warning).toBeLessThan(t.aggressive);
    expect(t.aggressive).toBeLessThan(t.emergency);
    expect(t.emergency).toBeLessThan(t.stopWrites);
    expect(t.stopWrites).toBeLessThan(t.limit);

    const MB = 1024 * 1024;
    expect(guard.classifyStorage(250 * MB, t)).toBe('NORMAL');
    expect(guard.classifyStorage(320 * MB, t)).toBe('WARNING');
    expect(guard.classifyStorage(370 * MB, t)).toBe('AGGRESSIVE_CLEANUP');
    expect(guard.classifyStorage(420 * MB, t)).toBe('EMERGENCY_CLEANUP');
    expect(guard.classifyStorage(460 * MB, t)).toBe('STOP_NON_ESSENTIAL_WRITES');

    const normal = retention.retentionWindows('NORMAL');
    const emergency = retention.retentionWindows('EMERGENCY_CLEANUP');
    expect(emergency.rawFeatureHours).toBeLessThan(normal.rawFeatureHours);
    expect(emergency.tradeEventsMinutes).toBeLessThan(normal.tradeEventsMinutes);
    expect(emergency.inUseCapHours).toBeLessThan(normal.inUseCapHours);
    // Research period is never cut, and the strategy's market history window is preserved.
    expect(emergency.compactResearchDays).toBe(normal.compactResearchDays);
    expect(emergency.marketFullResMinutes).toBe(normal.marketFullResMinutes);
  });

  it('emergency prune deletes raw research first and keeps compact + critical data', async () => {
    await simulateHighFrequencyWrites();
    await retention.pruneOldData(new Date(), 'EMERGENCY_CLEANUP');

    expect(await count(`SELECT COUNT(*) AS c FROM token_raw_feature_observations`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS c FROM trade_events`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM token_outcome_summaries`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM token_discovery_events`)).toBe(TOKENS);
    expect(await count(`SELECT COUNT(*) AS c FROM positions`)).toBe(2);
    // Open position still has ~1h of its own price path; every token keeps the strategy window.
    expect(await count(`SELECT COUNT(*) AS c FROM market_snapshots WHERE token_id = $1`, [inUseToken])).toBeGreaterThan(
      TICKS_PER_HOUR - 5,
    );
    expect(
      await count(`SELECT COUNT(*) AS c FROM market_snapshots WHERE token_id = $1 AND observed_at > NOW() - INTERVAL '16 minutes'`, [tokenIds[5]]),
    ).toBeGreaterThan(25);
  }, 120_000);

  it('trading stays operational when research storage is constrained', async () => {
    const { recordDecisionAudit, resetIntelligenceDedupeForTests } = await import('../../src/intelligence/ledger.js');
    const shadow = await import('../../src/research/shadow.js');
    const { insertMarketSnapshot } = await import('../../src/services/token-service.js');
    resetIntelligenceDedupeForTests();
    shadow.resetMissedOpportunityDedupeForTests();
    guard.setStorageStateForTests('STOP_NON_ESSENTIAL_WRITES');
    expect(guard.researchWritesAllowed()).toBe(false);

    const token = tokenIds[3]!;
    const auditsBefore = await count(`SELECT COUNT(*) AS c FROM token_decision_audits`);

    // High-frequency research audit is skipped without throwing.
    await expect(
      recordDecisionAudit({ tokenId: token, stage: 'SIGNAL', result: 'FAIL', reasonCode: 'SCORE_BELOW_THRESHOLD' }),
    ).resolves.toBe('');
    // Trading decisions (risk) are still recorded.
    const riskId = await recordDecisionAudit({ tokenId: token, stage: 'RISK', result: 'FAIL', reasonCode: 'EV_TOO_LOW' });
    expect(riskId).toMatch(/[0-9a-f-]{36}/);
    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits`)).toBe(auditsBefore + 1);

    await expect(
      shadow.recordMissedOpportunity({ portfolioId, tokenId: token, rejectionReason: 'EV_REJECTION' as never }),
    ).resolves.toBeUndefined();
    expect(await count(`SELECT COUNT(*) AS c FROM missed_opportunities`)).toBe(0);

    const res = await shadow.openShadowTrade({
      portfolioId,
      tokenId: token,
      rejectionReason: 'EV_REJECTION' as never,
      cooldownSec: 600,
      sim: {} as never,
    });
    expect(res.status).toBe('STORAGE_PAUSED');

    // Trading-path writes are never gated.
    await insertMarketSnapshot(token, {
      chain: 'solana',
      address: 'x',
      priceUsd: 1.5,
      liquidityUsd: 40000,
      marketCapUsd: 100000,
      volume5mUsd: 1000,
      volume1hUsd: 5000,
      volume24hUsd: 20000,
      buyVolume5mUsd: 600,
      sellVolume5mUsd: 400,
      txCount5m: 12,
      priceChange5mPct: 1,
      priceChange1hPct: 2,
      observedAt: new Date().toISOString(),
    } as never);
    expect(
      await count(`SELECT COUNT(*) AS c FROM market_snapshots WHERE token_id = $1 AND price_usd = 1.5`, [token]),
    ).toBe(1);
    await db.query(
      `UPDATE positions SET current_price_usd = 1.1 WHERE token_id = $1 AND status = 'OPEN'`,
      [inUseToken],
    );
    expect(await count(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN' AND current_price_usd = 1.1`)).toBe(1);
  });

  it('dedupe turns per-tick research writes into one row per decision change', async () => {
    const { recordDecisionAudit, resetIntelligenceDedupeForTests } = await import('../../src/intelligence/ledger.js');
    const shadow = await import('../../src/research/shadow.js');
    resetIntelligenceDedupeForTests();
    shadow.resetMissedOpportunityDedupeForTests();
    const token = tokenIds[4]!;
    const before = await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE token_id = $1`, [token]);

    for (let i = 0; i < 100; i++) {
      await recordDecisionAudit({ tokenId: token, stage: 'SIGNAL', result: 'FAIL', reasonCode: 'SCORE_BELOW_THRESHOLD' });
      await shadow.recordMissedOpportunity({ portfolioId, tokenId: token, rejectionReason: 'EV_REJECTION' as never });
    }
    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE token_id = $1`, [token])).toBe(before + 1);
    expect(await count(`SELECT COUNT(*) AS c FROM missed_opportunities WHERE token_id = $1`, [token])).toBe(1);

    // A changed decision is recorded immediately.
    await recordDecisionAudit({ tokenId: token, stage: 'SIGNAL', result: 'FAIL', reasonCode: 'LIQUIDITY_TOO_LOW' });
    expect(await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE token_id = $1`, [token])).toBe(before + 2);

    // Repeated capacity rejections while slots are full: one row, not one per tick.
    for (let i = 0; i < 50; i++) {
      await recordDecisionAudit({ tokenId: token, stage: 'RISK_GATE', result: 'FAIL', reasonCode: 'INSUFFICIENT_CAPACITY' });
    }
    expect(
      await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE token_id = $1 AND stage = 'RISK_GATE'`, [token]),
    ).toBe(1);
  });

  it('compact research is trimmed oldest-first once it exceeds its MB budget (last 24h kept)', async () => {
    const { env } = await import('../../src/config/env.js');
    const original = env.COMPACT_RESEARCH_BUDGET_MB;
    (env as { COMPACT_RESEARCH_BUDGET_MB: number }).COMPACT_RESEARCH_BUDGET_MB = 0.001;
    try {
      await db.query(`ANALYZE token_decision_audits, token_discovery_events`);
      const recent = await count(
        `SELECT COUNT(*) AS c FROM token_decision_audits WHERE decided_at > NOW() - INTERVAL '24 hours'`,
      );
      expect(recent).toBeGreaterThan(0);
      await retention.pruneOldData(new Date(), 'NORMAL');

      expect(
        await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE decided_at < NOW() - INTERVAL '24 hours'`),
      ).toBe(0);
      expect(await count(`SELECT COUNT(*) AS c FROM token_discovery_events`)).toBe(0);
      expect(
        await count(`SELECT COUNT(*) AS c FROM token_decision_audits WHERE decided_at > NOW() - INTERVAL '24 hours'`),
      ).toBe(recent);
      // Permanent outcome summaries and critical rows are untouched.
      expect(await count(`SELECT COUNT(*) AS c FROM token_outcome_summaries`)).toBe(TOKENS);
      expect(await count(`SELECT COUNT(*) AS c FROM positions`)).toBe(2);
    } finally {
      (env as { COMPACT_RESEARCH_BUDGET_MB: number }).COMPACT_RESEARCH_BUDGET_MB = original;
    }
  });
});
