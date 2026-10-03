/**
 * Execution realism: latency pipeline, profiles, failures, Jito tips, quote awareness.
 * PAPER ONLY — never submits transactions.
 */
import type { RealismProfile } from '@memebot/shared';
import { SeededRng } from '../domain/seeded-rng.js';
import {
  simulateTrade,
  type SimulateTradeInput,
  type SimulateTradeResult,
} from '../engines/cost/simulator.js';

export const EXECUTION_MODEL_VERSION = 'execution-v2';

export interface LatencyBreakdown {
  eventToFeatureMs: number;
  featureToSignalMs: number;
  signalToDecisionMs: number;
  decisionToQuoteMs: number;
  quoteToExecutionMs: number;
  executionToConfirmMs: number;
  totalMs: number;
}

export interface RealismKnobs {
  slippageMult: number;
  latencyMeanMult: number;
  failureRate: number;
  adverseSelectionMult: number;
  jitoTipMult: number;
  partialFillAggressiveness: number;
}

const PROFILES: Record<RealismProfile, RealismKnobs> = {
  OPTIMISTIC: {
    slippageMult: 0.7,
    latencyMeanMult: 0.6,
    failureRate: 0.02,
    adverseSelectionMult: 0.5,
    jitoTipMult: 0.5,
    partialFillAggressiveness: 0.5,
  },
  REALISTIC: {
    slippageMult: 1,
    latencyMeanMult: 1,
    failureRate: 0.08,
    adverseSelectionMult: 1,
    jitoTipMult: 1,
    partialFillAggressiveness: 1,
  },
  CONSERVATIVE: {
    slippageMult: 1.6,
    latencyMeanMult: 1.8,
    failureRate: 0.18,
    adverseSelectionMult: 1.5,
    jitoTipMult: 1.5,
    partialFillAggressiveness: 1.4,
  },
};

export function getRealismKnobs(profile: RealismProfile): RealismKnobs {
  return PROFILES[profile];
}

export function sampleLatency(
  rng: SeededRng,
  profile: RealismProfile,
): LatencyBreakdown {
  const k = getRealismKnobs(profile);
  const m = k.latencyMeanMult;
  const eventToFeatureMs = rng.latencyMs(40 * m, 30 * m);
  const featureToSignalMs = rng.latencyMs(25 * m, 20 * m);
  const signalToDecisionMs = rng.latencyMs(15 * m, 10 * m);
  const decisionToQuoteMs = rng.latencyMs(80 * m, 60 * m);
  const quoteToExecutionMs = rng.latencyMs(120 * m, 100 * m);
  const executionToConfirmMs = rng.latencyMs(400 * m, 350 * m);
  const totalMs =
    eventToFeatureMs +
    featureToSignalMs +
    signalToDecisionMs +
    decisionToQuoteMs +
    quoteToExecutionMs +
    executionToConfirmMs;
  return {
    eventToFeatureMs,
    featureToSignalMs,
    signalToDecisionMs,
    decisionToQuoteMs,
    quoteToExecutionMs,
    executionToConfirmMs,
    totalMs,
  };
}

export type FailureMode =
  | 'stale_quote'
  | 'insufficient_output'
  | 'congestion'
  | 'liquidity_changed'
  | 'route_unavailable'
  | 'not_landed'
  | 'became_unsellable'
  | null;

export function sampleFailureMode(rng: SeededRng, profile: RealismProfile): FailureMode {
  const k = getRealismKnobs(profile);
  if (!rng.chance(k.failureRate)) return null;
  return rng.pick([
    'stale_quote',
    'insufficient_output',
    'congestion',
    'liquidity_changed',
    'route_unavailable',
    'not_landed',
    'became_unsellable',
  ] as const);
}

export interface RealisticSimInput extends SimulateTradeInput {
  profile: RealismProfile;
  rng: SeededRng;
  jitoTipLamports: number;
  quoteExpectedOutUsd?: number | null;
  quoteAgeMs?: number;
}

export interface RealisticSimResult extends SimulateTradeResult {
  latency: LatencyBreakdown;
  failureMode: FailureMode;
  jitoTipUsd: number;
  fillProbability: number;
  executionModelVersion: string;
  realismProfile: RealismProfile;
}

export function simulateRealisticTrade(input: RealisticSimInput): RealisticSimResult {
  const knobs = getRealismKnobs(input.profile);
  const latency = sampleLatency(input.rng, input.profile);
  const failureMode = sampleFailureMode(input.rng, input.profile);

  const sol = input.gas.solPriceUsd ?? 0;
  const jitoTipUsd = ((input.jitoTipLamports * knobs.jitoTipMult) / 1e9) * sol;

  if (failureMode) {
    const forced = simulateTrade({
      ...input,
      forceFail: true,
      forceFailReason: failureMode,
    });
    // Add jito tip attempt cost on some failures
    if (failureMode === 'not_landed' || failureMode === 'congestion') {
      forced.costs.priorityFeeUsd += jitoTipUsd;
      forced.costs.totalCostUsd += jitoTipUsd;
      forced.execution.priorityFeeUsd = forced.costs.priorityFeeUsd;
      forced.execution.totalCostUsd = forced.costs.totalCostUsd;
    }
    return {
      ...forced,
      latency,
      failureMode,
      jitoTipUsd,
      fillProbability: 0,
      executionModelVersion: EXECUTION_MODEL_VERSION,
      realismProfile: input.profile,
    };
  }

  // Stale quote adverse selection: worsen mid slightly before sim
  let mid = input.midPriceUsd;
  if ((input.quoteAgeMs ?? 0) > 2000) {
    const adverse = 0.002 * knobs.adverseSelectionMult;
    mid = input.side === 'BUY' ? mid * (1 + adverse) : mid * (1 - adverse);
  }

  const result = simulateTrade({ ...input, midPriceUsd: mid });

  // Apply slippage multiplier to costs (conservative/optimistic)
  if (!result.execution.failed && knobs.slippageMult !== 1) {
    const slipAdj = result.costs.slippageCostUsd * (knobs.slippageMult - 1);
    result.costs.slippageCostUsd += slipAdj;
    result.costs.totalCostUsd += slipAdj;
    result.execution.slippagePct *= knobs.slippageMult;
    result.execution.totalCostUsd = result.costs.totalCostUsd;
  }

  // Jito tip on successful path
  result.costs.priorityFeeUsd += jitoTipUsd;
  result.costs.totalCostUsd += jitoTipUsd;
  result.execution.priorityFeeUsd = result.costs.priorityFeeUsd;
  result.execution.totalCostUsd = result.costs.totalCostUsd;

  const sizeRatio = input.requestedAmountUsd / Math.max(input.quote.liquidityUsd, 1);
  const fillProbability = Math.max(0.05, Math.min(0.99, 1 - sizeRatio * 2 * knobs.partialFillAggressiveness));

  return {
    ...result,
    latency,
    failureMode: null,
    jitoTipUsd,
    fillProbability,
    executionModelVersion: EXECUTION_MODEL_VERSION,
    realismProfile: input.profile,
  };
}