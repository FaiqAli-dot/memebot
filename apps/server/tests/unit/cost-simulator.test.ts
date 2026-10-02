import { describe, expect, it } from 'vitest';
import {
  constantProductPriceImpactPct,
  estimateSlippagePct,
  lamportsToUsd,
  simulateTrade,
  resolveDexFeeBps,
} from '../../src/engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

const gas: GasFeeEstimate = {
  chain: 'solana',
  baseFeeLamports: 5000,
  priorityFeeLamports: 5000,
  solPriceUsd: 150,
  observedAt: new Date(),
};

function quote(over: Partial<MarketQuote> = {}): MarketQuote {
  return {
    chain: 'solana',
    address: 'Demo',
    priceUsd: 0.001,
    marketCapUsd: 100000,
    volume5mUsd: 5000,
    volume1hUsd: 20000,
    volume24hUsd: 80000,
    buyVolume5mUsd: 3000,
    sellVolume5mUsd: 2000,
    txCount5m: 40,
    priceChange5mPct: 5,
    priceChange1hPct: 10,
    liquidityUsd: 20000,
    observedAt: new Date(),
    venue: 'raydium',
    feeBps: 25,
    quoteReserve: 10000,
    baseReserve: 10_000_000,
    ...over,
  };
}

describe('fee and cost simulator', () => {
  it('converts lamports to USD', () => {
    expect(lamportsToUsd(1_000_000_000, 150)).toBe(150);
    expect(lamportsToUsd(5000, 150)).toBeCloseTo(0.00075, 6);
  });

  it('uses pool fee_bps when provided', () => {
    expect(resolveDexFeeBps(quote({ feeBps: 100 }))).toBe(100);
    expect(resolveDexFeeBps(quote({ feeBps: null, venue: 'pump.fun' }))).toBe(100);
    expect(resolveDexFeeBps(quote({ feeBps: null, venue: 'raydium' }))).toBe(25);
  });

  it('computes constant-product price impact', () => {
    const impact = constantProductPriceImpactPct(1000, 10000);
    expect(impact).toBeCloseTo((1000 / 11000) * 100, 5);
  });

  it('estimates slippage from impact, size, and volatility', () => {
    const s = estimateSlippagePct({
      priceImpactPct: 2,
      liquidityUsd: 10000,
      tradeUsd: 500,
      absPriceChange5mPct: 10,
    });
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(50);
  });

  it('simulates a realistic buy with costs', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.failed).toBe(false);
    expect(result.execution.executedPriceUsd).toBeGreaterThan(0.001);
    expect(result.costs.dexFeeUsd).toBeGreaterThan(0);
    expect(result.costs.networkFeeUsd).toBeGreaterThan(0);
    expect(result.execution.tokenQuantity).toBeGreaterThan(0);
  });

  it('fails on zero liquidity and may charge network', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote({ liquidityUsd: 0, quoteReserve: 0 }),
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.failed).toBe(true);
    expect(result.costs.networkFeeUsd).toBeGreaterThan(0);
    expect(result.execution.filledAmountUsd).toBe(0);
  });

  it('partially fills oversized trades', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5000,
      midPriceUsd: 0.001,
      quote: quote({ liquidityUsd: 10000, quoteReserve: 5000 }),
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.partial).toBe(true);
    expect(result.execution.filledAmountUsd).toBeLessThan(5000);
  });

  it('sells at adverse executable price (not mid)', () => {
    const result = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.executedPriceUsd).toBeLessThan(0.001);
  });
});
