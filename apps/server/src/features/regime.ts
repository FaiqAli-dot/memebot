/**
 * Market regime detector — data-driven thresholds, measurable whether regimes matter.
 */
import type { MarketRegime } from '@memebot/shared';
import { measured, unavailable, type Measured } from '../domain/measured.js';

export const REGIME_VERSION = 'regime-v1';

export interface RegimeThresholds {
  deadActivity: number;
  coldActivity: number;
  hotActivity: number;
  extremeActivity: number;
  deadBuyPressure: number;
  hotBuyPressure: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  deadActivity: 5,
  coldActivity: 20,
  hotActivity: 80,
  extremeActivity: 150,
  deadBuyPressure: 0.7,
  hotBuyPressure: 1.4,
};

export interface RegimeInput {
  solMomentumPct: number | null;
  solVolatilityPct: number | null;
  memecoinActivityScore: number | null;
  newTokenCount1h: number | null;
  activeTokenCount: number | null;
  avgLiquidityUsd: number | null;
  marketBuySellPressure: number | null;
  launchSuccessRate: number | null;
  rugFailureRate: number | null;
  observedAt?: Date;
}

export interface RegimeResult {
  regime: MarketRegime;
  solMomentum: Measured<number>;
  solVolatility: Measured<number>;
  memecoinActivity: Measured<number>;
  newTokenCount: Measured<number>;
  activeTokenCount: Measured<number>;
  avgLiquidityUsd: Measured<number>;
  marketBuySellPressure: Measured<number>;
  launchSuccessRate: Measured<number>;
  rugFailureRate: Measured<number>;
  reasons: string[];
  version: string;
  observedAt: Date;
}

function m(value: number | null, source: string, ts: Date): Measured<number> {
  if (value == null) return unavailable(source);
  return measured(value, { source, confidence: 'MEDIUM', timestamp: ts, freshness: 'FRESH' });
}

export function detectRegime(
  input: RegimeInput,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): RegimeResult {
  const ts = input.observedAt ?? new Date();
  const reasons: string[] = [];
  const activity = input.memecoinActivityScore;
  const pressure = input.marketBuySellPressure;

  let regime: MarketRegime = 'NORMAL';

  if (activity == null && pressure == null) {
    regime = 'NORMAL';
    reasons.push('insufficient_market_breadth_data');
  } else if (
    (activity != null && activity < thresholds.deadActivity) ||
    (pressure != null && pressure < thresholds.deadBuyPressure && (activity ?? 0) < thresholds.coldActivity)
  ) {
    regime = 'DEAD';
    reasons.push('very_low_memecoin_activity');
  } else if (activity != null && activity < thresholds.coldActivity) {
    regime = 'COLD';
    reasons.push('below_normal_activity');
  } else if (activity != null && activity >= thresholds.extremeActivity) {
    regime = 'EXTREME';
    reasons.push('extreme_memecoin_activity');
  } else if (
    (activity != null && activity >= thresholds.hotActivity) ||
    (pressure != null && pressure >= thresholds.hotBuyPressure)
  ) {
    regime = 'HOT';
    reasons.push('elevated_activity_or_buy_pressure');
  } else {
    reasons.push('within_normal_bands');
  }

  if (input.rugFailureRate != null && input.rugFailureRate > 0.4 && regime === 'HOT') {
    reasons.push('high_rug_rate_during_hot_regime');
  }

  return {
    regime,
    solMomentum: m(input.solMomentumPct, 'sol_price', ts),
    solVolatility: m(input.solVolatilityPct, 'sol_price', ts),
    memecoinActivity: m(input.memecoinActivityScore, 'scanner', ts),
    newTokenCount: m(input.newTokenCount1h, 'discovery', ts),
    activeTokenCount: m(input.activeTokenCount, 'scanner', ts),
    avgLiquidityUsd: m(input.avgLiquidityUsd, 'market', ts),
    marketBuySellPressure: m(input.marketBuySellPressure, 'flow', ts),
    launchSuccessRate: m(input.launchSuccessRate, 'outcomes', ts),
    rugFailureRate: m(input.rugFailureRate, 'safety', ts),
    reasons,
    version: REGIME_VERSION,
    observedAt: ts,
  };
}

/** Map regime to a soft sizing multiplier — measured later whether this helps. */
export function regimeSizeMultiplier(regime: MarketRegime): number {
  switch (regime) {
    case 'DEAD':
      return 0.25;
    case 'COLD':
      return 0.6;
    case 'NORMAL':
      return 1;
    case 'HOT':
      return 1.1;
    case 'EXTREME':
      return 0.7; // choppy — reduce size, don't chase
    default:
      return 1;
  }
}
