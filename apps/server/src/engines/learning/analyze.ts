import type {
  ExitStats,
  FeatureStat,
  LearnableParam,
  PortfolioSettings,
} from '@memebot/shared';
import { safeDiv } from '../../utils/helpers.js';
import { getParam, stepFor } from './bounds.js';
import {
  type ClosedTrade,
  type TradeFeatures,
  bucketStats,
  holdSec,
  isWin,
  median,
  peakGainPct,
} from './types.js';

/** Minimum trades on each side of a threshold before it is analysed or acted on. */
export const MIN_BUCKET_TRADES = 8;

interface FeatureDef {
  feature: keyof TradeFeatures;
  param: LearnableParam;
  direction: 'min' | 'max';
}

export const FEATURE_DEFS: FeatureDef[] = [
  { feature: 'priceChange5mPct', param: 'minPriceChange5mPct', direction: 'min' },
  { feature: 'buySellRatio', param: 'minBuySellRatio', direction: 'min' },
  { feature: 'volumeAcceleration', param: 'minVolumeAcceleration', direction: 'min' },
  { feature: 'liquidityUsd', param: 'minLiquidityUsd', direction: 'min' },
  { feature: 'txCount5m', param: 'minActivityTx5m', direction: 'min' },
  { feature: 'volume5mUsd', param: 'minVolume5mUsd', direction: 'min' },
  { feature: 'overallScore', param: 'minOverallScore', direction: 'min' },
  { feature: 'topHolderPct', param: 'maxTopHolderPct', direction: 'max' },
  { feature: 'ageMinutes', param: 'minTokenAgeMinutes', direction: 'min' },
];

/** Rebuilds entry features from the strategy context stored on the signal. */
export function featuresFromMarketState(
  ms: Record<string, unknown> | null | undefined,
  overallScore: number,
): TradeFeatures | null {
  if (!ms || typeof ms !== 'object' || ms.priceUsd == null) return null;
  const n = (k: string) => Number(ms[k] ?? 0);
  const nullable = (k: string) => (ms[k] == null ? null : Number(ms[k]));
  const vol5m = n('volume5mUsd');
  const prior = n('priorVolume5mUsd');
  const vol1h = n('volume1hUsd');
  return {
    priceChange5mPct: n('priceChange5mPct'),
    buySellRatio: safeDiv(n('buyVolume5mUsd'), Math.max(n('sellVolume5mUsd'), 1), 0),
    volumeAcceleration: prior > 0 ? vol5m / prior : vol1h > 0 ? (vol5m * 12) / vol1h : 0,
    liquidityUsd: n('liquidityUsd'),
    txCount5m: n('txCount5m'),
    volume5mUsd: vol5m,
    overallScore,
    topHolderPct: nullable('topHolderPct'),
    ageMinutes: nullable('ageMinutes'),
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

export function analyzeFeatures(
  trades: ClosedTrade[],
  settings: PortfolioSettings,
): FeatureStat[] {
  const stats: FeatureStat[] = [];
  for (const def of FEATURE_DEFS) {
    const threshold = getParam(settings, def.param);
    if (threshold == null) continue;
    const step = stepFor(def.param, threshold);
    const candidate = def.direction === 'min' ? threshold + step : threshold - step;

    const points = trades
      .map((t) => ({ v: t.features?.[def.feature] ?? null, t }))
      .filter((p): p is { v: number; t: ClosedTrade } => p.v != null && Number.isFinite(p.v));

    const inBand = (v: number) => (def.direction === 'min' ? v < candidate : v > candidate);
    const band = points.filter((p) => inBand(p.v)).map((p) => p.t);
    const rest = points.filter((p) => !inBand(p.v)).map((p) => p.t);
    const winVals = points.filter((p) => isWin(p.t)).map((p) => p.v);
    const loseVals = points.filter((p) => !isWin(p.t)).map((p) => p.v);

    stats.push({
      feature: def.feature,
      param: def.param,
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