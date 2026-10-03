import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { closePool, getPool, query } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { ensureDefaultPortfolio } from '../../src/services/portfolio-service.js';
import { executePaperBuy } from '../../src/engines/paper/engine.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

const dbUrl = env.TEST_DATABASE_URL ?? env.DATABASE_URL;

describe('duplicate open position prevention', () => {
  beforeAll(async () => {
    getPool(dbUrl);
    await migrate(dbUrl);
    await ensureDefaultPortfolio();
    await query(`DELETE FROM positions WHERE portfolio_id = $1`, [env.DEFAULT_PORTFOLIO_ID]);
    await query(`DELETE FROM paper_orders WHERE portfolio_id = $1`, [env.DEFAULT_PORTFOLIO_ID]);
  });

  afterAll(async () => {
    await closePool();
  });

  it('DB unique index + transaction block second open position on same token', async () => {
    const { rows: tokens } = await query<{ id: string }>(
      `INSERT INTO tokens (chain, address, symbol, name, data_mode, discovery_source)
       VALUES ('solana','DupToken111111111111111111111111111111','DUP','Dup', $1, 'DEMO_SYNTHETIC')
       ON CONFLICT (chain, address, data_mode) DO UPDATE SET symbol = 'DUP'
       RETURNING id`,
      [env.DATA_MODE],
    );
    const tokenId = tokens[0]!.id;

    const quote: MarketQuote = {
      chain: 'solana',
      address: 'DupToken111111111111111111111111111111',
      priceUsd: 0.01,
      marketCapUsd: 10000,
      volume5mUsd: 5000,
      volume1hUsd: 10000,
      volume24hUsd: 20000,
      buyVolume5mUsd: 3000,
      sellVolume5mUsd: 2000,
      txCount5m: 30,
      priceChange5mPct: 5,
      priceChange1hPct: 8,
      liquidityUsd: 25_000,
      observedAt: new Date(),
      feeBps: 25,
      quoteReserve: 12_500,
      venue: 'raydium',
    };
    const gas: GasFeeEstimate = {
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

    const first = await executePaperBuy({
      portfolioId: env.DEFAULT_PORTFOLIO_ID,
      tokenId,
      signalId: null,
      amountUsd: 5,
      midPriceUsd: 0.01,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: 0.1,
    });
    expect(first.success).toBe(true);

    const second = await executePaperBuy({
      portfolioId: env.DEFAULT_PORTFOLIO_ID,
      tokenId,
      signalId: null,
      amountUsd: 5,
      midPriceUsd: 0.01,
      quote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      stopLossPct: 0.08,
      takeProfitPct: 0.2,
      trailingStopPct: 0.1,
    });
    expect(second.success).toBe(false);
    expect(second.reason).toMatch(/Duplicate/i);

    const { rows } = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM positions
       WHERE portfolio_id = $1 AND token_id = $2 AND status = 'OPEN'`,
      [env.DEFAULT_PORTFOLIO_ID, tokenId],
    );
    expect(Number(rows[0]!.c)).toBe(1);
  });
});
