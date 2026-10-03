/**
 * Strategy framework — entry strategies never emit SELL.
 * Exits belong to position / execution / risk systems.
 */
import type {
  MarketRegime,
  RejectionReason,
  SafetyClass,
  TokenPhase,
} from '@memebot/shared';
import type { WindowFlow } from '../features/flow.js';
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
  evaluate(context: StrategyContext): Signal;
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
    expectedReturn: number;
    expectedLoss: number;
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
