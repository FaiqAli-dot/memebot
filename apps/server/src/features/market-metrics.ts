/**
 * Market metrics from provider snapshots.
 *
 * DexScreener gives rolling windows (m5, h1, h24) re-read every poll. Comparing two
 * rolling 5m values taken seconds apart compares almost the same trades, so
 * acceleration here always uses NON-overlapping windows:
 *   current 5m  vs  the 5m value from a snapshot taken >= 5 minutes earlier.
 *
 * Short-interval volumes (30s / 1m / 15m) come from deltas of the rolling 24h
 * counters. For tokens younger than 24h nothing has rolled out of that window, so
 * the delta is the exact traded volume in the interval; for older tokens it is an
 * approximation (trades dropping out of the 24h window are subtracted) and is
 * labelled LOW confidence.
 */
import type { ConfidenceLevel } from '@memebot/shared';

export interface MetricSnapshot {
  observedAt: Date;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  txCount5m: number;
  buys5m: number | null;
  sells5m: number | null;
  buys24h: number | null;
  sells24h: number | null;
}

export type AccelMethod = 'previous_completed_5m' | 'h1_minus_m5_average' | 'none';

export interface VolumeAcceleration {
  raw: number | null;
  /** null when the baseline is insufficient — do not treat as a signal */
  capped: number | null;
  baselineUsd: number | null;
  currentUsd: number;
  method: AccelMethod;
  confidence: ConfidenceLevel;
  reasons: string[];
}

export interface AccelConfig {
  minBaselineUsd: number;
  maxAccel: number;
}

const FIVE_MIN_MS = 5 * 60_000;

/** Latest snapshot observed at or before `cutoff` (inputs may be unsorted). */
export function snapshotAtOrBefore<T extends { observedAt: Date }>(history: T[], cutoff: Date): T | null {
  let best: T | null = null;
  for (const s of history) {
    if (s.observedAt.getTime() > cutoff.getTime()) continue;
    if (!best || s.observedAt.getTime() > best.observedAt.getTime()) best = s;
  }
  return best;
}

/**
 * Previous completed 5m window: a snapshot taken between 5 and 10 minutes before
 * `current`, so its rolling 5m window does not overlap the current one.
 */
export function previousCompletedWindow<T extends { observedAt: Date }>(
  history: T[],
  current: { observedAt: Date },
): T | null {
  const prev = snapshotAtOrBefore(history, new Date(current.observedAt.getTime() - FIVE_MIN_MS));
  if (!prev) return null;
  if (current.observedAt.getTime() - prev.observedAt.getTime() > 2 * FIVE_MIN_MS) return null;
  return prev;
}

export function computeVolumeAcceleration(opts: {
  current: MetricSnapshot;
  previous: MetricSnapshot | null;
  ageMinutes: number | null;
  config: AccelConfig;
}): VolumeAcceleration {
  const { current, previous, ageMinutes, config } = opts;
  const reasons: string[] = [];
  let baseline: number | null = null;
  let method: AccelMethod = 'none';
  let methodConfidence: ConfidenceLevel = 'UNKNOWN';

  if (previous) {
    baseline = previous.volume5mUsd;
    method = 'previous_completed_5m';
    methodConfidence = 'MEDIUM';
  } else if (ageMinutes != null && ageMinutes >= 10 && current.volume1hUsd > current.volume5mUsd) {
    // Average 5m volume over the part of the last hour before the current 5m window
    const priorMinutes = Math.min(55, ageMinutes - 5);
    baseline = (current.volume1hUsd - current.volume5mUsd) / (priorMinutes / 5);
    method = 'h1_minus_m5_average';
    methodConfidence = 'LOW';
  } else {
    reasons.push('no_non_overlapping_baseline');
  }

  const raw = baseline != null && baseline > 0 ? current.volume5mUsd / baseline : null;

  if (baseline == null || baseline < config.minBaselineUsd) {
    if (baseline != null) reasons.push('baseline_below_min');
    return {
      raw,
      capped: null,
      baselineUsd: baseline,
      currentUsd: current.volume5mUsd,
      method,
      confidence: 'UNKNOWN',
      reasons: [...reasons, 'insufficient_data'],
    };
  }

  let capped = raw ?? 0;
  if (capped > config.maxAccel) {
    capped = config.maxAccel;
    reasons.push('capped_at_max');
  }
  return {
    raw,
    capped,
    baselineUsd: baseline,
    currentUsd: current.volume5mUsd,
    method,
    confidence: methodConfidence,
    reasons,
  };
}

export interface IntervalMetric {
  value: number | null;
  /** Actual elapsed seconds between the two snapshots used */
  elapsedSec: number | null;
  confidence: ConfidenceLevel;
}

/** Delta of a rolling-24h counter between now and the snapshot at/before now - windowSec. */
export function intervalDelta(opts: {
  current: MetricSnapshot;
  history: MetricSnapshot[];
  windowSec: number;
  pick: (s: MetricSnapshot) => number | null;
  ageMinutes: number | null;
}): IntervalMetric {
  const past = snapshotAtOrBefore(
    opts.history,
    new Date(opts.current.observedAt.getTime() - opts.windowSec * 1000),
  );
  const now = opts.pick(opts.current);
  const then = past ? opts.pick(past) : null;
  if (!past || now == null || then == null) {
    return { value: null, elapsedSec: null, confidence: 'UNKNOWN' };
  }
  const elapsedSec = (opts.current.observedAt.getTime() - past.observedAt.getTime()) / 1000;
  if (elapsedSec > opts.windowSec * 2) {
    return { value: null, elapsedSec, confidence: 'UNKNOWN' };
  }
  const delta = now - then;
  const young = opts.ageMinutes != null && opts.ageMinutes < 24 * 60;
  if (delta < 0) {
    return { value: null, elapsedSec, confidence: 'UNKNOWN' };
  }
  return { value: delta, elapsedSec, confidence: young ? 'MEDIUM' : 'LOW' };
}

export interface FlowAccel {
  value: number | null;
  confidence: ConfidenceLevel;
  reason?: string;
}

function countAccel(now: number | null, prev: number | null, minBaseline: number): FlowAccel {
  if (now == null || prev == null) return { value: null, confidence: 'UNKNOWN', reason: 'counts_unavailable' };
  if (prev < minBaseline) {
    return { value: null, confidence: 'UNKNOWN', reason: 'baseline_below_min' };
  }
  return { value: now / prev, confidence: 'MEDIUM' };
}

export interface MarketMetrics {
  volumeAcceleration: VolumeAcceleration;
  volume30sUsd: IntervalMetric;
  volume1mUsd: IntervalMetric;
  volume5mUsd: IntervalMetric;
  volume15mUsd: IntervalMetric;
  buys1m: IntervalMetric;
  sells1m: IntervalMetric;
  buyAcceleration: FlowAccel;
  sellAcceleration: FlowAccel;
  transactionAcceleration: FlowAccel;
  /** Wallet-level data not available from the current provider */
  uniqueBuyerAcceleration: FlowAccel;
  observations10m: number;
}

const MIN_COUNT_BASELINE = 5;

export function computeMarketMetrics(opts: {
  current: MetricSnapshot;
  /** Snapshots strictly before `current` (no look-ahead) */
  history: MetricSnapshot[];
  ageMinutes: number | null;
  config: AccelConfig;
}): MarketMetrics {
  const history = opts.history.filter((s) => s.observedAt.getTime() < opts.current.observedAt.getTime());
  const previous = previousCompletedWindow(history, opts.current);
  const volumeAcceleration = computeVolumeAcceleration({
    current: opts.current,
    previous,
    ageMinutes: opts.ageMinutes,
    config: opts.config,
  });
  const delta = (windowSec: number, pick: (s: MetricSnapshot) => number | null) =>
    intervalDelta({ current: opts.current, history, windowSec, pick, ageMinutes: opts.ageMinutes });

  const tenMinAgo = opts.current.observedAt.getTime() - 10 * 60_000;
  return {
    volumeAcceleration,
    volume30sUsd: delta(30, (s) => s.volume24hUsd),
    volume1mUsd: delta(60, (s) => s.volume24hUsd),
    volume5mUsd: { value: opts.current.volume5mUsd, elapsedSec: 300, confidence: 'MEDIUM' },
    volume15mUsd: delta(900, (s) => s.volume24hUsd),
    buys1m: delta(60, (s) => s.buys24h),
    sells1m: delta(60, (s) => s.sells24h),
    buyAcceleration: countAccel(opts.current.buys5m, previous?.buys5m ?? null, MIN_COUNT_BASELINE),
    sellAcceleration: countAccel(opts.current.sells5m, previous?.sells5m ?? null, MIN_COUNT_BASELINE),
    transactionAcceleration: countAccel(opts.current.txCount5m, previous?.txCount5m ?? null, MIN_COUNT_BASELINE),
    uniqueBuyerAcceleration: {
      value: null,
      confidence: 'UNKNOWN',
      reason: 'wallet_level_data_unavailable',
    },
    observations10m: history.filter((s) => s.observedAt.getTime() >= tenMinAgo).length + 1,
  };
}
