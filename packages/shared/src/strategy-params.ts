/**
 * Strategy parameter ownership. Every runtime-configurable strategy threshold is declared
 * here under exactly one strategy; the strategy reads it at evaluation time and the learner
 * may only change parameters declared (and consumed) by the strategy whose trades produced
 * the evidence. There is no portfolio-level strategy-parameter namespace.
 */

/** Strategy inputs as compared against thresholds at signal time (entry-time only). */
export interface StrategyInputs {
  priceChange5mPct: number | null;
  buySellRatio: number | null;
  volumeAcceleration: number | null;
  liquidityUsd: number | null;
  txCount5m: number | null;
  volume5mUsd: number | null;
  overallScore: number | null;
  topHolderPct: number | null;
  ageMinutes: number | null;
}

export type StrategyParamKey =
  | 'minVolume5mUsd'
  | 'minVolumeAcceleration'
  | 'minPriceChange5mPct'
  | 'minBuySellRatio'
  | 'minLiquidityUsd'
  | 'minActivityTx5m'
  | 'minTokenAgeMinutes'
  | 'maxTokenAgeMinutes'
  | 'minOverallScore'
  | 'maxTopHolderPct'
  // Older-token research strategies
  | 'minHistoryCoverageHours'
  | 'minHistoryVolumeUsd'
  | 'minVolumeRelativeBaseline'
  | 'minActivityAcceleration'
  | 'maxDormancyActivityRatio'
  | 'minRevivalVolumeRatio'
  | 'maxPriceChange1hPct';

export interface StrategyParamDef {
  key: StrategyParamKey;
  label: string;
  default: number;
  /** Hard range for operator and learner values */
  min: number;
  max: number;
  /** Floor for one guarded learner step */
  minStep: number;
  decimals: number;
  /** 'min': trade requires input ≥ value; 'max': input ≤ value */
  direction: 'min' | 'max';
  /** Entry-time input the threshold is compared with; null = not learnable */
  feature: keyof StrategyInputs | null;
  /** Safety thresholds may only be tightened automatically, never loosened */
  safety: boolean;
}

export type StrategyParamValues = Partial<Record<StrategyParamKey, number>>;
export type StrategyParamsById = Record<string, StrategyParamValues>;

const P = (d: StrategyParamDef) => d;

export const STRATEGY_PARAM_REGISTRY: Record<string, { name: string; params: StrategyParamDef[] }> = {
  'momentum-breakout': {
    name: 'Momentum Breakout',
    params: [
      P({ key: 'minLiquidityUsd', label: 'Min liquidity (USD)', default: 5000, min: 2000, max: 100_000, minStep: 200, decimals: 0, direction: 'min', feature: 'liquidityUsd', safety: true }),
      P({ key: 'minVolume5mUsd', label: 'Min 5m volume (USD)', default: 1500, min: 500, max: 50_000, minStep: 100, decimals: 0, direction: 'min', feature: 'volume5mUsd', safety: false }),
      P({ key: 'minVolumeAcceleration', label: 'Min volume acceleration', default: 1.3, min: 1, max: 3, minStep: 0.02, decimals: 2, direction: 'min', feature: 'volumeAcceleration', safety: false }),
      P({ key: 'minPriceChange5mPct', label: 'Min 5m price change (%)', default: 1.5, min: 0.5, max: 10, minStep: 0.1, decimals: 2, direction: 'min', feature: 'priceChange5mPct', safety: false }),
      P({ key: 'minBuySellRatio', label: 'Min buy/sell ratio', default: 1.1, min: 1, max: 3, minStep: 0.02, decimals: 2, direction: 'min', feature: 'buySellRatio', safety: false }),
      P({ key: 'minActivityTx5m', label: 'Min tx per 5m', default: 15, min: 5, max: 200, minStep: 1, decimals: 0, direction: 'min', feature: 'txCount5m', safety: false }),
      P({ key: 'minTokenAgeMinutes', label: 'Min token age (min)', default: 5, min: 1, max: 120, minStep: 0.5, decimals: 1, direction: 'min', feature: 'ageMinutes', safety: true }),
      P({ key: 'maxTokenAgeMinutes', label: 'Max token age (min)', default: 1440, min: 60, max: 10_080, minStep: 30, decimals: 0, direction: 'max', feature: null, safety: false }),
      P({ key: 'maxTopHolderPct', label: 'Max top holder (%)', default: 40, min: 10, max: 60, minStep: 1, decimals: 1, direction: 'max', feature: 'topHolderPct', safety: true }),
      P({ key: 'minOverallScore', label: 'Min overall score', default: 55, min: 40, max: 85, minStep: 1, decimals: 1, direction: 'min', feature: 'overallScore', safety: false }),
    ],
  },
  'early-volume-expansion': {
    name: 'Early Volume Expansion',
    params: [
      P({ key: 'minVolumeAcceleration', label: 'Min volume acceleration', default: 1.8, min: 1, max: 4, minStep: 0.02, decimals: 2, direction: 'min', feature: 'volumeAcceleration', safety: false }),
      P({ key: 'minVolume5mUsd', label: 'Min 5m volume (USD)', default: 2000, min: 500, max: 50_000, minStep: 100, decimals: 0, direction: 'min', feature: 'volume5mUsd', safety: false }),
    ],
  },
  'liquidity-expansion': {
    name: 'Liquidity Expansion',
    params: [
      P({ key: 'minLiquidityUsd', label: 'Min liquidity (USD)', default: 10_000, min: 5000, max: 250_000, minStep: 500, decimals: 0, direction: 'min', feature: 'liquidityUsd', safety: true }),
      P({ key: 'minPriceChange5mPct', label: 'Min 5m price change (%)', default: 0.5, min: 0.2, max: 10, minStep: 0.1, decimals: 2, direction: 'min', feature: 'priceChange5mPct', safety: false }),
    ],
  },
  'older-breakout': {
    name: 'Older Breakout (Research)',
    params: [
      P({ key: 'minLiquidityUsd', label: 'Min liquidity (USD)', default: 8000, min: 3000, max: 200_000, minStep: 500, decimals: 0, direction: 'min', feature: 'liquidityUsd', safety: true }),
      P({ key: 'minVolume5mUsd', label: 'Min 5m volume (USD)', default: 3000, min: 1000, max: 50_000, minStep: 100, decimals: 0, direction: 'min', feature: 'volume5mUsd', safety: false }),
      P({ key: 'minVolumeAcceleration', label: 'Min volume acceleration', default: 1.5, min: 1.1, max: 5, minStep: 0.05, decimals: 2, direction: 'min', feature: 'volumeAcceleration', safety: false }),
      P({ key: 'minPriceChange5mPct', label: 'Min 5m price change (%)', default: 2.0, min: 0.5, max: 15, minStep: 0.1, decimals: 2, direction: 'min', feature: 'priceChange5mPct', safety: false }),
      P({ key: 'minActivityTx5m', label: 'Min tx per 5m', default: 20, min: 5, max: 200, minStep: 1, decimals: 0, direction: 'min', feature: 'txCount5m', safety: false }),
      P({ key: 'minHistoryCoverageHours', label: 'Min prior history covered (h)', default: 6, min: 1, max: 23, minStep: 0.5, decimals: 1, direction: 'min', feature: null, safety: true }),
      P({ key: 'minHistoryVolumeUsd', label: 'Min prior-history volume (USD)', default: 20_000, min: 1000, max: 5_000_000, minStep: 1000, decimals: 0, direction: 'min', feature: null, safety: true }),
      P({ key: 'minVolumeRelativeBaseline', label: 'Min 5m volume vs prior baseline (x)', default: 3, min: 1.2, max: 20, minStep: 0.1, decimals: 2, direction: 'min', feature: null, safety: false }),
      P({ key: 'minActivityAcceleration', label: 'Min 5m tx vs prior baseline (x)', default: 2, min: 1.1, max: 20, minStep: 0.1, decimals: 2, direction: 'min', feature: null, safety: false }),
    ],
  },
  'older-revival': {
    name: 'Older Revival (Research)',
    params: [
      P({ key: 'minLiquidityUsd', label: 'Min liquidity (USD)', default: 5000, min: 2000, max: 150_000, minStep: 500, decimals: 0, direction: 'min', feature: 'liquidityUsd', safety: true }),
      P({ key: 'minVolume5mUsd', label: 'Min 5m volume (USD)', default: 2000, min: 500, max: 50_000, minStep: 100, decimals: 0, direction: 'min', feature: 'volume5mUsd', safety: false }),
      P({ key: 'minVolumeAcceleration', label: 'Min volume acceleration', default: 1.8, min: 1.2, max: 6, minStep: 0.05, decimals: 2, direction: 'min', feature: 'volumeAcceleration', safety: false }),
      P({ key: 'minPriceChange5mPct', label: 'Min 5m price change (%)', default: 1.5, min: 0.3, max: 12, minStep: 0.1, decimals: 2, direction: 'min', feature: 'priceChange5mPct', safety: false }),
      P({ key: 'minBuySellRatio', label: 'Min buy/sell ratio', default: 1.2, min: 1.0, max: 3.0, minStep: 0.05, decimals: 2, direction: 'min', feature: 'buySellRatio', safety: false }),
      P({ key: 'minHistoryCoverageHours', label: 'Min prior history covered (h)', default: 6, min: 1, max: 23, minStep: 0.5, decimals: 1, direction: 'min', feature: null, safety: true }),
      P({ key: 'minHistoryVolumeUsd', label: 'Min prior-history volume (USD)', default: 20_000, min: 1000, max: 5_000_000, minStep: 1000, decimals: 0, direction: 'min', feature: null, safety: true }),
      P({ key: 'maxDormancyActivityRatio', label: 'Max last-hour vs prior activity (x)', default: 0.5, min: 0.05, max: 1, minStep: 0.05, decimals: 2, direction: 'max', feature: null, safety: false }),
      P({ key: 'minRevivalVolumeRatio', label: 'Min 5m volume vs last hour (x)', default: 3, min: 1.2, max: 30, minStep: 0.1, decimals: 2, direction: 'min', feature: null, safety: false }),
      P({ key: 'minVolumeRelativeBaseline', label: 'Min 5m volume vs prior baseline (x)', default: 1.5, min: 1, max: 20, minStep: 0.1, decimals: 2, direction: 'min', feature: null, safety: false }),
      P({ key: 'maxPriceChange1hPct', label: 'Max 1h price change (%)', default: 30, min: 5, max: 200, minStep: 1, decimals: 1, direction: 'max', feature: null, safety: false }),
    ],
  },
};

/** Pre-Week-1 settings stored one flat, ownerless map; those values were Momentum Breakout's */
const LEGACY_FLAT_OWNER = 'momentum-breakout';

export function strategyParamDef(strategyId: string, key: string): StrategyParamDef | null {
  return STRATEGY_PARAM_REGISTRY[strategyId]?.params.find((p) => p.key === key) ?? null;
}

export function clampStrategyParam(def: StrategyParamDef, value: number): number {
  const f = 10 ** def.decimals;
  return Math.round(Math.min(def.max, Math.max(def.min, value)) * f) / f;
}

export function defaultStrategyParams(): StrategyParamsById {
  return Object.fromEntries(
    Object.entries(STRATEGY_PARAM_REGISTRY).map(([id, s]) => [
      id,
      Object.fromEntries(s.params.map((p) => [p.key, p.default])) as StrategyParamValues,
    ]),
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The one authoritative resolution of stored settings into per-strategy values: registry
 * defaults, overlaid with stored values for declared parameters only, clamped to range.
 * Unknown strategies/keys are dropped; a legacy flat map is read as Momentum Breakout's.
 */
export function resolveStrategyParams(raw: unknown): StrategyParamsById {
  const src = isObj(raw) ? raw : {};
  const legacy = Object.values(src).some((v) => typeof v === 'number');
  const out: StrategyParamsById = {};
  for (const [id, s] of Object.entries(STRATEGY_PARAM_REGISTRY)) {
    const storedRaw = legacy ? (id === LEGACY_FLAT_OWNER ? src : {}) : src[id];
    const stored = isObj(storedRaw) ? storedRaw : {};
    const values: StrategyParamValues = {};
    for (const p of s.params) {
      const v = stored[p.key];
      values[p.key] = typeof v === 'number' && Number.isFinite(v) ? clampStrategyParam(p, v) : p.default;
    }
    out[id] = values;
  }
  return out;
}
