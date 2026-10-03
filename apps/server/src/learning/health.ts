/**
 * LEVEL 2 — trade health / anomaly check. Pure: no database, no side effects.
 *
 * Runs every N new observations. It compares a recent window against a baseline window
 * per scope (PRODUCTION / RESEARCH) and per strategy, and flags anomalies. It NEVER
 * changes thresholds, EV coefficients, risk multipliers, stops or strategy state.
 *
 * Severity:
 *   INFO     — deviation, or any statistical finding on a small sample
 *   WARNING  — persistent deviation with an adequate sample
 *   CRITICAL — reserved for objective implementation/data faults (invalid prices, broken
 *              cost math, impossible losses, duplicate positions). Ordinary losing streaks
 *              can never be CRITICAL.
 */
import type { ObservationRecord } from './repository.js';
import { finite, mean, meanDropZ, meanInterval, median, profitFactor, stdev, wilson, type Interval } from './stats.js';

export type AnomalyType =
  | 'EXECUTION_COST_ANOMALY'
  | 'EV_CALIBRATION_ANOMALY'
  | 'WIN_PROBABILITY_CALIBRATION_ANOMALY'
  | 'STRATEGY_PERFORMANCE_DEGRADATION'
  | 'DATA_QUALITY_ANOMALY'
  | 'RISK_MODEL_ANOMALY';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Anomaly {
  key: string;
  type: AnomalyType;
  severity: Severity;
  scope: 'PRODUCTION' | 'RESEARCH';
  strategyId: string | null;
  /** Objective implementation/data fault; the only kind allowed to trigger protection */
  safety: boolean;
  message: string;
  metric: number | null;
  sampleSize: number;
  lowSample: boolean;
  evidence: Record<string, unknown>;
}

export interface HealthConfig {
  recentWindow: number;
  baselineWindow: number;
  staleQuoteMs: number;
}

export interface WindowSummary {
  n: number;
  lowSample: boolean;
  outcome: {
    winRate: number | null;
    winRateCI: Interval | null;
    avgNetPnlUsd: number | null;
    medianNetPnlUsd: number | null;
    avgReturn: number | null;
    avgReturnCI: Interval | null;
    profitFactor: number | null;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    largestWinUsd: number | null;
    largestLossUsd: number | null;
  };
  prediction: {
    avgPredictedEv: number | null;
    avgRealizedReturn: number | null;
    predictedMinusRealized: number | null;
    avgPredictedWinProbability: number | null;
    actualWinRate: number | null;
  };
  execution: {
    estimatedCostRate: number | null;
    actualCostRate: number | null;
    estimatedSlippageRate: number | null;
    actualSlippageRate: number | null;
    estimatedImpactRate: number | null;
    actualImpactRate: number | null;
  };
  risk: {
    avgRequestedSizeUsd: number | null;
    avgFinalSizeUsd: number | null;
    avgMaxPlannedLossUsd: number | null;
    avgActualLossUsd: number | null;
    stopLossRate: number | null;
    takeProfitRate: number | null;
    trailingStopRate: number | null;
    maxHoldRate: number | null;
    emergencyRate: number | null;
  };
  excursion: { avgMfePct: number | null; avgMaePct: number | null };
}

export interface GroupHealth {
  scope: 'PRODUCTION' | 'RESEARCH';
  strategyId: string | null;
  total: number;
  recent: WindowSummary;
  baseline: WindowSummary;
  drift: Record<string, WindowSummary>;
}

export interface HealthResult {
  groups: GroupHealth[];
  anomalies: Anomaly[];
}

export const MIN_STAT_SAMPLE = 10;
const isEmergency = (o: ObservationRecord) => (o.exitReason ?? '').startsWith('emergency');
const rateOf = (rows: ObservationRecord[], pred: (o: ObservationRecord) => boolean) =>
  rows.length ? rows.filter(pred).length / rows.length : null;

export function summarize(rows: ObservationRecord[], recentWindow: number): WindowSummary {
  const pnl = rows.map((o) => o.netPnlUsd);
  const rets = rows.map((o) => o.netReturn);
  const wins = rows.filter((o) => o.win);
  const losses = rows.filter((o) => !o.win);
  const winRate = rows.length ? wins.length / rows.length : null;
  const withEv = rows.filter((o) => o.predictedEv != null);
  const avgPredEv = mean(finite(withEv.map((o) => o.predictedEv)));
  const avgRealizedEvRows = mean(withEv.map((o) => o.netReturn));
  return {
    n: rows.length,
    lowSample: rows.length < recentWindow,
    outcome: {
      winRate,
      winRateCI: wilson(wins.length, rows.length),
      avgNetPnlUsd: mean(pnl),
      medianNetPnlUsd: median(pnl),
      avgReturn: mean(rets),
      avgReturnCI: meanInterval(rets),
      profitFactor: profitFactor(pnl),
      avgWinUsd: mean(wins.map((o) => o.netPnlUsd)),
      avgLossUsd: mean(losses.map((o) => o.netPnlUsd)),
      largestWinUsd: pnl.length ? Math.max(...pnl) : null,
      largestLossUsd: pnl.length ? Math.min(...pnl) : null,
    },
    prediction: {
      avgPredictedEv: avgPredEv,
      avgRealizedReturn: avgRealizedEvRows,
      predictedMinusRealized: avgPredEv != null && avgRealizedEvRows != null ? avgPredEv - avgRealizedEvRows : null,
      avgPredictedWinProbability: mean(finite(rows.map((o) => o.predictedWinProbability))),
      actualWinRate: winRate,
    },
    execution: {
      estimatedCostRate: mean(finite(rows.map((o) => o.estimatedCostRate))),
      actualCostRate: mean(finite(rows.map((o) => o.actualCostRate))),
      estimatedSlippageRate: mean(finite(rows.map((o) => o.estimatedSlippageRate))),
      actualSlippageRate: mean(finite(rows.map((o) => o.actualSlippageRate))),
      estimatedImpactRate: mean(finite(rows.map((o) => o.estimatedImpactRate))),
      actualImpactRate: mean(finite(rows.map((o) => o.actualImpactRate))),
    },
    risk: {
      avgRequestedSizeUsd: mean(finite(rows.map((o) => o.requestedSizeUsd))),
      avgFinalSizeUsd: mean(rows.map((o) => o.positionSizeUsd)),
      avgMaxPlannedLossUsd: mean(finite(rows.map((o) => o.maxPlannedLossUsd))),
      avgActualLossUsd: mean(losses.map((o) => -o.netPnlUsd)),
      stopLossRate: rateOf(rows, (o) => o.exitReason === 'stop_loss'),
      takeProfitRate: rateOf(rows, (o) => o.exitReason === 'take_profit'),
      trailingStopRate: rateOf(rows, (o) => o.exitReason === 'trailing_stop'),
      maxHoldRate: rateOf(rows, (o) => o.exitReason === 'max_holding_time'),
      emergencyRate: rateOf(rows, isEmergency),
    },
    excursion: {
      avgMfePct: mean(finite(rows.map((o) => o.mfePct))),
      avgMaePct: mean(finite(rows.map((o) => o.maePct))),
    },
  };
}

/** Statistical findings are never CRITICAL; small samples are capped at INFO. */
function statSeverity(n: number, strong: boolean, recentWindow: number): Severity {
  if (n < MIN_STAT_SAMPLE) return 'INFO';
  if (n < recentWindow) return strong ? 'WARNING' : 'INFO';
  return 'WARNING';
}

function anomaly(
  a: Omit<Anomaly, 'key' | 'lowSample'> & { variant?: string },
  recentWindow: number,
): Anomaly {
  const { variant, ...rest } = a;
  const key = [a.scope, a.strategyId ?? 'ALL', a.type, a.severity, variant].filter(Boolean).join(':');
  const lowSample = a.sampleSize < recentWindow;
  const prefix = lowSample && !a.safety ? `LOW SAMPLE (n=${a.sampleSize}) — ` : '';
  return { ...rest, key, lowSample, message: prefix + a.message };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function statisticalAnomalies(
  g: { scope: GroupHealth['scope']; strategyId: string | null },
  recent: ObservationRecord[],
  baseline: ObservationRecord[],
  cfg: HealthConfig,
): Anomaly[] {
  const out: Anomaly[] = [];
  const n = recent.length;
  if (n < 5) return out;
  const base = { scope: g.scope, strategyId: g.strategyId, safety: false };

  // A. execution cost: realized vs estimated round-trip cost
  const costRows = recent.filter((o) => o.estimatedCostRate != null && o.actualCostRate != null && o.estimatedCostRate > 0);
  if (costRows.length >= 5) {
    const est = mean(costRows.map((o) => o.estimatedCostRate!))!;
    const act = mean(costRows.map((o) => o.actualCostRate!))!;
    const ratio = act / est;
    if (ratio >= 2) {
      out.push(
        anomaly(
          {
            ...base,
            type: 'EXECUTION_COST_ANOMALY',
            severity: statSeverity(costRows.length, ratio >= 4, cfg.recentWindow),
            message: `Actual round-trip cost ${pct(act)} vs estimated ${pct(est)} (${ratio.toFixed(1)}×)`,
            metric: ratio,
            sampleSize: costRows.length,
            evidence: {
              estimatedCostRate: est,
              actualCostRate: act,
              estimatedSlippageRate: mean(finite(costRows.map((o) => o.estimatedSlippageRate))),
              actualSlippageRate: mean(finite(costRows.map((o) => o.actualSlippageRate))),
              estimatedImpactRate: mean(finite(costRows.map((o) => o.estimatedImpactRate))),
              actualImpactRate: mean(finite(costRows.map((o) => o.actualImpactRate))),
            },
          },
          cfg.recentWindow,
        ),
      );
    }
  }

  // Execution cost drift: recent actual cost vs baseline actual cost
  const recentCost = finite(recent.map((o) => o.actualCostRate));
  const baseCost = finite(baseline.map((o) => o.actualCostRate));
  if (recentCost.length >= MIN_STAT_SAMPLE && baseCost.length >= 20) {
    const r = mean(recentCost)!;
    const b = mean(baseCost)!;
    if (b > 0 && r / b >= 1.5) {
      out.push(
        anomaly(
          {
            ...base,
            type: 'EXECUTION_COST_ANOMALY',
            variant: 'drift',
            severity: statSeverity(recentCost.length, r / b >= 2.5, cfg.recentWindow),
            message: `Execution cost drifted up: recent ${pct(r)} vs baseline ${pct(b)}`,
            metric: r / b,
            sampleSize: recentCost.length,
            evidence: { recentActualCostRate: r, baselineActualCostRate: b, baselineN: baseCost.length },
          },
          cfg.recentWindow,
        ),
      );
    }
  }

  // B. EV calibration: mean predicted EV vs mean realized net return
  const evRows = recent.filter((o) => o.predictedEv != null);
  if (evRows.length >= 5) {
    const pred = mean(evRows.map((o) => o.predictedEv!))!;
    const realized = evRows.map((o) => o.netReturn);
    const real = mean(realized)!;
    const sd = stdev(realized) ?? 0;
    const se = sd / Math.sqrt(evRows.length);
    const gap = pred - real;
    if (pred > 0 && se > 0 && gap > 2 * se) {
      out.push(
        anomaly(
          {
            ...base,
            type: 'EV_CALIBRATION_ANOMALY',
            severity: statSeverity(evRows.length, gap > 3 * se, cfg.recentWindow),
            message: `Predicted EV ${pct(pred)} vs realized ${pct(real)} per trade (gap ${(gap / se).toFixed(1)} standard errors)`,
            metric: gap,
            sampleSize: evRows.length,
            evidence: { avgPredictedEv: pred, avgRealizedReturn: real, standardError: se },
          },
          cfg.recentWindow,
        ),
      );
    }
  }

  // C. win probability: mean predicted P(win) above the actual win-rate confidence interval
  const pRows = recent.filter((o) => o.predictedWinProbability != null);
  if (pRows.length >= 5) {
    const p = mean(pRows.map((o) => o.predictedWinProbability!))!;
    const wins = pRows.filter((o) => o.win).length;
    const ci = wilson(wins, pRows.length)!;
    if (p > ci.high) {
      out.push(
        anomaly(
          {
            ...base,
            type: 'WIN_PROBABILITY_CALIBRATION_ANOMALY',
            severity: statSeverity(pRows.length, p > ci.high + 0.1, cfg.recentWindow),
            message: `Predicted win probability ${pct(p)} is above the actual win-rate interval ${pct(ci.low)}–${pct(ci.high)}`,
            metric: p - wins / pRows.length,
            sampleSize: pRows.length,
            evidence: { avgPredicted: p, actualWinRate: wins / pRows.length, winRateCI: ci },
          },
          cfg.recentWindow,
        ),
      );
    }
  }

  // D. degradation: recent mean return significantly below the baseline mean
  if (n >= MIN_STAT_SAMPLE && baseline.length >= 20) {
    const z = meanDropZ(
      recent.map((o) => o.netReturn),
      baseline.map((o) => o.netReturn),
    );
    if (z != null && z > 2) {
      out.push(
        anomaly(
          {
            ...base,
            type: 'STRATEGY_PERFORMANCE_DEGRADATION',
            severity: statSeverity(n, z > 3, cfg.recentWindow),
            message: `Recent mean return ${pct(mean(recent.map((o) => o.netReturn))!)} vs baseline ${pct(mean(baseline.map((o) => o.netReturn))!)} (z=${z.toFixed(1)})`,
            metric: z,
            sampleSize: n,
            evidence: {
              recentWinRate: rateOf(recent, (o) => o.win),
              baselineWinRate: rateOf(baseline, (o) => o.win),
              baselineN: baseline.length,
            },
          },
          cfg.recentWindow,
        ),
      );
    }
  }
  return out;
}

function scopeAnomalies(
  scope: GroupHealth['scope'],
  recent: ObservationRecord[],
  cfg: HealthConfig,
): Anomaly[] {
  const out: Anomaly[] = [];
  const n = recent.length;
  if (n < 5) return out;
  const base = { scope, strategyId: null, safety: false };

  // E. data quality at entry: stale quotes or missing liquidity/volume inputs
  const stale = recent.filter((o) => o.quoteAgeMs != null && o.quoteAgeMs > cfg.staleQuoteMs).length;
  const missing = recent.filter((o) => o.entryLiquidityUsd == null || o.entryVolume5mUsd == null).length;
  const share = (stale + missing) / n;
  if (share >= 0.2) {
    out.push(
      anomaly(
        {
          ...base,
          type: 'DATA_QUALITY_ANOMALY',
          severity: statSeverity(n, share >= 0.5, cfg.recentWindow),
          message: `${stale} stale-quote and ${missing} missing-input entries in the last ${n} trades`,
          metric: share,
          sampleSize: n,
          evidence: { staleQuotes: stale, missingInputs: missing },
        },
        cfg.recentWindow,
      ),
    );
  }
  const jumps = recent.filter(
    (o) =>
      !isEmergency(o) &&
      o.exitPriceUsd != null &&
      o.exitPriceUsd > 0 &&
      o.entryPriceUsd > 0 &&
      (o.exitPriceUsd / o.entryPriceUsd > 20 || o.exitPriceUsd / o.entryPriceUsd < 0.05),
  );
  if (jumps.length > 0) {
    out.push(
      anomaly(
        {
          ...base,
          type: 'DATA_QUALITY_ANOMALY',
          variant: 'price_jump',
          severity: jumps.length >= 2 ? 'WARNING' : 'INFO',
          message: `${jumps.length} trade(s) exited at a price more than 20× away from entry outside an emergency exit`,
          metric: jumps.length,
          sampleSize: n,
          evidence: { seqs: jumps.map((o) => o.seq) },
        },
        cfg.recentWindow,
      ),
    );
  }

  // F. risk model: realized losses beyond the planned maximum loss (non-emergency exits)
  const planned = recent.filter((o) => !o.win && !isEmergency(o) && o.maxPlannedLossUsd != null && o.maxPlannedLossUsd > 0);
  const over = planned.filter((o) => -o.netPnlUsd > o.maxPlannedLossUsd! * 1.5);
  if (planned.length >= 5 && over.length >= 2 && over.length / planned.length >= 0.2) {
    const ratio = over.length / planned.length;
    out.push(
      anomaly(
        {
          ...base,
          type: 'RISK_MODEL_ANOMALY',
          severity: statSeverity(planned.length, ratio >= 0.4, cfg.recentWindow),
          message: `${over.length} of ${planned.length} non-emergency losses exceeded 1.5× the planned maximum loss`,
          metric: ratio,
          sampleSize: planned.length,
          evidence: {
            avgPlannedLossUsd: mean(over.map((o) => o.maxPlannedLossUsd!)),
            avgActualLossUsd: mean(over.map((o) => -o.netPnlUsd)),
            avgActualCostRate: mean(finite(over.map((o) => o.actualCostRate))),
          },
        },
        cfg.recentWindow,
      ),
    );
  }
  return out;
}

/**
 * Objective implementation/data faults, checked only on observations that are new since the
 * last health check (so a single historical fault is reported once, not on every check).
 */
export function safetyAnomalies(
  newRows: ObservationRecord[],
  system: { duplicateOpenPositions: number },
  recentWindow: number,
): Anomaly[] {
  const out: Anomaly[] = [];
  const crit = (scope: GroupHealth['scope'], type: AnomalyType, variant: string, message: string, rows: ObservationRecord[]) =>
    anomaly(
      {
        scope,
        strategyId: null,
        safety: true,
        type,
        variant,
        severity: 'CRITICAL',
        message,
        metric: rows.length,
        sampleSize: rows.length,
        evidence: { seqs: rows.map((o) => o.seq) },
      },
      recentWindow,
    );
  for (const scope of ['PRODUCTION', 'RESEARCH'] as const) {
    const rows = newRows.filter((o) => o.portfolioType === scope);
    const badPrice = rows.filter(
      (o) =>
        !Number.isFinite(o.entryPriceUsd) ||
        o.entryPriceUsd <= 0 ||
        (o.exitPriceUsd != null && !Number.isFinite(o.exitPriceUsd)) ||
        (!isEmergency(o) && (o.exitPriceUsd == null || o.exitPriceUsd <= 0)),
    );
    if (badPrice.length) {
      out.push(crit(scope, 'DATA_QUALITY_ANOMALY', 'invalid_price', `${badPrice.length} trade(s) recorded an invalid entry/exit price`, badPrice));
    }
    const badCost = rows.filter(
      (o) => !(o.positionSizeUsd > 0) || (o.actualCostUsd != null && (!Number.isFinite(o.actualCostUsd) || o.actualCostUsd < 0)),
    );
    if (badCost.length) {
      out.push(crit(scope, 'EXECUTION_COST_ANOMALY', 'invalid_cost', `${badCost.length} trade(s) have a negative/invalid execution cost or size`, badCost));
    }
    const impossible = rows.filter(
      (o) => !isEmergency(o) && o.positionSizeUsd > 0 && -o.netPnlUsd > o.positionSizeUsd + (o.actualCostUsd ?? 0) + 0.01,
    );
    if (impossible.length) {
      out.push(crit(scope, 'RISK_MODEL_ANOMALY', 'impossible_loss', `${impossible.length} trade(s) lost more than the capital committed`, impossible));
    }
  }
  if (system.duplicateOpenPositions > 0) {
    out.push(
      anomaly(
        {
          scope: 'PRODUCTION',
          strategyId: null,
          safety: true,
          type: 'RISK_MODEL_ANOMALY',
          variant: 'duplicate_position',
          severity: 'CRITICAL',
          message: `${system.duplicateOpenPositions} token(s) have more than one open position in a portfolio`,
          metric: system.duplicateOpenPositions,
          sampleSize: system.duplicateOpenPositions,
          evidence: {},
        },
        recentWindow,
      ),
    );
  }
  return out;
}

/** Windows: recent = last R; baseline = up to B observations before the recent window. */
export function computeHealth(
  all: ObservationRecord[],
  newRows: ObservationRecord[],
  system: { duplicateOpenPositions: number },
  cfg: HealthConfig,
): HealthResult {
  const groups: GroupHealth[] = [];
  const anomalies: Anomaly[] = [];
  for (const scope of ['PRODUCTION', 'RESEARCH'] as const) {
    const scoped = all.filter((o) => o.portfolioType === scope);
    if (!scoped.length) continue;
    const strategies = [...new Set(scoped.map((o) => o.strategyId))].sort();
    const sets: Array<[string | null, ObservationRecord[]]> = [[null, scoped], ...strategies.map((s): [string, ObservationRecord[]] => [s, scoped.filter((o) => o.strategyId === s)])];
    for (const [strategyId, rows] of sets) {
      const recent = rows.slice(-cfg.recentWindow);
      const baseline = rows.slice(Math.max(0, rows.length - cfg.recentWindow - cfg.baselineWindow), rows.length - recent.length);
      const drift: Record<string, WindowSummary> = {};
      for (const w of [25, 50, 100]) {
        if (rows.length >= w) drift[`recent${w}`] = summarize(rows.slice(-w), cfg.recentWindow);
      }
      if (rows.length > 100) drift.historical = summarize(rows.slice(0, -100), cfg.recentWindow);
      groups.push({
        scope,
        strategyId,
        total: rows.length,
        recent: summarize(recent, cfg.recentWindow),
        baseline: summarize(baseline, cfg.recentWindow),
        drift,
      });
      // Outcome/prediction anomalies are judged per strategy, never on the blended number
      if (strategyId != null) anomalies.push(...statisticalAnomalies({ scope, strategyId }, recent, baseline, cfg));
    }
    anomalies.push(...scopeAnomalies(scope, scoped.slice(-cfg.recentWindow), cfg));
  }
  anomalies.push(...safetyAnomalies(newRows, system, cfg.recentWindow));
  return { groups, anomalies };
}

/** Dedup: re-emit only after the cooldown, or when the metric moved materially (>50%). */
export function shouldEmit(
  a: Anomaly,
  last: { createdAt: Date; metric: number | null } | null,
  now: Date,
  cooldownMinutes: number,
): boolean {
  if (!last) return true;
  if (now.getTime() - last.createdAt.getTime() >= cooldownMinutes * 60_000) return true;
  if (a.metric == null || last.metric == null) return false;
  const denom = Math.max(Math.abs(last.metric), 1e-9);
  return Math.abs(a.metric - last.metric) / denom > 0.5;
}
