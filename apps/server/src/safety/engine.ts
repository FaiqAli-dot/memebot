/**
 * Token Safety Engine — runs BEFORE strategy decides tradability.
 * Score 0 (extremely dangerous) → 100 (relatively safer). Never implies "safe".
 * UNKNOWN never becomes LOWER_RISK by default.
 */
import type { SafetyClass } from '@memebot/shared';
import { measured, unavailable, type Measured } from '../domain/measured.js';

export const SAFETY_VERSION = 'safety-v1';

export interface SafetyInput {
  tokenId: string;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  isToken2022: boolean | null;
  transferRestricted: boolean | null;
  liquidityUsd: number | null;
  liquidityChangePct5m: number | null;
  lpLockedOrBurned: boolean | null;
  top1HolderPct: number | null;
  top5HolderPct: number | null;
  top10HolderPct: number | null;
  top20HolderPct: number | null;
  creatorHoldingPct: number | null;
  creatorPriorRugs: number | null;
  creatorPriorLaunches: number | null;
  sniperConcentrationPct: number | null;
  bundledLaunchSuspected: boolean | null;
  artificialVolumeSuspected: boolean | null;
  sellable: boolean | null;
  buyButNotSell: boolean | null;
  observedAt?: Date;
}

export interface SafetyResult {
  score: number;
  safetyClass: SafetyClass;
  blocked: boolean;
  reasons: string[];
  checks: Record<string, Measured<number | boolean | string>>;
  version: string;
  assessedAt: Date;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function assessSafety(input: SafetyInput): SafetyResult {
  const reasons: string[] = [];
  const checks: Record<string, Measured<number | boolean | string>> = {};
  const ts = input.observedAt ?? new Date();
  let score = 70;
  let unknownPenalty = 0;
  let blocked = false;

  // --- Authorities ---
  if (input.mintAuthorityActive === true) {
    score -= 35;
    reasons.push('mint_authority_active');
    blocked = true;
    checks.mintAuthorityActive = measured(true, { source: 'onchain', confidence: 'HIGH', timestamp: ts });
  } else if (input.mintAuthorityActive === false) {
    checks.mintAuthorityActive = measured(false, { source: 'onchain', confidence: 'HIGH', timestamp: ts });
  } else {
    checks.mintAuthorityActive = unavailable('mint_authority');
    unknownPenalty += 8;
    reasons.push('mint_authority_unknown');
  }

  if (input.freezeAuthorityActive === true) {
    score -= 30;
    reasons.push('freeze_authority_active');
    blocked = true;
    checks.freezeAuthorityActive = measured(true, { source: 'onchain', confidence: 'HIGH', timestamp: ts });
  } else if (input.freezeAuthorityActive === false) {
    checks.freezeAuthorityActive = measured(false, { source: 'onchain', confidence: 'HIGH', timestamp: ts });
  } else {
    checks.freezeAuthorityActive = unavailable('freeze_authority');
    unknownPenalty += 8;
  }

  if (input.transferRestricted === true) {
    score -= 40;
    reasons.push('transfer_restrictions');
    blocked = true;
  }
  checks.transferRestricted =
    input.transferRestricted == null
      ? unavailable('transfer_restrictions')
      : measured(input.transferRestricted, { source: 'onchain', confidence: 'MEDIUM', timestamp: ts });

  if (input.isToken2022 === true) {
    score -= 5;
    reasons.push('token_2022_extensions_present');
    checks.isToken2022 = measured(true, { source: 'onchain', confidence: 'MEDIUM', timestamp: ts });
  } else if (input.isToken2022 == null) {
    checks.isToken2022 = unavailable('token_program');
  }

  // --- Liquidity ---
  if (input.liquidityUsd != null) {
    checks.liquidityUsd = measured(input.liquidityUsd, {
      source: 'market',
      confidence: 'MEDIUM',
      timestamp: ts,
    });
    if (input.liquidityUsd < 1000) {
      score -= 25;
      reasons.push('liquidity_very_low');
    } else if (input.liquidityUsd < 5000) {
      score -= 10;
      reasons.push('liquidity_low');
    }
  } else {
    checks.liquidityUsd = unavailable('liquidity');
    unknownPenalty += 10;
  }

  if (input.liquidityChangePct5m != null && input.liquidityChangePct5m < -20) {
    score -= 20;
    reasons.push('liquidity_declining');
    checks.liquidityChangePct5m = measured(input.liquidityChangePct5m, {
      source: 'market',
      confidence: 'MEDIUM',
      timestamp: ts,
    });
  } else if (input.liquidityChangePct5m == null) {
    checks.liquidityChangePct5m = unavailable('liquidity_change');
  }

  if (input.lpLockedOrBurned === false) {
    score -= 15;
    reasons.push('lp_not_locked_or_burned');
  } else if (input.lpLockedOrBurned == null) {
    checks.lpLockedOrBurned = unavailable('lp_lock');
    unknownPenalty += 10;
    reasons.push('lp_lock_unknown');
  } else {
    checks.lpLockedOrBurned = measured(true, { source: 'onchain', confidence: 'MEDIUM', timestamp: ts });
  }

  // --- Holders ---
  const top1 = input.top1HolderPct;
  if (top1 != null) {
    checks.top1HolderPct = measured(top1, { source: 'holders', confidence: 'MEDIUM', timestamp: ts });
    if (top1 > 50) {
      score -= 30;
      reasons.push(`top_holder_${Math.round(top1)}_percent`);
      blocked = true;
    } else if (top1 > 30) {
      score -= 15;
      reasons.push(`creator_or_top_holds_${Math.round(top1)}_percent`);
    }
  } else {
    checks.top1HolderPct = unavailable('holders');
    unknownPenalty += 8;
  }

  if (input.top10HolderPct != null && input.top10HolderPct > 70) {
    score -= 15;
    reasons.push('high_top10_concentration');
  }

  if (input.creatorHoldingPct != null && input.creatorHoldingPct > 20) {
    score -= 12;
    reasons.push(`creator_holds_${Math.round(input.creatorHoldingPct)}_percent`);
  } else if (input.creatorHoldingPct == null) {
    checks.creatorHoldingPct = unavailable('creator_holdings');
  }

  // --- Creator history ---
  if (input.creatorPriorRugs != null && input.creatorPriorRugs > 0) {
    score -= 40;
    reasons.push('creator_prior_rugs');
    blocked = true;
  } else if (input.creatorPriorRugs == null) {
    checks.creatorPriorRugs = unavailable('creator_history');
    unknownPenalty += 5;
  }

  // --- Trading behavior ---
  if (input.sniperConcentrationPct != null && input.sniperConcentrationPct > 40) {
    score -= 20;
    reasons.push('high_sniper_concentration');
  } else if (input.sniperConcentrationPct == null) {
    checks.sniperConcentrationPct = unavailable('sniper_detection');
  }

  if (input.bundledLaunchSuspected === true) {
    score -= 25;
    reasons.push('bundled_launch_suspected');
  } else if (input.bundledLaunchSuspected == null) {
    checks.bundledLaunchSuspected = unavailable('bundle_detection');
  }

  if (input.artificialVolumeSuspected === true) {
    score -= 20;
    reasons.push('artificial_volume_suspected');
  }

  // --- Sellability (catastrophic if buy-but-not-sell) ---
  if (input.buyButNotSell === true || input.sellable === false) {
    score = 0;
    blocked = true;
    reasons.push('unsellable_or_honeypot');
    checks.sellable = measured(false, { source: 'quote_sim', confidence: 'HIGH', timestamp: ts });
  } else if (input.sellable == null) {
    checks.sellable = unavailable('sellability');
    unknownPenalty += 12;
    reasons.push('sellability_unknown');
  } else {
    checks.sellable = measured(true, { source: 'quote_sim', confidence: 'MEDIUM', timestamp: ts });
  }

  score = clamp(score - unknownPenalty, 0, 100);

  const safetyClass = classifySafety(score, blocked, unknownPenalty >= 20, reasons);
  // UNKNOWN never becomes LOWER_RISK
  const finalClass =
    safetyClass === 'LOWER_RISK' && unknownPenalty >= 15 ? 'UNKNOWN' : safetyClass;

  return {
    score,
    safetyClass: finalClass,
    blocked: blocked || finalClass === 'BLOCKED',
    reasons: [...new Set(reasons)],
    checks,
    version: SAFETY_VERSION,
    assessedAt: ts,
  };
}

export function classifySafety(
  score: number,
  blocked: boolean,
  mostlyUnknown: boolean,
  reasons: string[],
): SafetyClass {
  if (blocked || reasons.includes('unsellable_or_honeypot')) return 'BLOCKED';
  if (mostlyUnknown && score >= 50) return 'UNKNOWN';
  if (score < 20) return 'EXTREME_RISK';
  if (score < 40) return 'HIGH_RISK';
  if (score < 60) return 'MEDIUM_RISK';
  if (score < 75 && mostlyUnknown) return 'UNKNOWN';
  return 'LOWER_RISK';
}

/** Demo/synthetic safety from symbol heuristics — labeled low confidence where unknown. */
export function demoSafetyFromSymbol(symbol: string, liquidityUsd: number, topHolderPct: number | null): SafetyInput {
  const risky = symbol.includes('RUG');
  return {
    tokenId: '',
    mintAuthorityActive: risky ? true : false,
    freezeAuthorityActive: risky ? true : false,
    isToken2022: false,
    transferRestricted: false,
    liquidityUsd,
    liquidityChangePct5m: risky ? -35 : 2,
    lpLockedOrBurned: risky ? false : true,
    top1HolderPct: topHolderPct ?? (risky ? 45 : 12),
    top5HolderPct: risky ? 70 : 30,
    top10HolderPct: risky ? 85 : 45,
    top20HolderPct: risky ? 92 : 55,
    creatorHoldingPct: risky ? 38 : 5,
    creatorPriorRugs: risky ? 2 : 0,
    creatorPriorLaunches: risky ? 5 : 1,
    sniperConcentrationPct: risky ? 55 : 15,
    bundledLaunchSuspected: risky,
    artificialVolumeSuspected: false,
    sellable: risky ? false : true,
    buyButNotSell: risky,
  };
}
