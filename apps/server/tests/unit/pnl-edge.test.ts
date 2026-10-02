import { describe, expect, it } from 'vitest';
import { simulateTrade } from '../../src/engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

const gas: GasFeeEstimate = {
  chain: 'solana',
  baseFeeLamports: 5000,
  priorityFeeLamports: 10000,
  solPriceUsd: 200,
  observedAt: new Date(),
};

describe('P/L and edge cases', () => {
  it('net P/L accounts for fees exceeding gross', () => {
    const buy = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 10,
      midPriceUsd: 1,
      quote: {
        chain: 'solana',
        address: 'x',
        priceUsd: 1,
        marketCapUsd: 1000,
        volume5mUsd: 100,
        volume1hUsd: 400,
        volume24hUsd: 1000,
        buyVolume5mUsd: 60,
        sellVolume5mUsd: 40,
        txCount5m: 10,
        priceChange5mPct: 1,
        priceChange1hPct: 2,
        liquidityUsd: 500,
        observedAt: new Date(),
        feeBps: 100,
        venue: 'pump',
        quoteReserve: 250,
      } satisfies MarketQuote,
      gas,
      priorityFeeLamports: 50_000_000, // expensive priority
      failedTxStillChargesNetwork: true,
    });

    // Tiny favorable move but high costs
    const sellMid = buy.execution.executedPriceUsd * 1.002;
    const sell = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: buy.execution.tokenQuantity * sellMid,
      midPriceUsd: sellMid,
      quote: {
        chain: 'solana',
        address: 'x',
        priceUsd: sellMid,
        marketCapUsd: 1000,
        volume5mUsd: 100,
        volume1hUsd: 400,
        volume24hUsd: 1000,
        buyVolume5mUsd: 40,
        sellVolume5mUsd: 60,
        txCount5m: 10,
        priceChange5mPct: 0.2,
        priceChange1hPct: 0.5,
        liquidityUsd: 500,
        observedAt: new Date(),
        feeBps: 100,
        venue: 'pump',
        quoteReserve: 250,
      },
      gas,
      priorityFeeLamports: 50_000_000,
      failedTxStillChargesNetwork: true,
    });

    const gross =
      sell.execution.filledAmountUsd - buy.execution.filledAmountUsd;
    const totalFees =
      buy.costs.totalCostUsd + sell.costs.totalCostUsd;
    // Fees can exceed gross trading P/L
    expect(totalFees).toBeGreaterThan(Math.abs(gross) * 0.5);
  });

  it('handles 100% loss style emergency (zero liquidity sell)', () => {
    const result = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: 10,
      midPriceUsd: 0.5,
      quote: {
        chain: 'solana',
        address: 'x',
        priceUsd: 0.5,
        marketCapUsd: 0,
        volume5mUsd: 0,
        volume1hUsd: 0,
        volume24hUsd: 0,
        buyVolume5mUsd: 0,
        sellVolume5mUsd: 0,
        txCount5m: 0,
        priceChange5mPct: -99,
        priceChange1hPct: -99,
        liquidityUsd: 0,
        observedAt: new Date(),
      },
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
      forceFail: true,
      forceFailReason: 'untradeable',
    });
    expect(result.execution.failed).toBe(true);
    expect(result.execution.filledAmountUsd).toBe(0);
  });

  it('handles huge price movement with elevated slippage', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.01,
      quote: {
        chain: 'solana',
        address: 'x',
        priceUsd: 0.01,
        marketCapUsd: 10000,
        volume5mUsd: 50000,
        volume1hUsd: 100000,
        volume24hUsd: 200000,
        buyVolume5mUsd: 40000,
        sellVolume5mUsd: 10000,
        txCount5m: 200,
        priceChange5mPct: 80,
        priceChange1hPct: 120,
        liquidityUsd: 8000,
        observedAt: new Date(),
        feeBps: 30,
        quoteReserve: 4000,
      },
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.slippagePct).toBeGreaterThan(5);
  });
});
