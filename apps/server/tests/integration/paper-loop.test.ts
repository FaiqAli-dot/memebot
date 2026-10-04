import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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

describe('integration: paper trading loop + edge cases', () => {
  let migrate: typeof import('../../src/db/migrate.js').migrate;
  let closePool: typeof import('../../src/db/client.js').closePool;
  let query: typeof import('../../src/db/client.js').query;
  let ensureDefaultPortfolio: typeof import('../../src/services/portfolio-service.js').ensureDefaultPortfolio;
  let getPortfolio: typeof import('../../src/services/portfolio-service.js').getPortfolio;
  let upsertDiscoveredToken: typeof import('../../src/services/token-service.js').upsertDiscoveredToken;
  let insertMarketSnapshot: typeof import('../../src/services/token-service.js').insertMarketSnapshot;
  let getPriorVolume5m: typeof import('../../src/services/token-service.js').getPriorVolume5m;
  let getLatestMarketByToken: typeof import('../../src/services/token-service.js').getLatestMarketByToken;
  let executePaperBuy: typeof import('../../src/engines/paper/engine.js').executePaperBuy;
  let executePaperSell: typeof import('../../src/engines/paper/engine.js').executePaperSell;
  let MomentumStrategyV1: typeof import('../../src/engines/strategy/momentum-v1.js').MomentumStrategyV1;
  let DEFAULT_MOMENTUM_PARAMS: typeof import('../../src/engines/strategy/momentum-v1.js').DEFAULT_MOMENTUM_PARAMS;
  let portfolioId: string;

  const gas = {
    chain: 'solana',
    baseFeeLamports: 5000,
    priorityFeeLamports: 5000,
    solPriceUsd: 150,
    solPriceSource: 'demo-deterministic',
    solPriceObservedAt: new Date(),
    solPriceStale: false,
    usable: true,
    observedAt: new Date(),
  };

  beforeAll(async () => {
    ({ migrate } = await import('../../src/db/migrate.js'));
    ({ closePool, query } = await import('../../src/db/client.js'));
    ({ ensureDefaultPortfolio, getPortfolio } = await import(
      '../../src/services/portfolio-service.js'
    ));
    ({
      upsertDiscoveredToken,
      insertMarketSnapshot,
      getPriorVolume5m,
      getLatestMarketByToken,
    } = await import('../../src/services/token-service.js'));
    ({ executePaperBuy, executePaperSell } = await import(
      '../../src/engines/paper/engine.js'
    ));
    ({ MomentumStrategyV1, DEFAULT_MOMENTUM_PARAMS } = await import(
      '../../src/engines/strategy/momentum-v1.js'
    ));

    await migrate(process.env.DATABASE_URL);
    await query(`
      TRUNCATE paper_fills, fee_records, paper_orders, positions, portfolio_snapshots,
               bot_events, signals, strategy_runs, holder_snapshots, liquidity_snapshots,
               market_snapshots, token_snapshots, tokens, user_portfolios CASCADE
    `);
    portfolioId = await ensureDefaultPortfolio();
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  function liquidQuote(address: string, over: Record<string, unknown> = {}) {
    return {
      chain: 'solana',
      address,
      priceUsd: 0.002,
      marketCapUsd: 200000,
      volume5mUsd: 9000,
      volume1hUsd: 25000,
      volume24hUsd: 90000,
      buyVolume5mUsd: 6000,
      sellVolume5mUsd: 3000,
      txCount5m: 50,
      priceChange5mPct: 7,
      priceChange1hPct: 15,
      liquidityUsd: 25000,
      observedAt: new Date(),
      venue: 'demo-amm',
      feeBps: 25,
      quoteReserve: 12500,
      baseReserve: 6_250_000,
      ...over,
    };
  }

  it('ingests token + market snapshot, generates signal, executes buy/sell, updates portfolio', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoIntegration1111111111111111111111111',
      symbol: 'INTG',
      name: 'Integration Token',
      decimals: 9,
      createdAt: new Date(Date.now() - 40 * 60_000),
      metadata: { test: true },
    });
    expect(tokenId).toBeTruthy();

    const quote = liquidQuote('DemoIntegration1111111111111111111111111');
    await insertMarketSnapshot(tokenId!, { ...quote, volume5mUsd: 3000, observedAt: new Date(Date.now() - 60_000) });
    await insertMarketSnapshot(tokenId!, { ...quote, volume5mUsd: 3500, observedAt: new Date(Date.now() - 45_000) });
    await insertMarketSnapshot(tokenId!, { ...quote, volume5mUsd: 4000, observedAt: new Date(Date.now() - 30_000) });
    await insertMarketSnapshot(tokenId!, quote);

    const strategy = new MomentumStrategyV1();
    const ev = strategy.evaluate(
      {
        tokenId: tokenId!,
        address: quote.address,
        symbol: 'INTG',
        chain: 'solana',
        ageMinutes: 40,
        priceUsd: quote.priceUsd,
        liquidityUsd: quote.liquidityUsd,
        volume5mUsd: quote.volume5mUsd,
        volume1hUsd: quote.volume1hUsd,
        buyVolume5mUsd: quote.buyVolume5mUsd,
        sellVolume5mUsd: quote.sellVolume5mUsd,
        txCount5m: quote.txCount5m,
        priceChange5mPct: quote.priceChange5mPct,
        priceChange1hPct: quote.priceChange1hPct,
        holderCount: 150,
        topHolderPct: 10,
        observedAt: quote.observedAt,
        priorVolume5mUsd: 3000,
      },
      DEFAULT_MOMENTUM_PARAMS,
    );
    expect(ev.pass).toBe(true);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO signals (
        token_id, strategy_name, strategy_version, side,
        momentum_score, liquidity_score, volume_score, holder_score, risk_score, overall_score,
        risk_label, explanation, market_state, data_mode
      ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7,$8,$9,$10,$11,$12,'demo') RETURNING id`,
      [
        tokenId,
        strategy.name,
        strategy.version,
        ev.scores.momentum,
        ev.scores.liquidity,
        ev.scores.volume,
        ev.scores.holderDistribution,
        ev.scores.risk,
        ev.scores.overall,
        ev.riskLabel,
        JSON.stringify(ev.explanation),
        JSON.stringify({}),
      ],
    );

    const before = await getPortfolio(portfolioId);
    const buy = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: rows[0]!.id,
      amountUsd: 5,
      midPriceUsd: quote.priceUsd,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: 0.1,
    });
    expect(buy.success).toBe(true);

    const afterBuy = await getPortfolio(portfolioId);
    expect(afterBuy!.cashUsd).toBeLessThan(before!.cashUsd);
    expect(afterBuy!.openPositions).toBeGreaterThanOrEqual(1);

    // SOL price recorded on order + fee records
    const orderRow = await query<{ sol_price_usd: string; sol_price_source: string }>(
      `SELECT sol_price_usd, sol_price_source FROM paper_orders WHERE id = $1`,
      [buy.orderId],
    );
    expect(Number(orderRow.rows[0]!.sol_price_usd)).toBe(150);
    expect(orderRow.rows[0]!.sol_price_source).toBe('demo-deterministic');

    const feeRows = await query<{ sol_price_usd: string }>(
      `SELECT sol_price_usd FROM fee_records WHERE order_id = $1`,
      [buy.orderId],
    );
    expect(feeRows.rows.length).toBeGreaterThan(0);
    expect(feeRows.rows.every((r) => Number(r.sol_price_usd) === 150)).toBe(true);

    const sell = await executePaperSell({
      portfolioId,
      positionId: buy.positionId!,
      midPriceUsd: 0.0024,
      quote: { ...quote, priceUsd: 0.0024, observedAt: new Date() },
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'take_profit',
    });
    expect(sell.success).toBe(true);

    const afterSell = await getPortfolio(portfolioId);
    expect(afterSell!.openPositions).toBe(0);
  });

  it('no-look-ahead: prior volume at T ignores future snapshots', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoNoLookAhead11111111111111111111111',
      symbol: 'NOLA',
      name: 'No Lookahead',
      decimals: 9,
      createdAt: new Date(Date.now() - 60 * 60_000),
    });
    const t0 = new Date('2026-06-01T12:00:00Z');
    const tPast = new Date('2026-06-01T11:50:00Z');
    const tFuture = new Date('2026-06-01T12:10:00Z');
    const q = liquidQuote('DemoNoLookAhead11111111111111111111111');

    await insertMarketSnapshot(tokenId!, {
      ...q,
      volume5mUsd: 1000,
      observedAt: new Date(tPast.getTime() - 20_000),
    });
    await insertMarketSnapshot(tokenId!, {
      ...q,
      volume5mUsd: 1100,
      observedAt: new Date(tPast.getTime() - 10_000),
    });
    await insertMarketSnapshot(tokenId!, {
      ...q,
      volume5mUsd: 1200,
      observedAt: tPast,
    });
    await insertMarketSnapshot(tokenId!, {
      ...q,
      volume5mUsd: 1300,
      observedAt: t0,
    });
    // Future snapshot must not influence prior volume at t0
    await insertMarketSnapshot(tokenId!, {
      ...q,
      volume5mUsd: 999_999,
      observedAt: tFuture,
    });

    const prior = await getPriorVolume5m(tokenId!, t0);
    expect(prior).not.toBeNull();
    expect(prior).toBeLessThan(900_000);
    expect(prior).not.toBe(999_999);
  });

  it('rejects trade on zero liquidity (no position opened)', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoZeroLiq111111111111111111111111111',
      symbol: 'ZERO',
      name: 'Zero Liq',
      decimals: 9,
      createdAt: new Date(),
    });
    const beforePositions = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
      [portfolioId],
    );
    const result = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 5,
      midPriceUsd: 0.001,
      quote: liquidQuote('DemoZeroLiq111111111111111111111111111', {
        liquidityUsd: 0,
        quoteReserve: 0,
        priceUsd: 0.001,
      }),
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(result.success).toBe(false);
    expect(result.positionId).toBeUndefined();
    const afterPositions = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM positions WHERE portfolio_id = $1 AND status = 'OPEN'`,
      [portfolioId],
    );
    expect(afterPositions.rows[0]!.c).toBe(beforePositions.rows[0]!.c);

    // Failed order may still record network cost
    const failed = await query<{ status: string; network_fee_usd: string }>(
      `SELECT status, network_fee_usd FROM paper_orders WHERE id = $1`,
      [result.orderId],
    );
    expect(failed.rows[0]?.status).toBe('FAILED');
    expect(Number(failed.rows[0]?.network_fee_usd)).toBeGreaterThan(0);
  });

  it('failed execution with unusable SOL price opens no position and charges nothing', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoNoSolPrice111111111111111111111111',
      symbol: 'NOSOL',
      name: 'No Sol',
      decimals: 9,
      createdAt: new Date(),
    });
    const cashBefore = (await getPortfolio(portfolioId))!.cashUsd;
    const result = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 5,
      midPriceUsd: 0.002,
      quote: liquidQuote('DemoNoSolPrice111111111111111111111111'),
      gas: {
        ...gas,
        solPriceUsd: null,
        solPriceSource: null,
        solPriceStale: true,
        usable: false,
      },
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/SOL\/USD/i);
    const cashAfter = (await getPortfolio(portfolioId))!.cashUsd;
    expect(cashAfter).toBeCloseTo(cashBefore, 6);
  });

  it('100% loss / untradeable emergency exit marks position closed', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoRugPull111111111111111111111111111',
      symbol: 'RUGX',
      name: 'Rug Exit',
      decimals: 9,
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    const quote = liquidQuote('DemoRugPull111111111111111111111111111');
    const buy = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 3,
      midPriceUsd: quote.priceUsd,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(buy.success).toBe(true);

    const sell = await executePaperSell({
      portfolioId,
      positionId: buy.positionId!,
      midPriceUsd: 0.0001,
      quote: { ...quote, liquidityUsd: 0, quoteReserve: 0, priceUsd: 0.0001 },
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'emergency_liquidity_collapse',
    });
    expect(sell.success).toBe(true);
    expect(sell.netPnl).toBeLessThan(0);

    const pos = await query<{ status: string; close_reason: string; net_pnl_usd: string }>(
      `SELECT status, close_reason, net_pnl_usd FROM positions WHERE id = $1`,
      [buy.positionId],
    );
    expect(pos.rows[0]!.status).toBe('CLOSED');
    expect(pos.rows[0]!.close_reason).toBe('emergency_liquidity_collapse');
  });

  it('untradeable max-hold exit retries as one counted order, then closes at $0 after the grace period', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoDeadPool1111111111111111111111111',
      symbol: 'DEAD',
      name: 'Dead Pool',
      decimals: 9,
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    const quote = liquidQuote('DemoDeadPool1111111111111111111111111');
    const buy = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 3,
      midPriceUsd: quote.priceUsd,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(buy.success).toBe(true);
    const deadQuote = { ...quote, liquidityUsd: 0, quoteReserve: 0 };
    const sell = () =>
      executePaperSell({
        portfolioId,
        positionId: buy.positionId!,
        midPriceUsd: quote.priceUsd,
        quote: deadQuote,
        gas,
        priorityFeeLamports: 5000,
        failedTxStillChargesNetwork: true,
        closeReason: 'max_holding_time',
      });

    // Inside the grace period: position stays open, retries collapse into one counted row.
    for (let i = 0; i < 5; i++) expect((await sell()).success).toBe(false);
    const failed = await query<{ id: string; attempt_count: number; total_cost_usd: string; network_fee_usd: string }>(
      `SELECT id, attempt_count, total_cost_usd, network_fee_usd FROM paper_orders
       WHERE position_id = $1 AND status = 'FAILED'`,
      [buy.positionId],
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.attempt_count).toBe(5);
    expect(Number(failed.rows[0]!.total_cost_usd)).toBeGreaterThan(0);
    const open = await query<{ status: string }>(`SELECT status FROM positions WHERE id = $1`, [buy.positionId]);
    expect(open.rows[0]!.status).toBe('OPEN');

    // First attempt now older than 15 minutes: next failure closes the position at $0.
    await query(`UPDATE paper_orders SET created_at = NOW() - INTERVAL '16 minutes' WHERE id = $1`, [failed.rows[0]!.id]);
    const closing = await sell();
    expect(closing.success).toBe(true);
    expect(closing.closeReason).toBe('emergency_liquidity_collapse');
    const pos = await query<{ status: string; close_reason: string; exit_order_id: string; current_value_usd: string }>(
      `SELECT status, close_reason, exit_order_id, current_value_usd FROM positions WHERE id = $1`,
      [buy.positionId],
    );
    expect(pos.rows[0]!.status).toBe('CLOSED');
    expect(pos.rows[0]!.close_reason).toBe('emergency_liquidity_collapse');
    expect(pos.rows[0]!.exit_order_id).toBe(failed.rows[0]!.id);
    expect(Number(pos.rows[0]!.current_value_usd)).toBe(0);
    const after = await query<{ c: string; attempts: number }>(
      `SELECT COUNT(*)::text AS c, MAX(attempt_count) AS attempts FROM paper_orders
       WHERE position_id = $1 AND status = 'FAILED'`,
      [buy.positionId],
    );
    expect(after.rows[0]!.c).toBe('1');
    expect(after.rows[0]!.attempts).toBe(6);
  });

  it('migration 013 collapses existing repeated failed sells, summing fees, keeping other orders', async () => {
    const { readFileSync } = await import('node:fs');
    const { getPool } = await import('../../src/db/client.js');
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoRetrySpam111111111111111111111111',
      symbol: 'SPAM',
      name: 'Retry Spam',
      decimals: 9,
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    const quote = liquidQuote('DemoRetrySpam111111111111111111111111');
    const buy = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 3,
      midPriceUsd: quote.priceUsd,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    // Legacy layout: one row per retry.
    await query(
      `INSERT INTO paper_orders (portfolio_id, token_id, position_id, side, status, requested_price_usd,
         executed_price_usd, requested_amount_usd, filled_amount_usd, token_quantity, dex_fee_usd,
         network_fee_usd, priority_fee_usd, slippage_pct, slippage_cost_usd, price_impact_pct,
         price_impact_cost_usd, total_cost_usd, failure_reason, data_mode, created_at, execution_record)
       SELECT $1, $2, $3, 'SELL', 'FAILED', 1, 0, 3, 0, 0, 0, 0.001, 0.001, 0, 0, 0, 0, 0.002,
              'Legacy repeat', 'demo', NOW() - (g * INTERVAL '8 seconds'), '{}'::jsonb
       FROM generate_series(1, 4) g`,
      [portfolioId, tokenId, buy.positionId],
    );
    const sql = readFileSync(
      resolve(__dirname, '../../src/db/migrations/013_failed_order_attempts.sql'),
      'utf8',
    );
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const rows = await query<{ attempt_count: number; total_cost_usd: string; network_fee_usd: string }>(
      `SELECT attempt_count, total_cost_usd, network_fee_usd FROM paper_orders
       WHERE position_id = $1 AND status = 'FAILED'`,
      [buy.positionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.attempt_count).toBe(4);
    expect(Number(rows.rows[0]!.total_cost_usd)).toBeCloseTo(0.008, 9);
    expect(Number(rows.rows[0]!.network_fee_usd)).toBeCloseTo(0.004, 9);
    const buys = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM paper_orders WHERE token_id = $1 AND side = 'BUY'`,
      [tokenId],
    );
    expect(buys.rows[0]!.c).toBe('1');
  });

  it('stale market snapshot is readable as stale; missing market returns null (no invent)', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoStalePrice111111111111111111111111',
      symbol: 'STALE',
      name: 'Stale',
      decimals: 9,
      createdAt: new Date(),
    });
    await insertMarketSnapshot(
      tokenId!,
      liquidQuote('DemoStalePrice111111111111111111111111', {
        observedAt: new Date(Date.now() - 10 * 60_000),
      }),
      true,
    );
    const latest = await getLatestMarketByToken(tokenId!);
    expect(latest?.stale).toBe(true);

    const missing = await getLatestMarketByToken('00000000-0000-4000-8000-000000000099');
    expect(missing).toBeNull();
  });

  it('gap stop-loss sell uses market mid executable price recorded on order', async () => {
    // Ensure enough cash after prior edge-case draws
    await query(
      `UPDATE user_portfolios SET cash_usd = GREATEST(cash_usd, 50), updated_at = NOW() WHERE id = $1`,
      [portfolioId],
    );
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoGapStop111111111111111111111111111',
      symbol: 'GAP',
      name: 'Gap Stop',
      decimals: 9,
      createdAt: new Date(Date.now() - 20 * 60_000),
    });
    const entryMid = 1;
    const quote = liquidQuote('DemoGapStop111111111111111111111111111', {
      priceUsd: entryMid,
      liquidityUsd: 50_000,
      quoteReserve: 25_000,
    });
    const buy = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 4,
      midPriceUsd: entryMid,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(buy.success).toBe(true);

    const gapped = 0.5;
    const sell = await executePaperSell({
      portfolioId,
      positionId: buy.positionId!,
      midPriceUsd: gapped,
      quote: { ...quote, priceUsd: gapped },
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'stop_loss',
    });
    expect(sell.success).toBe(true);

    const order = await query<{
      requested_price_usd: string;
      executed_price_usd: string;
    }>(`SELECT requested_price_usd, executed_price_usd FROM paper_orders WHERE id = $1`, [
      sell.orderId,
    ]);
    const requested = Number(order.rows[0]!.requested_price_usd);
    const executed = Number(order.rows[0]!.executed_price_usd);
    // Requested is market mid (gap), not theoretical stop 0.92
    expect(requested).toBeCloseTo(gapped, 6);
    expect(requested).not.toBeCloseTo(0.92, 2);
    expect(executed).toBeLessThan(requested);
  });
});
