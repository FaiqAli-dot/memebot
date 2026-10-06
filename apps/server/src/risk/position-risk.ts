/**
 * Risk gate + position sizing for paper entries.
 *
 * Two layers:
 *  1. HARD SAFETY GATES — invalid / unsafe / unexecutable candidates are rejected.
 *  2. RISK SIZING — a valid candidate's uncertainty is expressed as a smaller size.
 *     Limits (max planned loss, exposure, cash, price impact, cost) cap the size;
 *     the candidate is rejected only if the capped size is below the minimum position.
 *
 * Each uncertainty source has exactly one effect on size:
 *  - measured data confidence → confidence multiplier (the EV gate separately raises
 *    its threshold for LOW confidence; that is the quality filter, not sizing)
 *  - EV margin                → tier multiplier (research / normal / strong)
 *  - |5m price change|        → volatility multiplier (outcome variance; the EV cost
 *    model separately charges expected slippage)
 *  - market regime            → regime multiplier
 *  - drawdown risk state      → risk-state multiplier
 * Strategy confidence is NOT reused here — it already drives pWin inside EV.
 *
 * Provisional research model: multipliers and limits are configurable starting points.
 */
import type { ConfidenceLevel, ExecutionCostEstimate, LiquidityStatus } from '@memebot/shared';

export const RISK_SIZING_VERSION = 'risk-v2';

export const RISK_REJECTION_REASONS = [
  'riskState',
  'unknownLiquidity',
  'invalidStop',
  'invalidExecution',
  'volatilityExtreme',
  'maxOpenPositions',
  'insufficientCash',
  'portfolioExposure',
  'strategyExposure',
  'tokenExposure',
  'maximumLossExceeded',
  'priceImpactTooHigh',
  'executionCostTooHigh',
  'minimumPositionSize',
] as const;
export type RiskRejectionReason = (typeof RISK_REJECTION_REASONS)[number];

export type RiskDecisionKind = 'SIZED' | 'RESIZED' | 'REJECTED';
export type RiskTier = 'STRONG' | 'NORMAL' | 'REDUCED';

export interface RiskConfig {
  baseSizeUsd: number;
  minSizeUsd: number;
  maxRiskPerTradeUsd: number;
  maxOpenPositions: number;
  maxPortfolioExposureUsd: number;
  maxStrategyExposureUsd: number;
  maxTokenExposureUsd: number;
  confidenceMultipliers: { HIGH: number; MEDIUM: number; LOW: number };
  strongEvMargin: number;
  strongEvMultiplier: number;
  researchMultiplier: number;
  volHighPct: number;
  volVeryHighPct: number;
  volExtremePct: number;
  highVolMultiplier: number;
  veryHighVolMultiplier: number;
  maxEntryPriceImpactPct: number;
  maxRoundTripCostRate: number;
}

export interface RiskCandidate {
  lane: 'PRODUCTION' | 'RESEARCH';
  dataConfidence: ConfidenceLevel;
  expectedNetValue: number | null;
  evThreshold: number;
  liquidityStatus: LiquidityStatus | string;
  liquidityUsd: number;
  absPriceChange5mPct: number;
  stopLossPct: number;
  regimeMultiplier: number;
  /** Round-trip cost estimate for a given size (same model as the simulator) */
  costAt: (sizeUsd: number) => ExecutionCostEstimate;
}

export interface PortfolioExposure {
  cashUsd: number;
  openPositions: number;
  portfolioExposureUsd: number;
  strategyExposureUsd: number;
  tokenExposureUsd: number;
  riskStateAllowsEntries: boolean;
  riskStateMultiplier: number;
}

export interface RiskAssessment {
  decision: RiskDecisionKind;
  rejectionReason: RiskRejectionReason | null;
  detail: string;
  riskTier: RiskTier;
  /** Combined size multiplier vs base (0..strongEvMultiplier) */
  riskScore: number;
  multipliers: Record<string, number>;
  baseSizeUsd: number;
  requestedSizeUsd: number;
  finalSizeUsd: number;
  positionSizeMultiplier: number;
  /** Largest size satisfying every limit (diagnostic; may be below the minimum) */
  maxViableSizeUsd: number;
  bindingConstraint: RiskRejectionReason | null;
  constraints: Partial<Record<RiskRejectionReason, number>>;
  /** Loss if the configured stop is hit, including round-trip execution costs */
  maximumPlannedLossUsd: number;
  stopLossUsd: number;
  maxRiskPerTradeUsd: number;
  cost: ExecutionCostEstimate | null;
  portfolioExposureBeforeUsd: number;
  portfolioExposureAfterUsd: number;
  version: string;
}

export function confidenceSizeMultiplier(conf: ConfidenceLevel, cfg: RiskConfig): number {
  if (conf === 'HIGH') return cfg.confidenceMultipliers.HIGH;
  if (conf === 'MEDIUM') return cfg.confidenceMultipliers.MEDIUM;
  return cfg.confidenceMultipliers.LOW;
}

export function volatilitySizeMultiplier(absChangePct: number, cfg: RiskConfig): number {
  if (absChangePct > cfg.volVeryHighPct) return cfg.veryHighVolMultiplier;
  if (absChangePct > cfg.volHighPct) return cfg.highVolMultiplier;
  return 1;
}

/** Size at which EV is first estimated (before EV tier and portfolio limits are known). */
export function referenceSizeUsd(
  cfg: RiskConfig,
  conf: ConfidenceLevel,
  absChangePct: number,
  regimeMultiplier: number,
): number {
  const s =
    cfg.baseSizeUsd *
    confidenceSizeMultiplier(conf, cfg) *
    volatilitySizeMultiplier(absChangePct, cfg) *
    regimeMultiplier;
  return Math.max(cfg.minSizeUsd, s);
}

export function plannedLossUsd(sizeUsd: number, stopLossPct: number, cost: ExecutionCostEstimate): number {
  return sizeUsd * stopLossPct + cost.totalCostUsd;
}

/** Largest x in [0, hi] with ok(x) true, assuming ok is true below some boundary. */
function largestSatisfying(hi: number, ok: (x: number) => boolean): number {
  if (hi <= 0) return 0;
  if (ok(hi)) return hi;
  let lo = 0;
  let top = hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + top) / 2;
    if (ok(mid)) lo = mid;
    else top = mid;
  }
  return lo;
}

export function assessPositionRisk(
  c: RiskCandidate,
  p: PortfolioExposure,
  cfg: RiskConfig,
): RiskAssessment {
  const base: RiskAssessment = {
    decision: 'REJECTED',
    rejectionReason: null,
    detail: '',
    riskTier: 'NORMAL',
    riskScore: 0,
    multipliers: {},
    baseSizeUsd: cfg.baseSizeUsd,
    requestedSizeUsd: 0,
    finalSizeUsd: 0,
    positionSizeMultiplier: 0,
    maxViableSizeUsd: 0,
    bindingConstraint: null,
    constraints: {},
    maximumPlannedLossUsd: 0,
    stopLossUsd: 0,
    maxRiskPerTradeUsd: cfg.maxRiskPerTradeUsd,
    cost: null,
    portfolioExposureBeforeUsd: p.portfolioExposureUsd,
    portfolioExposureAfterUsd: p.portfolioExposureUsd,
    version: RISK_SIZING_VERSION,
  };
  const reject = (reason: RiskRejectionReason, detail: string, extra: Partial<RiskAssessment> = {}) => ({
    ...base,
    ...extra,
    decision: 'REJECTED' as const,
    rejectionReason: reason,
    detail,
    finalSizeUsd: 0,
    positionSizeMultiplier: 0,
    portfolioExposureAfterUsd: p.portfolioExposureUsd,
  });

  // ---- Hard safety gates ----
  if (!p.riskStateAllowsEntries || p.riskStateMultiplier <= 0) {
    return reject('riskState', 'portfolio risk state blocks new entries');
  }
  if (c.liquidityStatus !== 'KNOWN' || !(c.liquidityUsd > 0)) {
    return reject('unknownLiquidity', `liquidity ${c.liquidityStatus}`);
  }
  if (!(c.stopLossPct > 0 && c.stopLossPct < 1)) {
    return reject('invalidStop', `stop loss ${c.stopLossPct}`);
  }
  if (c.absPriceChange5mPct >= cfg.volExtremePct) {
    return reject('volatilityExtreme', `|5m change| ${c.absPriceChange5mPct.toFixed(1)}% >= ${cfg.volExtremePct}%`);
  }
  if (p.openPositions >= cfg.maxOpenPositions) {
    return reject('maxOpenPositions', `${p.openPositions}/${cfg.maxOpenPositions} open`);
  }
  const probe = c.costAt(cfg.minSizeUsd);
  if (!probe.networkFeePriced) {
    return reject('invalidExecution', 'network fee cannot be priced (SOL/USD unusable)');
  }

  // ---- Risk sizing: uncertainty → smaller size ----
  const lowConf = c.dataConfidence === 'LOW' || c.dataConfidence === 'UNKNOWN';
  const strongEv =
    c.lane === 'PRODUCTION' &&
    c.expectedNetValue != null &&
    c.expectedNetValue >= c.evThreshold + cfg.strongEvMargin;
  const evMult = c.lane === 'RESEARCH' ? cfg.researchMultiplier : strongEv ? cfg.strongEvMultiplier : 1;
  const riskTier: RiskTier = c.lane === 'RESEARCH' || lowConf ? 'REDUCED' : strongEv ? 'STRONG' : 'NORMAL';
  const multipliers = {
    confidence: confidenceSizeMultiplier(c.dataConfidence, cfg),
    evTier: evMult,
    volatility: volatilitySizeMultiplier(c.absPriceChange5mPct, cfg),
    regime: c.regimeMultiplier,
    riskState: p.riskStateMultiplier,
  };
  const riskScore = Object.values(multipliers).reduce((a, b) => a * b, 1);
  // Research lanes trade the minimum rather than going silent when multipliers shrink
  // the size below it; the limits below can still cap or reject it.
  const scaled = cfg.baseSizeUsd * riskScore;
  const requested = c.lane === 'RESEARCH' ? Math.max(cfg.minSizeUsd, scaled) : scaled;

  // ---- Limits cap the size (resize before reject) ----
  // Exposure is booked as cost basis (fill + entry fee), so headroom excludes the entry fee
  const entryFeeUsd = probe.networkFeeUsd / 2;
  const constraints: Partial<Record<RiskRejectionReason, number>> = {
    insufficientCash: Math.max(0, p.cashUsd * 0.99 - probe.networkFeeUsd),
    portfolioExposure: Math.max(0, cfg.maxPortfolioExposureUsd - p.portfolioExposureUsd - entryFeeUsd),
    strategyExposure: Math.max(0, cfg.maxStrategyExposureUsd - p.strategyExposureUsd - entryFeeUsd),
    tokenExposure: Math.max(0, cfg.maxTokenExposureUsd - p.tokenExposureUsd - entryFeeUsd),
    maximumLossExceeded: largestSatisfying(
      requested,
      (s) => plannedLossUsd(s, c.stopLossPct, c.costAt(s)) <= cfg.maxRiskPerTradeUsd,
    ),
    // Entry-leg impact = half the round-trip impact rate
    priceImpactTooHigh: largestSatisfying(
      requested,
      (s) => (c.costAt(s).priceImpactRate / 2) * 100 <= cfg.maxEntryPriceImpactPct,
    ),
  };
  let size = requested;
  let binding: RiskRejectionReason | null = null;
  for (const [k, limit] of Object.entries(constraints) as [RiskRejectionReason, number][]) {
    if (limit < size) {
      size = limit;
      binding = k;
    }
  }

  // Round-trip cost rate: impact grows with size, fixed fees shrink with it. If the
  // capped size is too expensive, look for a smaller size that is acceptable.
  const costOk = (s: number) => s > 0 && c.costAt(s).totalCostRate <= cfg.maxRoundTripCostRate;
  if (size >= cfg.minSizeUsd && !costOk(size)) {
    if (!costOk(cfg.minSizeUsd)) {
      return reject('executionCostTooHigh', `round-trip cost ${(probe.totalCostRate * 100).toFixed(1)}% at minimum size`, {
        riskTier,
        riskScore,
        multipliers,
        requestedSizeUsd: requested,
        constraints,
        cost: probe,
      });
    }
    let lo = cfg.minSizeUsd;
    let hi = size;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (costOk(mid)) lo = mid;
      else hi = mid;
    }
    constraints.executionCostTooHigh = lo;
    size = lo;
    binding = 'executionCostTooHigh';
  }

  const shared = {
    riskTier,
    riskScore: round4(riskScore),
    multipliers,
    requestedSizeUsd: requested,
    maxViableSizeUsd: size,
    bindingConstraint: binding,
    constraints,
  };

  if (size < cfg.minSizeUsd) {
    const reason = binding ?? 'minimumPositionSize';
    return reject(
      reason,
      `size $${size.toFixed(2)} below minimum $${cfg.minSizeUsd.toFixed(2)}` +
        (binding ? ` (limited by ${binding})` : ` (requested $${requested.toFixed(2)})`),
      { ...shared, cost: probe },
    );
  }

  const cost = c.costAt(size);
  return {
    ...base,
    ...shared,
    decision: size < requested - 1e-9 ? 'RESIZED' : 'SIZED',
    detail: binding ? `resized from $${requested.toFixed(2)} by ${binding}` : 'sized by tier multipliers',
    finalSizeUsd: size,
    positionSizeMultiplier: cfg.baseSizeUsd > 0 ? size / cfg.baseSizeUsd : 0,
    maximumPlannedLossUsd: plannedLossUsd(size, c.stopLossPct, cost),
    stopLossUsd: size * c.stopLossPct,
    cost,
    portfolioExposureAfterUsd: p.portfolioExposureUsd + size,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
