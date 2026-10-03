/**
 * Diagnostic funnel: makes "why are there no trades?" answerable from data.
 * One row per signal tick (kind 'signal') and per execution tick per lane
 * (kind 'execution_production' / 'execution_research').
 */
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import type { Signal } from '../strategies/types.js';
import type { RiskAssessment, RiskRejectionReason } from '../risk/position-risk.js';

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export const FUNNEL_STAGES = [
  'discovered',
  'tracked',
  'freshMarketData',
  'knownLiquidity',
  'researchOnly',
  'evaluated',
  'safetyPassed',
  'strategyEligible',
  'evPassed',
  'riskEvaluated',
  'riskSized',
  'riskResized',
  'riskRejected',
  'riskPassed',
  'executionAttempted',
  'executed',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_REJECTIONS = [
  'tooOld',
  'tooYoung',
  'staleData',
  'unknownLiquidity',
  'lowLiquidity',
  'safetyFailed',
  'strategyFailed',
  'volumeFailed',
  'priceFailed',
  'transactionCountFailed',
  'evFailed',
  'riskFailed',
  'executionFailed',
] as const;
export type FunnelRejection = (typeof FUNNEL_REJECTIONS)[number];

/** Map one strategy NO_TRADE to a funnel rejection category. */
export function classifyStrategyRejection(sig: Signal, ageMinutes: number | null): FunnelRejection {
  const reasons = sig.reasons ?? [];
  const has = (r: string) => reasons.some((x) => x === r || x.startsWith(r));
  if (has('age_out_of_range')) return ageMinutes != null && ageMinutes < 5 ? 'tooYoung' : 'tooOld';
  if (has('not_early')) return 'tooOld';
  switch (sig.rejectionReason) {
    case 'LIQUIDITY_REJECTION':
      return has('liquidity_status_') ? 'unknownLiquidity' : 'lowLiquidity';
    case 'SAFETY_REJECTION':
      return 'safetyFailed';
    case 'VOLUME_REJECTION':
      return has('activity_low') ? 'transactionCountFailed' : 'volumeFailed';
    case 'MOMENTUM_REJECTION':
      if (has('momentum_weak') || has('no_price_confirmation') || has('trend_not_intact') || has('selloff') || has('no_recovery')) {
        return 'priceFailed';
      }
      return 'strategyFailed';
    case 'STALE_DATA':
      return 'staleData';
    default:
      return 'strategyFailed';
  }
}

export interface EvCandidate {
  tokenId: string;
  symbol: string;
  strategyId: string;
  expectedNetValue: number;
  threshold: number;
  dataConfidence: string;
  executionCostRate: number | null;
  positionSizeUsd: number | null;
}

export class FunnelRecorder {
  readonly stages: Record<string, number> = {};
  readonly rejections: Record<string, number> = {};
  readonly strategyRejections: Record<string, Record<string, number>> = {};
  readonly riskRejections: Record<string, number> = {};
  private readonly riskSamples: Record<string, unknown>[] = [];
  private evCandidates: EvCandidate[] = [];
  readonly details: Record<string, unknown> = {};

  stage(name: FunnelStage, n = 1): void {
    this.stages[name] = (this.stages[name] ?? 0) + n;
  }

  setStage(name: FunnelStage, n: number): void {
    this.stages[name] = n;
  }

  reject(name: FunnelRejection, n = 1): void {
    this.rejections[name] = (this.rejections[name] ?? 0) + n;
  }

  rejectStrategy(strategyId: string, category: FunnelRejection): void {
    const s = (this.strategyRejections[strategyId] ??= {});
    s[category] = (s[category] ?? 0) + 1;
  }

  riskReject(reason: RiskRejectionReason): void {
    this.riskRejections[reason] = (this.riskRejections[reason] ?? 0) + 1;
  }

  /** Compact "what if sized" record for the last few risk decisions of this tick. */
  riskSample(a: RiskAssessment, strategyId: string | null): void {
    if (this.riskSamples.length >= 10) return;
    this.riskSamples.push({
      strategyId,
      decision: a.decision,
      reason: a.rejectionReason ?? a.bindingConstraint,
      tier: a.riskTier,
      requestedSizeUsd: round(a.requestedSizeUsd),
      finalSizeUsd: round(a.finalSizeUsd),
      maxViableSizeUsd: round(a.maxViableSizeUsd),
      maximumPlannedLossUsd: round(a.maximumPlannedLossUsd),
      maxRiskPerTradeUsd: round(a.maxRiskPerTradeUsd),
      costRate: a.cost ? round(a.cost.totalCostRate) : null,
    });
  }

  evCandidate(c: EvCandidate): void {
    this.evCandidates.push(c);
  }

  evSummary() {
    const sorted = [...this.evCandidates].sort((a, b) => b.expectedNetValue - a.expectedNetValue);
    const best = sorted[0] ?? null;
    const misses = this.evCandidates
      .filter((c) => c.expectedNetValue < c.threshold)
      .map((c) => ({ ...c, shortfall: c.threshold - c.expectedNetValue }))
      .sort((a, b) => a.shortfall - b.shortfall);
    const within = (x: number) => misses.filter((m) => m.shortfall <= x).length;
    return {
      candidates: this.evCandidates.length,
      best,
      closestMiss: misses[0] ?? null,
      within0_5pct: within(0.005),
      within1pct: within(0.01),
      within2pct: within(0.02),
    };
  }

  toJson() {
    return {
      counts: { stages: this.stages, rejections: this.rejections, riskRejections: this.riskRejections },
      details: {
        ...this.details,
        strategyRejections: this.strategyRejections,
        ev: this.evSummary(),
        riskSamples: this.riskSamples,
      },
    };
  }

  async persist(kind: string, observedAt = new Date()): Promise<void> {
    const j = this.toJson();
    await query(
      `INSERT INTO funnel_snapshots (kind, counts, details, observed_at, data_mode) VALUES ($1,$2,$3,$4,$5)`,
      [kind, JSON.stringify(j.counts), JSON.stringify(j.details), observedAt, dataMode],
    );
  }
}

export async function pruneFunnelSnapshots(keepHours = 48): Promise<void> {
  await query(
    `DELETE FROM funnel_snapshots WHERE observed_at < NOW() - ($1::text || ' hours')::interval`,
    [String(keepHours)],
  );
}
