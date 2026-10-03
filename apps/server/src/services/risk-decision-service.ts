import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import type { RiskAssessment } from '../risk/position-risk.js';

export type RiskExecutionStatus = 'EXECUTED' | 'EV_FAILED_AT_FINAL_SIZE' | 'EXECUTION_FAILED' | 'LIMIT_BLOCKED';

/**
 * One row per (portfolio, signal). A live signal is re-evaluated every execution tick;
 * re-evaluations update the row (latest decision, attempts + 1) instead of inserting.
 */
export async function recordRiskDecision(
  a: RiskAssessment,
  meta: {
    portfolioId: string;
    signalId: string;
    tokenId: string;
    strategyId: string | null;
    lane: string;
    stopLossPct: number;
    expectedNetValue: number | null;
    evThreshold: number | null;
    dataConfidence: string | null;
  },
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO risk_decisions (
      portfolio_id, signal_id, token_id, strategy_id, lane, decision, rejection_reason, detail,
      risk_tier, risk_score, base_size_usd, requested_size_usd, final_size_usd, max_viable_size_usd,
      position_size_multiplier, binding_constraint, maximum_planned_loss_usd, max_risk_per_trade_usd,
      stop_loss_pct, stop_loss_usd, execution_cost_rate, execution_cost_usd, execution_cost_estimate,
      portfolio_exposure_before_usd, portfolio_exposure_after_usd, expected_net_value, ev_threshold,
      data_confidence, multipliers, constraints, sizing_version, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
              $24,$25,$26,$27,$28,$29,$30,$31,$32)
    ON CONFLICT (portfolio_id, signal_id) WHERE signal_id IS NOT NULL DO UPDATE SET
      decision = EXCLUDED.decision,
      rejection_reason = EXCLUDED.rejection_reason,
      detail = EXCLUDED.detail,
      risk_tier = EXCLUDED.risk_tier,
      risk_score = EXCLUDED.risk_score,
      base_size_usd = EXCLUDED.base_size_usd,
      requested_size_usd = EXCLUDED.requested_size_usd,
      final_size_usd = EXCLUDED.final_size_usd,
      max_viable_size_usd = EXCLUDED.max_viable_size_usd,
      position_size_multiplier = EXCLUDED.position_size_multiplier,
      binding_constraint = EXCLUDED.binding_constraint,
      maximum_planned_loss_usd = EXCLUDED.maximum_planned_loss_usd,
      max_risk_per_trade_usd = EXCLUDED.max_risk_per_trade_usd,
      stop_loss_usd = EXCLUDED.stop_loss_usd,
      execution_cost_rate = EXCLUDED.execution_cost_rate,
      execution_cost_usd = EXCLUDED.execution_cost_usd,
      execution_cost_estimate = EXCLUDED.execution_cost_estimate,
      portfolio_exposure_before_usd = EXCLUDED.portfolio_exposure_before_usd,
      portfolio_exposure_after_usd = EXCLUDED.portfolio_exposure_after_usd,
      multipliers = EXCLUDED.multipliers,
      constraints = EXCLUDED.constraints,
      execution_status = CASE WHEN risk_decisions.execution_status = 'EXECUTED' THEN 'EXECUTED' END,
      execution_reason = CASE WHEN risk_decisions.execution_status = 'EXECUTED' THEN risk_decisions.execution_reason END,
      attempts = risk_decisions.attempts + 1,
      evaluated_at = NOW()
    RETURNING id`,
    [
      meta.portfolioId,
      meta.signalId,
      meta.tokenId,
      meta.strategyId,
      meta.lane,
      a.decision,
      a.rejectionReason,
      a.detail,
      a.riskTier,
      a.riskScore,
      a.baseSizeUsd,
      a.requestedSizeUsd,
      a.finalSizeUsd,
      a.maxViableSizeUsd,
      a.positionSizeMultiplier,
      a.bindingConstraint,
      a.maximumPlannedLossUsd,
      a.maxRiskPerTradeUsd,
      meta.stopLossPct,
      a.stopLossUsd,
      a.cost?.totalCostRate ?? null,
      a.cost?.totalCostUsd ?? null,
      a.cost ? JSON.stringify(a.cost) : null,
      a.portfolioExposureBeforeUsd,
      a.portfolioExposureAfterUsd,
      meta.expectedNetValue,
      meta.evThreshold,
      meta.dataConfidence,
      JSON.stringify(a.multipliers),
      JSON.stringify(a.constraints),
      a.version,
      dataMode,
    ],
  );
  return rows[0]!.id;
}

export async function markRiskExecution(
  id: string,
  status: RiskExecutionStatus,
  reason: string | null,
  positionId: string | null = null,
): Promise<void> {
  await query(
    `UPDATE risk_decisions SET execution_status = $2, execution_reason = $3, position_id = COALESCE($4, position_id)
     WHERE id = $1`,
    [id, status, reason, positionId],
  );
}
