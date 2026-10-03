import { describe, expect, it } from 'vitest';
import {
  evaluateExitRules,
  theoreticalStopPrice,
  theoreticalTakeProfitPrice,
} from '../../src/engines/paper/exits.js';
import {
  computeEquity,
  computeGrossPnl,
  computeNetPnl,
  computeReturnPct,
  computeUnrealizedPnl,
  markPositionValue,
  sizePositionUsd,
} from '../../src/engines/portfolio/valuation.js';
import {
  evaluateRisk,
  computeDrawdownPct,
  defaultPortfolioSettings,
} from '../../src/engines/risk/engine.js';
import { simulateTrade } from '../../src/engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

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

describe('P/L and portfolio valuation', () => {
  it('computes equity, unrealized, return', () => {
    expect(computeEquity(80, 20)).toBe(100);
    expect(computeUnrealizedPnl(22, 20)).toBe(2);
    expect(computeReturnPct(110, 100)).toBeCloseTo(10);
  });

  it('gross vs net P/L', () => {
    expect(computeGrossPnl(12, 10)).toBe(2);
    expect(computeNetPnl(11.5, 10)).toBe(1.5);
  });

  it('marks position value from quantity × mark', () => {
    expect(markPositionValue(1000, 0.002)).toBeCloseTo(2);
  });

  it('sizes position within pct, risk, and cash caps', () => {
    const sized = sizePositionUsd({
      equityUsd: 100,
      cashUsd: 100,
      maxPositionPct: 0.05,
      maxRiskPerTradePct: 0.01,
      stopLossPct: 0.08,
    });
    expect(sized).toBeLessThanOrEqual(5);
    expect(sized).toBeGreaterThan(0);
  });
});

describe('stop loss / take profit / trailing / max hold', () => {
  const base = {
    entryPriceUsd: 1,
    highestPriceUsd: 1,
    stopLossPct: 0.08,
    takeProfitPct: 0.2,
    trailingStopPct: 0.1 as number | null,
    openedAt: new Date('2026-01-01T00:00:00Z'),
    now: new Date('2026-01-01T00:10:00Z'),
    maxHoldingTimeSec: 3600,
    liquidityUsd: 20_000,
    minLiquidityUsd: 5000,
    marketStale: false,
  };

  it('triggers stop loss on mark breach', () => {
    const d = evaluateExitRules({ ...base, markPriceUsd: 0.9 });
    expect(d.closeReason).toBe('stop_loss');
  });

  it('triggers take profit', () => {
    const d = evaluateExitRules({ ...base, markPriceUsd: 1.25 });
    expect(d.closeReason).toBe('take_profit');
  });

  it('triggers trailing stop after peak', () => {
    const d = evaluateExitRules({
      ...base,
      highestPriceUsd: 1.3,
      markPriceUsd: 1.15, // ~11.5% off peak
    });
    expect(d.closeReason).toBe('trailing_stop');
  });

  it('triggers max holding time', () => {
    const d = evaluateExitRules({
      ...base,
      markPriceUsd: 1.01,
      now: new Date('2026-01-01T02:00:00Z'),
      maxHoldingTimeSec: 3600,
    });
    expect(d.closeReason).toBe('max_holding_time');
  });

  it('emergency on liquidity collapse', () => {
    const d = evaluateExitRules({
      ...base,
      markPriceUsd: 1,
      liquidityUsd: 0,
    });
    expect(d.closeReason).toBe('emergency_liquidity_collapse');
  });

  it('defers non-emergency exits when market stale', () => {
    const d = evaluateExitRules({
      ...base,
      markPriceUsd: 0.9,
      marketStale: true,
    });
    expect(d.deferredDueToStale).toBe(true);
    expect(d.closeReason).toBeNull();
  });

  it('allows emergency exit even when stale', () => {
    const d = evaluateExitRules({
      ...base,
      markPriceUsd: 0.5,
      liquidityUsd: 0,
      marketStale: true,
    });
    expect(d.closeReason).toBe('emergency_liquidity_collapse');
  });
});

describe('gap through stop loss — exit at executable market price, not stop', () => {
  it('close reason is stop_loss but exit mid is gapped mark, not theoretical stop', () => {
    const entry = 1;
    const stopPct = 0.08;
    const stopLevel = theoreticalStopPrice(entry, stopPct);
    const gappedMark = 0.5; // gap well through 0.92 stop

    const decision = evaluateExitRules({
      entryPriceUsd: entry,
      markPriceUsd: gappedMark,
      highestPriceUsd: entry,
      stopLossPct: stopPct,
      takeProfitPct: 0.2,
      trailingStopPct: null,
      openedAt: new Date(),
      now: new Date(),
      maxHoldingTimeSec: 3600,
      liquidityUsd: 15_000,
      minLiquidityUsd: 5000,
      marketStale: false,
    });

    expect(decision.closeReason).toBe('stop_loss');
    expect(decision.exitMidPriceUsd).toBe(gappedMark);
    expect(decision.exitMidPriceUsd).not.toBe(stopLevel);
    expect(decision.exitMidPriceUsd).toBeLessThan(stopLevel);

    const sell = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: 10 * gappedMark,
      midPriceUsd: decision.exitMidPriceUsd,
      quote: {
        chain: 'solana',
        address: 'x',
        priceUsd: gappedMark,
        marketCapUsd: 1000,
        volume5mUsd: 1000,
        volume1hUsd: 4000,
        volume24hUsd: 10000,
        buyVolume5mUsd: 400,
        sellVolume5mUsd: 600,
        txCount5m: 20,
        priceChange5mPct: -50,
        priceChange1hPct: -60,
        liquidityUsd: 15_000,
        observedAt: new Date(),
        feeBps: 25,
        quoteReserve: 7500,
      } satisfies MarketQuote,
      gas,
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });

    // Executable sell is adverse to mid — not equal to theoretical stop
    expect(sell.execution.executedPriceUsd).toBeLessThan(gappedMark);
    expect(sell.execution.executedPriceUsd).not.toBeCloseTo(stopLevel, 4);
    expect(theoreticalTakeProfitPrice(entry, 0.2)).toBeCloseTo(1.2);
  });
});

describe('risk limits: drawdown and daily loss', () => {
  const settings = defaultPortfolioSettings();

  it('computes drawdown', () => {
    expect(computeDrawdownPct(100, 85)).toBeCloseTo(0.15);
  });

  it('enters RECOVERY when flat after max drawdown (no deadlock)', () => {
    const r = evaluateRisk({
      equityUsd: 80,
      cashUsd: 80,
      openPositions: 0,
      startingBalanceUsd: 100,
      peakEquityUsd: 100,
      // Keep daily loss under the 5% cap so only drawdown state machine applies
      realizedPnlTodayUsd: -2,
      proposedSizeUsd: 5,
      stopLossPct: settings.stopLossPct,
      settings: { ...settings, maxDrawdownPct: 0.15 },
      currentRiskState: 'HALTED',
    });
    // Flat + breached DD → RECOVERY with reduced size (not permanent deadlock)
    expect(r.riskState).toBe('RECOVERY');
    expect(r.allowed).toBe(true);
    expect(r.sizeMultiplier).toBeLessThan(1);
  });

  it('halts new entries on max drawdown while positions remain open', () => {
    const r = evaluateRisk({
      equityUsd: 80,
      cashUsd: 40,
      openPositions: 2,
      startingBalanceUsd: 100,
      peakEquityUsd: 100,
      realizedPnlTodayUsd: -2,
      proposedSizeUsd: 5,
      stopLossPct: settings.stopLossPct,
      settings: { ...settings, maxDrawdownPct: 0.15 },
      currentRiskState: 'NORMAL',
    });
    expect(r.allowed).toBe(false);
    expect(r.riskState).toBe('HALTED');
    expect(r.manageExisting).toBe(true);
  });

  it('blocks on max daily loss', () => {
    const r = evaluateRisk({
      equityUsd: 100,
      cashUsd: 100,
      openPositions: 0,
      startingBalanceUsd: 100,
      peakEquityUsd: 100,
      realizedPnlTodayUsd: -6,
      proposedSizeUsd: 5,
      stopLossPct: settings.stopLossPct,
      settings: { ...settings, maxDailyLossPct: 0.05 },
    });
    expect(r.allowed).toBe(false);
    expect(r.riskState).toBe('HALTED');
  });

  it('blocks when max positions hit', () => {
    const r = evaluateRisk({
      equityUsd: 100,
      cashUsd: 100,
      openPositions: settings.maxSimultaneousPositions,
      startingBalanceUsd: 100,
      peakEquityUsd: 100,
      realizedPnlTodayUsd: 0,
      proposedSizeUsd: 5,
      stopLossPct: settings.stopLossPct,
      settings,
    });
    expect(r.allowed).toBe(false);
  });

  it('sizes within caps when allowed', () => {
    const r = evaluateRisk({
      equityUsd: 100,
      cashUsd: 100,
      openPositions: 0,
      startingBalanceUsd: 100,
      peakEquityUsd: 100,
      realizedPnlTodayUsd: 0,
      proposedSizeUsd: 50,
      stopLossPct: settings.stopLossPct,
      settings,
    });
    expect(r.allowed).toBe(true);
    expect(r.sizedAmountUsd).toBeLessThanOrEqual(100 * settings.maxPositionPct + 1e-9);
  });
});
