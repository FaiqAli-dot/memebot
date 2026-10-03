import {
  STRATEGY_PARAM_REGISTRY,
  type ExitStats,
  type FeatureStat,
  type LearnableParam,
  type PortfolioSettings,
  type StrategyInputs,
  type StrategyParamDef,
  type StrategyParamValues,
} from '@memebot/shared';
import { safeDiv } from '../../utils/helpers.js';
import { strategyStep } from './bounds.js';
import {
  type ClosedTrade,
  bucketStats,
  holdSec,
  isWin,
  median,
  peakGainPct,
} from './types.js';

/** Minimum trades on each side of a threshold before it is analysed or acted on. */
export const MIN_BUCKET_TRADES = 8;

/**
 * Rebuilds the strategy inputs from the context stored on the signal. Volume acceleration is
 * the capped non-overlapping value strategies compare against (`volumeAccel.capped`).
 */
export function strategyInputsFromMarketState(
  ms: Record<string, unknown> | null | undefined,
  overallScore: number | null,
): StrategyInputs | null {
  if (!ms || typeof ms !== 'object') return null;
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const accel = ms.volumeAccel && typeof ms.volumeAccel === 'object' ? (ms.volumeAccel as Record<string, unknown>) : null;
  const buy = num(ms.buyVolume5mUsd);
  const sell = num(ms.sellVolume5mUsd);
  return {
    priceChange5mPct: num(ms.priceChange5mPct),
    buySellRatio: buy == null || sell == null ? null : safeDiv(buy, Math.max(sell, 1), 0),
    volumeAcceleration: accel ? num(accel.capped) : null,
    liquidityUsd: num(ms.liquidityUsd),
    txCount5m: num(ms.txCount5m),
    volume5mUsd: num(ms.volume5mUsd),
    overallScore: overallScore != null && Number.isFinite(overallScore) ? overallScore : null,
    topHolderPct: num(ms.topHolderPct),
    ageMinutes: num(ms.ageMinutes),
  };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function quartiles(points: Array<{ v: number; t: ClosedTrade }>): FeatureStat['quartiles'] {
  if (points.length < MIN_BUCKET_TRADES) return [];
  const sorted = [...points].sort((a, b) => a.v - b.v);
  const out: FeatureStat['quartiles'] = [];
  for (let q = 0; q < 4; q++) {
    const slice = sorted.slice(
      Math.floor((q * sorted.length) / 4),
      Math.floor(((q + 1) * sorted.length) / 4),
    );
    if (!slice.length) continue;
    out.push({
      from: slice[0]!.v,
      to: slice.at(-1)!.v,
      ...bucketStats(slice.map((p) => p.t)),
    });
  }
  return out;
}

/** One guarded tightening step for a threshold. */
export function tightenedThreshold(def: StrategyParamDef, threshold: number): number {
  const step = strategyStep(def, threshold);
  return def.direction === 'min' ? threshold + step : threshold - step;
}

/** Trades the tightened threshold would filter out ("near the limit"). */
export function inBand(def: StrategyParamDef, candidate: number, v: number): boolean {
  return def.direction === 'min' ? v < candidate : v > candidate;
}

export function featurePoints(trades: ClosedTrade[], def: StrategyParamDef): Array<{ v: number; t: ClosedTrade }> {
  if (!def.feature) return [];
  const feature = def.feature;
  return trades
    .map((t) => ({ v: t.features?.[feature] ?? null, t }))
    .filter((p): p is { v: number; t: ClosedTrade } => p.v != null && Number.isFinite(p.v));
}

/** Winners vs losers around each learnable threshold the strategy actually consumes. */
export function analyzeStrategyFeatures(
  strategyId: string,
  trades: ClosedTrade[],
  params: StrategyParamValues,
): Array<FeatureStat & { strategyId: string }> {
  const stats: Array<FeatureStat & { strategyId: string }> = [];
  for (const def of STRATEGY_PARAM_REGISTRY[strategyId]?.params ?? []) {
    if (!def.feature) continue;
    const threshold = params[def.key] ?? def.default;
    const candidate = tightenedThreshold(def, threshold);
    const points = featurePoints(trades, def);
    const band = points.filter((p) => inBand(def, candidate, p.v)).map((p) => p.t);
    const rest = points.filter((p) => !inBand(def, candidate, p.v)).map((p) => p.t);
    const winVals = points.filter((p) => isWin(p.t)).map((p) => p.v);
    const loseVals = points.filter((p) => !isWin(p.t)).map((p) => p.v);
    stats.push({
      strategyId,
      feature: def.feature,
      param: def.key as LearnableParam,
      direction: def.direction,
      threshold,
      candidate,
      winners: { n: winVals.length, mean: mean(winVals) },
      losers: { n: loseVals.length, mean: mean(loseVals) },
      band: bucketStats(band),
      rest: bucketStats(rest),
      quartiles: quartiles(points),
    });
  }
  return stats;
}

export function analyzeExits(trades: ClosedTrade[], settings: PortfolioSettings): ExitStats {
  const byReason: Record<string, number> = {};
  for (const t of trades) {
    const r = t.closeReason ?? 'unknown';
    byReason[r] = (byReason[r] ?? 0) + 1;
  }
  const stops = trades.filter((t) => t.closeReason === 'stop_loss');
  const winners = trades.filter(isWin);
  const losers = trades.filter((t) => !isWin(t));
  // A loser "was up" if it reached at least half the take-profit target before reversing.
  const upThresholdPct = settings.takeProfitPct * 100 * 0.5;
  const losersUp = losers.filter((t) => peakGainPct(t) >= upThresholdPct);

  return {
    total: trades.length,
    byReason,
    stopLossSharePct: trades.length ? (stops.length / trades.length) * 100 : 0,
    medianStopHoldSec: median(stops.map(holdSec)),
    medianWinnerHoldSec: median(winners.map(holdSec)),
    losers: losers.length,
    losersThatWereUp: losersUp.length,
    losersThatWereUpSharePct: losers.length ? (losersUp.length / losers.length) * 100 : 0,
    avgLoserPeakGainPct: mean(losers.map(peakGainPct)),
  };
}
