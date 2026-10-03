import {
  resolveStrategyParams,
  type PortfolioSettings,
  type StrategyParamDef,
  type StrategyParamKey,
} from '@memebot/shared';

/** Largest relative change the learner may make to one setting in one day. */
export const MAX_STEP_PCT = 0.1;

/** Portfolio-wide exit settings: shared by every strategy, so the learner never applies them. */
export type ExitParam = 'stopLossPct' | 'takeProfitPct' | 'trailingStopPct';
export const EXIT_PARAMS: ReadonlySet<string> = new Set<ExitParam>(['stopLossPct', 'takeProfitPct', 'trailingStopPct']);

export const EXIT_BOUNDS: Record<ExitParam, { min: number; max: number; minStep: number; decimals: number }> = {
  stopLossPct: { min: 0.03, max: 0.25, minStep: 0.005, decimals: 4 },
  takeProfitPct: { min: 0.05, max: 1, minStep: 0.01, decimals: 4 },
  trailingStopPct: { min: 0.03, max: 0.3, minStep: 0.005, decimals: 4 },
};

export function exitStep(param: ExitParam, current: number): number {
  return Math.max(Math.abs(current) * MAX_STEP_PCT, EXIT_BOUNDS[param].minStep);
}

export function clampExit(param: ExitParam, value: number): number {
  const b = EXIT_BOUNDS[param];
  const f = 10 ** b.decimals;
  return Math.round(Math.min(b.max, Math.max(b.min, value)) * f) / f;
}

export function strategyStep(def: StrategyParamDef, current: number): number {
  return Math.max(Math.abs(current) * MAX_STEP_PCT, def.minStep);
}

export function getExitParam(settings: PortfolioSettings, param: ExitParam): number | null {
  return settings[param] ?? null;
}

export function setExitParam(settings: PortfolioSettings, param: ExitParam, value: number): PortfolioSettings {
  return { ...settings, [param]: value };
}

export function getStrategyParam(settings: PortfolioSettings, strategyId: string, key: string): number | null {
  return resolveStrategyParams(settings.strategyParams)[strategyId]?.[key as StrategyParamKey] ?? null;
}

/** Changes exactly one parameter of exactly one strategy; every other strategy is untouched. */
export function setStrategyParam(
  settings: PortfolioSettings,
  strategyId: string,
  key: string,
  value: number,
): PortfolioSettings {
  const resolved = resolveStrategyParams(settings.strategyParams);
  return {
    ...settings,
    strategyParams: { ...resolved, [strategyId]: { ...resolved[strategyId], [key]: value } },
  };
}
