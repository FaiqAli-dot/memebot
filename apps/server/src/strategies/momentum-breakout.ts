import type { StrategyParamValues } from '@memebot/shared';
import { clamp, safeDiv } from '../utils/helpers.js';
import {
  buySignal,
  liquidityIsKnown,
  noTrade,
  paramsFor,
  strategyVolumeAccel,
  type Strategy,
  type StrategyContext,
  type Signal,
} from './types.js';

export class MomentumBreakoutStrategy implements Strategy {
  readonly id = 'momentum-breakout';
  readonly name = 'Momentum Breakout';
  readonly version = 'momentum-v4';
  readonly activeByDefault = true;

  evaluate(ctx: StrategyContext, params?: StrategyParamValues): Signal {
    const p = paramsFor(this.id, params);
    if (ctx.safety?.blocked) {
      return noTrade(this, ['safety_blocked', ...(ctx.safety.reasons ?? [])], 'SAFETY_REJECTION');
    }
    if (!liquidityIsKnown(ctx)) {
      return noTrade(this, [`liquidity_status_${ctx.liquidityStatus ?? 'UNKNOWN'}`], 'LIQUIDITY_REJECTION');
    }
    if (ctx.liquidityUsd < p.minLiquidityUsd) {
      return noTrade(this, ['liquidity_below_min'], 'LIQUIDITY_REJECTION');
    }
    if (ctx.volume5mUsd < p.minVolume5mUsd) {
      return noTrade(this, ['volume_below_min'], 'VOLUME_REJECTION');
    }

    const accelInfo = strategyVolumeAccel(ctx);
    const buySell = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);

    if (accelInfo.value == null) {
      return noTrade(this, ['volume_acceleration_insufficient_data'], 'VOLUME_REJECTION', 15);
    }
    const accel = accelInfo.value;
    if (accel < p.minVolumeAcceleration) return noTrade(this, ['volume_acceleration_weak'], 'VOLUME_REJECTION', 20);
    if (ctx.priceChange5mPct < p.minPriceChange5mPct) return noTrade(this, ['momentum_weak'], 'MOMENTUM_REJECTION', 25);
    if (buySell < p.minBuySellRatio) return noTrade(this, ['buy_pressure_weak'], 'MOMENTUM_REJECTION', 30);
    if (ctx.txCount5m < p.minActivityTx5m) return noTrade(this, ['activity_low'], 'VOLUME_REJECTION', 20);
    if (ctx.ageMinutes != null && (ctx.ageMinutes < p.minTokenAgeMinutes || ctx.ageMinutes > p.maxTokenAgeMinutes)) {
      return noTrade(this, ['age_out_of_range'], 'UNKNOWN', 10);
    }
    if (ctx.topHolderPct != null && ctx.topHolderPct > p.maxTopHolderPct) {
      return noTrade(this, ['holder_concentration'], 'SAFETY_REJECTION', 15);
    }
    if (ctx.phase === 'DISTRIBUTION' || ctx.phase === 'DECLINE' || ctx.phase === 'DEAD') {
      return noTrade(this, [`phase_${ctx.phase}`], 'MOMENTUM_REJECTION', 10);
    }
    if (ctx.regime === 'DEAD') {
      return noTrade(this, ['regime_dead'], 'REGIME_REJECTION', 5);
    }

    const momentum = clamp(40 + ctx.priceChange5mPct * 3 + Math.min(20, Math.max(0, accel - 1) * 20), 0, 100);
    const liquidity = clamp(Math.log10(Math.max(ctx.liquidityUsd, 1)) / Math.log10(1_000_000) * 100, 0, 100);
    const volume = clamp(Math.log10(Math.max(ctx.volume5mUsd, 1)) / Math.log10(100_000) * 100, 0, 100);
    const holder =
      ctx.topHolderPct == null ? 50 : clamp(100 - ctx.topHolderPct * 1.8, 0, 100);
    let risk = 20;
    if (ctx.liquidityUsd < 5000) risk += 25;
    if (ctx.topHolderPct != null && ctx.topHolderPct > 25) risk += 20;
    risk = clamp(risk, 0, 100);
    const overall = clamp(
      momentum * 0.3 + liquidity * 0.2 + volume * 0.2 + holder * 0.15 + (100 - risk) * 0.15,
      0,
      100,
    );
    if (overall < p.minOverallScore) return noTrade(this, ['overall_score_low'], 'MOMENTUM_REJECTION', overall);

    const confMult = ctx.buySellConfidence === 'LOW' ? 0.7 : ctx.buySellConfidence === 'HIGH' ? 1 : 0.85;
    const confidence = clamp(overall * confMult, 0, 100);

    return buySignal(this, {
      confidence,
      expectedReturn: clamp(ctx.priceChange5mPct / 100 * 1.5, 0.02, 0.35),
      expectedLoss: 0.08,
      expectedHoldTimeSec: 900,
      reasons: [
        `5m_momentum_+${ctx.priceChange5mPct.toFixed(1)}%`,
        `volume_accel_x${accelInfo.label}`,
        `buy_sell_${buySell.toFixed(2)}`,
        `phase_${ctx.phase ?? 'unknown'}`,
      ],
      scores: {
        momentum: round1(momentum),
        liquidity: round1(liquidity),
        volume: round1(volume),
        holderDistribution: round1(holder),
        risk: round1(risk),
        overall: round1(overall),
      },
      riskLabel: risk >= 80 ? 'EXTREME' : risk >= 60 ? 'HIGH' : risk >= 35 ? 'MODERATE' : 'LOWER_RISK',
    });
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
