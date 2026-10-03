import { describe, expect, it } from 'vitest';
import { buildObservation, type PositionForObservation } from '../../src/learning/observations.js';
import { computeHealth, shouldEmit, type HealthConfig } from '../../src/learning/health.js';
import type { ObservationRecord } from '../../src/learning/repository.js';
import {
  CALIBRATION_RULES,
  PROMOTION_MIN_OBSERVATIONS,
  calibrateStrategy,
  evBuckets,
  segmentTables,
  stageFor,
  winProbabilityBuckets,
  type CalibrationObservation,
} from '../../src/learning/calibration.js';
import { decideGate } from '../../src/learning/calibration-service.js';
import { applyEvCalibration } from '../../src/risk/expected-value.js';
import { wilson } from '../../src/learning/stats.js';

const T0 = new Date('2026-10-01T12:00:00Z');

function position(over: Partial<PositionForObservation> = {}): PositionForObservation {
  return {
    id: 'pos-1',
    portfolio_id: 'pf-1',
    portfolio_type: 'PRODUCTION',
    token_id: 'tok-1',
    symbol: 'TEST',
    strategy_key: 'momentum',
    strategy_name: 'momentum',
    strategy_version: '1.0.0',
    opened_at: T0,
    closed_at: new Date(T0.getTime() + 600_000),
    entry_price_usd: '1',
    current_price_usd: '1.2',
    cost_basis_usd: '5',
    gross_pnl_usd: '1',
    net_pnl_usd: '0.9',
    entry_costs: { totalCostUsd: 0.05, slippageCostUsd: 0.03, priceImpactCostUsd: 0.01 },
    exit_costs: { totalCostUsd: 0.05, slippageCostUsd: 0.03, priceImpactCostUsd: 0.01 },
    close_reason: 'take_profit',
    stop_loss_pct: '0.08',
    take_profit_pct: '0.2',
    trailing_stop_pct: null,
    mfe_pct: '22',
    mae_pct: '-3',
    mfe_at: new Date(T0.getTime() + 540_000),
    mae_at: new Date(T0.getTime() + 60_000),
    risk_tier: 'NORMAL',
    requested_size_usd: '5',
    max_planned_loss_usd: '0.5',
    expected_net_value: '0.03',
    market_regime: 'NORMAL',
    token_phase: null,
    journal: {
      ev: {
        expectedNetValue: 0.03,
        winProbability: 0.55,
        grossUpside: 0.18,
        downside: 0.1,
        executionCostUsd: 0.1,
        executionCostRate: 0.02,
        dataConfidence: 'MEDIUM',
        costBreakdown: { slippageRate: 0.012, priceImpactRate: 0.004 },
      },
    },
    entry_snapshot: {
      features: {
        observedAt: new Date(T0.getTime() - 1500).toISOString(),
        quoteAgeMs: 1500,
        liquidityUsd: 30_000,
        volume5mUsd: 9000,
        txCount5m: 40,
        marketRegime: 'NORMAL',
      },
      maxHoldSec: 1800,
    },
    signal_market_state: { liquidityUsd: 12_345, observedAt: new Date(T0.getTime() - 30_000).toISOString() },
    signal_expected_value: null,
    signal_confidence: '70',
    signal_overall_score: '70',
    signal_data_confidence: 'MEDIUM',
    signal_created_at: new Date(T0.getTime() - 20_000),
    risk_version: 'risk-v2',
    execution_model_version: 'exec-v1',
    safety_version: 'safety-v1',
    data_mode: 'demo',
    ...over,
  };
}

describe('Level 1 — observation', () => {
  it('preserves the entry-time snapshot as the input features', () => {
    const o = buildObservation(position());
    expect(o.snapshotSource).toBe('ENTRY_SNAPSHOT');
    expect(o.entryFeatures.liquidityUsd).toBe(30_000);
    expect(o.liquidityBucket).toBe('10K_50K');
    expect(o.maxHoldSec).toBe(1800);
  });

  it('keeps outcomes out of the input features', () => {
    const o = buildObservation(position());
    const keys = Object.keys(o.entryFeatures).join(',');
    expect(keys).not.toMatch(/exit|pnl|return|mfe|mae/i);
    expect(o.exitPriceUsd).toBe(1.2);
    expect(o.netReturn).toBeCloseTo(0.18);
    expect(o.win).toBe(true);
    expect(o.timeToMfeSec).toBe(540);
    expect(o.timeToMaeSec).toBe(60);
  });

  it('rejects input features observed after entry (look-ahead) and falls back to signal-time data', () => {
    const late = position({
      entry_snapshot: { features: { observedAt: new Date(T0.getTime() + 120_000).toISOString(), liquidityUsd: 99_999 } },
    });
    const o = buildObservation(late);
    expect(o.snapshotSource).toBe('SIGNAL_BACKFILL');
    expect(o.entryFeatures.liquidityUsd).toBe(12_345);
  });

  it('separates predicted from actual execution cost and preserves classification', () => {
    const o = buildObservation(position({ portfolio_type: 'RESEARCH' }));
    expect(o.portfolioType).toBe('RESEARCH');
    expect(o.estimatedCostRate).toBe(0.02);
    expect(o.actualCostRate).toBeCloseTo(0.1 / 5);
    expect(o.actualSlippageRate).toBeCloseTo(0.06 / 5);
    expect(o.predictedWinProbability).toBe(0.55);
  });
});

let seq = 0;
function obs(over: Partial<ObservationRecord> = {}): ObservationRecord {
  seq++;
  return {
    seq,
    portfolioType: 'PRODUCTION',
    strategyId: 'momentum',
    entryAt: new Date(T0.getTime() + seq * 60_000),
    exitAt: new Date(T0.getTime() + seq * 60_000 + 300_000),
    entryPriceUsd: 1,
    exitPriceUsd: 1.05,
    positionSizeUsd: 5,
    requestedSizeUsd: 5,
    predictedEv: 0.03,
    predictedWinProbability: 0.5,
    dataConfidence: 'MEDIUM',
    riskTier: 'NORMAL',
    marketRegime: 'NORMAL',
    liquidityBucket: '10K_50K',
    maxPlannedLossUsd: 0.5,
    estimatedCostRate: 0.03,
    estimatedSlippageRate: 0.02,
    estimatedImpactRate: 0.005,
    actualCostUsd: 0.15,
    actualCostRate: 0.03,
    actualSlippageRate: 0.02,
    actualImpactRate: 0.005,
    netPnlUsd: 0.2,
    netReturn: 0.04,
    win: true,
    mfePct: 6,
    maePct: -2,
    exitReason: 'take_profit',
    quoteAgeMs: 800,
    entryLiquidityUsd: 30_000,
    entryVolume5mUsd: 9000,
    ...over,
  };
}
const loss = (over: Partial<ObservationRecord> = {}) =>
  obs({ netPnlUsd: -0.45, netReturn: -0.09, win: false, exitPriceUsd: 0.92, exitReason: 'stop_loss', ...over });
const CFG: HealthConfig = { recentWindow: 25, baselineWindow: 100, staleQuoteMs: 30_000 };
const NONE = { duplicateOpenPositions: 0 };

describe('Level 2 — health check', () => {
  it('compares a recent window with the baseline before it', () => {
    const rows = [...Array.from({ length: 60 }, () => obs()), ...Array.from({ length: 25 }, () => loss())];
    const r = computeHealth(rows, [], NONE, CFG);
    const g = r.groups.find((x) => x.scope === 'PRODUCTION' && x.strategyId === 'momentum')!;
    expect(g.recent.n).toBe(25);
    expect(g.baseline.n).toBe(60);
    expect(g.recent.outcome.winRate).toBe(0);
    expect(g.baseline.outcome.winRate).toBe(1);
    expect(g.drift.recent50!.n).toBe(50);
    expect(r.anomalies.some((a) => a.type === 'STRATEGY_PERFORMANCE_DEGRADATION' && a.strategyId === 'momentum')).toBe(true);
  });

  it('labels small samples and never escalates statistics beyond INFO below 10 trades', () => {
    const rows = Array.from({ length: 6 }, () => loss({ predictedWinProbability: 0.65 }));
    const r = computeHealth(rows, [], NONE, CFG);
    const g = r.groups.find((x) => x.strategyId === 'momentum')!;
    expect(g.recent.lowSample).toBe(true);
    expect(r.anomalies.length).toBeGreaterThan(0);
    for (const a of r.anomalies) {
      expect(a.severity).toBe('INFO');
      expect(a.lowSample).toBe(true);
      expect(a.message).toMatch(/^LOW SAMPLE \(n=6\)/);
    }
  });

  it('REGRESSION: 5 consecutive losses produce no CRITICAL/safety anomaly (no protection)', () => {
    const rows = [...Array.from({ length: 40 }, () => obs()), ...Array.from({ length: 5 }, () => loss())];
    const r = computeHealth(rows, rows.slice(-5), NONE, CFG);
    expect(r.anomalies.filter((a) => a.severity === 'CRITICAL' || a.safety)).toEqual([]);
  });

  it('flags execution-cost anomalies per strategy, not on the blended group', () => {
    const rows = Array.from({ length: 30 }, () => obs({ actualCostRate: 0.12, actualCostUsd: 0.6 }));
    const r = computeHealth(rows, [], NONE, CFG);
    const exec = r.anomalies.filter((a) => a.type === 'EXECUTION_COST_ANOMALY');
    expect(exec).toHaveLength(1);
    expect(exec[0]!.strategyId).toBe('momentum');
    expect(exec[0]!.severity).toBe('WARNING');
    expect(exec[0]!.safety).toBe(false);
  });

  it('flags objective faults on new observations as CRITICAL safety anomalies', () => {
    const bad = obs({ exitPriceUsd: 0, exitReason: 'stop_loss' });
    const dup = computeHealth([bad], [bad], { duplicateOpenPositions: 1 }, CFG);
    const crit = dup.anomalies.filter((a) => a.severity === 'CRITICAL');
    expect(crit.map((a) => a.key).sort()).toEqual([
      'PRODUCTION:ALL:DATA_QUALITY_ANOMALY:CRITICAL:invalid_price',
      'PRODUCTION:ALL:RISK_MODEL_ANOMALY:CRITICAL:duplicate_position',
    ]);
    expect(crit.every((a) => a.safety)).toBe(true);
    // An emergency exit at zero is a real outcome, not a data fault
    const emergency = obs({ exitPriceUsd: 0, exitReason: 'emergency_liquidity_collapse' });
    expect(computeHealth([emergency], [emergency], NONE, CFG).anomalies.filter((a) => a.safety)).toEqual([]);
  });

  it('suppresses duplicate alerts within the cooldown unless the metric changes materially', () => {
    const r = computeHealth(Array.from({ length: 30 }, () => obs({ actualCostRate: 0.12 })), [], NONE, CFG);
    const a = r.anomalies[0]!;
    const now = new Date();
    expect(shouldEmit(a, null, now, 60)).toBe(true);
    expect(shouldEmit(a, { createdAt: new Date(now.getTime() - 10 * 60_000), metric: a.metric }, now, 60)).toBe(false);
    expect(shouldEmit(a, { createdAt: new Date(now.getTime() - 61 * 60_000), metric: a.metric }, now, 60)).toBe(true);
    expect(shouldEmit(a, { createdAt: new Date(now.getTime() - 10 * 60_000), metric: a.metric! / 3 }, now, 60)).toBe(true);
  });

  it('keeps production and research apart', () => {
    const rows = [...Array.from({ length: 10 }, () => obs()), ...Array.from({ length: 10 }, () => loss({ portfolioType: 'RESEARCH' }))];
    const r = computeHealth(rows, [], NONE, CFG);
    const prod = r.groups.find((g) => g.scope === 'PRODUCTION' && g.strategyId == null)!;
    const res = r.groups.find((g) => g.scope === 'RESEARCH' && g.strategyId == null)!;
    expect(prod.recent.outcome.winRate).toBe(1);
    expect(res.recent.outcome.winRate).toBe(0);
  });
});

function calObs(i: number, ev: number, realized: number): CalibrationObservation {
  return {
    seq: i,
    exitAt: new Date(T0.getTime() + i * 60_000),
    predictedEv: ev,
    predictedWinProbability: 0.55,
    netReturn: realized,
    netPnlUsd: realized * 5,
    win: realized > 0,
    mfePct: 5,
    maePct: -3,
    dataConfidence: 'MEDIUM',
    marketRegime: 'NORMAL',
    liquidityBucket: '10K_50K',
    riskTier: 'NORMAL',
  };
}
/** Deterministic noise in ±1% */
const noise = (i: number) => (((i * 7919) % 101) - 50) / 5000;
/** EV is overstated: realized ≈ 0.4 × EV − 1% */
const overstated = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const ev = 0.02 + ((i * 37) % 60) / 1000;
    return calObs(i, ev, 0.4 * ev - 0.01 + noise(i));
  });

describe('Level 3 — calibration', () => {
  it('gate requires BOTH enough new observations AND the interval', () => {
    const now = new Date('2026-10-03T00:00:00Z');
    const base = { enabled: true, requiredObservations: 25, requiredHours: 24, now };
    const old = new Date(now.getTime() - 30 * 3600_000);
    const recent = new Date(now.getTime() - 2 * 3600_000);
    expect(decideGate({ ...base, newObservations: 12, intervalStartsAt: old }).decision).toBe('SKIPPED_INSUFFICIENT_OBSERVATIONS');
    expect(decideGate({ ...base, newObservations: 12, intervalStartsAt: old }).reason).toBe(
      'Insufficient TRUE_ENTRY_SNAPSHOT observations: only 12 new calibration-grade production observations; 25 required',
    );
    expect(decideGate({ ...base, newObservations: 40, intervalStartsAt: recent }).decision).toBe('SKIPPED_INTERVAL_NOT_REACHED');
    expect(decideGate({ ...base, newObservations: 40, intervalStartsAt: old }).decision).toBe('PERFORMED');
    expect(decideGate({ ...base, enabled: false, newObservations: 40, intervalStartsAt: old }).decision).toBe('SKIPPED_DISABLED');
  });

  it('skips strategies without enough data to fit AND validate', () => {
    const r = calibrateStrategy({ strategyId: 's', rows: overstated(30), current: null, totalProductionObservations: 30 });
    expect(r.computed).toBe(false);
    expect(r.skippedReason).toMatch(/need 40 to fit and 15 unseen/);
  });

  it('validates on a forward window the fit never saw', () => {
    const r = calibrateStrategy({ strategyId: 's', rows: overstated(400), current: null, totalProductionObservations: 400 });
    expect(r.computed).toBe(true);
    expect(r.trainingCount).toBe(280);
    expect(r.validationCount).toBe(120);
    expect(r.validationWindow!.start.getTime()).toBeGreaterThan(r.trainingWindow!.end.getTime());
  });

  it('promotes a conservative candidate that improves forward error at the INITIAL_CALIBRATION stage', () => {
    const r = calibrateStrategy({ strategyId: 's', rows: overstated(400), current: null, totalProductionObservations: 400 });
    expect(r.status).toBe('PROMOTED');
    expect(r.candidate!.offset).toBeLessThanOrEqual(0);
    expect(r.candidate!.scale).toBeLessThanOrEqual(1);
    expect(r.validationMetrics!.improvement!).toBeGreaterThanOrEqual(CALIBRATION_RULES.minImprovement);
  });

  it('keeps a validated candidate unpromoted below the INITIAL_CALIBRATION stage', () => {
    const r = calibrateStrategy({ strategyId: 's', rows: overstated(200), current: null, totalProductionObservations: 200 });
    expect(r.status).toBe('VALIDATED');
    expect(r.promotionDecision).toMatch(`${PROMOTION_MIN_OBSERVATIONS}+ calibration-grade production observations`);
  });

  it('rejects a candidate that does not beat the current calibration on unseen data', () => {
    const accurate = Array.from({ length: 400 }, (_, i) => {
      const ev = 0.02 + ((i * 37) % 60) / 1000;
      return calObs(i, ev, ev + noise(i));
    });
    const r = calibrateStrategy({ strategyId: 's', rows: accurate, current: null, totalProductionObservations: 400 });
    expect(r.status).toBe('REJECTED');
    expect(r.promotionDecision).toMatch(/Current calibration retained|not materially different/);
  });

  it('never makes EV more aggressive', () => {
    for (const raw of [-0.05, 0, 0.01, 0.03, 0.2]) {
      expect(applyEvCalibration(raw, { version: 'v', offset: 0.05, scale: 2 })).toBeLessThanOrEqual(raw);
      expect(applyEvCalibration(raw, { version: 'v', offset: -0.01, scale: 0.5 })).toBeLessThanOrEqual(raw);
    }
  });

  it('reports predicted-vs-realized buckets and refuses tiny segments', () => {
    const rows = overstated(120);
    const ev = evBuckets(rows);
    expect(ev.map((b) => b.label)).toContain('2–3%');
    expect(ev.reduce((a, b) => a + b.n, 0)).toBe(120);
    expect(winProbabilityBuckets(rows)[0]!.label).toBe('0.55–0.60');
    const mixed = rows.map((o, i) => ({ ...o, marketRegime: i < 5 ? 'HOT' : 'NORMAL' }));
    expect(segmentTables(mixed, ['marketRegime']).marketRegime).toEqual({
      skipped: expect.stringContaining('HOT=5'),
    });
  });

  it('labels data stages and gives honest intervals', () => {
    expect(stageFor(18).stage).toBe('OBSERVATION');
    expect(stageFor(184).stage).toBe('DESCRIPTIVE');
    expect(stageFor(300).stage).toBe('INITIAL_CALIBRATION');
    expect(stageFor(1500).stage).toBe('MODEL_FITTING');
    const ci = wilson(13, 18)!;
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.85);
  });
});
