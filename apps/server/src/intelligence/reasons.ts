/**
 * Map existing funnel / strategy / risk gate strings onto machine-readable
 * DecisionReasonCode values. Does NOT invent new trading gates.
 */
import type { DecisionReasonCode } from '@memebot/shared';

const FUNNEL_MAP: Record<string, DecisionReasonCode> = {
  tooYoung: 'TOKEN_TOO_YOUNG',
  tooOld: 'TOKEN_TOO_OLD',
  staleData: 'STALE_MARKET_DATA',
  unknownLiquidity: 'LIQUIDITY_UNKNOWN',
  lowLiquidity: 'LIQUIDITY_TOO_LOW',
  safetyFailed: 'HIGH_RISK',
  strategyFailed: 'STRATEGY_REJECTED',
  volumeFailed: 'INSUFFICIENT_VOLUME',
  priceFailed: 'STRATEGY_REJECTED',
  transactionCountFailed: 'INSUFFICIENT_VOLUME',
  evFailed: 'EXPECTED_VALUE_TOO_LOW',
  riskFailed: 'LIQUIDITY_RISK',
  executionFailed: 'EXECUTION_RISK',
};

const RISK_MAP: Record<string, DecisionReasonCode> = {
  riskState: 'RISK_STATE_BLOCKED',
  unknownLiquidity: 'LIQUIDITY_UNKNOWN',
  invalidStop: 'EXECUTION_RISK',
  invalidExecution: 'EXECUTION_RISK',
  volatilityExtreme: 'VOLATILITY_EXTREME',
  maxOpenPositions: 'MAX_OPEN_POSITIONS',
  insufficientCash: 'INSUFFICIENT_CASH',
  portfolioExposure: 'CORRELATED_EXPOSURE',
  strategyExposure: 'CORRELATED_EXPOSURE',
  tokenExposure: 'CORRELATED_EXPOSURE',
  maximumLossExceeded: 'POSITION_SIZE_TOO_LARGE',
  priceImpactTooHigh: 'EXECUTION_RISK',
  executionCostTooHigh: 'EXECUTION_RISK',
  minimumPositionSize: 'INSUFFICIENT_CAPACITY',
};

const STRATEGY_REASON_MAP: Record<string, DecisionReasonCode> = {
  age_out_of_range: 'TOKEN_TOO_YOUNG',
  not_early: 'TOKEN_TOO_OLD',
  late_phase: 'TOKEN_TOO_OLD',
  liquidity_below_min: 'LIQUIDITY_TOO_LOW',
  liquidity_thin_for_mr: 'LIQUIDITY_TOO_LOW',
  need_deeper_liquidity: 'LIQUIDITY_TOO_LOW',
  liquidity_status_UNKNOWN: 'LIQUIDITY_UNKNOWN',
  liquidity_status_BONDING_CURVE: 'UNSUPPORTED_VENUE',
  volume_low: 'INSUFFICIENT_VOLUME',
  volume_below_min: 'INSUFFICIENT_VOLUME',
  volume_not_confirming: 'INSUFFICIENT_VOLUME',
  volume_acceleration_weak: 'INSUFFICIENT_VOLUME',
  volume_acceleration_insufficient_data: 'INSUFFICIENT_VOLUME',
  unique_buyers_low: 'INSUFFICIENT_HOLDERS',
  holder_concentration: 'HIGH_RISK',
  safety_blocked: 'HIGH_RISK',
  overall_score_low: 'SCORE_BELOW_THRESHOLD',
  momentum_weak: 'SCORE_BELOW_THRESHOLD',
  buy_pressure_weak: 'SCORE_BELOW_THRESHOLD',
  activity_low: 'SCORE_BELOW_THRESHOLD',
  accel_insufficient: 'SCORE_BELOW_THRESHOLD',
  accel_insufficient_data: 'SCORE_BELOW_THRESHOLD',
  regime_dead: 'STRATEGY_REJECTED',
};

const SHARED_REJECTION_MAP: Record<string, DecisionReasonCode> = {
  SAFETY_REJECTION: 'HIGH_RISK',
  LIQUIDITY_REJECTION: 'LIQUIDITY_TOO_LOW',
  VOLUME_REJECTION: 'INSUFFICIENT_VOLUME',
  MOMENTUM_REJECTION: 'SCORE_BELOW_THRESHOLD',
  REGIME_REJECTION: 'STRATEGY_REJECTED',
  POSITION_LIMIT: 'MAX_OPEN_POSITIONS',
  RISK_LIMIT: 'LIQUIDITY_RISK',
  EXPECTED_VALUE_TOO_LOW: 'EXPECTED_VALUE_TOO_LOW',
  DUPLICATE_POSITION: 'CORRELATED_EXPOSURE',
  COOLDOWN: 'STRATEGY_REJECTED',
  STALE_DATA: 'STALE_MARKET_DATA',
  KILL_SWITCH: 'KILL_SWITCH_ACTIVE',
  UNKNOWN: 'UNKNOWN',
};

const ELIGIBILITY_MAP: Record<string, DecisionReasonCode> = {
  pumpfun_bonding_curve_no_execution_model: 'UNSUPPORTED_VENUE',
  meteora_dbc_bonding_curve_no_execution_model: 'UNSUPPORTED_VENUE',
  liquidity_unknown: 'LIQUIDITY_UNKNOWN',
};

export function mapFunnelRejection(category: string | null | undefined): DecisionReasonCode {
  if (!category) return 'UNKNOWN';
  return FUNNEL_MAP[category] ?? 'UNKNOWN';
}

export function mapRiskRejection(reason: string | null | undefined): DecisionReasonCode {
  if (!reason) return 'UNKNOWN';
  return RISK_MAP[reason] ?? 'LIQUIDITY_RISK';
}

export function mapStrategyReason(reason: string | null | undefined): DecisionReasonCode {
  if (!reason) return 'STRATEGY_REJECTED';
  if (STRATEGY_REASON_MAP[reason]) return STRATEGY_REASON_MAP[reason]!;
  if (reason.startsWith('liquidity_status_')) return 'LIQUIDITY_UNKNOWN';
  if (reason.startsWith('phase_')) return 'STRATEGY_REJECTED';
  if (reason.includes('liquidity')) return 'LIQUIDITY_TOO_LOW';
  if (reason.includes('volume')) return 'INSUFFICIENT_VOLUME';
  if (reason.includes('score') || reason.includes('momentum')) return 'SCORE_BELOW_THRESHOLD';
  return 'STRATEGY_REJECTED';
}

export function mapSharedRejection(reason: string | null | undefined): DecisionReasonCode {
  if (!reason) return 'UNKNOWN';
  return SHARED_REJECTION_MAP[reason] ?? 'UNKNOWN';
}

export function mapEligibilityReason(reason: string | null | undefined): DecisionReasonCode {
  if (!reason) return 'UNKNOWN';
  return ELIGIBILITY_MAP[reason] ?? 'UNKNOWN';
}

/** Collapse dashboard rejection buckets for summary charts. */
export function rejectionBucket(code: DecisionReasonCode | string | null | undefined): string {
  switch (code) {
    case 'LIQUIDITY_TOO_LOW':
    case 'LIQUIDITY_UNKNOWN':
    case 'LIQUIDITY_RISK':
      return 'liquidity';
    case 'TOKEN_TOO_YOUNG':
    case 'TOKEN_TOO_OLD':
      return 'age';
    case 'MARKET_CAP_TOO_LOW':
    case 'MARKET_CAP_TOO_HIGH':
      return 'market_cap';
    case 'INSUFFICIENT_VOLUME':
      return 'volume';
    case 'HIGH_RISK':
    case 'VOLATILITY_EXTREME':
    case 'RISK_STATE_BLOCKED':
      return 'risk';
    case 'SCORE_BELOW_THRESHOLD':
    case 'STRATEGY_REJECTED':
    case 'EXPECTED_VALUE_TOO_LOW':
      return 'signal_threshold';
    case 'MAX_OPEN_POSITIONS':
    case 'INSUFFICIENT_CAPACITY':
    case 'INSUFFICIENT_CASH':
    case 'POSITION_SIZE_TOO_LARGE':
    case 'CORRELATED_EXPOSURE':
      return 'position_capacity';
    case 'UNSUPPORTED_VENUE':
    case 'STALE_MARKET_DATA':
    case 'EXECUTION_RISK':
    case 'KILL_SWITCH_ACTIVE':
    case 'INVALID_ADDRESS':
    case 'UNSUPPORTED_TOKEN_FORMAT':
      return 'other';
    default:
      return 'other';
  }
}
