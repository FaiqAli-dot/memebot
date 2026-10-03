/**
 * Token lifecycle phases — age + velocity + flow, not raw % moves alone.
 * +80% in 2 min ≠ +80% over 2 h.
 */
import type { TokenPhase } from '@memebot/shared';

export const LIFECYCLE_VERSION = 'lifecycle-v1';

export interface LifecycleInput {
  ageMinutes: number | null;
  priceChange2mPct: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  volumeAcceleration: number | null;
  liquidityUsd: number | null;
  liquidityChangePct: number | null;
  uniqueBuyers5m: number | null;
  uniqueSellers5m: number | null;
  netFlow5mUsd: number | null;
  holderGrowthPct: number | null;
  largeWalletSellPct: number | null;
  volatility5mPct: number | null;
}

export interface LifecycleResult {
  phase: TokenPhase;
  reasons: string[];
  version: string;
}

export function detectTokenPhase(input: LifecycleInput): LifecycleResult {
  const reasons: string[] = [];
  const age = input.ageMinutes;
  const liq = input.liquidityUsd ?? 0;
  const accel = input.volumeAcceleration ?? 1;
  const chg5 = input.priceChange5mPct ?? 0;
  const chg2 = input.priceChange2mPct ?? chg5;
  const chg1h = input.priceChange1hPct ?? 0;
  const netFlow = input.netFlow5mUsd ?? 0;
  const buyers = input.uniqueBuyers5m ?? 0;
  const sellers = input.uniqueSellers5m ?? 0;
  const liqChg = input.liquidityChangePct ?? 0;
  const largeSell = input.largeWalletSellPct ?? 0;

  if (liq <= 0 || (age != null && age > 48 * 60 && accel < 0.5 && Math.abs(chg5) < 1)) {
    reasons.push('no_liquidity_or_inactive');
    return { phase: 'DEAD', reasons, version: LIFECYCLE_VERSION };
  }

  if (age != null && age < 5) {
    reasons.push('age_under_5m');
    return { phase: 'LAUNCH', reasons, version: LIFECYCLE_VERSION };
  }

  if (age != null && age < 30 && buyers > 0 && accel >= 1) {
    reasons.push('early_discovery_window');
    if (chg2 >= 15 && accel >= 1.5) {
      reasons.push('fast_2m_move');
      return { phase: 'EARLY_MOMENTUM', reasons, version: LIFECYCLE_VERSION };
    }
    return { phase: 'DISCOVERY', reasons, version: LIFECYCLE_VERSION };
  }

  if (largeSell > 40 || (netFlow < 0 && sellers > buyers && chg5 < -10)) {
    reasons.push('distribution_pressure');
    if (chg5 < -25 || liqChg < -30) {
      return { phase: 'DECLINE', reasons, version: LIFECYCLE_VERSION };
    }
    return { phase: 'DISTRIBUTION', reasons, version: LIFECYCLE_VERSION };
  }

  // Velocity-aware peaking: large move already happened over longer window, short-term slowing
  if (chg1h > 40 && chg5 < 5 && accel < 1.1) {
    reasons.push('extended_move_decelerating');
    return { phase: 'PEAKING', reasons, version: LIFECYCLE_VERSION };
  }

  if (chg2 >= 20 && accel >= 2 && netFlow > 0) {
    reasons.push('rapid_acceleration');
    return { phase: 'ACCELERATION', reasons, version: LIFECYCLE_VERSION };
  }

  if (chg5 >= 8 && accel >= 1.3 && netFlow > 0) {
    reasons.push('momentum_building');
    return { phase: 'EARLY_MOMENTUM', reasons, version: LIFECYCLE_VERSION };
  }

  if (chg5 < -15 && liqChg < -10) {
    reasons.push('price_and_liquidity_declining');
    return { phase: 'DECLINE', reasons, version: LIFECYCLE_VERSION };
  }

  if (age != null && age < 120) {
    reasons.push('default_discovery');
    return { phase: 'DISCOVERY', reasons, version: LIFECYCLE_VERSION };
  }

  reasons.push('default_early_momentum');
  return { phase: 'EARLY_MOMENTUM', reasons, version: LIFECYCLE_VERSION };
}
