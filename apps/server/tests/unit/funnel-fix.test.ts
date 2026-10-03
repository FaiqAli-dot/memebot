import { describe, expect, it } from 'vitest';
import {
  classifyLiquidity,
  classifyTradingEligibility,
  deriveLifecycleState,
  hasBasicTradingData,
  selectForEvaluation,
  selectForPolling,
  tokenAge,
  type LifecycleInput,
} from '../../src/universe/lifecycle.js';
import {
  computeMarketMetrics,
  computeVolumeAcceleration,
  previousCompletedWindow,
  type MetricSnapshot,
} from '../../src/features/market-metrics.js';
import { assessBuySellConfidence, assessDataConfidence } from '../../src/features/data-confidence.js';
import { estimateExpectedValue, evThresholdMultiplier } from '../../src/risk/expected-value.js';
import { estimateRoundTripCost, networkFeePerLegUsd } from '../../src/execution/cost-estimate.js';
import { closeForMissingData, initExitState, runExitPath, type ExitParams } from '../../src/research/exit-sim.js';
import { computeHorizonOutcome, horizonTolerance } from '../../src/research/opportunities.js';
import { seedFrom, simulateShadowExit, type ExecutionSettings } from '../../src/research/shadow.js';
import { classifyStrategyRejection, FunnelRecorder } from '../../src/research/funnel.js';
import { MomentumBreakoutStrategy } from '../../src/strategies/momentum-breakout.js';
import { strategyVolumeAccel, type Signal, type StrategyContext } from '../../src/strategies/types.js';
import { sellProceedsUsd, simulateTrade } from '../../src/engines/cost/simulator.js';
import { assessSafety, demoSafetyFromSymbol } from '../../src/safety/engine.js';
import type { GasFeeEstimate, MarketQuote } from '../../src/providers/types.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const secAfter = (base: Date, s: number) => new Date(base.getTime() + s * 1000);

function gas(over: Partial<GasFeeEstimate> = {}): GasFeeEstimate {
  return {
    chain: 'solana',
    baseFeeLamports: 5000,
    priorityFeeLamports: 5000,
    solPriceUsd: 150,
    solPriceSource: 'test',
    solPriceObservedAt: NOW,
    solPriceStale: false,
    usable: true,
    observedAt: NOW,
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
    observedAt: NOW,
    venue: 'raydium',
    feeBps: 25,
    quoteReserve: 10000,
    baseReserve: 10_000_000,
    ...over,
  };
}

function lifecycle(over: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    currentState: 'TRACKING',
    now: NOW,
    discoveredAt: minAgo(2),
    ageMinutes: 2,
    lastMarketAt: new Date(NOW.getTime() - 5_000),
    lastEvaluatedAt: null,
    eligibility: 'TRADING_ELIGIBLE',
    basicDataOk: true,
    hasOpenExposure: false,
    maxAgeHours: 24,
    staleAfterSec: 60,
    archiveStaleAfterMin: 30,
    activeWindowSec: 120,
    ...over,
  };
}

function snap(minutesAgo: number, over: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    observedAt: minAgo(minutesAgo),
    volume5mUsd: 1000,
    volume1hUsd: 10000,
    volume24hUsd: 50000,
    txCount5m: 40,
    buys5m: 25,
    sells5m: 15,
    buys24h: 1000,
    sells24h: 800,
    ...over,
  };
}

const ACCEL_CFG = { minBaselineUsd: 500, maxAccel: 10 };

const signal = (over: Partial<Signal> = {}): Signal => ({
  action: 'BUY',
  confidence: 60,
  expectedReturn: 0.25,
  expectedLoss: 0.08,
  expectedHoldTimeSec: 600,
  reasons: [],
  strategyId: 'test',
  strategyVersion: '1',
  ...over,
});

describe('universe: tracking is decoupled from the newest-N window', () => {
  it('keeps a young token tracked until it reaches strategy age (no age-based drop)', () => {
    // Token discovered 2 minutes ago, 60 newer tokens arrived since — state is only
    // a function of its own data, never its rank among recent discoveries.
    expect(deriveLifecycleState(lifecycle({ ageMinutes: 2 }))).toBe('ELIGIBLE');
    expect(deriveLifecycleState(lifecycle({ ageMinutes: 6, discoveredAt: minAgo(6) }))).toBe('ELIGIBLE');
  });

  it('archives tokens whose market data stopped arriving', () => {
    expect(
      deriveLifecycleState(lifecycle({ lastMarketAt: minAgo(45), discoveredAt: minAgo(60), ageMinutes: 60 })),
    ).toBe('ARCHIVED');
    expect(deriveLifecycleState(lifecycle({ lastMarketAt: minAgo(2) }))).toBe('STALE');
  });

  it('archives tokens older than max age, but never with open exposure', () => {
    expect(deriveLifecycleState(lifecycle({ ageMinutes: 25 * 60 }))).toBe('ARCHIVED');
    expect(deriveLifecycleState(lifecycle({ ageMinutes: 25 * 60, hasOpenExposure: true }))).toBe('ELIGIBLE');
    expect(
      deriveLifecycleState(lifecycle({ currentState: 'ARCHIVED', hasOpenExposure: true })),
    ).toBe('ELIGIBLE');
  });

  it('never makes non-tradeable liquidity ELIGIBLE', () => {
    expect(deriveLifecycleState(lifecycle({ eligibility: 'RESEARCH_ONLY' }))).toBe('TRACKING');
    expect(deriveLifecycleState(lifecycle({ eligibility: 'UNKNOWN' }))).toBe('TRACKING');
    expect(deriveLifecycleState(lifecycle({ basicDataOk: false }))).toBe('TRACKING');
  });

  it('respects the evaluation cap and rotates lower-ranked tokens in', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `t${String(i).padStart(3, '0')}`,
      activityScore: 100 - i,
      lastEvaluatedAt: i === 99 ? null : minAgo(1),
    }));
    const picked = selectForEvaluation(candidates, 20, 0.25);
    expect(picked).toHaveLength(20);
    expect(picked.filter((p) => p.reason === 'priority')).toHaveLength(15);
    expect(picked.filter((p) => p.reason === 'rotation')).toHaveLength(5);
    // Lowest-ranked, never-evaluated token gets a rotation slot
    expect(picked.some((p) => p.item.id === 't099' && p.reason === 'rotation')).toBe(true);
  });

  it('every token is eventually evaluated under rotation', () => {
    const lastEval = new Map<string, Date | null>();
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    ids.forEach((id) => lastEval.set(id, null));
    const seen = new Set<string>();
    for (let tick = 0; tick < 20; tick++) {
      const now = secAfter(NOW, tick);
      const picked = selectForEvaluation(
        ids.map((id, i) => ({ id, activityScore: 50 - i, lastEvaluatedAt: lastEval.get(id) ?? null })),
        10,
        0.3,
      );
      for (const p of picked) {
        seen.add(p.item.id);
        lastEval.set(p.item.id, now);
      }
    }
    expect(seen.size).toBe(50);
  });

  it('polling budget always includes exposures and new discoveries', () => {
    const cands = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `old${i}`,
        mustInclude: false,
        activityScore: 100 - i,
        lastPolledAt: minAgo(1),
      })),
      { id: 'exposure', mustInclude: true, activityScore: 0, lastPolledAt: minAgo(1) },
      { id: 'brandnew', mustInclude: false, activityScore: 0, lastPolledAt: null },
    ];
    const picked = selectForPolling(cands, 8).map((p) => p.item.id);
    expect(picked).toHaveLength(8);
    expect(picked).toContain('exposure');
    expect(picked).toContain('brandnew');
  });
});

describe('age source', () => {
  it('prefers pool creation time', () => {
    const a = tokenAge({ poolCreatedAt: minAgo(30), firstObservedAt: minAgo(3), discoveredAt: minAgo(3) }, NOW);
    expect(a.source).toBe('POOL_CREATED_AT');
    expect(a.minutes).toBeCloseTo(30);
  });

  it('falls back to first-observed time', () => {
    const a = tokenAge({ poolCreatedAt: null, firstObservedAt: minAgo(7), discoveredAt: minAgo(3) }, NOW);
    expect(a.source).toBe('FIRST_OBSERVED_AT');
    expect(a.minutes).toBeCloseTo(7);
    const b = tokenAge({ poolCreatedAt: null, firstObservedAt: null, discoveredAt: minAgo(3) }, NOW);
    expect(b.minutes).toBeCloseTo(3);
  });
});

describe('pump.fun / liquidity classification', () => {
  it('classifies bonding-curve venues without inventing liquidity', () => {
    expect(classifyLiquidity({ venue: 'pumpfun', liquidityUsd: null })).toBe('BONDING_CURVE');
    expect(classifyLiquidity({ venue: 'pumpfun', liquidityUsd: 0 })).toBe('BONDING_CURVE');
    expect(classifyLiquidity({ venue: 'raydium', liquidityUsd: null })).toBe('UNKNOWN');
    expect(classifyLiquidity({ venue: 'raydium', liquidityUsd: 0 })).toBe('UNKNOWN');
    expect(classifyLiquidity({ venue: 'raydium', liquidityUsd: 12_000 })).toBe('KNOWN');
  });

  it('marks bonding-curve tokens RESEARCH_ONLY and unknown as UNKNOWN', () => {
    expect(classifyTradingEligibility('BONDING_CURVE').eligibility).toBe('RESEARCH_ONLY');
    expect(classifyTradingEligibility('UNKNOWN').eligibility).toBe('UNKNOWN');
    expect(classifyTradingEligibility('KNOWN').eligibility).toBe('TRADING_ELIGIBLE');
  });

  it('basic trading data requires KNOWN liquidity', () => {
    const base = { priceUsd: 0.001, liquidityUsd: 20_000, volume5mUsd: 1000, volume1hUsd: 5000 };
    expect(hasBasicTradingData({ ...base, liquidityStatus: 'KNOWN' })).toBe(true);
    expect(hasBasicTradingData({ ...base, liquidityStatus: 'BONDING_CURVE' })).toBe(false);
    expect(hasBasicTradingData({ ...base, liquidityStatus: 'UNKNOWN' })).toBe(false);
  });

  it('production strategy rejects non-KNOWN liquidity with a liquidity reason', () => {
    const ctx: StrategyContext = {
      tokenId: '1',
      address: 'a',
      symbol: 'PUMP',
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
      observedAt: NOW,
      priorVolume5mUsd: 2000,
      safety: assessSafety(demoSafetyFromSymbol('PUMP', 20_000, 10)),
      phase: 'EARLY_MOMENTUM',
      regime: 'NORMAL',
      liquidityStatus: 'BONDING_CURVE',
    };
    const sig = new MomentumBreakoutStrategy().evaluate(ctx);
    expect(sig.action).toBe('NO_TRADE');
    expect(sig.rejectionReason).toBe('LIQUIDITY_REJECTION');
    expect(classifyStrategyRejection(sig, 20)).toBe('unknownLiquidity');
  });
});

describe('volume acceleration', () => {
  it('uses a non-overlapping previous window only', () => {
    const current = snap(0);
    // 1-minute-old snapshot overlaps the current rolling 5m window — must not be used
    expect(previousCompletedWindow([snap(1), snap(3)], current)).toBeNull();
    expect(previousCompletedWindow([snap(1), snap(6), snap(12)], current)?.observedAt).toEqual(minAgo(6));
    // Older than 10 minutes is not "the previous window"
    expect(previousCompletedWindow([snap(12)], current)).toBeNull();
  });

  it('computes acceleration against the previous completed 5m', () => {
    const a = computeVolumeAcceleration({
      current: snap(0, { volume5mUsd: 3000 }),
      previous: snap(6, { volume5mUsd: 1000 }),
      ageMinutes: 20,
      config: ACCEL_CFG,
    });
    expect(a.method).toBe('previous_completed_5m');
    expect(a.raw).toBeCloseTo(3);
    expect(a.capped).toBeCloseTo(3);
    expect(a.confidence).toBe('MEDIUM');
  });

  it('treats a tiny baseline as insufficient data, preserving the raw value', () => {
    const a = computeVolumeAcceleration({
      current: snap(0, { volume5mUsd: 5000 }),
      previous: snap(6, { volume5mUsd: 50 }),
      ageMinutes: 20,
      config: ACCEL_CFG,
    });
    expect(a.capped).toBeNull();
    expect(a.raw).toBeCloseTo(100);
    expect(a.confidence).toBe('UNKNOWN');
    expect(a.reasons).toContain('baseline_below_min');
  });

  it('caps extreme values', () => {
    const a = computeVolumeAcceleration({
      current: snap(0, { volume5mUsd: 100_000 }),
      previous: snap(6, { volume5mUsd: 1000 }),
      ageMinutes: 20,
      config: ACCEL_CFG,
    });
    expect(a.raw).toBeCloseTo(100);
    expect(a.capped).toBe(10);
    expect(a.reasons).toContain('capped_at_max');
  });

  it('falls back to the h1 average at LOW confidence, never for very young tokens', () => {
    const current = snap(0, { volume5mUsd: 3000, volume1hUsd: 14_000 });
    const old = computeVolumeAcceleration({ current, previous: null, ageMinutes: 60, config: ACCEL_CFG });
    expect(old.method).toBe('h1_minus_m5_average');
    expect(old.confidence).toBe('LOW');
    expect(old.baselineUsd).toBeCloseTo(1000);
    const young = computeVolumeAcceleration({ current, previous: null, ageMinutes: 6, config: ACCEL_CFG });
    expect(young.capped).toBeNull();
    expect(young.reasons).toContain('no_non_overlapping_baseline');
  });

  it('strategies see null (reject) rather than infinite acceleration', () => {
    const accel = computeVolumeAcceleration({
      current: snap(0, { volume5mUsd: 5000 }),
      previous: snap(6, { volume5mUsd: 0 }),
      ageMinutes: 20,
      config: ACCEL_CFG,
    });
    expect(strategyVolumeAccel({ volumeAccel: accel } as StrategyContext).value).toBeNull();
  });

  it('ignores future snapshots (no look-ahead)', () => {
    const m = computeMarketMetrics({
      current: snap(10, { volume5mUsd: 3000 }),
      history: [snap(16, { volume5mUsd: 1000 }), snap(0, { volume5mUsd: 99_999 })],
      ageMinutes: 30,
      config: ACCEL_CFG,
    });
    expect(m.volumeAcceleration.raw).toBeCloseTo(3);
  });
});

describe('measured data confidence', () => {
  const good = {
    liquidityStatus: 'KNOWN' as const,
    liquidityUsd: 20_000,
    snapshotAgeSec: 5,
    staleAfterSec: 60,
    volume5mUsd: 2000,
    volume1hUsd: 10_000,
    txCount5m: 40,
    buys5m: 25,
    sells5m: 15,
    ageSource: 'POOL_CREATED_AT' as const,
    observations10m: 8,
    volumeAccelConfidence: 'MEDIUM' as const,
    agreeingProviders: 1,
  };

  it('good single-provider data is MEDIUM (HIGH needs provider agreement)', () => {
    expect(assessDataConfidence(good).level).toBe('MEDIUM');
    expect(assessDataConfidence({ ...good, agreeingProviders: 2 }).level).toBe('HIGH');
  });

  it('a critical failure gives LOW', () => {
    expect(assessDataConfidence({ ...good, liquidityStatus: 'BONDING_CURVE' }).level).toBe('LOW');
    expect(assessDataConfidence({ ...good, snapshotAgeSec: 120 }).level).toBe('LOW');
    expect(assessDataConfidence({ ...good, observations10m: 1 }).level).toBe('LOW');
  });

  it('buy/sell confidence is capped at MEDIUM and LOW on thin samples', () => {
    const bs = {
      buys5m: 25,
      sells5m: 15,
      buys1h: 200,
      sells1h: 150,
      txCount5m: 40,
      snapshotAgeSec: 5,
      staleAfterSec: 60,
    };
    expect(assessBuySellConfidence(bs).level).toBe('MEDIUM');
    expect(assessBuySellConfidence({ ...bs, buys5m: 2, sells5m: 2, txCount5m: 4 }).level).toBe('LOW');
    expect(assessBuySellConfidence({ ...bs, buys5m: null }).level).toBe('LOW');
  });
});

describe('expected value (ev-v2)', () => {
  const cost = (size = 25, liq = 40_000) =>
    estimateRoundTripCost({ positionSizeUsd: size, liquidityUsd: liq, venue: 'raydium', networkFeePerLegUsd: 0.0015 });

  const ev = (over: Partial<Parameters<typeof estimateExpectedValue>[0]> = {}) =>
    estimateExpectedValue({
      signal: signal(),
      cost: cost(),
      failureProbability: 0.05,
      minExpectedNetValue: 0.02,
      dataConfidence: 'MEDIUM',
      lowConfidenceMultiplier: 1.2,
      ...over,
    });

  it('applies the LOW multiplier to the threshold only — no extra haircut', () => {
    const med = ev();
    const low = ev({ dataConfidence: 'LOW' });
    expect(low.expectedNetValue).toBe(med.expectedNetValue);
    expect(med.threshold).toBeCloseTo(0.02);
    expect(low.threshold).toBeCloseTo(0.024);
    expect(evThresholdMultiplier('HIGH', 1.2)).toBe(1);
    expect(evThresholdMultiplier('UNKNOWN', 1.2)).toBe(1.2);
  });

  it('signal confidence raises expected value', () => {
    const lo = ev({ signal: signal({ confidence: 20 }) });
    const hi = ev({ signal: signal({ confidence: 90 }) });
    expect(hi.expectedNetValue!).toBeGreaterThan(lo.expectedNetValue!);
  });

  it('position size changes the cost rate', () => {
    const small = cost(5);
    const big = cost(2_000);
    // Network is fixed per tx (dominates small size); impact grows with size
    expect(small.networkFeeUsd).toBeCloseTo(big.networkFeeUsd);
    expect(big.priceImpactRate).toBeGreaterThan(small.priceImpactRate);
    expect(ev({ cost: big }).expectedNetValue!).toBeLessThan(ev({ cost: cost(25) }).expectedNetValue!);
  });

  it('fails when the network fee cannot be priced', () => {
    const unpriced = estimateRoundTripCost({ positionSizeUsd: 25, liquidityUsd: 40_000, networkFeePerLegUsd: null });
    expect(unpriced.networkFeePriced).toBe(false);
    const r = ev({ cost: unpriced });
    expect(r.passes).toBe(false);
    expect(r.reasons).toContain('network_fee_unpriced');
    expect(networkFeePerLegUsd(gas({ usable: false }))).toBeNull();
    expect(networkFeePerLegUsd(gas({ solPriceStale: true }))).toBeNull();
    expect(networkFeePerLegUsd(gas())).toBeCloseTo(((5000 + 5000) / 1e9) * 150, 8);
  });

  it('is deterministic and labelled uncalibrated', () => {
    expect(ev()).toEqual(ev());
    expect(ev().calibrated).toBe(false);
  });
});

describe('exit-path simulation', () => {
  const params: ExitParams = {
    // Fractions, same units as portfolio settings / evaluateExitRules
    stopLossPct: 0.1,
    takeProfitPct: 0.2,
    trailingStopPct: null,
    maxHoldSec: 600,
    minLiquidityUsd: 1000,
  };
  const entryAt = NOW;
  const pt = (s: number, price: number, liq: number | null = 20_000) => ({
    observedAt: secAfter(entryAt, s),
    priceUsd: price,
    liquidityUsd: liq,
  });

  it('processes points chronologically: SL hit first wins even if TP appears later', () => {
    const s = runExitPath(1, entryAt, [pt(60, 1.25), pt(30, 0.85)], params);
    expect(s.exitReason).toBe('stop_loss');
    expect(s.exitMidPriceUsd).toBeCloseTo(0.85);
  });

  it('take profit uses the observed (gapped) price', () => {
    const s = runExitPath(1, entryAt, [pt(30, 1.1), pt(60, 1.4)], params);
    expect(s.exitReason).toBe('take_profit');
    expect(s.exitMidPriceUsd).toBeCloseTo(1.4);
    expect(s.mfePct).toBeCloseTo(40);
  });

  it('closes on max hold and ignores points before entry', () => {
    const s = runExitPath(1, entryAt, [pt(-30, 0.1), pt(300, 1.05), pt(700, 1.02)], params);
    expect(s.exitReason).toBe('max_holding_time');
    expect(s.maePct).toBe(0);
  });

  it('liquidity collapse triggers emergency exit; unknown liquidity does not', () => {
    expect(runExitPath(1, entryAt, [pt(30, 1.0, 50)], params).exited).toBe(true);
    expect(runExitPath(1, entryAt, [pt(30, 1.0, null)], params).exited).toBe(false);
  });

  it('force-closes only after max hold plus grace when data disappears', () => {
    const st = initExitState(1, entryAt);
    expect(closeForMissingData(st, secAfter(entryAt, 900), params).exited).toBe(false);
    const closed = closeForMissingData(st, secAfter(entryAt, 1300), params);
    expect(closed.exitReason).toBe('data_unavailable');
  });
});

describe('opportunity horizons', () => {
  const entry = { observedAt: NOW, priceUsd: 1 };
  const p = (s: number, price: number) => ({
    observedAt: secAfter(NOW, s),
    priceUsd: price,
    liquidityUsd: 20_000,
    volume5mUsd: 1000,
  });

  it('uses the first snapshot at/after the horizon, with MFE/MAE up to it', () => {
    const r = computeHorizonOutcome(entry, [p(20, 1.3), p(40, 0.9), p(65, 1.1), p(90, 2)], 60, secAfter(NOW, 100));
    expect(r).not.toBe('pending');
    expect(r).not.toBe('missing');
    const o = r as Exclude<typeof r, string>;
    expect(o.priceUsd).toBe(1.1);
    expect(o.lagSec).toBe(5);
    expect(o.mfePct).toBeCloseTo(30);
    expect(o.maePct).toBeCloseTo(-10);
  });

  it('is pending until the tolerance passes, then missing', () => {
    expect(horizonTolerance(10)).toBe(15);
    expect(horizonTolerance(600)).toBe(300);
    expect(computeHorizonOutcome(entry, [p(5, 1)], 60, secAfter(NOW, 70))).toBe('pending');
    expect(computeHorizonOutcome(entry, [p(5, 1)], 60, secAfter(NOW, 200))).toBe('missing');
    expect(computeHorizonOutcome(entry, [p(200, 1)], 60, secAfter(NOW, 200))).toBe('missing');
  });
});

describe('shadow execution realism', () => {
  const exec: ExecutionSettings = {
    profile: 'CONSERVATIVE',
    priorityFeeLamports: 5000,
    jitoTipLamports: 0,
    failedTxStillChargesNetwork: true,
  };
  const point = {
    observedAt: NOW.toISOString(),
    priceUsd: 0.001,
    liquidityUsd: 20_000,
    venue: 'raydium',
    priceChange5mPct: 2,
  };

  it('is deterministic for a given seed', () => {
    const seed = seedFrom('p', 't', 's', NOW.toISOString());
    expect(seed).toBe(seedFrom('p', 't', 's', NOW.toISOString()));
    expect(seed).not.toBe(seedFrom('p', 't', 's2', NOW.toISOString()));
    const a = simulateShadowExit({ quantity: 25_000, exitMidPriceUsd: 0.001, point, gas: gas(), exec, seed });
    const b = simulateShadowExit({ quantity: 25_000, exitMidPriceUsd: 0.001, point, gas: gas(), exec, seed });
    expect(a?.proceedsUsd).toBe(b?.proceedsUsd);
  });

  it('exit proceeds are net of costs (below gross mid value)', () => {
    let checked = 0;
    for (let i = 0; i < 20; i++) {
      const r = simulateShadowExit({ quantity: 25_000, exitMidPriceUsd: 0.001, point, gas: gas(), exec, seed: i });
      if (!r) continue;
      checked++;
      expect(r.proceedsUsd).toBeLessThan(25);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('defers instead of inventing costs when SOL/USD is unusable', () => {
    const r = simulateShadowExit({
      quantity: 25_000,
      exitMidPriceUsd: 0.001,
      point,
      gas: gas({ usable: false, solPriceUsd: null }),
      exec,
      seed: 1,
    });
    expect(r).toBeNull();
  });
});

describe('paper sell proceeds include all costs', () => {
  it('deducts DEX fee, price effect and network fees', () => {
    const sim = simulateTrade({
      side: 'SELL',
      requestedAmountUsd: 50,
      midPriceUsd: 0.001,
      quote: quote(),
      gas: gas(),
      priorityFeeLamports: 5000,
      failedTxStillChargesNetwork: true,
    });
    expect(sim.execution.failed).toBe(false);
    const proceeds = sellProceedsUsd(sim);
    expect(proceeds).toBeLessThan(50);
    expect(proceeds).toBeLessThan(sim.execution.filledAmountUsd);
  });
});

describe('funnel classification', () => {
  const noTrade = (reasons: string[], rejectionReason: Signal['rejectionReason']): Signal =>
    signal({ action: 'NO_TRADE', reasons, rejectionReason });

  it('maps age rejections to tooYoung / tooOld', () => {
    expect(classifyStrategyRejection(noTrade(['age_out_of_range'], 'MOMENTUM_REJECTION'), 3)).toBe('tooYoung');
    expect(classifyStrategyRejection(noTrade(['age_out_of_range'], 'MOMENTUM_REJECTION'), 200)).toBe('tooOld');
  });

  it('separates unknown from low liquidity', () => {
    expect(classifyStrategyRejection(noTrade(['liquidity_status_UNKNOWN'], 'LIQUIDITY_REJECTION'), 20)).toBe(
      'unknownLiquidity',
    );
    expect(classifyStrategyRejection(noTrade(['liquidity_low'], 'LIQUIDITY_REJECTION'), 20)).toBe('lowLiquidity');
  });

  it('summarises EV near-misses', () => {
    const f = new FunnelRecorder();
    const c = (expectedNetValue: number) => ({
      tokenId: String(expectedNetValue),
      symbol: 'X',
      strategyId: 's',
      expectedNetValue,
      threshold: 0.02,
      dataConfidence: 'MEDIUM',
      executionCostRate: 0.01,
      positionSizeUsd: 25,
    });
    [0.03, 0.017, 0.012, 0.001, -0.1].forEach((v) => f.evCandidate(c(v)));
    const s = f.evSummary();
    expect(s.candidates).toBe(5);
    expect(s.best?.expectedNetValue).toBe(0.03);
    expect(s.closestMiss?.expectedNetValue).toBe(0.017);
    expect(s.within0_5pct).toBe(1);
    expect(s.within1pct).toBe(2);
    expect(s.within2pct).toBe(3);
  });
});
