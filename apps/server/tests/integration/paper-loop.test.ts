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

describe('integration: paper trading loop', () => {
  let migrate: typeof import('../../src/db/migrate.js').migrate;
  let closePool: typeof import('../../src/db/client.js').closePool;
  let query: typeof import('../../src/db/client.js').query;
  let ensureDefaultPortfolio: typeof import('../../src/services/portfolio-service.js').ensureDefaultPortfolio;
  let upsertDiscoveredToken: typeof import('../../src/services/token-service.js').upsertDiscoveredToken;
  let insertMarketSnapshot: typeof import('../../src/services/token-service.js').insertMarketSnapshot;
  let executePaperBuy: typeof import('../../src/engines/paper/engine.js').executePaperBuy;
  let executePaperSell: typeof import('../../src/engines/paper/engine.js').executePaperSell;
  let getPortfolio: typeof import('../../src/services/portfolio-service.js').getPortfolio;
  let MomentumStrategyV1: typeof import('../../src/engines/strategy/momentum-v1.js').MomentumStrategyV1;
  let DEFAULT_MOMENTUM_PARAMS: typeof import('../../src/engines/strategy/momentum-v1.js').DEFAULT_MOMENTUM_PARAMS;
  let portfolioId: string;

  beforeAll(async () => {
    ({ migrate } = await import('../../src/db/migrate.js'));
    ({ closePool, query } = await import('../../src/db/client.js'));
    ({ ensureDefaultPortfolio, getPortfolio } = await import(
      '../../src/services/portfolio-service.js'
    ));
    ({ upsertDiscoveredToken, insertMarketSnapshot } = await import(
      '../../src/services/token-service.js'
    ));
    ({ executePaperBuy, executePaperSell } = await import(
      '../../src/engines/paper/engine.js'
    ));
    ({ MomentumStrategyV1, DEFAULT_MOMENTUM_PARAMS } = await import(
      '../../src/engines/strategy/momentum-v1.js'
    ));

    await migrate(process.env.DATABASE_URL);
    // Clean demo tables for isolation
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

  it('ingests token + market snapshot and generates signal', async () => {
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

    const quote = {
      chain: 'solana',
      address: 'DemoIntegration1111111111111111111111111',
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
    };
    await insertMarketSnapshot(tokenId!, quote);
    // prior snapshots for acceleration
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
    expect(rows[0]?.id).toBeTruthy();

    const gas = {
      chain: 'solana',
      baseFeeLamports: 5000,
      priorityFeeLamports: 5000,
      solPriceUsd: 150,
      observedAt: new Date(),
    };

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
    expect(buy.positionId).toBeTruthy();

    const afterBuy = await getPortfolio(portfolioId);
    expect(afterBuy!.cashUsd).toBeLessThan(100);
    expect(afterBuy!.openPositions).toBe(1);

    // Close position
    const sellQuote = { ...quote, priceUsd: 0.0024, observedAt: new Date() };
    const sell = await executePaperSell({
      portfolioId,
      positionId: buy.positionId!,
      midPriceUsd: 0.0024,
      quote: sellQuote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      closeReason: 'take_profit',
    });
    expect(sell.success).toBe(true);

    const afterSell = await getPortfolio(portfolioId);
    expect(afterSell!.openPositions).toBe(0);
    expect(afterSell!.cashUsd).toBeGreaterThan(0);

    const orders = await query(
      `SELECT status FROM paper_orders WHERE portfolio_id = $1`,
      [portfolioId],
    );
    expect(orders.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects trade on zero liquidity', async () => {
    const tokenId = await upsertDiscoveredToken({
      chain: 'solana',
      address: 'DemoZeroLiq111111111111111111111111111',
      symbol: 'ZERO',
      name: 'Zero Liq',
      decimals: 9,
      createdAt: new Date(),
    });
    const quote = {
      chain: 'solana',
      address: 'DemoZeroLiq111111111111111111111111111',
      priceUsd: 0.001,
      marketCapUsd: 0,
      volume5mUsd: 0,
      volume1hUsd: 0,
      volume24hUsd: 0,
      buyVolume5mUsd: 0,
      sellVolume5mUsd: 0,
      txCount5m: 0,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      liquidityUsd: 0,
      observedAt: new Date(),
      quoteReserve: 0,
    };
    const result = await executePaperBuy({
      portfolioId,
      tokenId: tokenId!,
      signalId: null,
      amountUsd: 5,
      midPriceUsd: 0.001,
      quote,
      gas: {
        chain: 'solana',
        baseFeeLamports: 5000,
        priorityFeeLamports: 5000,
        solPriceUsd: 150,
        observedAt: new Date(),
      },
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: null,
    });
    expect(result.success).toBe(false);
  });
});
