import type { PortfolioSettings } from '@memebot/shared';
import { DEFAULT_MOMENTUM_PARAMS } from '../strategy/momentum-v1.js';
import { env } from '../../config/env.js';

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
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  riskState: string;
  sizedAmountUsd: number;
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
    strategyParams: { ...DEFAULT_MOMENTUM_PARAMS },
    failedTxStillChargesNetwork: env.FAILED_TX_STILL_CHARGES_NETWORK,
    priorityFeeLamports: env.DEFAULT_PRIORITY_FEE_LAMPORTS,
  };
}

export function evaluateRisk(input: RiskCheckInput): RiskCheckResult {
  const { settings } = input;
  const drawdownPct =
    input.peakEquityUsd > 0
      ? (input.peakEquityUsd - input.equityUsd) / input.peakEquityUsd
      : 0;

  if (drawdownPct >= settings.maxDrawdownPct) {
    return {
      allowed: false,
      reason: `Max portfolio drawdown hit (${(drawdownPct * 100).toFixed(2)}%)`,
      riskState: 'MAX_DRAWDOWN',
      sizedAmountUsd: 0,
    };
  }

  const dailyLossPct =
    input.startingBalanceUsd > 0
      ? Math.max(0, -input.realizedPnlTodayUsd) / input.startingBalanceUsd
      : 0;
  if (dailyLossPct >= settings.maxDailyLossPct) {
    return {
      allowed: false,
      reason: `Max daily loss hit (${(dailyLossPct * 100).toFixed(2)}%)`,
      riskState: 'MAX_DAILY_LOSS',
      sizedAmountUsd: 0,
    };
  }

  if (input.openPositions >= settings.maxSimultaneousPositions) {
    return {
      allowed: false,
      reason: `Max simultaneous positions (${settings.maxSimultaneousPositions})`,
      riskState: 'MAX_POSITIONS',
      sizedAmountUsd: 0,
    };
  }

  const maxByPct = input.equityUsd * settings.maxPositionPct;
  // Risk per trade ≈ size * stopLoss
  const maxByRisk =
    settings.stopLossPct > 0
      ? (input.equityUsd * settings.maxRiskPerTradePct) / settings.stopLossPct
      : maxByPct;

  let sized = Math.min(input.proposedSizeUsd, maxByPct, maxByRisk, input.cashUsd * 0.99);
  sized = Math.max(0, sized);

  if (sized < 1) {
    return {
      allowed: false,
      reason: 'Insufficient cash or sized position below minimum ($1)',
      riskState: 'INSUFFICIENT_CASH',
      sizedAmountUsd: 0,
    };
  }

  return {
    allowed: true,
    reason: 'Risk check passed',
    riskState: 'OK',
    sizedAmountUsd: sized,
  };
}

export function computeDrawdownPct(peak: number, equity: number): number {
  if (peak <= 0) return 0;
  return Math.max(0, (peak - equity) / peak);
}
