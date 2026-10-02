import type {
  MomentumStrategyParams,
  RiskLabel,
  ScoreBreakdown,
  SignalExplanation,
} from '@memebot/shared';
import { clamp, safeDiv } from '../../utils/helpers.js';

export interface StrategyMarketContext {
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
  /** Prior volume5m if known — for acceleration. No future data. */
  priorVolume5mUsd: number | null;
}

export interface StrategyEvaluation {
  pass: boolean;
  side: 'BUY' | 'SELL';
  scores: ScoreBreakdown;
  riskLabel: RiskLabel;
  explanation: SignalExplanation;
}

export interface Strategy {
  readonly name: string;
  readonly version: string;
  evaluate(ctx: StrategyMarketContext, params: MomentumStrategyParams): StrategyEvaluation;
  score(ctx: StrategyMarketContext, params: MomentumStrategyParams): ScoreBreakdown;
  explain(ctx: StrategyMarketContext, scores: ScoreBreakdown): SignalExplanation;
}

export const DEFAULT_MOMENTUM_PARAMS: MomentumStrategyParams = {
  minVolume5mUsd: 1500,
  minVolumeAcceleration: 1.3,
  minPriceChange5mPct: 1.5,
  minBuySellRatio: 1.1,
  minLiquidityUsd: 5000,
  minActivityTx5m: 15,
  minTokenAgeMinutes: 5,
  maxTokenAgeMinutes: 24 * 60,
  minOverallScore: 55,
  maxTopHolderPct: 40,
};

export function riskLabelFromScore(riskScore: number, topHolderPct: number | null, liquidityUsd: number): RiskLabel {
  if (liquidityUsd < 1000 || (topHolderPct != null && topHolderPct > 50) || riskScore >= 80) {
    return 'EXTREME';
  }
  if (liquidityUsd < 5000 || (topHolderPct != null && topHolderPct > 30) || riskScore >= 60) {
    return 'HIGH';
  }
  if (riskScore >= 35 || (topHolderPct != null && topHolderPct > 20)) {
    return 'MODERATE';
  }
  return 'LOWER_RISK';
}

export class MomentumStrategyV1 implements Strategy {
  readonly name = 'Momentum Scanner v1';
  readonly version = '1.0.0';

  score(ctx: StrategyMarketContext, _params: MomentumStrategyParams): ScoreBreakdown {
    const accel = ctx.priorVolume5mUsd && ctx.priorVolume5mUsd > 0
      ? ctx.volume5mUsd / ctx.priorVolume5mUsd
      : ctx.volume1hUsd > 0
        ? (ctx.volume5mUsd * 12) / ctx.volume1hUsd
        : 1;

    const momentum = clamp(
      40 + ctx.priceChange5mPct * 3 + Math.min(20, Math.max(0, accel - 1) * 20),
      0,
      100,
    );
    const liquidity = clamp(
      Math.log10(Math.max(ctx.liquidityUsd, 1)) / Math.log10(1_000_000) * 100,
      0,
      100,
    );
    const volume = clamp(
      Math.log10(Math.max(ctx.volume5mUsd, 1)) / Math.log10(100_000) * 100,
      0,
      100,
    );
    const buySell = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 1);
    const holderDistribution =
      ctx.topHolderPct == null
        ? 50
        : clamp(100 - ctx.topHolderPct * 1.8, 0, 100);

    // Higher risk score = riskier
    let risk = 20;
    if (ctx.liquidityUsd < 5000) risk += 25;
    if (ctx.liquidityUsd < 1500) risk += 25;
    if (ctx.topHolderPct != null && ctx.topHolderPct > 25) risk += 20;
    if (ctx.topHolderPct != null && ctx.topHolderPct > 40) risk += 20;
    if (Math.abs(ctx.priceChange5mPct) > 20) risk += 15;
    if (ctx.ageMinutes != null && ctx.ageMinutes < 10) risk += 10;
    risk = clamp(risk, 0, 100);

    const buyPressureBonus = clamp((buySell - 1) * 25, -10, 20);
    const overall = clamp(
      momentum * 0.3 +
        liquidity * 0.2 +
        volume * 0.2 +
        holderDistribution * 0.15 +
        (100 - risk) * 0.15 +
        buyPressureBonus,
      0,
      100,
    );

    return {
      momentum: round1(momentum),
      liquidity: round1(liquidity),
      volume: round1(volume),
      holderDistribution: round1(holderDistribution),
      risk: round1(risk),
      overall: round1(overall),
    };
  }

  explain(ctx: StrategyMarketContext, scores: ScoreBreakdown): SignalExplanation {
    const accel =
      ctx.priorVolume5mUsd && ctx.priorVolume5mUsd > 0
        ? ctx.volume5mUsd / ctx.priorVolume5mUsd
        : null;
    const buySell = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);
    const reasons: string[] = [];
    const warnings: string[] = [];

    if (accel != null && accel >= 1.3) {
      reasons.push(`5m volume acceleration x${accel.toFixed(2)}`);
    } else if (ctx.volume5mUsd > 0) {
      reasons.push(`5m volume $${ctx.volume5mUsd.toFixed(0)}`);
    }
    if (ctx.priceChange5mPct >= 1.5) {
      reasons.push(`Price change 5m +${ctx.priceChange5mPct.toFixed(2)}%`);
    }
    if (buySell >= 1.1) {
      reasons.push(`Buy/sell volume ratio ${buySell.toFixed(2)}`);
    }
    if (ctx.liquidityUsd >= 5000) {
      reasons.push(`Liquidity $${ctx.liquidityUsd.toFixed(0)} above threshold`);
    }
    if (ctx.txCount5m >= 15) {
      reasons.push(`Activity ${ctx.txCount5m} tx / 5m`);
    }

    if (ctx.liquidityUsd < 5000) warnings.push('Low liquidity relative to typical thresholds');
    if (ctx.topHolderPct != null && ctx.topHolderPct > 25) {
      warnings.push(`Concentrated holders: top holder ${ctx.topHolderPct.toFixed(1)}%`);
    }
    if (Math.abs(ctx.priceChange5mPct) > 15) warnings.push('High short-term volatility');
    if (ctx.ageMinutes != null && ctx.ageMinutes < 15) warnings.push('Very new token');
    if (safeDiv(ctx.volume5mUsd, ctx.liquidityUsd, 0) > 0.5) {
      warnings.push('Volume high relative to liquidity');
    }

    return {
      reasons,
      warnings,
      factors: {
        momentumScore: scores.momentum,
        liquidityScore: scores.liquidity,
        volumeScore: scores.volume,
        holderScore: scores.holderDistribution,
        riskScore: scores.risk,
        overallScore: scores.overall,
        volumeAcceleration: accel ?? 'n/a',
        buySellRatio: buySell,
        ageMinutes: ctx.ageMinutes ?? 'n/a',
      },
    };
  }

  evaluate(ctx: StrategyMarketContext, params: MomentumStrategyParams): StrategyEvaluation {
    const scores = this.score(ctx, params);
    const explanation = this.explain(ctx, scores);
    const riskLabel = riskLabelFromScore(scores.risk, ctx.topHolderPct, ctx.liquidityUsd);
    const buySell = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);
    const accel =
      ctx.priorVolume5mUsd && ctx.priorVolume5mUsd > 0
        ? ctx.volume5mUsd / ctx.priorVolume5mUsd
        : ctx.volume1hUsd > 0
          ? (ctx.volume5mUsd * 12) / ctx.volume1hUsd
          : 0;

    const failures: string[] = [];
    if (ctx.liquidityUsd < params.minLiquidityUsd) failures.push('liquidity filter');
    if (ctx.volume5mUsd < params.minVolume5mUsd) failures.push('volume filter');
    if (accel < params.minVolumeAcceleration) failures.push('volume acceleration');
    if (ctx.priceChange5mPct < params.minPriceChange5mPct) failures.push('momentum');
    if (buySell < params.minBuySellRatio) failures.push('buy pressure');
    if (ctx.txCount5m < params.minActivityTx5m) failures.push('activity');
    if (ctx.ageMinutes != null) {
      if (ctx.ageMinutes < params.minTokenAgeMinutes) failures.push('token too new');
      if (ctx.ageMinutes > params.maxTokenAgeMinutes) failures.push('token too old');
    }
    if (ctx.topHolderPct != null && ctx.topHolderPct > params.maxTopHolderPct) {
      failures.push('holder concentration');
    }
    if (scores.overall < params.minOverallScore) failures.push('overall score');
    if (riskLabel === 'EXTREME') failures.push('extreme risk');

    if (failures.length) {
      explanation.warnings.push(`Filtered: ${failures.join(', ')}`);
    }

    return {
      pass: failures.length === 0,
      side: 'BUY',
      scores,
      riskLabel,
      explanation,
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
