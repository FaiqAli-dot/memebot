/**
 * Expected value assessment — optimize for net expectancy, not win rate.
 */
import type { ConfidenceLevel, ExpectedValueEstimate } from '@memebot/shared';
import type { Signal } from '../strategies/types.js';

export const EV_VERSION = 'ev-v1';

export interface EvInput {
  signal: Signal;
  estimatedExecutionCostPct: number;
  failureProbability: number;
  /** Extra uncertainty haircut 0-1 */
  uncertaintyHaircut?: number;
  minExpectedNetValue: number;
  dataConfidence?: ConfidenceLevel;
}

export function estimateExpectedValue(input: EvInput): ExpectedValueEstimate {
  const grossUpside = input.signal.expectedReturn;
  const downside = input.signal.expectedLoss;
  const cost = input.estimatedExecutionCostPct;
  const failP = clamp(input.failureProbability, 0, 0.95);
  const reasons: string[] = [];

  if (grossUpside == null || downside == null) {
    return {
      grossUpside,
      downside,
      executionCostUsd: null,
      failureProbability: failP,
      timeToTargetSec: input.signal.expectedHoldTimeSec,
      expectedNetValue: null,
      threshold: input.minExpectedNetValue,
      passes: false,
      uncertainty: 'UNKNOWN',
      reasons: ['missing_return_or_loss_estimate'],
    };
  }

  // Simple EV: pWin * (upside - cost) + pLose * (-downside - cost) - failP * cost
  const conf = input.signal.confidence / 100;
  const pWin = clamp(0.35 + conf * 0.25, 0.15, 0.65);
  const pLose = 1 - pWin - failP * 0.5;
  let expectedNet =
    pWin * (grossUpside - cost) +
    Math.max(0, pLose) * (-downside - cost) -
    failP * cost;

  const haircut = input.uncertaintyHaircut ?? 0;
  if (input.dataConfidence === 'LOW' || input.dataConfidence === 'UNKNOWN') {
    expectedNet -= 0.03;
    reasons.push('low_data_confidence_haircut');
  }
  expectedNet -= haircut;

  const uncertainty: ConfidenceLevel =
    input.dataConfidence === 'HIGH' && input.signal.confidence >= 70
      ? 'HIGH'
      : input.dataConfidence === 'LOW' || input.signal.confidence < 45
        ? 'LOW'
        : 'MEDIUM';

  // Uncertainty-aware threshold: require more edge when uncertain
  const threshold =
    input.minExpectedNetValue *
    (uncertainty === 'LOW' ? 1.5 : uncertainty === 'HIGH' ? 1 : 1.2);

  const passes = expectedNet >= threshold;
  if (!passes) reasons.push('expected_value_below_threshold');
  else reasons.push('edge_exceeds_uncertainty_aware_threshold');

  return {
    grossUpside,
    downside,
    executionCostUsd: cost,
    failureProbability: failP,
    timeToTargetSec: input.signal.expectedHoldTimeSec,
    expectedNetValue: round4(expectedNet),
    threshold: round4(threshold),
    passes,
    uncertainty,
    reasons,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
