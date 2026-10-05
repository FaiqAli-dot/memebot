import { describe, expect, it } from 'vitest';
import { STRATEGY_PARAM_REGISTRY } from '@memebot/shared';
import { OlderBreakoutStrategy } from '../../src/strategies/older-breakout.js';
import { OlderRevivalStrategy } from '../../src/strategies/older-revival.js';
import { historicalBaseline, insufficientHistory } from '../../src/strategies/historical-baseline.js';
import { activeStrategies, createStrategyCatalog, researchOnlyStrategies } from '../../src/strategies/catalog.js';
import { estimateExpectedValue } from '../../src/risk/expected-value.js';
import { historyCoverageMinutes, olderLaneRejection } from '../../src/research/older-token-lane.js';
import type { StrategyContext } from '../../src/strategies/types.js';
import type { ExecutionCostEstimate } from '@memebot/shared';

const breakout = new OlderBreakoutStrategy();
const revival = new OlderRevivalStrategy();

/** 12h of history: prior 11h averaged 500 USD / 10 tx per 5m; the last hour was quiet (200 USD per 5m). */
function ctx(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    tokenId: 't',
    address: 'a',
    symbol: 'OLD',
    chain: 'solana',
    ageMinutes: 720,
    priceUsd: 1,
    liquidityUsd: 30_000,
    liquidityStatus: 'KNOWN',
    volume5mUsd: 8_000,
    volume1hUsd: 10_200,
    volume24hUsd: 76_200,
    buys1h: 50,
    sells1h: 30,
    buys24h: 800,
    sells24h: 600,
    buyVolume5mUsd: 6_000,
    sellVolume5mUsd: 2_000,
    txCount5m: 40,
    priceChange5mPct: 5,
    priceChange1hPct: 10,
    holderCount: 500,
    topHolderPct: 15,
    observedAt: new Date(),
    priorVolume5mUsd: 3_000,
    ...over,
  };
}

const cost = (rate: number, priced = true): ExecutionCostEstimate =>
  ({ positionSizeUsd: 100, totalCostUsd: rate * 100, totalCostRate: rate, networkFeePriced: priced }) as ExecutionCostEstimate;

describe('historical baseline (non-overlapping windows)', () => {
  it('splits 24h / 1h / 5m into disjoint prior-history, recent-hour and current windows', () => {
    const b = historicalBaseline(ctx());
    expect(b.coverageMinutes).toBe(720);
    expect(b.priorMinutes).toBe(660);
    expect(b.priorVolumeUsd).toBe(66_000);
    expect(b.priorVolumePer5mUsd).toBe(500);
    expect(b.recentHourVolumePer5mUsd).toBe(200);
    expect(b.priorTxPer5m).toBe(10);
    expect(b.inconsistent).toBeNull();
  });

  it('caps coverage at the 24h window and uses observed span when age is unknown or understated', () => {
    expect(historicalBaseline(ctx({ ageMinutes: 5000 })).coverageMinutes).toBe(1440);
    expect(historicalBaseline(ctx({ ageMinutes: null, observedSpanMinutes: 480 })).coverageMinutes).toBe(480);
    expect(historicalBaseline(ctx({ ageMinutes: 120, observedSpanMinutes: 480 })).coverageMinutes).toBe(480);
  });

  it('flags inconsistent or missing provider windows instead of inventing a baseline', () => {
    expect(historicalBaseline(ctx({ volume24hUsd: null })).inconsistent).toBe('volume_24h_missing');
    expect(historicalBaseline(ctx({ volume24hUsd: 5_000 })).inconsistent).toBe('volume_1h_exceeds_24h');
    expect(historicalBaseline(ctx({ buys24h: null })).priorTxPer5m).toBeNull();
  });

  it('sufficiency is prior coverage + prior volume from the registry, not token age', () => {
    const p = { minHistoryCoverageHours: 6, minHistoryVolumeUsd: 20_000 };
    expect(insufficientHistory(historicalBaseline(ctx()), p)).toBeNull();
    expect(insufficientHistory(historicalBaseline(ctx({ ageMinutes: 300 })), p)).toBe('history_coverage_insufficient');
    // A 3-day-old token with almost no prior trading has no regime to measure
    expect(
      insufficientHistory(historicalBaseline(ctx({ ageMinutes: 4320, volume24hUsd: 12_000 })), p),
    ).toBe('history_volume_insufficient');
  });
});

describe('older-breakout', () => {
  it('buys a breakout above its own prior-history regime', () => {
    const s = breakout.evaluate(ctx());
    expect(s.action).toBe('BUY');
    expect(s.reasons).toContain('volume_vs_prior_16.00x');
    expect(s.reasons).toContain('activity_vs_prior_4.00x');
  });

  it('has no minimum-age gate: eligibility follows history, not age', () => {
    expect(STRATEGY_PARAM_REGISTRY['older-breakout']!.params.map((p) => p.key)).not.toContain('minTokenAgeMinutes');
    // 7h old with 6h of prior history qualifies
    expect(breakout.evaluate(ctx({ ageMinutes: 420, volume24hUsd: 46_200 })).action).toBe('BUY');
    // Very old but without measurable prior trading does not
    const thin = breakout.evaluate(ctx({ ageMinutes: 4320, volume24hUsd: 12_000 }));
    expect(thin.action).toBe('NO_TRADE');
    expect(thin.reasons).toEqual(['history_volume_insufficient']);
  });

  it('a spike over a quiet last hour alone is not a breakout if it does not beat the prior regime', () => {
    // 5m = 1,200 is 6x the recent-hour average (the old 1h-only rule would pass) but only 0.8x the
    // prior 1,500/5m regime → rejected
    const s = breakout.evaluate(
      ctx({ volume5mUsd: 1_200, volume1hUsd: 3_400, volume24hUsd: 3_400 + 198_000, priorVolume5mUsd: 400 }),
      { minVolume5mUsd: 1_000 },
    );
    expect(s.action).toBe('NO_TRADE');
    expect(s.reasons).toEqual(['volume_vs_prior_0.80x']);
  });

  it('rejects when the provider omits tx history instead of assuming activity', () => {
    const s = breakout.evaluate(ctx({ buys1h: null }));
    expect(s.action).toBe('NO_TRADE');
    expect(s.reasons).toEqual(['history_tx_baseline_missing']);
  });

  it('thresholds come from the registry (params override defaults)', () => {
    expect(breakout.evaluate(ctx(), { minVolumeRelativeBaseline: 17 }).action).toBe('NO_TRADE');
    expect(breakout.evaluate(ctx(), { minVolumeRelativeBaseline: 15 }).action).toBe('BUY');
  });
});

describe('older-revival', () => {
  it('buys a revival: active prior history → quiet last hour → activity back above both', () => {
    const s = revival.evaluate(ctx());
    expect(s.action).toBe('BUY');
    expect(s.reasons).toContain('dormancy_0.40x');
    expect(s.reasons).toContain('revival_40.00x');
  });

  it('a token that never went quiet is not a revival', () => {
    // Last hour as busy as the prior regime (500/5m) → not dormant
    const s = revival.evaluate(ctx({ volume1hUsd: 8_000 + 5_500, volume24hUsd: 66_000 + 13_500 }));
    expect(s.action).toBe('NO_TRADE');
    expect(s.reasons[0]).toMatch(/^not_dormant_/);
  });

  it('activity back above the quiet hour but still below the prior regime is rejected', () => {
    // 600 now vs 50/5m last hour (12x) but prior regime 500/5m → only 1.2x < 1.5x
    const s = revival.evaluate(
      ctx({ volume5mUsd: 600, volume1hUsd: 1_150, volume24hUsd: 1_150 + 66_000, priorVolume5mUsd: 200 }),
      { minVolume5mUsd: 500 },
    );
    expect(s.action).toBe('NO_TRADE');
    expect(s.reasons).toEqual(['volume_vs_prior_1.20x']);
  });

  it('1h extension limit comes from the registry (no hardcoded 30%)', () => {
    expect(revival.evaluate(ctx({ priceChange1hPct: 35 })).action).toBe('NO_TRADE');
    expect(revival.evaluate(ctx({ priceChange1hPct: 35 }), { maxPriceChange1hPct: 40 }).action).toBe('BUY');
  });

  it('has no minimum-age gate', () => {
    expect(STRATEGY_PARAM_REGISTRY['older-revival']!.params.map((p) => p.key)).not.toContain('minTokenAgeMinutes');
    expect(revival.evaluate(ctx({ ageMinutes: null, observedSpanMinutes: 720 })).action).toBe('BUY');
  });
});

describe('no fabricated profitability signal', () => {
  it('both strategies emit no return/loss estimate, so EV is unknown and never passes', () => {
    for (const s of [breakout.evaluate(ctx()), revival.evaluate(ctx())]) {
      expect(s.action).toBe('BUY');
      expect(s.expectedReturn).toBeNull();
      expect(s.expectedLoss).toBeNull();
      const ev = estimateExpectedValue({
        signal: s,
        cost: cost(0.01),
        failureProbability: 0.05,
        minExpectedNetValue: 0,
        dataConfidence: 'HIGH',
        lowConfidenceMultiplier: 1.2,
        calibration: null,
      });
      expect(ev.expectedNetValue).toBeNull();
      expect(ev.passes).toBe(false);
      expect(ev.reasons).toEqual(['missing_return_or_loss_estimate']);
    }
  });

  it('confidence does not depend on any return/loss value (ranking only)', () => {
    expect(breakout.evaluate(ctx()).confidence).toBeGreaterThan(0);
    expect(breakout.evaluate(ctx()).confidence).toBeLessThanOrEqual(95);
  });
});

describe('research-only isolation in strategy selection', () => {
  it('production selection never includes research-only strategies, even when listed', () => {
    const catalog = createStrategyCatalog();
    const ids = (list: { id: string }[]) => list.map((s) => s.id);
    expect(ids(activeStrategies(catalog))).not.toContain('older-breakout');
    expect(ids(activeStrategies(catalog, ['older-breakout', 'older-revival', 'momentum-breakout']))).toEqual([
      'momentum-breakout',
    ]);
    expect(ids(researchOnlyStrategies(catalog)).sort()).toEqual(['older-breakout', 'older-revival']);
  });
});

describe('older-token lane gates', () => {
  const ok = { costRate: 0.02, networkFeePriced: true, maxRoundTripCostPct: 3, criticalDataOk: true, inCooldown: false };
  it('trades only when measured cost is within the lane limit and inputs are trustworthy', () => {
    expect(olderLaneRejection(ok)).toBeNull();
    expect(olderLaneRejection({ ...ok, costRate: 0.031 })).toBe('round_trip_cost_too_high');
    expect(olderLaneRejection({ ...ok, networkFeePriced: false })).toBe('network_fee_unpriced');
    expect(olderLaneRejection({ ...ok, criticalDataOk: false })).toBe('critical_data_check_failed');
    expect(olderLaneRejection({ ...ok, inCooldown: true })).toBe('signal_cooldown');
  });

  it('history coverage uses pool age, or first-observed span when that is longer', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const h = (ms: number) => new Date(now.getTime() - ms * 3_600_000);
    expect(
      historyCoverageMinutes({ pool_created_at: h(10), created_at_onchain: null, first_observed_at: h(2), discovered_at: h(2) }, now)
        .coverage,
    ).toBe(600);
    expect(
      historyCoverageMinutes({ pool_created_at: h(1), created_at_onchain: null, first_observed_at: h(3), discovered_at: h(3) }, now)
        .coverage,
    ).toBe(180);
  });
});
