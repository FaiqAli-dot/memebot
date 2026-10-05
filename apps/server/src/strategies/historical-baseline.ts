/**
 * Long-horizon activity baselines for the older-token research strategies, built from
 * non-overlapping windows of the provider's rolling 5m / 1h / 24h data:
 *
 *   prior history : (24h − 1h) window, spread over the covered 5-minute slots
 *   recent hour   : (1h − 5m) window, 11 slots — the hour leading into now
 *   current       : the latest 5m window
 *
 * The 24h window only covers min(24h, token age); coverage uses token age, or the span since
 * this system first observed the token when that is longer (age unknown or understated).
 * "Older" means enough prior history to measure a regime — not an arbitrary minimum age.
 */
import type { StrategyContext } from './types.js';

const SLOT_MIN = 5;
const HOUR_MIN = 60;
const DAY_MIN = 1440;
const RECENT_HOUR_SLOTS = (HOUR_MIN - SLOT_MIN) / SLOT_MIN;

export interface HistoricalBaseline {
  /** Minutes of history the provider windows cover (≤ 24h) */
  coverageMinutes: number;
  /** Minutes of history before the most recent hour */
  priorMinutes: number;
  priorVolumeUsd: number | null;
  /** Average volume per 5m in the prior-history window */
  priorVolumePer5mUsd: number | null;
  /** Average transactions per 5m in the prior-history window (null when tx counts are missing) */
  priorTxPer5m: number | null;
  /** Average volume per 5m over the last hour, excluding the current 5m window */
  recentHourVolumePer5mUsd: number | null;
  /** Why the provider windows can't be split (e.g. 1h volume above 24h volume); null when consistent */
  inconsistent: string | null;
}

export function historicalBaseline(ctx: StrategyContext): HistoricalBaseline {
  const coverageMinutes = Math.min(DAY_MIN, Math.max(ctx.ageMinutes ?? 0, ctx.observedSpanMinutes ?? 0, 0));
  const priorMinutes = Math.max(0, coverageMinutes - HOUR_MIN);
  const priorSlots = priorMinutes / SLOT_MIN;
  const v24 = ctx.volume24hUsd ?? null;
  const v1h = ctx.volume1hUsd;
  const v5m = ctx.volume5mUsd;

  let inconsistent: string | null = null;
  if (v24 == null) inconsistent = 'volume_24h_missing';
  else if (v24 + 1e-6 < v1h) inconsistent = 'volume_1h_exceeds_24h';
  else if (v1h + 1e-6 < v5m) inconsistent = 'volume_5m_exceeds_1h';

  const priorVolumeUsd = v24 != null && !inconsistent ? v24 - v1h : null;
  const priorVolumePer5mUsd = priorVolumeUsd != null && priorSlots >= 1 ? priorVolumeUsd / priorSlots : null;

  const tx1h = sumOrNull(ctx.buys1h, ctx.sells1h);
  const tx24h = sumOrNull(ctx.buys24h, ctx.sells24h);
  const priorTxPer5m =
    tx1h != null && tx24h != null && tx24h >= tx1h && priorSlots >= 1 ? (tx24h - tx1h) / priorSlots : null;

  const recentHourVolumePer5mUsd = v1h >= v5m ? (v1h - v5m) / RECENT_HOUR_SLOTS : null;

  return {
    coverageMinutes,
    priorMinutes,
    priorVolumeUsd,
    priorVolumePer5mUsd,
    priorTxPer5m,
    recentHourVolumePer5mUsd,
    inconsistent,
  };
}

/** Why the history is insufficient to establish a regime, or null when it is sufficient. */
export function insufficientHistory(
  b: HistoricalBaseline,
  p: { minHistoryCoverageHours: number; minHistoryVolumeUsd: number },
): string | null {
  if (b.inconsistent) return `history_${b.inconsistent}`;
  if (b.priorMinutes < p.minHistoryCoverageHours * HOUR_MIN) return 'history_coverage_insufficient';
  if (b.priorVolumeUsd == null || b.priorVolumeUsd < p.minHistoryVolumeUsd) return 'history_volume_insufficient';
  if (b.priorVolumePer5mUsd == null || b.priorVolumePer5mUsd <= 0) return 'history_baseline_missing';
  return null;
}

/** Ratio against a baseline; a zero baseline with positive activity is reported as Infinity. */
export function ratioTo(value: number, baseline: number | null): number | null {
  if (baseline == null) return null;
  if (baseline <= 0) return value > 0 ? Number.POSITIVE_INFINITY : null;
  return value / baseline;
}

export function fmtRatio(r: number): string {
  return Number.isFinite(r) ? `${r.toFixed(2)}x` : 'inf';
}

function sumOrNull(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : a + b;
}
