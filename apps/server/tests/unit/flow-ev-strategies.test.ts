import { describe, expect, it } from 'vitest';
import {
  approximateTradesFromSnapshot,
  computeFlowFeatures,
} from '../../src/features/flow.js';
import { estimateExpectedValue } from '../../src/risk/expected-value.js';
import { estimateRoundTripCost } from '../../src/execution/cost-estimate.js';
import { MomentumBreakoutStrategy } from '../../src/strategies/momentum-breakout.js';
import { assessSafety, demoSafetyFromSymbol } from '../../src/safety/engine.js';
import { detectTokenPhase } from '../../src/features/lifecycle.js';
import { detectRegime } from '../../src/features/regime.js';
import { getRealismKnobs, sampleLatency } from '../../src/execution/realism.js';
import { SeededRng } from '../../src/domain/seeded-rng.js';
import { buildWalkForwardPlan, summarizeFold } from '../../src/backtest/walk-forward.js';

describe('flow features', () => {
  it('marks tx-count approximations as LOW confidence', () => {
    const ticks = approximateTradesFromSnapshot({
      buyVolume5mUsd: 3000,
      sellVolume5mUsd: 1000,
      txCount5m: 20,
      priceUsd: 0.01,
      observedAt: new Date(),
    });
    expect(ticks.every((t) => t.approximated)).toBe(true);
    const flow = computeFlowFeatures(ticks);
    expect(flow['5m'].buyVolumeUsd.confidence).toBe('LOW');
    expect(flow['5m'].buyVolumeUsd.source).toBe('tx_count_approximation');
  });
});

describe('expected value', () => {
  it('rejects when edge below uncertainty-aware threshold', () => {
    const ev = estimateExpectedValue({
      signal: {
        action: 'BUY',
        confidence: 40,
        expectedReturn: 0.03,
        expectedLoss: 0.1,
        expectedHoldTimeSec: 600,
        reasons: [],
        strategyId: 't',
        strategyVersion: '1',
      },
      cost: estimateRoundTripCost({
        positionSizeUsd: 50,
        liquidityUsd: 2_000,
        networkFeePerLegUsd: 0.003,
      }),
      failureProbability: 0.1,
      minExpectedNetValue: 0.05,
      dataConfidence: 'LOW',
      lowConfidenceMultiplier: 1.2,
    });
    expect(ev.passes).toBe(false);
    expect(ev.reasons).toContain('expected_value_below_threshold');
  });
});

describe('strategies', () => {
  it('never emits SELL from entry strategy', () => {
    const s = new MomentumBreakoutStrategy();
    const safety = assessSafety(demoSafetyFromSymbol('PEPE2', 20_000, 10));
    const sig = s.evaluate({
      tokenId: '1',
      address: 'a',
      symbol: 'PEPE2',
      chain: 'solana',
      ageMinutes: 20,
      priceUsd: 0.001,
      liquidityUsd: 20_000,
      volume5mUsd: 5_000,
      volume1hUsd: 12_000,
      buyVolume5mUsd: 3500,
      sellVolume5mUsd: 1500,
      txCount5m: 40,
      priceChange5mPct: 5,
      priceChange1hPct: 10,
      holderCount: 100,
      topHolderPct: 10,
      observedAt: new Date(),
      priorVolume5mUsd: 2000,
      safety,
      phase: 'EARLY_MOMENTUM',
      regime: 'NORMAL',
      buySellConfidence: 'LOW',
    });
    expect(sig.action === 'BUY' || sig.action === 'NO_TRADE').toBe(true);
    expect((sig as { action: string }).action).not.toBe('SELL');
  });

  it('blocks on safety before momentum', () => {
    const s = new MomentumBreakoutStrategy();
    const safety = assessSafety(demoSafetyFromSymbol('RUG?', 500, 45));
    const sig = s.evaluate({
      tokenId: '1',
      address: 'a',
      symbol: 'RUG?',
      chain: 'solana',
      ageMinutes: 20,
      priceUsd: 0.001,
      liquidityUsd: 20_000,
      volume5mUsd: 5_000,
      volume1hUsd: 12_000,
      buyVolume5mUsd: 3500,
      sellVolume5mUsd: 1500,
      txCount5m: 40,
      priceChange5mPct: 5,
      priceChange1hPct: 10,
      holderCount: 100,
      topHolderPct: 10,
      observedAt: new Date(),
      priorVolume5mUsd: 2000,
      safety,
    });
    expect(sig.action).toBe('NO_TRADE');
    expect(sig.rejectionReason).toBe('SAFETY_REJECTION');
  });
});

describe('lifecycle + regime', () => {
  it('does not treat slow 1h move as launch acceleration', () => {
    const slow = detectTokenPhase({
      ageMinutes: 120,
      priceChange2mPct: 1,
      priceChange5mPct: 2,
      priceChange1hPct: 80,
      volumeAcceleration: 0.9,
      liquidityUsd: 15_000,
      liquidityChangePct: 0,
      uniqueBuyers5m: 3,
      uniqueSellers5m: 3,
      netFlow5mUsd: 100,
      holderGrowthPct: null,
      largeWalletSellPct: null,
      volatility5mPct: 2,
    });
    expect(slow.phase).toBe('PEAKING');
  });

  it('detects DEAD regime on very low activity', () => {
    const r = detectRegime({
      solMomentumPct: 0,
      solVolatilityPct: 1,
      memecoinActivityScore: 2,
      newTokenCount1h: 0,
      activeTokenCount: 1,
      avgLiquidityUsd: 1000,
      marketBuySellPressure: 0.5,
      launchSuccessRate: null,
      rugFailureRate: null,
    });
    expect(r.regime).toBe('DEAD');
  });
});

describe('realism profiles', () => {
  it('conservative has higher failure rate than optimistic', () => {
    expect(getRealismKnobs('CONSERVATIVE').failureRate).toBeGreaterThan(
      getRealismKnobs('OPTIMISTIC').failureRate,
    );
  });

  it('latency sampling is deterministic for seed', () => {
    const a = sampleLatency(new SeededRng(99), 'REALISTIC');
    const b = sampleLatency(new SeededRng(99), 'REALISTIC');
    expect(a).toEqual(b);
    expect(a.totalMs).toBeGreaterThan(0);
  });
});

describe('walk-forward', () => {
  it('builds train/validate folds plus untouched OOS', () => {
    const plan = buildWalkForwardPlan({ start: new Date('2026-01-01T00:00:00Z') });
    expect(plan.folds.length).toBe(3);
    expect(plan.outOfSample.start.getTime()).toBe(
      plan.folds[2]!.validate.end.getTime(),
    );
    for (const f of plan.folds) {
      expect(f.train.end.getTime()).toBe(f.validate.start.getTime());
    }
  });

  it('summarizes expectancy and costs', () => {
    const m = summarizeFold([1, -0.5, 2], [0.1, 0.1, 0.1]);
    expect(m.tradeCount).toBe(3);
    expect(m.expectancyUsd).toBeCloseTo(2.5 / 3);
    expect(m.totalCostsUsd).toBeCloseTo(0.3);
  });
});
