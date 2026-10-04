import type { StrategyParamsById } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { activeStrategies } from '../strategies/catalog.js';
import type { Signal, Strategy, StrategyContext } from '../strategies/types.js';

export interface StrategyRevalidation {
  passed: boolean;
  /** Short machine reason when the signal no longer holds */
  reason: string | null;
  reasons: string[];
  sharedRejection: string | null;
  confidence: number | null;
  signal: Signal | null;
}

/**
 * Re-runs the stored signal's own strategy `evaluate()` against the current market context.
 * The strategy implementation is the single source of truth: no thresholds live here.
 * A strategy that is no longer active (or no longer exists) cannot produce a BUY, exactly as in
 * the signal job.
 */
export function revalidateSignalStrategy(opts: {
  strategyId: string | null;
  catalog: Strategy[];
  activeIds?: string[];
  params: StrategyParamsById;
  ctx: StrategyContext;
}): StrategyRevalidation {
  const strategy = opts.strategyId
    ? activeStrategies(opts.catalog, opts.activeIds).find((s) => s.id === opts.strategyId)
    : undefined;
  if (!strategy) {
    const known = opts.catalog.some((s) => s.id === opts.strategyId);
    const reason = known ? 'strategy_inactive' : 'strategy_unknown';
    return { passed: false, reason, reasons: [reason], sharedRejection: null, confidence: null, signal: null };
  }
  const signal = strategy.evaluate(opts.ctx, opts.params[strategy.id]);
  const passed = signal.action === 'BUY';
  return {
    passed,
    reason: passed ? null : (signal.reasons[0] ?? 'strategy_no_trade'),
    reasons: signal.reasons,
    sharedRejection: passed ? null : (signal.rejectionReason ?? null),
    confidence: signal.confidence,
    signal,
  };
}

/** Compact execution-time features (the signal-time view stays on signals.market_state). */
export function revalidationFeatures(ctx: StrategyContext): Record<string, unknown> {
  return {
    observedAt: ctx.observedAt,
    priceUsd: ctx.priceUsd,
    liquidityUsd: ctx.liquidityUsd,
    liquidityStatus: ctx.liquidityStatus ?? null,
    volume5mUsd: ctx.volume5mUsd,
    volume1hUsd: ctx.volume1hUsd,
    buyVolume5mUsd: ctx.buyVolume5mUsd,
    sellVolume5mUsd: ctx.sellVolume5mUsd,
    txCount5m: ctx.txCount5m,
    priceChange5mPct: ctx.priceChange5mPct,
    priceChange1hPct: ctx.priceChange1hPct,
    ageMinutes: ctx.ageMinutes,
    volumeAcceleration: ctx.volumeAccel?.capped ?? null,
    volumeAccelerationConfidence: ctx.volumeAccel?.confidence ?? null,
    uniqueBuyers5m: ctx.flow?.['5m']?.uniqueBuyers.value ?? null,
    phase: ctx.phase ?? null,
    regime: ctx.regime ?? null,
    safetyBlocked: ctx.safety?.blocked ?? null,
  };
}

export type ExecutionAttemptStatus =
  | 'PENDING'
  | 'STALE_DATA'
  | 'UNKNOWN_LIQUIDITY'
  | 'STRATEGY_INVALIDATED'
  | 'RISK_REJECTED'
  | 'EV_FAILED'
  | 'CAPACITY_BLOCKED'
  | 'EXECUTION_FAILED'
  | 'EXECUTED';

/** Statuses after which the signal is never executed. */
export const TERMINAL_ATTEMPT_STATUSES: ExecutionAttemptStatus[] = ['STRATEGY_INVALIDATED', 'EXECUTED'];

/**
 * Upserts the (portfolio, signal) attempt row for this tick: attempts + 1, latest market time
 * and status. Returns the row id.
 */
export async function beginExecutionAttempt(opts: {
  portfolioId: string;
  signalId: string;
  tokenId: string;
  tokenAddress: string | null;
  strategyId: string | null;
  lane: string;
  signalCreatedAt: Date;
  marketObservedAt: Date | null;
  status: ExecutionAttemptStatus;
  statusReason?: string | null;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO signal_execution_attempts (
       portfolio_id, signal_id, token_id, token_address, strategy_id, lane, signal_created_at,
       signal_age_ms, market_observed_at, status, status_reason, data_mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,
       (EXTRACT(EPOCH FROM (NOW() - $7::timestamptz)) * 1000)::bigint, $8,$9,$10,$11)
     ON CONFLICT (portfolio_id, signal_id) DO UPDATE SET
       attempts = signal_execution_attempts.attempts + 1,
       last_attempt_at = NOW(),
       signal_age_ms = EXCLUDED.signal_age_ms,
       market_observed_at = EXCLUDED.market_observed_at,
       status = CASE WHEN signal_execution_attempts.status IN ('STRATEGY_INVALIDATED','EXECUTED')
                     THEN signal_execution_attempts.status ELSE EXCLUDED.status END,
       status_reason = CASE WHEN signal_execution_attempts.status IN ('STRATEGY_INVALIDATED','EXECUTED')
                     THEN signal_execution_attempts.status_reason ELSE EXCLUDED.status_reason END
     RETURNING id`,
    [
      opts.portfolioId,
      opts.signalId,
      opts.tokenId,
      opts.tokenAddress,
      opts.strategyId,
      opts.lane,
      opts.signalCreatedAt,
      opts.marketObservedAt,
      opts.status,
      opts.statusReason ?? null,
      dataMode,
    ],
  );
  return rows[0]!.id;
}

export async function recordRevalidation(
  attemptId: string,
  r: StrategyRevalidation,
  features: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE signal_execution_attempts SET
       revalidation_result = $2,
       revalidation_reason = $3,
       revalidation_reasons = $4,
       revalidation_confidence = $5,
       revalidated_at = NOW(),
       revalidation_features = $6,
       strategy_pass_count = strategy_pass_count + CASE WHEN $2 = 'PASS' THEN 1 ELSE 0 END,
       strategy_fail_count = strategy_fail_count + CASE WHEN $2 = 'FAIL' THEN 1 ELSE 0 END,
       status = CASE WHEN $2 = 'FAIL' AND status <> 'EXECUTED' THEN 'STRATEGY_INVALIDATED' ELSE status END,
       status_reason = CASE WHEN $2 = 'FAIL' AND status <> 'EXECUTED' THEN $3 ELSE status_reason END
     WHERE id = $1`,
    [
      attemptId,
      r.passed ? 'PASS' : 'FAIL',
      r.reason,
      JSON.stringify(r.reasons),
      r.confidence,
      JSON.stringify(features),
    ],
  );
}

export async function updateExecutionAttempt(
  attemptId: string,
  patch: {
    status: ExecutionAttemptStatus;
    statusReason?: string | null;
    riskDecisionId?: string | null;
    riskResult?: string | null;
    riskReason?: string | null;
    orderId?: string | null;
    positionId?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE signal_execution_attempts SET
       status = CASE WHEN status IN ('STRATEGY_INVALIDATED','EXECUTED') THEN status ELSE $2 END,
       status_reason = CASE WHEN status IN ('STRATEGY_INVALIDATED','EXECUTED') THEN status_reason ELSE $3 END,
       risk_decision_id = COALESCE($4, risk_decision_id),
       risk_result = COALESCE($5, risk_result),
       risk_reason = CASE WHEN $5::text IS NULL THEN risk_reason ELSE $6 END,
       order_id = COALESCE($7, order_id),
       position_id = COALESCE($8, position_id)
     WHERE id = $1`,
    [
      attemptId,
      patch.status,
      patch.statusReason ?? null,
      patch.riskDecisionId ?? null,
      patch.riskResult ?? null,
      patch.riskReason ?? null,
      patch.orderId ?? null,
      patch.positionId ?? null,
    ],
  );
}
