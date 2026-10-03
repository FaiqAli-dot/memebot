import type { LearnableParam, PortfolioSettings } from '@memebot/shared';

/** Largest relative change the learner may make to one setting in one day. */
export const MAX_STEP_PCT = 0.1;

interface Bound {
  min: number;
  max: number;
  /** Floor for the step so tiny values can still move. */
  minStep: number;
  decimals: number;
}

export const LEARNING_BOUNDS: Record<LearnableParam, Bound> = {
  minPriceChange5mPct: { min: 0.5, max: 10, minStep: 0.1, decimals: 2 },
  minBuySellRatio: { min: 1, max: 3, minStep: 0.02, decimals: 2 },
  minVolumeAcceleration: { min: 1, max: 3, minStep: 0.02, decimals: 2 },
  minLiquidityUsd: { min: 2_000, max: 100_000, minStep: 200, decimals: 0 },
  minActivityTx5m: { min: 5, max: 200, minStep: 1, decimals: 0 },
  minVolume5mUsd: { min: 500, max: 50_000, minStep: 100, decimals: 0 },
  minOverallScore: { min: 40, max: 85, minStep: 1, decimals: 1 },
  maxTopHolderPct: { min: 10, max: 60, minStep: 1, decimals: 1 },
  minTokenAgeMinutes: { min: 1, max: 120, minStep: 0.5, decimals: 1 },
  stopLossPct: { min: 0.03, max: 0.25, minStep: 0.005, decimals: 4 },
  takeProfitPct: { min: 0.05, max: 1, minStep: 0.01, decimals: 4 },
  trailingStopPct: { min: 0.03, max: 0.3, minStep: 0.005, decimals: 4 },
};

const TOP_LEVEL: ReadonlySet<LearnableParam> = new Set([
  'stopLossPct',
  'takeProfitPct',
  'trailingStopPct',
]);

export function stepFor(param: LearnableParam, current: number): number {
  return Math.max(Math.abs(current) * MAX_STEP_PCT, LEARNING_BOUNDS[param].minStep);
}

export function clampToBounds(param: LearnableParam, value: number): number {
  const b = LEARNING_BOUNDS[param];
  const clamped = Math.min(b.max, Math.max(b.min, value));
  const f = 10 ** b.decimals;
  return Math.round(clamped * f) / f;
}

export function getParam(settings: PortfolioSettings, param: LearnableParam): number | null {
  if (TOP_LEVEL.has(param)) {
    const v = settings[param as 'stopLossPct' | 'takeProfitPct' | 'trailingStopPct'];
    return v ?? null;
  }
  return settings.strategyParams[param as keyof PortfolioSettings['strategyParams']];
}

export function setParam(
  settings: PortfolioSettings,
  param: LearnableParam,
  value: number,
): PortfolioSettings {
  if (TOP_LEVEL.has(param)) return { ...settings, [param]: value };
  return { ...settings, strategyParams: { ...settings.strategyParams, [param]: value } };
}
