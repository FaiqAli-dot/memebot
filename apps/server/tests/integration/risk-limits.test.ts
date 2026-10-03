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
type Engine = typeof import('../../src/engines/paper/engine.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Portfolios = typeof import('../../src/services/portfolio-service.js');
type Decisions = typeof import('../../src/services/risk-decision-service.js');
type Risk = typeof import('../../src/risk/position-risk.js');

describe('integration: risk limits under concurrency (scenario G)', () => {
  let db: Db;
  let engine: Engine;
  let tokens: Tokens;
  let portfolios: Portfolios;
  let decisions: Decisions;
  let risk: Risk;
  let portfolioId: string;

  const gas = {
    chain: 'solana',
    baseFeeLamports: 5000,
    priorityFeeLamports: 5000,
    solPriceUsd: 150,
    solPriceSource: 'test',
    solPriceObservedAt: new Date(),
    solPriceStale: false,
    usable: true,
    observedAt: new Date(),
  };

  let seq = 0;
  async function newToken(): Promise<{ id: string; addr: string }> {
    seq++;
    const addr = `Rsk${String(seq).padStart(6, '0')}${'1'.repeat(32)}`.slice(0, 44);
    const id = await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address: addr,
      symbol: `K${seq}`,
      name: `Risk ${seq}`,
      decimals: 9,
      createdAt: null,
    });
    return { id: id!, addr };
  }

  function quote(addr: string) {
    return {
      chain: 'solana',
      address: addr,
      priceUsd: 0.001,
      marketCapUsd: 100_000,
      volume5mUsd: 5000,
      volume1hUsd: 20_000,
      volume24hUsd: 80_000,
      buyVolume5mUsd: 3000,
      sellVolume5mUsd: 2000,
      txCount5m: 40,
      priceChange5mPct: 1,
      priceChange1hPct: 2,
      liquidityUsd: 500_000,
      liquidityStatus: 'KNOWN' as const,
      observedAt: new Date(),
      venue: 'raydium',
      feeBps: 25,
      quoteReserve: 250_000,
      baseReserve: 250_000_000,
    };
  }

  async function buy(amountUsd: number, limits: { maxOpen: number; maxPortfolio: number; maxStrategy: number }, strategyKey = 'momentum') {
    const t = await newToken();
    return engine.executePaperBuy({
      portfolioId,
      tokenId: t.id,
      signalId: null,
      amountUsd,
      midPriceUsd: 0.001,
      quote: quote(t.addr) as never,
      gas: gas as never,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
      risk: {
        maxOpenPositions: limits.maxOpen,
        maxPortfolioExposureUsd: limits.maxPortfolio,
        maxStrategyExposureUsd: limits.maxStrategy,
        strategyKey,
      },
    });
  }

  async function openAggregate() {
    const { rows } = await db.query<{ n: string; exposure: string }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_basis_usd), 0) AS exposure
       FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
      [portfolioId],
    );
    return { n: Number(rows[0]!.n), exposure: Number(rows[0]!.exposure) };
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    engine = await import('../../src/engines/paper/engine.js');
    tokens = await import('../../src/services/token-service.js');
    portfolios = await import('../../src/services/portfolio-service.js');
    decisions = await import('../../src/services/risk-decision-service.js');
    risk = await import('../../src/risk/position-risk.js');
    await migrate(process.env.DATABASE_URL);
    await db.query(`
      TRUNCATE risk_decisions, opportunity_outcomes, opportunity_trackers, opportunities, shadow_trades,
               funnel_snapshots, paper_fills, fee_records, paper_orders, positions,
               market_snapshots, signals, tokens, user_portfolios CASCADE
    `);
    portfolioId = await portfolios.ensureDefaultPortfolio();
  }, 60_000);

  beforeEach(async () => {
    await portfolios.resetPaperAccount(portfolioId);
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('concurrent buys never exceed the portfolio exposure limit', async () => {
    const limits = { maxOpen: 50, maxPortfolio: 25, maxStrategy: 1000 };
    const results = await Promise.all(Array.from({ length: 12 }, () => buy(6, limits)));
    const agg = await openAggregate();
    expect(agg.exposure).toBeLessThanOrEqual(25 + 1e-6);
    expect(agg.n).toBe(results.filter((r) => r.success).length);
    expect(agg.n).toBeGreaterThan(0);
    expect(results.some((r) => r.limitBlocked === 'portfolioExposure')).toBe(true);
  });

  it('concurrent buys never exceed max open positions', async () => {
    const limits = { maxOpen: 3, maxPortfolio: 1000, maxStrategy: 1000 };
    const results = await Promise.all(Array.from({ length: 10 }, () => buy(2, limits)));
    const agg = await openAggregate();
    expect(agg.n).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.limitBlocked === 'maxOpenPositions').length).toBeGreaterThan(0);
  });

  it('concurrent buys never exceed per-strategy exposure; other strategies unaffected', async () => {
    const limits = { maxOpen: 50, maxPortfolio: 1000, maxStrategy: 10 };
    await Promise.all([
      ...Array.from({ length: 8 }, () => buy(3, limits, 'momentum')),
      ...Array.from({ length: 2 }, () => buy(3, limits, 'eve')),
    ]);
    const { rows } = await db.query<{ strategy_key: string; exposure: string }>(
      `SELECT strategy_key, SUM(cost_basis_usd) AS exposure FROM positions
       WHERE portfolio_id = $1 AND status = 'OPEN' GROUP BY strategy_key`,
      [portfolioId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.strategy_key, Number(r.exposure)]));
    expect(by.momentum).toBeLessThanOrEqual(10 + 1e-6);
    expect(by.eve).toBeGreaterThan(5);
  });

  it('records one risk decision per signal; re-evaluation updates it', async () => {
    const t = await newToken();
    const { rows: s } = await db.query<{ id: string }>(
      `INSERT INTO signals (token_id, strategy_name, strategy_version, side, risk_label, data_mode)
       VALUES ($1, 'momentum', 'v1', 'BUY', 'MEDIUM', 'demo') RETURNING id`,
      [t.id],
    );
    const signalId = s[0]!.id;
    const cfg = {
      baseSizeUsd: 5,
      minSizeUsd: 1,
      maxRiskPerTradeUsd: 1,
      maxOpenPositions: 5,
      maxPortfolioExposureUsd: 50,
      maxStrategyExposureUsd: 25,
      maxTokenExposureUsd: 10,
      confidenceMultipliers: { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 },
      strongEvMargin: 0.03,
      strongEvMultiplier: 1.25,
      researchMultiplier: 0.5,
      volHighPct: 15,
      volVeryHighPct: 25,
      volExtremePct: 80,
      highVolMultiplier: 0.75,
      veryHighVolMultiplier: 0.5,
      maxEntryPriceImpactPct: 3,
      maxRoundTripCostRate: 0.2,
    };
    const { estimateRoundTripCost } = await import('../../src/execution/cost-estimate.js');
    const assess = (openPositions: number) =>
      risk.assessPositionRisk(
        {
          lane: 'PRODUCTION',
          dataConfidence: 'MEDIUM',
          expectedNetValue: 0.03,
          evThreshold: 0.02,
          liquidityStatus: 'KNOWN',
          liquidityUsd: 50_000,
          absPriceChange5mPct: 2,
          stopLossPct: 0.08,
          regimeMultiplier: 1,
          costAt: (size) =>
            estimateRoundTripCost({
              positionSizeUsd: size,
              liquidityUsd: 50_000,
              venue: 'raydium',
              absPriceChange5mPct: 2,
              networkFeePerLegUsd: 0.002,
            }),
        },
        {
          cashUsd: 100,
          openPositions,
          portfolioExposureUsd: 0,
          strategyExposureUsd: 0,
          tokenExposureUsd: 0,
          riskStateAllowsEntries: true,
          riskStateMultiplier: 1,
        },
        cfg,
      );
    const meta = {
      portfolioId,
      signalId,
      tokenId: t.id,
      strategyId: 'momentum',
      lane: 'PRODUCTION',
      stopLossPct: 0.08,
      expectedNetValue: 0.03,
      evThreshold: 0.02,
      dataConfidence: 'MEDIUM',
    };
    const id1 = await decisions.recordRiskDecision(assess(0), meta);
    await decisions.markRiskExecution(id1, 'EV_FAILED_AT_FINAL_SIZE', 'test');
    const id2 = await decisions.recordRiskDecision(assess(5), meta);
    expect(id2).toBe(id1);
    const { rows } = await db.query<{
      decision: string;
      rejection_reason: string;
      attempts: number;
      execution_status: string | null;
      maximum_planned_loss_usd: string | null;
    }>(
      `SELECT decision, rejection_reason, attempts, execution_status, maximum_planned_loss_usd
       FROM risk_decisions WHERE signal_id = $1`,
      [signalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('REJECTED');
    expect(rows[0]!.rejection_reason).toBe('maxOpenPositions');
    expect(rows[0]!.attempts).toBe(2);
    expect(rows[0]!.execution_status).toBeNull();
  });
});
