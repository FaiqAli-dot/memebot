/**
 * Strategy framework — entry strategies never emit SELL.
 * Exits belong to position / execution / risk systems.
 */
import {
  STRATEGY_PARAM_REGISTRY,
  type LiquidityStatus,
  type MarketRegime,
  type RejectionReason,
  type SafetyClass,
  type StrategyParamKey,
  type StrategyParamValues,
  type TokenPhase,
} from '@memebot/shared';
import type { WindowFlow } from '../features/flow.js';
import type { VolumeAcceleration } from '../features/market-metrics.js';
import type { SafetyResult } from '../safety/engine.js';

export interface StrategyContext {
  tokenId: string;
  address: string;
  symbol: string;
  chain: string;
  ageMinutes: number | null;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  /** Provider rolling 24h window; covers min(24h, token age) */
  volume24hUsd?: number | null;
  /** Provider rolling 1h/24h transaction counts (null when the provider omits them) */
  buys1h?: number | null;
  sells1h?: number | null;
  buys24h?: number | null;
  sells24h?: number | null;
  /** Minutes since this system first observed the token (a lower bound on token age) */
  observedSpanMinutes?: number | null;
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  txCount5m: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  holderCount: number | null;
  topHolderPct: number | null;
  observedAt: Date;
  priorVolume5mUsd: number | null;
  /** Flow features — may be LOW confidence approximations */
  flow?: Record<string, WindowFlow>;
  safety?: SafetyResult;
  regime?: MarketRegime;
  phase?: TokenPhase;
  buySellConfidence?: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  discoverySource?: string;
  /** Non-overlapping volume acceleration (preferred over priorVolume5mUsd) */
  volumeAccel?: VolumeAcceleration;
  /** Only KNOWN liquidity passes production liquidity checks */
  liquidityStatus?: LiquidityStatus;
}

const LEGACY_ACCEL = { minBaselineUsd: 500, maxAccel: 10 };

/**
 * Volume acceleration a strategy may act on. Returns null when the baseline is
 * insufficient — strategies must reject rather than treat it as zero or infinite.
 */
export function strategyVolumeAccel(ctx: StrategyContext): { value: number | null; label: string } {
  if (ctx.volumeAccel) {
    const a = ctx.volumeAccel;
    return {
      value: a.capped,
      label: a.capped == null ? `insufficient_data(${a.method})` : `${a.capped.toFixed(2)}(${a.method})`,
    };
  }
  const prior = ctx.priorVolume5mUsd;
  if (prior == null || prior < LEGACY_ACCEL.minBaselineUsd) {
    return { value: null, label: 'insufficient_data(legacy)' };
  }
  const v = Math.min(ctx.volume5mUsd / prior, LEGACY_ACCEL.maxAccel);
  return { value: v, label: `${v.toFixed(2)}(legacy)` };
}

export function liquidityIsKnown(ctx: StrategyContext): boolean {
  if (ctx.liquidityStatus) return ctx.liquidityStatus === 'KNOWN' && ctx.liquidityUsd > 0;
  return ctx.liquidityUsd > 0;
}

export interface Signal {
  action: 'BUY' | 'NO_TRADE';
  confidence: number;
  expectedReturn: number | null;
  expectedLoss: number | null;
  expectedHoldTimeSec: number | null;
  reasons: string[];
  strategyId: string;
  strategyVersion: string;
  rejectionReason?: RejectionReason;
  /** Legacy score bridge for existing UI */
  scores?: {
    momentum: number;
    liquidity: number;
    volume: number;
    holderDistribution: number;
    risk: number;
    overall: number;
  };
  riskLabel?: string;
  safetyClass?: SafetyClass;
}

export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly activeByDefault: boolean;
  /** Research-lane only: never selected for the production lane, whatever activeStrategyIds says */
  readonly researchOnly?: boolean;
  /** `params` are this strategy's resolved thresholds; omitted keys use registry defaults */
  evaluate(context: StrategyContext, params?: StrategyParamValues): Signal;
}

/** This strategy's registered thresholds: registry defaults overlaid with `params`. */
export function paramsFor(strategyId: string, params?: StrategyParamValues): Record<StrategyParamKey, number> {
  const out: Partial<Record<StrategyParamKey, number>> = {};
  for (const def of STRATEGY_PARAM_REGISTRY[strategyId]?.params ?? []) {
    const v = params?.[def.key];
    out[def.key] = typeof v === 'number' && Number.isFinite(v) ? v : def.default;
  }
  return out as Record<StrategyParamKey, number>;
}

export function noTrade(
  strategy: Pick<Strategy, 'id' | 'version'>,
  reasons: string[],
  rejectionReason: RejectionReason = 'UNKNOWN',
  confidence = 0,
): Signal {
  return {
    action: 'NO_TRADE',
    confidence,
    expectedReturn: null,
    expectedLoss: null,
    expectedHoldTimeSec: null,
    reasons,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    rejectionReason,
  };
}

export function buySignal(
  strategy: Pick<Strategy, 'id' | 'version'>,
  opts: {
    confidence: number;
    /** null = no empirical estimate; EV is then unknown and can never pass */
    expectedReturn: number | null;
    expectedLoss: number | null;
    expectedHoldTimeSec: number;
    reasons: string[];
    scores?: Signal['scores'];
    riskLabel?: string;
  },
): Signal {
  return {
    action: 'BUY',
    confidence: opts.confidence,
    expectedReturn: opts.expectedReturn,
    expectedLoss: opts.expectedLoss,
    expectedHoldTimeSec: opts.expectedHoldTimeSec,
    reasons: opts.reasons,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    scores: opts.scores,
    riskLabel: opts.riskLabel,
  };
}
