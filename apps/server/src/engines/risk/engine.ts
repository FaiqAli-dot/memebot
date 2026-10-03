import { defaultStrategyParams, resolveStrategyParams, type PortfolioSettings } from '@memebot/shared';
import { env, realismProfile } from '../../config/env.js';
import {
  transitionRiskState,
  normalizeRiskState,
  type PortfolioRiskState,
} from '../../risk/state-machine.js';

export interface RiskCheckInput {
  equityUsd: number;
  cashUsd: number;
  openPositions: number;
  startingBalanceUsd: number;
  peakEquityUsd: number;
  realizedPnlTodayUsd: number;
  proposedSizeUsd: number;
  stopLossPct: number;
  settings: PortfolioSettings;
  /** Current persisted risk state (NORMAL/CAUTION/HALTED/RECOVERY) */
  currentRiskState?: string;
  killSwitchActive?: boolean;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  riskState: string;
  sizedAmountUsd: number;
  sizeMultiplier: number;
  manageExisting: boolean;
}

export function defaultPortfolioSettings(): PortfolioSettings {
  return {
    startingBalanceUsd: env.INITIAL_BALANCE_USD,
    maxPositionPct: env.MAX_POSITION_PCT,
    maxSimultaneousPositions: env.MAX_SIMULTANEOUS_POSITIONS,
    maxRiskPerTradePct: env.MAX_RISK_PER_TRADE_PCT,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    stopLossPct: 0.08,
    takeProfitPct: 0.2,
    trailingStopPct: 0.1,
    maxHoldingTimeSec: 3600,
    minLiquidityUsd: 5000,
    minTokenAgeMinutes: 5,
    maxTokenAgeMinutes: 24 * 60,
    scanIntervalMs: env.JOB_TOKEN_DISCOVERY_INTERVAL_MS,
    strategyParams: defaultStrategyParams(),
    failedTxStillChargesNetwork: env.FAILED_TX_STILL_CHARGES_NETWORK,
    priorityFeeLamports: env.DEFAULT_PRIORITY_FEE_LAMPORTS,
    allowDuplicateTokenPositions: false,
    realismProfile,
    killSwitchActive: false,
    activeStrategyIds: [
      'momentum-breakout',
      'early-volume-expansion',
      'liquidity-expansion',
    ],
    minExpectedNetValue: env.MIN_EXPECTED_NET_VALUE,
    jitoTipLamports: env.DEFAULT_JITO_TIP_LAMPORTS,
    recoveryDrawdownPct: env.RECOVERY_DRAWDOWN_PCT,
    cautionDrawdownPct: env.CAUTION_DRAWDOWN_PCT,
    maxHoldPartialExits: false,
  };
}

/** Stored settings → complete settings with per-strategy parameters resolved (one path for all readers). */
export function normalizeSettings(stored: Partial<PortfolioSettings> | null | undefined): PortfolioSettings {
  return {
    ...defaultPortfolioSettings(),
    ...(stored ?? {}),
    strategyParams: resolveStrategyParams(stored?.strategyParams),
  };
}

export function evaluateRisk(input: RiskCheckInput): RiskCheckResult {
  const { settings } = input;
  const drawdownPct =
    input.peakEquityUsd > 0
      ? (input.peakEquityUsd - input.equityUsd) / input.peakEquityUsd
      : 0;

  const dailyLossPct =
    input.startingBalanceUsd > 0
      ? Math.max(0, -input.realizedPnlTodayUsd) / input.startingBalanceUsd
      : 0;
  const dailyLossBreached = dailyLossPct >= settings.maxDailyLossPct;

  const transition = transitionRiskState({
    currentState: input.currentRiskState ?? 'NORMAL',
    drawdownPct,
    maxDrawdownPct: settings.maxDrawdownPct,
    cautionDrawdownPct: settings.cautionDrawdownPct ?? env.CAUTION_DRAWDOWN_PCT,
    recoveryDrawdownPct: settings.recoveryDrawdownPct ?? env.RECOVERY_DRAWDOWN_PCT,
    openPositions: input.openPositions,
    killSwitchActive: input.killSwitchActive ?? settings.killSwitchActive,
    dailyLossBreached,
  });

  if (!transition.allowNewEntries) {
    return {
      allowed: false,
      reason: transition.reason,
      riskState: transition.state,
      sizedAmountUsd: 0,
      sizeMultiplier: 0,
      manageExisting: transition.manageExisting,
    };
  }

  if (input.openPositions >= settings.maxSimultaneousPositions) {
    return {
      allowed: false,
      reason: `Max simultaneous positions (${settings.maxSimultaneousPositions})`,
      riskState: transition.state,
      sizedAmountUsd: 0,
      sizeMultiplier: transition.sizeMultiplier,
      manageExisting: true,
    };
  }

  const maxByPct = input.equityUsd * settings.maxPositionPct;
  const maxByRisk =
    settings.stopLossPct > 0
      ? (input.equityUsd * settings.maxRiskPerTradePct) / settings.stopLossPct
      : maxByPct;

  let sized =
    Math.min(input.proposedSizeUsd, maxByPct, maxByRisk, input.cashUsd * 0.99) *
    transition.sizeMultiplier;
  sized = Math.max(0, sized);

  if (sized < 1) {
    return {
      allowed: false,
      reason: 'Insufficient cash or sized position below minimum ($1)',
      riskState: transition.state === 'NORMAL' ? 'INSUFFICIENT_CASH' : transition.state,
      sizedAmountUsd: 0,
      sizeMultiplier: transition.sizeMultiplier,
      manageExisting: true,
    };
  }

  return {
    allowed: true,
    reason: transition.reason === 'within_normal_risk' ? 'Risk check passed' : transition.reason,
    riskState: transition.state,
    sizedAmountUsd: sized,
    sizeMultiplier: transition.sizeMultiplier,
    manageExisting: true,
  };
}

export { normalizeRiskState, type PortfolioRiskState };

export function computeDrawdownPct(peak: number, equity: number): number {
  if (peak <= 0) return 0;
  return Math.max(0, (peak - equity) / peak);
}
