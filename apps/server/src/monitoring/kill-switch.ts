/**
 * Global paper kill switch + circuit breakers.
 * Stops new signals/entries; keeps monitoring, emergency exits, analytics, data collection.
 */
import { query } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { publish } from '../ws/hub.js';

export type CircuitBreakerReason =
  | 'manual_kill_switch'
  | 'abnormal_losses'
  | 'data_corruption'
  | 'provider_outage'
  | 'extreme_slippage'
  | 'liquidity_collapse'
  | 'unexpected_trade_frequency'
  | 'runaway_execution_loop';

export interface CircuitBreakerState {
  active: boolean;
  reasons: CircuitBreakerReason[];
  activatedAt: string | null;
}

let runawayCount = 0;
let lastExecMinute = '';
let execsThisMinute = 0;

export async function setKillSwitch(
  portfolioId: string,
  active: boolean,
  reason: CircuitBreakerReason = 'manual_kill_switch',
): Promise<void> {
  await query(
    `UPDATE user_portfolios SET
      kill_switch_active = $2,
      bot_status = CASE WHEN $2 THEN 'KILLED' ELSE
        CASE WHEN bot_status = 'KILLED' THEN 'PAUSED' ELSE bot_status END
      END,
      risk_state = CASE WHEN $2 THEN 'HALTED' ELSE risk_state END,
      risk_state_changed_at = NOW(),
      updated_at = NOW()
     WHERE id = $1`,
    [portfolioId, active],
  );
  await query(
    `INSERT INTO bot_events (portfolio_id, level, category, message, details, data_mode)
     SELECT $1, $2, 'kill_switch', $3, $4, data_mode FROM user_portfolios WHERE id = $1`,
    [
      portfolioId,
      active ? 'error' : 'info',
      active ? `Kill switch ON: ${reason}` : 'Kill switch OFF',
      JSON.stringify({ reason, active }),
    ],
  );
  publish('kill_switch', { portfolioId, active, reason });
  logger.warn({ portfolioId, active, reason }, 'Kill switch toggled');
}

export async function isKillSwitchActive(portfolioId: string): Promise<boolean> {
  const { rows } = await query<{ kill_switch_active: boolean }>(
    `SELECT kill_switch_active FROM user_portfolios WHERE id = $1`,
    [portfolioId],
  );
  return !!rows[0]?.kill_switch_active;
}

export function noteExecutionAttempt(): {
  runaway: boolean;
  execsThisMinute: number;
} {
  const minute = new Date().toISOString().slice(0, 16);
  if (minute !== lastExecMinute) {
    lastExecMinute = minute;
    execsThisMinute = 0;
    runawayCount = 0;
  }
  execsThisMinute++;
  // > 30 paper attempts / minute is runaway for this bot scale
  const runaway = execsThisMinute > 30;
  if (runaway) runawayCount++;
  return { runaway, execsThisMinute };
}

export async function evaluateCircuitBreakers(opts: {
  portfolioId: string;
  netPnlUsd: number;
  startingBalanceUsd: number;
  recentSlippagePct: number;
  providerOutages: number;
  staleCritical: boolean;
}): Promise<CircuitBreakerReason[]> {
  const reasons: CircuitBreakerReason[] = [];
  if (opts.netPnlUsd <= -opts.startingBalanceUsd * 0.25) {
    reasons.push('abnormal_losses');
  }
  if (opts.recentSlippagePct > 25) {
    reasons.push('extreme_slippage');
  }
  if (opts.providerOutages >= 5) {
    reasons.push('provider_outage');
  }
  if (opts.staleCritical) {
    reasons.push('data_corruption');
  }
  const { runaway } = noteExecutionAttempt();
  if (runaway) {
    reasons.push('runaway_execution_loop');
    reasons.push('unexpected_trade_frequency');
  }

  if (reasons.length) {
    await setKillSwitch(opts.portfolioId, true, reasons[0]!);
  }
  return reasons;
}
