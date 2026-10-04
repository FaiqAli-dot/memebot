import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

process.env.DATA_MODE = 'demo';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memebot:memebot@localhost:5432/memebot_test';

type Db = typeof import('../../src/db/client.js');
type Runners = typeof import('../../src/jobs/runners.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Portfolios = typeof import('../../src/services/portfolio-service.js');
type Engine = typeof import('../../src/engines/paper/engine.js');
type Query = typeof import('../../src/intelligence/query.js');

const EVE = 'early-volume-expansion';

describe('integration: execution-time strategy revalidation of BUY signals', () => {
  let db: Db;
  let runners: Runners;
  let tokens: Tokens;
  let portfolios: Portfolios;
  let engine: Engine;
  let intel: Query;
  let resetDedupe: () => void;
  let portfolioId: string;
  let seq = 0;

  const ago = (ms: number) => new Date(Date.now() - ms);

  async function newToken(): Promise<{ id: string; address: string }> {
    seq++;
    const address = `Rv${String(seq).padStart(6, '0')}${'2'.repeat(40)}`.slice(0, 44);
    const id = (await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address,
      symbol: `RV${seq}`,
      name: `Revalidate ${seq}`,
      decimals: 9,
      createdAt: null,
    }))!;
    // 20 minutes old and actively tracked, like a token the signal job just evaluated
    await db.query(
      `UPDATE tokens SET lifecycle_state = 'ACTIVE', first_observed_at = NOW() - INTERVAL '20 minutes',
              discovered_at = NOW() - INTERVAL '20 minutes'
       WHERE id = $1`,
      [id],
    );
    return { id, address };
  }

  async function snapshot(
    token: { id: string; address: string },
    at: Date,
    m: { volume5mUsd: number; liquidityUsd: number; priceUsd?: number; priceChange5mPct?: number; txCount5m?: number },
  ) {
    await tokens.insertMarketSnapshot(token.id, {
      chain: 'solana',
      address: token.address,
      priceUsd: m.priceUsd ?? 0.001,
      marketCapUsd: 100_000,
      volume5mUsd: m.volume5mUsd,
      volume1hUsd: m.volume5mUsd * 6,
      volume24hUsd: m.volume5mUsd * 50,
      buyVolume5mUsd: m.volume5mUsd * 0.7,
      sellVolume5mUsd: m.volume5mUsd * 0.3,
      txCount5m: m.txCount5m ?? 120,
      buys5m: Math.round((m.txCount5m ?? 120) * 0.7),
      sells5m: Math.round((m.txCount5m ?? 120) * 0.3),
      priceChange5mPct: m.priceChange5mPct ?? 3,
      priceChange1hPct: 10,
      liquidityUsd: m.liquidityUsd,
      liquidityStatus: 'KNOWN',
      observedAt: at,
      venue: 'raydium',
      feeBps: 25,
      quoteReserve: m.liquidityUsd / 2,
      baseReserve: m.liquidityUsd / 2 / (m.priceUsd ?? 0.001),
    });
  }

  /** Previous completed 5m window + current snapshot: volume acceleration 4x, healthy liquidity. */
  async function healthyMarket(token: { id: string; address: string }) {
    await snapshot(token, ago(6 * 60_000), { volume5mUsd: 2_000, liquidityUsd: 60_000 });
    await snapshot(token, ago(2_000), { volume5mUsd: 8_000, liquidityUsd: 60_000 });
  }

  /** Same history, but the latest snapshot has collapsed below the strategy floors. */
  async function collapsedMarket(token: { id: string; address: string }) {
    await snapshot(token, ago(6 * 60_000), { volume5mUsd: 20_000, liquidityUsd: 18_338, priceUsd: 0.000049 });
    await snapshot(token, ago(2_000), {
      volume5mUsd: 78,
      liquidityUsd: 2_372,
      priceUsd: 0.000002369,
      priceChange5mPct: -0.17,
      txCount5m: 10,
    });
  }

  async function signal(tokenId: string, ageMs: number, strategy = EVE): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO signals (
         token_id, strategy_name, strategy_version, side, action, lane, risk_label, data_mode,
         momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
         confidence, data_confidence, expected_value, market_state, created_at
       ) VALUES ($1,$2,'eve-v1','BUY','BUY','PRODUCTION','MODERATE','demo',
         80,80,80,50,40,85, 85,'HIGH',$3,$4, NOW() - ($5::text || ' milliseconds')::interval)
       RETURNING id`,
      [
        tokenId,
        strategy,
        JSON.stringify({ grossUpside: 0.18, downside: 0.1, timeToTargetSec: 600, expectedNetValue: 0.05, threshold: 0.02 }),
        JSON.stringify({ liquidityUsd: 18_338, volume5mUsd: 20_750, priceUsd: 0.000049, marker: 'signal-time' }),
        String(ageMs),
      ],
    );
    return rows[0]!.id;
  }

  const tick = () => runners.executeLane(portfolioId, 'PRODUCTION', 'RUNNING');

  async function attempt(signalId: string) {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM signal_execution_attempts WHERE signal_id = $1`,
      [signalId],
    );
    return rows;
  }

  async function orders(signalId: string) {
    const { rows } = await db.query<{ id: string; side: string; status: string }>(
      `SELECT id, side, status FROM paper_orders WHERE signal_id = $1`,
      [signalId],
    );
    return rows;
  }

  async function audits(signalId: string) {
    const { rows } = await db.query<{ stage: string; result: string; reason_code: string | null; risk_decision_id: string | null }>(
      `SELECT stage, result, reason_code, risk_decision_id FROM token_decision_audits
       WHERE signal_id = $1 ORDER BY decided_at`,
      [signalId],
    );
    return rows;
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    await migrate(process.env.DATABASE_URL);
    tokens = await import('../../src/services/token-service.js');
    portfolios = await import('../../src/services/portfolio-service.js');
    engine = await import('../../src/engines/paper/engine.js');
    intel = await import('../../src/intelligence/query.js');
    runners = await import('../../src/jobs/runners.js');
    resetDedupe = (await import('../../src/intelligence/ledger.js')).resetIntelligenceDedupeForTests;
    portfolioId = await portfolios.ensureDefaultPortfolio();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`
      TRUNCATE signal_execution_attempts, token_decision_feature_snapshots, token_decision_audits,
               risk_decisions, paper_fills, fee_records, paper_orders, positions, shadow_trades,
               missed_opportunities, market_snapshots, signals CASCADE
    `);
    await portfolios.resetPaperAccount(portfolioId);
    resetDedupe();
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('1. fresh signal + strategy still passes → executes with full signal→revalidation→risk→order→position links', async () => {
    const t = await newToken();
    await healthyMarket(t);
    const sid = await signal(t.id, 30_000);
    await tick();

    const [a] = await attempt(sid);
    expect(a).toMatchObject({ status: 'EXECUTED', revalidation_result: 'PASS', risk_result: 'PASS', token_address: t.address });
    const o = await orders(sid);
    expect(o).toHaveLength(1);
    expect(a!.order_id).toBe(o[0]!.id);

    const { rows: p } = await db.query<Record<string, unknown>>(`SELECT * FROM positions WHERE id = $1`, [a!.position_id]);
    expect(p[0]!.entry_signal_id).toBe(sid);
    expect(p[0]!.risk_decision_id).toBe(a!.risk_decision_id);
    const entry = p[0]!.entry_snapshot as Record<string, unknown>;
    expect((entry.strategyRevalidation as Record<string, unknown>).result).toBe('PASS');
    const { rows: fills } = await db.query(`SELECT 1 FROM paper_fills WHERE order_id = $1`, [o[0]!.id]);
    expect(fills).toHaveLength(1);

    const stages = (await audits(sid)).map((r) => `${r.stage}:${r.result}`);
    expect(stages).toEqual(['STRATEGY_REVALIDATION:PASS', 'RISK_GATE:PASS', 'FINAL_OUTCOME:TRADED']);
    const final = (await audits(sid)).find((r) => r.stage === 'FINAL_OUTCOME')!;
    expect(final.risk_decision_id).toBe(a!.risk_decision_id);
  });

  it('2. fresh signal + strategy now fails → no order, explicit invalidation', async () => {
    const t = await newToken();
    await collapsedMarket(t);
    const sid = await signal(t.id, 20_000);
    await tick();

    expect(await orders(sid)).toHaveLength(0);
    const [a] = await attempt(sid);
    expect(a).toMatchObject({ status: 'STRATEGY_INVALIDATED', revalidation_result: 'FAIL', revalidation_reason: 'liquidity_below_min' });
    expect(a!.risk_decision_id).toBeNull();
    const rows = await audits(sid);
    expect(rows.map((r) => `${r.stage}:${r.result}:${r.reason_code}`)).toEqual([
      'STRATEGY_REVALIDATION:FAIL:LIQUIDITY_TOO_LOW',
      'FINAL_OUTCOME:NOT_TRADED:SIGNAL_INVALIDATED',
    ]);
  });

  it('3 + 8. old (7.5 min) signal whose token collapsed → no order; judged on current data, not signal-time features', async () => {
    const t = await newToken();
    await collapsedMarket(t);
    const sid = await signal(t.id, 456_000);
    await tick();

    expect(await orders(sid)).toHaveLength(0);
    const [a] = await attempt(sid);
    expect(a!.status).toBe('STRATEGY_INVALIDATED');
    expect(Number(a!.signal_age_ms)).toBeGreaterThanOrEqual(456_000);
    const f = a!.revalidation_features as Record<string, number>;
    expect(f.liquidityUsd).toBe(2_372);
    expect(f.volume5mUsd).toBe(78);
  });

  it('4. old signal + strategy still passes + risk passes → executes as before', async () => {
    const t = await newToken();
    await healthyMarket(t);
    const sid = await signal(t.id, 456_000);
    await tick();
    expect(await orders(sid)).toHaveLength(1);
    expect((await attempt(sid))[0]!.status).toBe('EXECUTED');
  });

  it('5 + 14. strategy passes but risk fails → no order; repeated ticks stay bounded', async () => {
    // Fill the 5-position cap with other tokens so the risk gate rejects on capacity
    const { maxSimultaneousPositions } = await portfolios.getPortfolioSettings(portfolioId);
    for (let i = 0; i < maxSimultaneousPositions; i++) {
      const other = await newToken();
      await healthyMarket(other);
      const r = await engine.executePaperBuy({
        portfolioId,
        tokenId: other.id,
        signalId: null,
        amountUsd: 2,
        midPriceUsd: 0.001,
        quote: {
          priceUsd: 0.001,
          liquidityUsd: 60_000,
          liquidityStatus: 'KNOWN',
          observedAt: new Date(),
          venue: 'raydium',
          feeBps: 25,
          quoteReserve: 30_000,
          baseReserve: 30_000_000,
        } as Parameters<Engine['executePaperBuy']>[0]['quote'],
        gas: {
          chain: 'solana',
          baseFeeLamports: 5000,
          priorityFeeLamports: 5000,
          solPriceUsd: 150,
          solPriceSource: 'test',
          solPriceObservedAt: new Date(),
          solPriceStale: false,
          usable: true,
          observedAt: new Date(),
        },
        priorityFeeLamports: 5000,
        failedTxStillChargesNetwork: true,
        stopLossPct: 0.5,
        takeProfitPct: 5,
        trailingStopPct: null,
      });
      expect(r.success).toBe(true);
    }

    const t = await newToken();
    await healthyMarket(t);
    const sid = await signal(t.id, 10_000);
    for (let i = 0; i < 10; i++) await tick();

    expect(await orders(sid)).toHaveLength(0);
    const rows = await attempt(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CAPACITY_BLOCKED', revalidation_result: 'PASS', risk_result: 'FAIL', attempts: 10 });
    expect(rows[0]!.strategy_pass_count).toBe(10);
    const { rows: rd } = await db.query<{ attempts: number }>(`SELECT attempts FROM risk_decisions WHERE signal_id = $1`, [sid]);
    expect(rd).toHaveLength(1);
    expect(rd[0]!.attempts).toBe(10);
    // 10 identical ticks: one audit row per distinct outcome, not one per tick
    const a = await audits(sid);
    expect(a.map((r) => `${r.stage}:${r.result}`)).toEqual(['STRATEGY_REVALIDATION:PASS', 'POSITION_CAPACITY:FAIL']);
  });

  it('6 + 7. strategy + risk pass → exactly one order across repeated 8-second ticks and direct re-execution', async () => {
    const t = await newToken();
    await healthyMarket(t);
    const sid = await signal(t.id, 15_000);
    await tick();
    await tick();
    await tick();
    expect(await orders(sid)).toHaveLength(1);
    expect((await attempt(sid))[0]!.attempts).toBe(1);

    // Even a caller that ignores the selection query cannot execute the signal twice
    await db.query(`UPDATE positions SET status = 'CLOSED', closed_at = NOW() WHERE entry_signal_id = $1`, [sid]);
    const again = await engine.executePaperBuy({
      portfolioId,
      tokenId: t.id,
      signalId: sid,
      amountUsd: 2,
      midPriceUsd: 0.001,
      quote: {
        priceUsd: 0.001,
        liquidityUsd: 60_000,
        liquidityStatus: 'KNOWN',
        observedAt: new Date(),
        venue: 'raydium',
        feeBps: 25,
        quoteReserve: 30_000,
        baseReserve: 30_000_000,
      } as Parameters<Engine['executePaperBuy']>[0]['quote'],
      gas: {
        chain: 'solana',
        baseFeeLamports: 5000,
        priorityFeeLamports: 5000,
        solPriceUsd: 150,
        solPriceSource: 'test',
        solPriceObservedAt: new Date(),
        solPriceStale: false,
        usable: true,
        observedAt: new Date(),
      },
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.5,
      takeProfitPct: 5,
      trailingStopPct: null,
    });
    expect(again.success).toBe(false);
    expect(again.reason).toMatch(/already executed or invalidated/);
    expect(await orders(sid)).toHaveLength(1);
  });

  it('an invalidated signal is never executed later, even if the token recovers', async () => {
    const t = await newToken();
    await collapsedMarket(t);
    const sid = await signal(t.id, 20_000);
    await tick();
    await healthyMarket(t);
    await tick();
    await tick();
    expect(await orders(sid)).toHaveLength(0);
    const [a] = await attempt(sid);
    expect(a).toMatchObject({ status: 'STRATEGY_INVALIDATED', attempts: 1 });
  });

  it('9. signal-time features and score are never overwritten', async () => {
    const t = await newToken();
    await collapsedMarket(t);
    const sid = await signal(t.id, 60_000);
    const before = (await db.query(`SELECT market_state, overall_score, created_at, expected_value FROM signals WHERE id = $1`, [sid])).rows[0];
    await tick();
    const after = (await db.query(`SELECT market_state, overall_score, created_at, expected_value FROM signals WHERE id = $1`, [sid])).rows[0];
    expect(after).toEqual(before);
    expect((after!.market_state as Record<string, unknown>).liquidityUsd).toBe(18_338);
  });

  it('10. revalidation result is persisted and visible in the token investigation view', async () => {
    const t = await newToken();
    await collapsedMarket(t);
    const sid = await signal(t.id, 300_000);
    await tick();
    const detail = (await intel.getIntelligenceTokenDetail(t.id))!;
    const attempts = detail.executionAttempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ signal_id: sid, revalidation_result: 'FAIL', status: 'STRATEGY_INVALIDATED' });
    const kinds = (detail.timeline as Array<{ kind: string; result: string | null }>).map((e) => `${e.kind}:${e.result}`);
    expect(kinds).toContain('SIGNAL_CREATED:PRODUCTION');
    expect(kinds).toContain('STRATEGY_REVALIDATION:FAIL');
    expect(kinds).toContain('FINAL_OUTCOME:NOT_TRADED');
    const search = await intel.searchTokens(sid);
    expect(search).toMatchObject({ matchType: 'signal_id', found: true });
    expect(search.tokens[0]!.tokenId).toBe(t.id);
  });
});
