/**
 * Position exit rule evaluation.
 *
 * Gaps: when mark price jumps through a stop/take-profit, the close *reason*
 * is stop_loss / take_profit / trailing_stop, but the exit *price* used for
 * simulation must be the market mid (then adverse executable price) — never
 * the theoretical stop/take-profit level.
 */
import { safeDiv } from '../../utils/helpers.js';

export interface ExitRuleInput {
  entryPriceUsd: number;
  markPriceUsd: number;
  highestPriceUsd: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
  openedAt: Date;
  now: Date;
  maxHoldingTimeSec: number;
  liquidityUsd: number;
  minLiquidityUsd: number;
  /** When true, market data is too old for non-emergency exits */
  marketStale: boolean;
}

export type ExitCloseReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'max_holding_time'
  | 'emergency_liquidity_collapse'
  | null;

export interface ExitDecision {
  closeReason: ExitCloseReason;
  /** Always market mid — never the stop/TP trigger price */
  exitMidPriceUsd: number;
  pnlPct: number;
  deferredDueToStale: boolean;
}

export function evaluateExitRules(input: ExitRuleInput): ExitDecision {
  const entry = input.entryPriceUsd;
  const price = input.markPriceUsd;
  const pnlPct = safeDiv(price - entry, entry, 0);
  const highest = Math.max(input.highestPriceUsd, price);

  let closeReason: ExitCloseReason = null;

  if (
    input.liquidityUsd <= 0 ||
    input.liquidityUsd < input.minLiquidityUsd * 0.1
  ) {
    closeReason = 'emergency_liquidity_collapse';
  } else if (pnlPct <= -input.stopLossPct) {
    closeReason = 'stop_loss';
  } else if (pnlPct >= input.takeProfitPct) {
    closeReason = 'take_profit';
  } else if (
    input.trailingStopPct != null &&
    highest > entry &&
    safeDiv(highest - price, highest, 0) >= input.trailingStopPct
  ) {
    closeReason = 'trailing_stop';
  } else if (
    (input.now.getTime() - input.openedAt.getTime()) / 1000 >=
    input.maxHoldingTimeSec
  ) {
    closeReason = 'max_holding_time';
  }

  const deferredDueToStale =
    closeReason != null &&
    closeReason !== 'emergency_liquidity_collapse' &&
    input.marketStale;

  return {
    closeReason: deferredDueToStale ? null : closeReason,
    // Critical: exit mid is market mark, never stop/TP theoretical price
    exitMidPriceUsd: price,
    pnlPct,
    deferredDueToStale,
  };
}

/** Max one-tick rise of a mark that is not backed by known pool liquidity. */
export const MAX_UNVERIFIED_MARK_JUMP = 10;

/**
 * A price from a pool with no known liquidity that jumps far above the last trusted mark is a
 * bad tick (e.g. a dust pool quoting 18,000x) and must not revalue the position or set peak equity.
 */
export function isImplausibleMark(input: {
  previousMarkUsd: number;
  markPriceUsd: number;
  liquidityKnown: boolean;
}): boolean {
  if (input.liquidityKnown || !(input.previousMarkUsd > 0)) return false;
  return input.markPriceUsd / input.previousMarkUsd > MAX_UNVERIFIED_MARK_JUMP;
}

/** Theoretical stop price for display only — never used as execution price. */
export function theoreticalStopPrice(
  entryPriceUsd: number,
  stopLossPct: number,
): number {
  return entryPriceUsd * (1 - stopLossPct);
}

export function theoreticalTakeProfitPrice(
  entryPriceUsd: number,
  takeProfitPct: number,
): number {
  return entryPriceUsd * (1 + takeProfitPct);
}
