import { describe, expect, it } from 'vitest';
import {
  constantProductPriceImpactPct,
  estimateSlippagePct,
  lamportsToUsd,
  simulateTrade,
  resolveDexFeeBps,
} from '../../src/engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

function gas(over: Partial<GasFeeEstimate> = {}): GasFeeEstimate {
  return {
    chain: 'solana',
    baseFeeLamports: 5000,
    priorityFeeLamports: 5000,
    solPriceUsd: 150,
    solPriceSource: 'test',
    solPriceObservedAt: new Date(),
    solPriceStale: false,
    usable: true,
    observedAt: new Date(),
    ...over,
  };
}

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

describe('DEX / network / priority fee calcs', () => {
  it('converts lamports to USD with SOL price', () => {
    expect(lamportsToUsd(1_000_000_000, 150)).toBe(150);
    expect(lamportsToUsd(5000, 150)).toBeCloseTo(0.00075, 6);
    expect(lamportsToUsd(5000, 200)).toBeCloseTo(0.001, 6);
  });

  it('uses pool fee_bps when provided, else venue defaults', () => {
    expect(resolveDexFeeBps(quote({ feeBps: 100 }))).toBe(100);
    expect(resolveDexFeeBps(quote({ feeBps: null, venue: 'pump.fun' }))).toBe(100);
    expect(resolveDexFeeBps(quote({ feeBps: null, venue: 'raydium' }))).toBe(25);
    expect(resolveDexFeeBps(quote({ feeBps: null, venue: 'orca' }))).toBe(30);
  });

  it('records SOL/USD used on each cost breakdown', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas({ solPriceUsd: 180, solPriceSource: 'dexscreener-wsol' }),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.costs.solPriceUsd).toBe(180);
    expect(result.costs.solPriceSource).toBe('dexscreener-wsol');
    expect(result.execution.solPriceUsd).toBe(180);
    expect(result.costs.networkFeeUsd).toBeCloseTo(lamportsToUsd(5000, 180), 8);
    expect(result.costs.priorityFeeUsd).toBeCloseTo(lamportsToUsd(5000, 180), 8);
    expect(result.costs.dexFeeUsd).toBeGreaterThan(0);
  });
});

describe('slippage and price impact', () => {
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

  it('buy pays adverse executable price; sell receives adverse', () => {
    const buy = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    const sell = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(buy.execution.executedPriceUsd).toBeGreaterThan(0.001);
    expect(sell.execution.executedPriceUsd).toBeLessThan(0.001);
  });
});

describe('liquidity edge cases', () => {
  it('zero liquidity fails and may charge network', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote({ liquidityUsd: 0, quoteReserve: 0 }),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.failed).toBe(true);
    expect(result.execution.filledAmountUsd).toBe(0);
    expect(result.costs.networkFeeUsd).toBeGreaterThan(0);
    expect(result.execution.tokenQuantity).toBe(0);
  });

  it('extremely low liquidity produces high impact (or unfillable)', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote({ liquidityUsd: 40, quoteReserve: 20 }),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    if (result.execution.failed) {
      expect(result.execution.filledAmountUsd).toBe(0);
    } else {
      // Trade size vs tiny pool → severe impact vs a deep book
      const deep = simulateTrade({
        side: 'BUY',
        requestedAmountUsd: 5,
        midPriceUsd: 0.001,
        quote: quote({ liquidityUsd: 200_000, quoteReserve: 100_000 }),
        gas: gas(),
        priorityFeeLamports: 5000,
        failedTxStillChargesNetwork: true,
      });
      expect(result.execution.priceImpactPct).toBeGreaterThan(deep.execution.priceImpactPct);
      expect(result.execution.slippagePct).toBeGreaterThan(deep.execution.slippagePct);
      expect(result.execution.executedPriceUsd).toBeGreaterThan(deep.execution.executedPriceUsd);
    }
  });

  it('partially fills oversized trades', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5000,
      midPriceUsd: 0.001,
      quote: quote({ liquidityUsd: 10000, quoteReserve: 5000 }),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.partial).toBe(true);
    expect(result.execution.filledAmountUsd).toBeLessThan(5000);
    expect(result.execution.failed).toBe(false);
  });
});

describe('failed execution', () => {
  it('charges network when configured and opens no fill', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas(),
      priorityFeeLamports: 10_000,
      failedTxStillChargesNetwork: true,
      forceFail: true,
      forceFailReason: 'Simulated RPC drop',
    });
    expect(result.execution.failed).toBe(true);
    expect(result.execution.filledAmountUsd).toBe(0);
    expect(result.execution.tokenQuantity).toBe(0);
    expect(result.costs.networkFeeUsd + result.costs.priorityFeeUsd).toBeGreaterThan(0);
  });

  it('does not charge network when configured false', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas(),
      priorityFeeLamports: 10_000,
      failedTxStillChargesNetwork: false,
      forceFail: true,
    });
    expect(result.execution.failed).toBe(true);
    expect(result.costs.totalCostUsd).toBe(0);
  });

  it('blocks trade when SOL/USD unavailable (no invented price)', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas({
        solPriceUsd: null,
        solPriceSource: null,
        solPriceStale: true,
        usable: false,
      }),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.failed).toBe(true);
    expect(result.execution.failureReason).toMatch(/SOL\/USD/i);
    expect(result.execution.filledAmountUsd).toBe(0);
    expect(result.costs.totalCostUsd).toBe(0);
  });

  it('blocks trade when SOL/USD is stale', () => {
    const result = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 5,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas({
        solPriceUsd: 150,
        solPriceStale: true,
        usable: false,
      }),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(result.execution.failed).toBe(true);
    expect(result.execution.filledAmountUsd).toBe(0);
  });
});

describe('fee greater than expected profit', () => {
  it('net can be negative while gross trading P/L is positive', () => {
    const buy = simulateTrade({
      side: 'BUY',
      requestedAmountUsd: 10,
      midPriceUsd: 1,
      quote: quote({
        priceUsd: 1,
        liquidityUsd: 500,
        quoteReserve: 250,
        feeBps: 100,
        venue: 'pump',
        priceChange5mPct: 1,
      }),
      gas: gas({
        solPriceUsd: 200,
        priorityFeeLamports: 50_000_000,
      }),
      priorityFeeLamports: 50_000_000,
      failedTxStillChargesNetwork: true,
    });
    expect(buy.execution.failed).toBe(false);

    const sellMid = buy.execution.executedPriceUsd * 1.01;
    const sell = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: buy.execution.tokenQuantity * sellMid,
      midPriceUsd: sellMid,
      quote: quote({
        priceUsd: sellMid,
        liquidityUsd: 500,
        quoteReserve: 250,
        feeBps: 100,
        venue: 'pump',
      }),
      gas: gas({ solPriceUsd: 200 }),
      priorityFeeLamports: 50_000_000,
      failedTxStillChargesNetwork: true,
    });

    const gross = sell.execution.filledAmountUsd - buy.execution.filledAmountUsd;
    const totalFees = buy.costs.totalCostUsd + sell.costs.totalCostUsd;
    const entryCost =
      buy.execution.filledAmountUsd +
      buy.costs.networkFeeUsd +
      buy.costs.priorityFeeUsd;
    const exitProceeds =
      sell.execution.filledAmountUsd -
      sell.costs.networkFeeUsd -
      sell.costs.priorityFeeUsd;
    const net = exitProceeds - entryCost;

    // Fees large enough that net is worse than gross
    expect(totalFees).toBeGreaterThan(0);
    expect(net).toBeLessThan(gross);
  });
});
