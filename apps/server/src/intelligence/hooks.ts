/**
 * Thin helpers used by job runners to persist decision audits + feature snapshots
 * without changing strategy / risk / sizing logic.
 */
import type { DecisionReasonCode, DecisionStage } from '@memebot/shared';
import {
  recordDecisionAudit,
  recordDiscoveryObservation,
  recordMarketTick,
  updateIntelligenceStatus,
} from './ledger.js';
import {
  mapEligibilityReason,
  mapFunnelRejection,
  mapRiskRejection,
  mapSharedRejection,
  mapStrategyReason,
} from './reasons.js';
import { scheduleOutcomeCheckpoints } from './outcomes.js';
import type { EnrichedDiscoveredToken } from '../providers/discovery/multi-source.js';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { WriteDedupe } from '../db/write-dedupe.js';
import { researchWritesAllowed } from '../db/storage-guard.js';

export async function onTokenDiscovered(
  token: EnrichedDiscoveredToken,
  tokenId: string | null,
  isNew: boolean,
): Promise<void> {
  const result = await recordDiscoveryObservation(token, tokenId);
  if (!tokenId || !result.normalized) {
    if (result.reasonCode) {
      // Cannot attach to token row; log as bot event only via caller
    }
    return;
  }

  await recordDecisionAudit({
    tokenId,
    stage: 'DISCOVERED',
    result: 'PASS',
    details: {
      discoverySource: token.discoverySource,
      allSources: token.allDiscoverySources ?? [token.discoverySource],
      venue: token.dexVenue ?? null,
      isNew,
    },
  });

  await recordDecisionAudit({
    tokenId,
    stage: 'NORMALIZED',
    result: 'PASS',
    details: {
      symbol: token.symbol,
      decimals: token.decimals,
      address: token.address,
    },
  });
}

export async function onMarketTracked(
  tokenId: string,
  market: {
    price_usd: number;
    market_cap_usd: number | null;
    liquidity_usd: number;
    volume_24h_usd?: number;
    volume_1h_usd?: number;
  },
  holders: number | null,
  ageMinutes: number | null,
): Promise<void> {
  await recordMarketTick(tokenId, {
    priceUsd: market.price_usd,
    marketCapUsd: market.market_cap_usd,
    liquidityUsd: market.liquidity_usd,
    volumeUsd: market.volume_24h_usd ?? market.volume_1h_usd ?? null,
    holders,
    ageMinutes,
  });
  await recordDecisionAudit({
    tokenId,
    stage: 'TRACKED',
    result: 'PASS',
    actualValues: {
      price: market.price_usd,
      marketCap: market.market_cap_usd,
      liquidity: market.liquidity_usd,
      holders,
      ageMinutes,
    },
  });
}

export function buildFeatureSnapshot(input: {
  liquidityUsd?: number | null;
  volume5mUsd?: number | null;
  volume1hUsd?: number | null;
  volume24hUsd?: number | null;
  marketCapUsd?: number | null;
  ageMinutes?: number | null;
  holders?: number | null;
  priceChange5mPct?: number | null;
  priceChange1hPct?: number | null;
  buyVolume5mUsd?: number | null;
  sellVolume5mUsd?: number | null;
  momentumScore?: number | null;
  overallScore?: number | null;
  riskScore?: number | null;
  modelScore?: number | null;
  volatility5mPct?: number | null;
  liquidityStatus?: string | null;
  venue?: string | null;
  dataConfidence?: string | null;
  buySellRatio?: number | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const buy = input.buyVolume5mUsd;
  const sell = input.sellVolume5mUsd;
  const buySellRatio =
    input.buySellRatio ??
    (buy != null && sell != null && sell > 0 ? buy / sell : buy != null && sell === 0 ? null : null);
  return {
    liquidity: input.liquidityUsd ?? null,
    volume5m: input.volume5mUsd ?? null,
    volume1h: input.volume1hUsd ?? null,
    volume24h: input.volume24hUsd ?? null,
    marketCap: input.marketCapUsd ?? null,
    ageMinutes: input.ageMinutes ?? null,
    holders: input.holders ?? null,
    momentum: input.momentumScore ?? null,
    volatility: input.volatility5mPct ?? Math.abs(input.priceChange5mPct ?? 0),
    buySellRatio,
    priceChange5mPct: input.priceChange5mPct ?? null,
    priceChange1hPct: input.priceChange1hPct ?? null,
    liquidityStatus: input.liquidityStatus ?? null,
    venue: input.venue ?? null,
    modelScore: input.modelScore ?? input.overallScore ?? null,
    riskScore: input.riskScore ?? null,
    dataConfidence: input.dataConfidence ?? null,
    ...(input.extra ?? {}),
  };
}

export async function auditEligibility(opts: {
  tokenId: string;
  portfolioId?: string | null;
  pass: boolean;
  reasons: string[];
  actual: Record<string, unknown>;
  required: Record<string, unknown>;
  features?: Record<string, unknown>;
}): Promise<string> {
  const reasonCode: DecisionReasonCode | null = opts.pass
    ? null
    : mapEligibilityReason(opts.reasons[0]) !== 'UNKNOWN'
      ? mapEligibilityReason(opts.reasons[0])
      : mapFunnelRejection(String(opts.reasons[0] ?? 'unknownLiquidity'));
  return recordDecisionAudit({
    tokenId: opts.tokenId,
    portfolioId: opts.portfolioId,
    stage: 'ELIGIBILITY',
    result: opts.pass ? 'PASS' : 'FAIL',
    reasonCode,
    actualValues: opts.actual,
    requiredValues: opts.required,
    details: { reasons: opts.reasons },
    features: opts.features,
  });
}

export async function auditSignalRejection(opts: {
  tokenId: string;
  portfolioId?: string | null;
  funnelCategory?: string | null;
  strategyReasons?: string[];
  sharedRejection?: string | null;
  score?: number | null;
  threshold?: number | null;
  features?: Record<string, unknown>;
  strategyId?: string | null;
}): Promise<string> {
  let reasonCode: DecisionReasonCode = 'STRATEGY_REJECTED';
  if (opts.funnelCategory) reasonCode = mapFunnelRejection(opts.funnelCategory);
  else if (opts.sharedRejection) reasonCode = mapSharedRejection(opts.sharedRejection);
  else if (opts.strategyReasons?.[0]) reasonCode = mapStrategyReason(opts.strategyReasons[0]);

  const decisionId = await recordDecisionAudit({
    tokenId: opts.tokenId,
    portfolioId: opts.portfolioId,
    stage: 'SIGNAL',
    result: 'FAIL',
    reasonCode,
    actualValues: {
      score: opts.score ?? null,
      reasons: opts.strategyReasons ?? [],
    },
    requiredValues: { threshold: opts.threshold ?? null },
    details: {
      funnelCategory: opts.funnelCategory ?? null,
      sharedRejection: opts.sharedRejection ?? null,
    },
    features: opts.features,
    strategyId: opts.strategyId,
  });

  await maybeScheduleOutcomes(opts.tokenId, decisionId, opts.features);
  return decisionId;
}

export async function auditSignalPass(opts: {
  tokenId: string;
  portfolioId?: string | null;
  score: number;
  threshold?: number | null;
  features?: Record<string, unknown>;
  strategyId?: string | null;
  signalId?: string | null;
}): Promise<string> {
  await updateIntelligenceStatus(opts.tokenId, 'SIGNAL', {
    signalScore: opts.score,
  });
  return recordDecisionAudit({
    tokenId: opts.tokenId,
    portfolioId: opts.portfolioId,
    stage: 'SIGNAL',
    result: 'PASS',
    actualValues: { score: opts.score },
    requiredValues: { threshold: opts.threshold ?? null },
    features: opts.features,
    strategyId: opts.strategyId,
    signalId: opts.signalId,
  });
}

export async function auditRiskDecision(opts: {
  tokenId: string;
  portfolioId?: string | null;
  rejected: boolean;
  riskReason?: string | null;
  actual: Record<string, unknown>;
  required: Record<string, unknown>;
  features?: Record<string, unknown>;
  strategyId?: string | null;
  signalId?: string | null;
  riskDecisionId?: string | null;
}): Promise<string> {
  const reasonCode = opts.rejected ? mapRiskRejection(opts.riskReason) : null;
  const stage: DecisionStage =
    opts.riskReason === 'maxOpenPositions' ? 'POSITION_CAPACITY' : 'RISK_GATE';
  const decisionId = await recordDecisionAudit({
    tokenId: opts.tokenId,
    portfolioId: opts.portfolioId,
    stage,
    result: opts.rejected ? 'FAIL' : 'PASS',
    reasonCode,
    actualValues: opts.actual,
    requiredValues: opts.required,
    features: opts.features,
    strategyId: opts.strategyId,
    signalId: opts.signalId,
    riskDecisionId: opts.riskDecisionId,
  });
  if (opts.rejected) {
    await updateIntelligenceStatus(opts.tokenId, stage, {
      rejectionReason: reasonCode,
      riskStatus: 'REJECTED',
    });
    await maybeScheduleOutcomes(opts.tokenId, decisionId, opts.features);
  } else {
    await updateIntelligenceStatus(opts.tokenId, 'RISK_GATE', { riskStatus: 'PASSED' });
  }
  return decisionId;
}

export async function auditFinalOutcome(opts: {
  tokenId: string;
  portfolioId?: string | null;
  traded: boolean;
  reasonCode?: DecisionReasonCode | string | null;
  details?: Record<string, unknown>;
}): Promise<string> {
  return recordDecisionAudit({
    tokenId: opts.tokenId,
    portfolioId: opts.portfolioId,
    stage: 'FINAL_OUTCOME',
    result: opts.traded ? 'TRADED' : 'NOT_TRADED',
    reasonCode: opts.reasonCode ?? (opts.traded ? 'TRADED' : 'NOT_TRADED'),
    details: opts.details,
  });
}

async function maybeScheduleOutcomes(
  tokenId: string,
  decisionId: string,
  features?: Record<string, unknown>,
): Promise<void> {
  if (!decisionId) return;
  await scheduleOutcomeCheckpoints({
    tokenId,
    decisionId,
    decisionPrice: typeof features?.price === 'number' ? features.price : null,
    decisionMarketCap: typeof features?.marketCap === 'number' ? features.marketCap : null,
    decisionLiquidity: typeof features?.liquidity === 'number' ? features.liquidity : null,
  });
}

const rawObservationSamples = new WriteDedupe();

/** Persist a temporary raw observation: sampled per token, subject to retention. */
export async function persistRawFeatureObservation(
  tokenId: string,
  features: Record<string, unknown>,
): Promise<void> {
  if (rawObservationSamples.recent(tokenId, '', env.RAW_FEATURE_SAMPLE_MINUTES * 60_000)) return;
  if (!researchWritesAllowed()) return;
  rawObservationSamples.remember(tokenId, '');
  await query(
    `INSERT INTO token_raw_feature_observations (token_id, features, data_mode)
     VALUES ($1,$2,$3)`,
    [tokenId, JSON.stringify(features), dataMode],
  );
}
