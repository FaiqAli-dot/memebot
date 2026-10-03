/**
 * Expected value assessment — optimize for net expectancy, not win rate.
 *
 * PROVISIONAL RESEARCH MODEL. pWin(confidence), expectedReturn and expectedLoss are
 * uncalibrated placeholders until enough closed paper/research trades exist to fit
 * them empirically. The output is NOT a statistically proven expected return.
 *
 * Threshold:
 *   MEDIUM/HIGH measured data confidence → minExpectedNetValue
 *   LOW/UNKNOWN                          → minExpectedNetValue × lowConfidenceMultiplier
 * There is no additional confidence haircut (that double penalty was removed).
 *
 * An optional promoted EV calibration (Level 3) maps raw EV → offset + scale × raw.
 * Calibrations are constrained to offset ≤ 0 and scale ≤ 1, so they can only make
 * the model more conservative, never more aggressive.
 */
import type { ConfidenceLevel, ExecutionCostEstimate, ExpectedValueEstimate } from '@memebot/shared';
import type { Signal } from '../strategies/types.js';

export const EV_VERSION = 'ev-v2';

export interface EvCalibration {
  version: string;
  offset: number;
  scale: number;
}

export interface EvInput {
  signal: Signal;
  /** Round-trip cost for the actual proposed position size */
  cost: ExecutionCostEstimate;
  failureProbability: number;
  minExpectedNetValue: number;
  /** Measured, never hard-coded */
  dataConfidence: ConfidenceLevel;
  lowConfidenceMultiplier: number;
  /** Optional explicit extra haircut (fraction); default none */
  uncertaintyHaircut?: number;
  /** Promoted calibration for this strategy (production only) */
  calibration?: EvCalibration | null;
}

export function evThresholdMultiplier(dataConfidence: ConfidenceLevel, lowConfidenceMultiplier: number): number {
  return dataConfidence === 'LOW' || dataConfidence === 'UNKNOWN' ? lowConfidenceMultiplier : 1;
}

/** Model win probability from strategy confidence (0–100). Uncalibrated placeholder. */
export function winProbabilityFromConfidence(confidence: number): number {
  return clamp(0.35 + (confidence / 100) * 0.25, 0.15, 0.65);
}

export function applyEvCalibration(rawEv: number, c: EvCalibration): number {
  const offset = Math.min(0, c.offset);
  const scale = clamp(c.scale, 0, 1);
  const calibrated = offset + scale * rawEv;
  return Math.min(rawEv, calibrated);
}

export function estimateExpectedValue(input: EvInput): ExpectedValueEstimate {
  const grossUpside = input.signal.expectedReturn;
  const downside = input.signal.expectedLoss;
  const cost = input.cost.totalCostRate;
  const failP = clamp(input.failureProbability, 0, 0.95);
  const multiplier = evThresholdMultiplier(input.dataConfidence, input.lowConfidenceMultiplier);
  const threshold = round4(input.minExpectedNetValue * multiplier);
  const reasons: string[] = [];
  const pWin = winProbabilityFromConfidence(input.signal.confidence);

  const base = {
    grossUpside,
    downside,
    positionSizeUsd: input.cost.positionSizeUsd,
    executionCostRate: round6(cost),
    executionCostUsd: round6(input.cost.totalCostUsd),
    costBreakdown: input.cost,
    failureProbability: failP,
    timeToTargetSec: input.signal.expectedHoldTimeSec,
    threshold,
    thresholdMultiplier: multiplier,
    dataConfidence: input.dataConfidence,
    winProbability: pWin,
    calibrated: false,
  };

  if (grossUpside == null || downside == null) {
    return {
      ...base,
      expectedNetValue: null,
      passes: false,
      uncertainty: 'UNKNOWN',
      reasons: ['missing_return_or_loss_estimate'],
    };
  }

  // pWin * (upside - cost) + pLose * (-downside - cost) - failP * cost
  const pLose = 1 - pWin - failP * 0.5;
  let expectedNet =
    pWin * (grossUpside - cost) + Math.max(0, pLose) * (-downside - cost) - failP * cost;
  if (input.uncertaintyHaircut) {
    expectedNet -= input.uncertaintyHaircut;
    reasons.push('explicit_uncertainty_haircut');
  }

  let calibration: Pick<ExpectedValueEstimate, 'calibrated' | 'rawExpectedNetValue' | 'calibrationVersion'> = {
    calibrated: false,
  };
  if (input.calibration) {
    const raw = expectedNet;
    expectedNet = applyEvCalibration(raw, input.calibration);
    calibration = { calibrated: true, rawExpectedNetValue: round4(raw), calibrationVersion: input.calibration.version };
    reasons.push('ev_calibrated');
  }

  if (!input.cost.networkFeePriced) reasons.push('network_fee_unpriced');
  if (multiplier > 1) reasons.push('low_data_confidence_threshold_multiplier');

  const passes = input.cost.networkFeePriced && expectedNet >= threshold;
  reasons.push(passes ? 'edge_exceeds_threshold' : 'expected_value_below_threshold');

  return {
    ...base,
    ...calibration,
    expectedNetValue: round4(expectedNet),
    passes,
    uncertainty: input.dataConfidence,
    reasons,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
