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
type Shadow = typeof import('../../src/research/shadow.js');
type Opps = typeof import('../../src/research/opportunities.js');
type Universe = typeof import('../../src/universe/repository.js');
type Tokens = typeof import('../../src/services/token-service.js');
type Portfolios = typeof import('../../src/services/portfolio-service.js');

describe('integration: universe, shadows, research lane, opportunities', () => {
  let db: Db;
  let shadow: Shadow;
  let opps: Opps;
  let universe: Universe;
  let tokens: Tokens;
  let portfolios: Portfolios;
  let productionId: string;
  let researchId: string;

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
  const exec = {
    profile: 'OPTIMISTIC' as const,
    priorityFeeLamports: 5000,
    jitoTipLamports: 0,
    failedTxStillChargesNetwork: true,
  };
  const exit = { stopLossPct: 0.1, takeProfitPct: 0.3, trailingStopPct: null, maxHoldSec: 1800, minLiquidityUsd: 3000 };

  let seq = 0;
  function address(): string {
    seq++;
    return `Res${String(seq).padStart(6, '0')}${'1'.repeat(32)}`.slice(0, 44);
  }

  function quote(addr: string, over: Record<string, unknown> = {}) {
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
      priceChange5mPct: 2,
      priceChange1hPct: 5,
      liquidityUsd: 30_000,
      liquidityStatus: 'KNOWN' as const,
      observedAt: new Date(),
      venue: 'raydium',
      feeBps: 25,
      quoteReserve: 15_000,
      baseReserve: 15_000_000,
      ...over,
    };
  }

  async function newToken(): Promise<{ id: string; addr: string }> {
    const addr = address();
    const id = await tokens.upsertDiscoveredToken({
      chain: 'solana',
      address: addr,
      symbol: `R${seq}`,
      name: `Res ${seq}`,
      decimals: 9,
      createdAt: null,
    });
    return { id: id!, addr };
  }

  beforeAll(async () => {
    db = await import('../../src/db/client.js');
    const { migrate } = await import('../../src/db/migrate.js');
    shadow = await import('../../src/research/shadow.js');
    opps = await import('../../src/research/opportunities.js');
    universe = await import('../../src/universe/repository.js');
    tokens = await import('../../src/services/token-service.js');
    portfolios = await import('../../src/services/portfolio-service.js');
    await migrate(process.env.DATABASE_URL);
    await db.query(`
      TRUNCATE opportunity_outcomes, opportunity_trackers, opportunities, shadow_trades,
               funnel_snapshots, paper_fills, fee_records, paper_orders, positions,
               market_snapshots, signals, tokens, user_portfolios CASCADE
    `);
    productionId = await portfolios.ensureDefaultPortfolio();
    researchId = await portfolios.ensureResearchPortfolio();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE opportunity_outcomes, opportunity_trackers, opportunities, shadow_trades CASCADE`);
  });

  afterAll(async () => {
    await db.closePool();
  });

  it('research portfolio is a separate RESEARCH-typed portfolio', async () => {
    expect(researchId).not.toBe(productionId);
    expect(await portfolios.getPortfolioType(researchId)).toBe('RESEARCH');
    expect(await portfolios.getPortfolioType(productionId)).toBe('PRODUCTION');
  });

  it('tracks far more than 50 tokens (no newest-N window)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      const t = await newToken();
      ids.push(t.id);
      await tokens.insertMarketSnapshot(t.id, quote(t.addr) as never);
      await universe.applyQuoteToToken({
        tokenId: t.id,
        observedAt: new Date(),
        liquidityStatus: 'KNOWN',
        eligibility: 'TRADING_ELIGIBLE',
        eligibilityReasons: [],
        activityScore: i,
        basicDataOk: true,
        poolCreatedAt: new Date(Date.now() - 2 * 60_000),
        venue: 'raydium',
      });
    }
    await universe.runLifecycleTick({
      maxAgeHours: 24,
      staleAfterSec: 60,
      archiveStaleAfterMin: 30,
      activeWindowSec: 120,
      trackingCap: 1000,
    });
    const tracked = await universe.listTrackedTokens(new Set());
    const trackedIds = new Set(tracked.map((t) => t.id));
    // The oldest discovered tokens are still tracked after 69 newer arrivals
    expect(ids.every((id) => trackedIds.has(id))).toBe(true);
    const counts = await universe.getUniverseCounts(60);
    expect(counts.byState.ELIGIBLE ?? 0).toBeGreaterThanOrEqual(70);
  });

  it('tracking cap archives the least active, never tokens with exposure', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tokens WHERE lifecycle_state <> 'ARCHIVED'`,
    );
    const live = Number(rows[0]!.n);
    const { rows: lowest } = await db.query<{ id: string }>(
      `SELECT id FROM tokens WHERE lifecycle_state <> 'ARCHIVED' ORDER BY activity_score ASC LIMIT 1`,
    );
    const protectedId = lowest[0]!.id;
    const { rows: o } = await db.query<{ id: string }>(
      `INSERT INTO opportunities (token_id, strategy_id, decision, observed_at, price_usd, liquidity_status,
         volume_5m_usd, volume_1h_usd, tx_count_5m, age_source, data_confidence, buy_sell_confidence,
         volume_accel_confidence, features, sim_params, data_mode)
       VALUES ($1, 'x', 'BUY', NOW(), 1, 'KNOWN', 0, 0, 0, 'FIRST_OBSERVED_AT', 'LOW', 'LOW', 'UNKNOWN',
         '{}', '{}', 'demo') RETURNING id`,
      [protectedId],
    );
    await db.query(
      `INSERT INTO opportunity_trackers (opportunity_id, token_id, status, sim_state)
       VALUES ($1, $2, 'PENDING', '{}'::jsonb)`,
      [o[0]!.id, protectedId],
    );
    const res = await universe.runLifecycleTick({
      maxAgeHours: 24,
      staleAfterSec: 60,
      archiveStaleAfterMin: 30,
      activeWindowSec: 120,
      trackingCap: live - 10,
    });
    expect(res.archivedByCap).toBe(10);
    const { rows: st } = await db.query<{ lifecycle_state: string }>(
      `SELECT lifecycle_state FROM tokens WHERE id = $1`,
      [protectedId],
    );
    expect(st[0]!.lifecycle_state).not.toBe('ARCHIVED');
  });

  it('opens one shadow per (portfolio, token, strategy) and honours the cooldown', async () => {
    const t = await newToken();
    const now = new Date();
    const open = (at: Date, strategyId = 'momentum') =>
      shadow.openShadowTrade({
        portfolioId: productionId,
        tokenId: t.id,
        strategyId,
        rejectionReason: 'EV_REJECTION' as never,
        cooldownSec: 600,
        sim: { quote: quote(t.addr, { observedAt: at }) as never, gas, positionSizeUsd: 25, exit, quoteAgeMs: 500, ...exec },
        now: at,
      });

    const first = await open(now);
    expect(first.status === 'OPENED' || first.status === 'ENTRY_FAILED').toBe(true);
    for (let i = 1; i <= 5; i++) {
      expect((await open(new Date(now.getTime() + i * 1000))).status).toBe('COOLDOWN');
    }
    // A different strategy on the same token is a different identity
    expect((await open(now, 'eve')).status).not.toBe('COOLDOWN');

    // Close it; still inside cooldown → no re-entry. After cooldown → allowed.
    await db.query(`UPDATE shadow_trades SET status = 'CLOSED', closed_at = $2 WHERE token_id = $1`, [t.id, now]);
    expect((await open(new Date(now.getTime() + 60_000))).status).toBe('COOLDOWN');
    expect((await open(new Date(now.getTime() + 11 * 60_000))).status).not.toBe('COOLDOWN');

    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM shadow_trades WHERE token_id = $1 AND strategy_key = 'momentum'`,
      [t.id],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('the DB index rejects a second OPEN shadow for the same identity', async () => {
    const t = await newToken();
    const insert = () =>
      db.query(
        `INSERT INTO shadow_trades (portfolio_id, token_id, strategy_key, rejection_reason, status, opened_at, data_mode)
         VALUES ($1, $2, 'k', 'EV_REJECTION', 'OPEN', NOW(), 'demo')`,
        [productionId, t.id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/uq_shadow_open_identity|duplicate key/);
  });

  it('closes shadows on stop loss with net P&L below gross (costs included)', async () => {
    const t = await newToken();
    const opened = new Date(Date.now() - 5 * 60_000);
    const res = await shadow.openShadowTrade({
      portfolioId: researchId,
      tokenId: t.id,
      strategyId: 'momentum',
      rejectionReason: 'EV_REJECTION' as never,
      cooldownSec: 600,
      sim: { quote: quote(t.addr, { observedAt: opened }) as never, gas, positionSizeUsd: 25, exit, quoteAgeMs: 0, ...exec },
      now: opened,
    });
    expect(res.status).toBe('OPENED');

    // Price path after entry: small up, then a 20% drop (SL is 10%), then a recovery
    const path = [
      [30, 0.00105],
      [60, 0.0008],
      [90, 0.002],
    ] as const;
    for (const [s, price] of path) {
      await tokens.insertMarketSnapshot(
        t.id,
        quote(t.addr, { priceUsd: price, observedAt: new Date(opened.getTime() + s * 1000) }) as never,
      );
    }
    const r = await shadow.updateOpenShadowTrades({ gas, exec });
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const { rows } = await db.query<{
      status: string;
      exit_reason: string;
      hypothetical_exit_price_usd: string;
      net_return_pct: string;
      gross_return_pct: string;
    }>(`SELECT status, exit_reason, hypothetical_exit_price_usd, net_return_pct, gross_return_pct
        FROM shadow_trades WHERE id = $1`, [res.id]);
    const row = rows[0]!;
    expect(row.status).toBe('CLOSED');
    expect(row.exit_reason).toBe('stop_loss');
    expect(Number(row.hypothetical_exit_price_usd)).toBeCloseTo(0.0008, 8);
    expect(Number(row.gross_return_pct)).toBeCloseTo(-20, 4);
    expect(Number(row.net_return_pct)).toBeLessThan(Number(row.gross_return_pct));
  });

  it('records an opportunity once per cooldown and resolves forward horizons', async () => {
    const t = await newToken();
    const at = new Date(Date.now() - 40 * 60_000);
    const input = {
      tokenId: t.id,
      strategyId: 'momentum',
      decision: 'BUY',
      observedAt: at,
      priceUsd: 1,
      liquidityUsd: 30_000,
      liquidityStatus: 'KNOWN',
      volume5mUsd: 5000,
      volume1hUsd: 20_000,
      buys5m: 25,
      sells5m: 15,
      txCount5m: 40,
      uniqueBuyers: null,
      uniqueSellers: null,
      marketRegime: 'NORMAL',
      tokenAgeMin: 20,
      ageSource: 'POOL_CREATED_AT',
      sinceFirstObservedSec: 600,
      dataConfidence: 'MEDIUM',
      buySellConfidence: 'MEDIUM',
      volumeAccelRaw: 2,
      volumeAccelCapped: 2,
      volumeAccelConfidence: 'MEDIUM',
      expectedValue: null,
      evNet: 0.01,
      evThreshold: 0.02,
      executionCostRate: 0.02,
      executionCostUsd: 0.5,
      positionSizeUsd: 25,
      features: {},
      exitParams: exit,
      cooldownSec: 300,
    };
    const id = await opps.recordOpportunity(input);
    expect(id).toBeTruthy();
    expect(await opps.recordOpportunity({ ...input, observedAt: new Date(at.getTime() + 60_000) })).toBeNull();

    for (const h of opps.OUTCOME_HORIZONS_SEC) {
      await tokens.insertMarketSnapshot(
        t.id,
        quote(t.addr, { priceUsd: 1 + h / 10_000, observedAt: new Date(at.getTime() + (h + 2) * 1000) }) as never,
      );
    }
    await opps.processOpportunityOutcomes();
    const { rows } = await db.query<{ horizon_sec: number; return_pct: string }>(
      `SELECT horizon_sec, return_pct FROM opportunity_outcomes WHERE opportunity_id = $1 ORDER BY horizon_sec`,
      [id],
    );
    expect(rows.map((r) => r.horizon_sec)).toEqual([...opps.OUTCOME_HORIZONS_SEC]);
    expect(Number(rows.find((r) => r.horizon_sec === 600)!.return_pct)).toBeCloseTo(6, 4);
    const { rows: tr } = await db.query<{ status: string }>(
      `SELECT status FROM opportunity_trackers WHERE opportunity_id = $1`,
      [id],
    );
    expect(tr[0]!.status).toBe('COMPLETE');
  });
});
