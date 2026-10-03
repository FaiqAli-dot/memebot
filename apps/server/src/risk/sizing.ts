/**
 * Position sizing: base risk × confidence × liquidity × volatility × regime × exposure.
 * Hard caps the strategy can never override.
 */
import type { MarketRegime, TokenPhase } from '@memebot/shared';
import { regimeSizeMultiplier } from '../features/regime.js';

export const SIZING_VERSION = 'sizing-v1';

export interface SizingInput {
  equityUsd: number;
  cashUsd: number;
  maxPositionPct: number;
  maxRiskPerTradePct: number;
  stopLossPct: number;
  confidence: number; // 0-100
  liquidityUsd: number;
  volatilityPct: number;
  regime: MarketRegime | null;
  phase: TokenPhase | null;
  portfolioExposurePct: number;
  maxPortfolioExposurePct: number;
  priceImpactPct: number;
  expectedNetValue: number | null;
  riskStateSizeMult: number;
  /** Absolute hard cap USD */
  hardCapUsd?: number;
}

export interface SizingResult {
  sizedAmountUsd: number;
  multipliers: Record<string, number>;
  cappedBy: string[];
  version: string;
}

export function computePositionSize(input: SizingInput): SizingResult {
  const cappedBy: string[] = [];
  const maxByPct = input.equityUsd * input.maxPositionPct;
  const maxByRisk =
    input.stopLossPct > 0
      ? (input.equityUsd * input.maxRiskPerTradePct) / input.stopLossPct
      : maxByPct;
  let base = Math.min(maxByPct, maxByRisk, input.cashUsd * 0.99);

  const confidenceMult = clamp(input.confidence / 100, 0.25, 1.25);
  const liqMult = clamp(Math.log10(Math.max(input.liquidityUsd, 100)) / Math.log10(100_000), 0.3, 1.2);
  const volMult = input.volatilityPct > 25 ? 0.5 : input.volatilityPct > 15 ? 0.75 : 1;
  const regimeMult = input.regime ? regimeSizeMultiplier(input.regime) : 1;
  const phaseMult =
    input.phase === 'DISTRIBUTION' || input.phase === 'DECLINE'
      ? 0
      : input.phase === 'PEAKING'
        ? 0.5
        : input.phase === 'ACCELERATION'
          ? 1.1
          : 1;
  const exposureHeadroom = Math.max(0, input.maxPortfolioExposurePct - input.portfolioExposurePct);
  const exposureMult = clamp(exposureHeadroom / Math.max(input.maxPositionPct, 0.01), 0, 1);
  const impactMult = input.priceImpactPct > 5 ? 0.4 : input.priceImpactPct > 2 ? 0.7 : 1;
  const evMult =
    input.expectedNetValue == null
      ? 0.8
      : input.expectedNetValue < 0
        ? 0
        : clamp(0.5 + input.expectedNetValue * 5, 0.4, 1.3);

  const multipliers = {
    confidence: confidenceMult,
    liquidity: liqMult,
    volatility: volMult,
    regime: regimeMult,
    phase: phaseMult,
    exposure: exposureMult,
    impact: impactMult,
    ev: evMult,
    riskState: input.riskStateSizeMult,
  };

  let sized =
    base *
    confidenceMult *
    liqMult *
    volMult *
    regimeMult *
    phaseMult *
    exposureMult *
    impactMult *
    evMult *
    input.riskStateSizeMult;

  if (sized > maxByPct) {
    sized = maxByPct;
    cappedBy.push('max_position_pct');
  }
  if (sized > maxByRisk) {
    sized = maxByRisk;
    cappedBy.push('max_risk_per_trade');
  }
  if (sized > input.cashUsd * 0.99) {
    sized = input.cashUsd * 0.99;
    cappedBy.push('cash');
  }
  const hard = input.hardCapUsd ?? input.equityUsd * input.maxPositionPct;
  if (sized > hard) {
    sized = hard;
    cappedBy.push('hard_cap');
  }
  if (phaseMult === 0 || evMult === 0 || input.riskStateSizeMult === 0) {
    sized = 0;
    cappedBy.push('blocked_multiplier');
  }

  return {
    sizedAmountUsd: Math.max(0, sized),
    multipliers,
    cappedBy,
    version: SIZING_VERSION,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
