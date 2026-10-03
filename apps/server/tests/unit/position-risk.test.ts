import { describe, expect, it } from 'vitest';
import type { ConfidenceLevel } from '@memebot/shared';
import {
  assessPositionRisk,
  plannedLossUsd,
  referenceSizeUsd,
  type PortfolioExposure,
  type RiskCandidate,
  type RiskConfig,
} from '../../src/risk/position-risk.js';
import { estimateRoundTripCost } from '../../src/execution/cost-estimate.js';

// $100 bankroll with the existing portfolio settings: 5% base, 1% max risk, 5 open
const CFG: RiskConfig = {
  baseSizeUsd: 5,
  minSizeUsd: 1,
  maxRiskPerTradeUsd: 1,
  maxOpenPositions: 5,
  maxPortfolioExposureUsd: 50,
  maxStrategyExposureUsd: 25,
  maxTokenExposureUsd: 10,
  confidenceMultipliers: { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 },
  strongEvMargin: 0.03,
  strongEvMultiplier: 1.25,
  researchMultiplier: 0.5,
  volHighPct: 15,
  volVeryHighPct: 25,
  volExtremePct: 80,
  highVolMultiplier: 0.75,
  veryHighVolMultiplier: 0.5,
  maxEntryPriceImpactPct: 3,
  maxRoundTripCostRate: 0.2,
};

function costFn(liquidityUsd: number, absChange = 5, netLeg: number | null = 0.003) {
  return (positionSizeUsd: number) =>
    estimateRoundTripCost({
      positionSizeUsd,
      liquidityUsd,
      venue: 'raydium',
      absPriceChange5mPct: absChange,
      networkFeePerLegUsd: netLeg,
    });
}

function candidate(over: Partial<RiskCandidate> = {}): RiskCandidate {
  const liq = over.liquidityUsd ?? 40_000;
  const chg = over.absPriceChange5mPct ?? 5;
  return {
    lane: 'PRODUCTION',
    dataConfidence: 'MEDIUM',
    expectedNetValue: 0.03,
    evThreshold: 0.02,
    liquidityStatus: 'KNOWN',
    liquidityUsd: liq,
    absPriceChange5mPct: chg,
    stopLossPct: 0.08,
    regimeMultiplier: 1,
    costAt: costFn(liq, chg),
    ...over,
  };
}

function portfolio(over: Partial<PortfolioExposure> = {}): PortfolioExposure {
  return {
    cashUsd: 100,
    openPositions: 0,
    portfolioExposureUsd: 0,
    strategyExposureUsd: 0,
    tokenExposureUsd: 0,
    riskStateAllowsEntries: true,
    riskStateMultiplier: 1,
    ...over,
  };
}

describe('risk scenarios', () => {
  it('A: valid medium-confidence setup trades at a reduced size, with an explicit max loss', () => {
    const r = assessPositionRisk(candidate(), portfolio(), CFG);
    expect(r.decision).toBe('SIZED');
    expect(r.finalSizeUsd).toBeCloseTo(3); // 5 × 0.6
    expect(r.maximumPlannedLossUsd).toBeCloseTo(plannedLossUsd(3, 0.08, r.cost!), 8);
    expect(r.maximumPlannedLossUsd).toBeLessThanOrEqual(CFG.maxRiskPerTradeUsd);
    expect(r.stopLossUsd).toBeCloseTo(0.24);
  });

  it('A2: LOW confidence with valid data → small position, not rejection', () => {
    const r = assessPositionRisk(candidate({ dataConfidence: 'LOW' }), portfolio(), CFG);
    expect(r.decision).toBe('SIZED');
    expect(r.riskTier).toBe('REDUCED');
    expect(r.finalSizeUsd).toBeCloseTo(1.5);
  });

  it('B: max loss too high at base size → resized, not rejected', () => {
    const cfg = { ...CFG, baseSizeUsd: 20, maxRiskPerTradeUsd: 1 };
    const r = assessPositionRisk(candidate({ dataConfidence: 'HIGH' }), portfolio(), cfg);
    expect(r.decision).toBe('RESIZED');
    expect(r.bindingConstraint).toBe('maximumLossExceeded');
    expect(r.requestedSizeUsd).toBeCloseTo(20);
    expect(r.finalSizeUsd).toBeLessThan(20);
    expect(r.maximumPlannedLossUsd).toBeLessThanOrEqual(1 + 1e-6);
    expect(r.maximumPlannedLossUsd).toBeGreaterThan(0.99);
  });

  it('C: minimum position still exceeds allowed risk → reject', () => {
    const cfg = { ...CFG, maxRiskPerTradeUsd: 0.05 };
    const r = assessPositionRisk(candidate(), portfolio(), cfg);
    expect(r.decision).toBe('REJECTED');
    expect(r.rejectionReason).toBe('maximumLossExceeded');
    expect(r.maxViableSizeUsd).toBeLessThan(CFG.minSizeUsd);
  });

  it('D: unknown liquidity or bonding curve → reject (sizing never bypasses liquidity)', () => {
    for (const liquidityStatus of ['UNKNOWN', 'BONDING_CURVE']) {
      const r = assessPositionRisk(candidate({ liquidityStatus }), portfolio(), CFG);
      expect(r.decision).toBe('REJECTED');
      expect(r.rejectionReason).toBe('unknownLiquidity');
    }
    expect(assessPositionRisk(candidate({ liquidityUsd: 0 }), portfolio(), CFG).rejectionReason).toBe(
      'unknownLiquidity',
    );
  });

  it('E: extreme price impact → resize when a smaller size is executable', () => {
    const liq = 300; // tiny pool: impact at $5 is far above 3%
    const r = assessPositionRisk(
      candidate({ dataConfidence: 'HIGH', liquidityUsd: liq, costAt: costFn(liq) }),
      portfolio(),
      { ...CFG, maxRoundTripCostRate: 1, maxRiskPerTradeUsd: 5 },
    );
    expect(r.decision).toBe('RESIZED');
    expect(r.bindingConstraint).toBe('priceImpactTooHigh');
    expect((r.cost!.priceImpactRate / 2) * 100).toBeLessThanOrEqual(3 + 1e-6);
  });

  it('E2: impact unacceptable even at minimum size → reject', () => {
    const liq = 40;
    const r = assessPositionRisk(
      candidate({ dataConfidence: 'HIGH', liquidityUsd: liq, costAt: costFn(liq) }),
      portfolio(),
      { ...CFG, maxRoundTripCostRate: 1 },
    );
    expect(r.decision).toBe('REJECTED');
    expect(r.rejectionReason).toBe('priceImpactTooHigh');
  });

  it('F: portfolio exposure limit reached → reject', () => {
    const r = assessPositionRisk(candidate(), portfolio({ portfolioExposureUsd: 49.5 }), CFG);
    expect(r.decision).toBe('REJECTED');
    expect(r.rejectionReason).toBe('portfolioExposure');
  });

  it('F2: partial headroom resizes instead of rejecting', () => {
    const r = assessPositionRisk(candidate(), portfolio({ portfolioExposureUsd: 48 }), CFG);
    expect(r.decision).toBe('RESIZED');
    expect(r.bindingConstraint).toBe('portfolioExposure');
    expect(r.finalSizeUsd).toBeCloseTo(2 - 0.003, 6);
    expect(r.portfolioExposureAfterUsd + 0.003).toBeCloseTo(50, 6);
  });

  it('max open positions, strategy and token exposure are enforced', () => {
    expect(assessPositionRisk(candidate(), portfolio({ openPositions: 5 }), CFG).rejectionReason).toBe(
      'maxOpenPositions',
    );
    expect(assessPositionRisk(candidate(), portfolio({ strategyExposureUsd: 25 }), CFG).rejectionReason).toBe(
      'strategyExposure',
    );
    expect(assessPositionRisk(candidate(), portfolio({ tokenExposureUsd: 10 }), CFG).rejectionReason).toBe(
      'tokenExposure',
    );
  });

  it('volatility reduces size; only extreme volatility rejects', () => {
    const at = (chg: number) =>
      assessPositionRisk(candidate({ absPriceChange5mPct: chg, costAt: costFn(40_000, chg) }), portfolio(), {
        ...CFG,
        maxRoundTripCostRate: 1,
      });
    expect(at(5).finalSizeUsd).toBeCloseTo(3);
    expect(at(20).finalSizeUsd).toBeCloseTo(2.25);
    expect(at(40).finalSizeUsd).toBeCloseTo(1.5);
    expect(at(90).rejectionReason).toBe('volatilityExtreme');
  });

  it('hard gates: invalid stop, unpriced execution, blocked risk state', () => {
    expect(assessPositionRisk(candidate({ stopLossPct: 0 }), portfolio(), CFG).rejectionReason).toBe('invalidStop');
    expect(
      assessPositionRisk(candidate({ costAt: costFn(40_000, 5, null) }), portfolio(), CFG).rejectionReason,
    ).toBe('invalidExecution');
    expect(
      assessPositionRisk(candidate(), portfolio({ riskStateAllowsEntries: false }), CFG).rejectionReason,
    ).toBe('riskState');
  });

  it('round-trip cost above the hard cap at minimum size → reject', () => {
    const r = assessPositionRisk(candidate(), portfolio(), { ...CFG, maxRoundTripCostRate: 0.001 });
    expect(r.rejectionReason).toBe('executionCostTooHigh');
  });

  it('research lane is smaller, never exempt', () => {
    const prod = assessPositionRisk(candidate(), portfolio(), CFG);
    const research = assessPositionRisk(candidate({ lane: 'RESEARCH', expectedNetValue: 0.01 }), portfolio(), CFG);
    expect(research.finalSizeUsd).toBeLessThan(prod.finalSizeUsd);
    expect(research.riskTier).toBe('REDUCED');
    expect(
      assessPositionRisk(candidate({ lane: 'RESEARCH', liquidityStatus: 'UNKNOWN' }), portfolio(), CFG).decision,
    ).toBe('REJECTED');
  });

  it('strong EV raises size only moderately and stays within limits', () => {
    const strong = assessPositionRisk(
      candidate({ dataConfidence: 'HIGH', expectedNetValue: 0.2 }),
      portfolio(),
      CFG,
    );
    expect(strong.riskTier).toBe('STRONG');
    expect(strong.requestedSizeUsd).toBeCloseTo(6.25);
    expect(strong.maximumPlannedLossUsd).toBeLessThanOrEqual(CFG.maxRiskPerTradeUsd + 1e-6);
  });
});

describe('risk model is monotonic', () => {
  const size = (c: Partial<RiskCandidate> = {}, p: Partial<PortfolioExposure> = {}, cfg = CFG) =>
    assessPositionRisk(candidate(c), portfolio(p), cfg).finalSizeUsd;

  it('better confidence → same or larger size', () => {
    const levels: ConfidenceLevel[] = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'];
    const sizes = levels.map((dataConfidence) => size({ dataConfidence }));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });

  it('higher EV → same or larger size', () => {
    const sizes = [0.02, 0.03, 0.05, 0.08].map((expectedNetValue) => size({ expectedNetValue }));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });

  it('more portfolio exposure → same or smaller size', () => {
    const sizes = [0, 20, 40, 46, 48, 49.5].map((portfolioExposureUsd) => size({}, { portfolioExposureUsd }));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
  });

  it('higher volatility → same or smaller size', () => {
    const sizes = [0, 10, 16, 30, 79].map((chg) =>
      size({ absPriceChange5mPct: chg, costAt: costFn(40_000, chg) }, {}, { ...CFG, maxRoundTripCostRate: 1 }),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
  });

  it('higher execution cost (thinner liquidity) → same or smaller size', () => {
    const cfg = { ...CFG, baseSizeUsd: 30, maxRiskPerTradeUsd: 5, maxRoundTripCostRate: 1 };
    const sizes = [100_000, 20_000, 5_000, 2_000, 1_000].map((liq) =>
      size({ dataConfidence: 'HIGH', liquidityUsd: liq, costAt: costFn(liq) }, {}, cfg),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]! + 1e-9);
  });

  it('tighter max-loss budget → same or smaller size', () => {
    const cfg = { ...CFG, baseSizeUsd: 20 };
    const sizes = [5, 2, 1, 0.5, 0.2].map((maxRiskPerTradeUsd) =>
      size({ dataConfidence: 'HIGH' }, {}, { ...cfg, maxRiskPerTradeUsd }),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
  });
});

describe('no double penalty', () => {
  it('data confidence affects size exactly once (one multiplier)', () => {
    const med = assessPositionRisk(candidate({ dataConfidence: 'MEDIUM' }), portfolio(), CFG);
    const low = assessPositionRisk(candidate({ dataConfidence: 'LOW' }), portfolio(), CFG);
    expect(low.requestedSizeUsd / med.requestedSizeUsd).toBeCloseTo(0.3 / 0.6);
    expect(Object.keys(med.multipliers).sort()).toEqual(['confidence', 'evTier', 'regime', 'riskState', 'volatility']);
  });

  it('reference size used for EV follows the same multipliers', () => {
    expect(referenceSizeUsd(CFG, 'MEDIUM', 5, 1)).toBeCloseTo(3);
    expect(referenceSizeUsd(CFG, 'LOW', 30, 0.7)).toBeCloseTo(Math.max(1, 5 * 0.3 * 0.5 * 0.7));
  });

  it('is deterministic', () => {
    expect(assessPositionRisk(candidate(), portfolio(), CFG)).toEqual(assessPositionRisk(candidate(), portfolio(), CFG));
  });
});
