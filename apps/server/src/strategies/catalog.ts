import type { StrategyParamValues, StrategyParamsById } from '@memebot/shared';
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
import { MomentumBreakoutStrategy } from './momentum-breakout.js';
import { OlderBreakoutStrategy } from './older-breakout.js';
import { OlderRevivalStrategy } from './older-revival.js';

function baseGates(s: Strategy, ctx: StrategyContext): Signal | null {
  if (ctx.safety?.blocked) {
    return noTrade(s, ['safety_blocked', ...(ctx.safety.reasons ?? [])], 'SAFETY_REJECTION');
  }
  if (!liquidityIsKnown(ctx)) {
    return noTrade(s, [`liquidity_status_${ctx.liquidityStatus ?? 'UNKNOWN'}`], 'LIQUIDITY_REJECTION');
  }
  if (ctx.liquidityUsd < 3000) {
    return noTrade(s, ['liquidity_below_min'], 'LIQUIDITY_REJECTION');
  }
  return null;
}

export class EarlyVolumeExpansionStrategy implements Strategy {
  readonly id = 'early-volume-expansion';
  readonly name = 'Early Volume Expansion';
  readonly version = 'eve-v1';
  readonly activeByDefault = true;

  evaluate(ctx: StrategyContext, params?: StrategyParamValues): Signal {
    const p = paramsFor(this.id, params);
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    const accelInfo = strategyVolumeAccel(ctx);
    const uniqueBuyers = ctx.flow?.['5m']?.uniqueBuyers.value ?? null;
    if (ctx.ageMinutes != null && ctx.ageMinutes > 60) {
      return noTrade(this, ['not_early'], 'MOMENTUM_REJECTION');
    }
    if (accelInfo.value == null) {
      return noTrade(this, ['accel_insufficient_data'], 'VOLUME_REJECTION', 15);
    }
    const accel = accelInfo.value;
    if (accel < p.minVolumeAcceleration) return noTrade(this, ['accel_insufficient'], 'VOLUME_REJECTION', 20);
    if (ctx.volume5mUsd < p.minVolume5mUsd) return noTrade(this, ['volume_low'], 'VOLUME_REJECTION', 20);
    if (uniqueBuyers != null && uniqueBuyers < 5) {
      return noTrade(this, ['unique_buyers_low'], 'VOLUME_REJECTION', 25);
    }
    if (ctx.phase && !['LAUNCH', 'DISCOVERY', 'EARLY_MOMENTUM'].includes(ctx.phase)) {
      return noTrade(this, [`phase_${ctx.phase}`], 'MOMENTUM_REJECTION');
    }
    const confidence = clamp(50 + accel * 10 + (uniqueBuyers ?? 3) * 2, 0, 95);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.18,
      expectedLoss: 0.1,
      expectedHoldTimeSec: 600,
      reasons: [`volume_accel_x${accelInfo.label}`, `unique_buyers_${uniqueBuyers ?? 'unknown'}`],
      scores: {
        momentum: clamp(accel * 30, 0, 100),
        liquidity: clamp(ctx.liquidityUsd / 100, 0, 100),
        volume: clamp(ctx.volume5mUsd / 50, 0, 100),
        holderDistribution: 50,
        risk: 40,
        overall: confidence,
      },
    });
  }
}

export class LiquidityExpansionStrategy implements Strategy {
  readonly id = 'liquidity-expansion';
  readonly name = 'Liquidity Expansion';
  readonly version = 'liq-v1';
  readonly activeByDefault = true;

  evaluate(ctx: StrategyContext, params?: StrategyParamValues): Signal {
    const p = paramsFor(this.id, params);
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    if (ctx.liquidityUsd < p.minLiquidityUsd) return noTrade(this, ['need_deeper_liquidity'], 'LIQUIDITY_REJECTION');
    if (ctx.volume5mUsd < ctx.liquidityUsd * 0.05) {
      return noTrade(this, ['volume_not_confirming'], 'VOLUME_REJECTION');
    }
    if (ctx.priceChange5mPct < p.minPriceChange5mPct) return noTrade(this, ['no_price_confirmation'], 'MOMENTUM_REJECTION');
    const confidence = clamp(40 + Math.log10(ctx.liquidityUsd) * 8, 0, 90);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.12,
      expectedLoss: 0.07,
      expectedHoldTimeSec: 1200,
      reasons: [`liquidity_$${Math.round(ctx.liquidityUsd)}`, 'volume_confirms_depth'],
      scores: {
        momentum: clamp(ctx.priceChange5mPct * 5, 0, 100),
        liquidity: 80,
        volume: 60,
        holderDistribution: 55,
        risk: 30,
        overall: confidence,
      },
    });
  }
}

export class TrendContinuationStrategy implements Strategy {
  readonly id = 'trend-continuation';
  readonly name = 'Trend Continuation';
  readonly version = 'trend-v1';
  readonly activeByDefault = false;

  evaluate(ctx: StrategyContext): Signal {
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    if (ctx.priceChange1hPct < 8 || ctx.priceChange5mPct < 1) {
      return noTrade(this, ['trend_not_intact'], 'MOMENTUM_REJECTION');
    }
    if (ctx.phase === 'PEAKING' || ctx.phase === 'DISTRIBUTION') {
      return noTrade(this, ['late_phase'], 'MOMENTUM_REJECTION');
    }
    const confidence = clamp(45 + ctx.priceChange1hPct, 0, 88);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.1,
      expectedLoss: 0.08,
      expectedHoldTimeSec: 1800,
      reasons: [`1h_+${ctx.priceChange1hPct.toFixed(1)}%`, `5m_+${ctx.priceChange5mPct.toFixed(1)}%`],
      scores: {
        momentum: clamp(ctx.priceChange1hPct * 2, 0, 100),
        liquidity: 60,
        volume: 55,
        holderDistribution: 50,
        risk: 35,
        overall: confidence,
      },
    });
  }
}

export class MeanReversionStrategy implements Strategy {
  readonly id = 'mean-reversion';
  readonly name = 'Mean Reversion';
  readonly version = 'mr-v1';
  readonly activeByDefault = false;

  evaluate(ctx: StrategyContext): Signal {
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    // Buy dip after sharp selloff with stabilizing flow
    if (ctx.priceChange5mPct > -8 || ctx.priceChange5mPct < -35) {
      return noTrade(this, ['selloff_not_in_band'], 'MOMENTUM_REJECTION');
    }
    const buySell = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);
    if (buySell < 0.9) return noTrade(this, ['still_selling'], 'MOMENTUM_REJECTION');
    if (ctx.liquidityUsd < 8000) return noTrade(this, ['liquidity_thin_for_mr'], 'LIQUIDITY_REJECTION');
    const confidence = clamp(40 + buySell * 20, 0, 75);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.08,
      expectedLoss: 0.12,
      expectedHoldTimeSec: 600,
      reasons: [`dip_${ctx.priceChange5mPct.toFixed(1)}%`, `stabilizing_buy_sell_${buySell.toFixed(2)}`],
      scores: {
        momentum: 40,
        liquidity: 65,
        volume: 50,
        holderDistribution: 50,
        risk: 45,
        overall: confidence,
      },
    });
  }
}

export class PostSelloffRecoveryStrategy implements Strategy {
  readonly id = 'post-selloff-recovery';
  readonly name = 'Post-Selloff Recovery';
  readonly version = 'psr-v1';
  readonly activeByDefault = false;

  evaluate(ctx: StrategyContext): Signal {
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    if (ctx.priceChange1hPct > -15 || ctx.priceChange5mPct < 2) {
      return noTrade(this, ['no_recovery_signal'], 'MOMENTUM_REJECTION');
    }
    const confidence = clamp(35 + ctx.priceChange5mPct * 4, 0, 80);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.1,
      expectedLoss: 0.1,
      expectedHoldTimeSec: 900,
      reasons: ['1h_selloff', '5m_recovery_bounce'],
      scores: {
        momentum: clamp(ctx.priceChange5mPct * 6, 0, 100),
        liquidity: 55,
        volume: 50,
        holderDistribution: 50,
        risk: 50,
        overall: confidence,
      },
    });
  }
}

export class WalletFlowStrategy implements Strategy {
  readonly id = 'wallet-flow';
  readonly name = 'Wallet Flow';
  readonly version = 'wf-v1';
  readonly activeByDefault = false;

  evaluate(ctx: StrategyContext): Signal {
    const blocked = baseGates(this, ctx);
    if (blocked) return blocked;
    const flow = ctx.flow?.['5m'];
    if (!flow || flow.uniqueBuyers.confidence === 'UNKNOWN') {
      return noTrade(this, ['wallet_flow_unavailable'], 'UNKNOWN', 0);
    }
    const buyers = flow.uniqueBuyers.value ?? 0;
    const net = flow.netFlowUsd.value ?? 0;
    const conc = flow.buyerConcentration.value;
    if (buyers < 8) return noTrade(this, ['unique_buyers_low'], 'VOLUME_REJECTION');
    if (net <= 0) return noTrade(this, ['net_flow_negative'], 'MOMENTUM_REJECTION');
    if (conc != null && conc > 60) return noTrade(this, ['buyer_concentration_high'], 'SAFETY_REJECTION');
    const confidence = clamp(40 + buyers * 2 + Math.min(20, net / 500), 0, 90);
    return buySignal(this, {
      confidence,
      expectedReturn: 0.14,
      expectedLoss: 0.09,
      expectedHoldTimeSec: 720,
      reasons: [`unique_buyers_${buyers}`, `net_flow_$${Math.round(net)}`],
      scores: {
        momentum: 55,
        liquidity: 60,
        volume: 70,
        holderDistribution: conc != null ? clamp(100 - conc, 0, 100) : 50,
        risk: 35,
        overall: confidence,
      },
    });
  }
}

export function createStrategyCatalog(): Strategy[] {
  return [
    new MomentumBreakoutStrategy(),
    new EarlyVolumeExpansionStrategy(),
    new LiquidityExpansionStrategy(),
    new TrendContinuationStrategy(),
    new MeanReversionStrategy(),
    new PostSelloffRecoveryStrategy(),
    new WalletFlowStrategy(),
    new OlderBreakoutStrategy(),
    new OlderRevivalStrategy(),
  ];
}

/** Production-lane strategies. Research-only strategies are never selected, even if listed. */
export function activeStrategies(
  catalog: Strategy[],
  activeIds?: string[],
): Strategy[] {
  const eligible = catalog.filter((s) => !s.researchOnly);
  if (activeIds?.length) {
    return eligible.filter((s) => activeIds.includes(s.id));
  }
  return eligible.filter((s) => s.activeByDefault);
}

export function researchOnlyStrategies(catalog: Strategy[]): Strategy[] {
  return catalog.filter((s) => s.researchOnly);
}

/**
 * Pick best BUY signal by confidence; collect NO_TRADE rejections for shadow tracking.
 * Each strategy receives only its own resolved parameters.
 */
export function evaluateAllStrategies(
  strategies: Strategy[],
  ctx: StrategyContext,
  paramsById: StrategyParamsById = {},
): { best: Signal | null; all: Signal[] } {
  const all = strategies.map((s) => s.evaluate(ctx, paramsById[s.id]));
  const buys = all.filter((s) => s.action === 'BUY').sort((a, b) => b.confidence - a.confidence);
  return { best: buys[0] ?? null, all };
}
