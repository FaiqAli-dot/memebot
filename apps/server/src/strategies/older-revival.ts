/**
 * Older-Revival research strategy: a token that was active in its prior history, went quiet
 * over the last hour (dormant regime), and whose current 5m activity has come back above
 * both the quiet hour and its prior regime, with price/buy-pressure confirmation.
 *
 *   prior history (24h − 1h) → dormant last hour (1h − 5m) → revival (current 5m)
 *
 * RESEARCH ONLY. Eligibility is enough prior history to measure the regime, never a minimum
 * token age. All thresholds come from the strategy parameter registry. No return/loss estimate
 * is emitted until one can be fitted from research outcomes, so EV stays unknown.
 */
import { clamp, safeDiv } from '../utils/helpers.js';
import { fmtRatio, historicalBaseline, insufficientHistory, ratioTo } from './historical-baseline.js';
import {
  buySignal,
  liquidityIsKnown,
  noTrade,
  paramsFor,
  strategyVolumeAccel,
  type Signal,
  type Strategy,
  type StrategyContext,
} from './types.js';
import type { StrategyParamValues } from '@memebot/shared';

export class OlderRevivalStrategy implements Strategy {
  readonly id = 'older-revival';
  readonly name = 'Older Revival (Research)';
  readonly version = 'or-r2';
  readonly activeByDefault = false;
  readonly researchOnly = true;

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

    const base = historicalBaseline(ctx);
    const missing = insufficientHistory(base, p);
    if (missing) return noTrade(this, [missing], 'UNKNOWN');
    if (base.recentHourVolumePer5mUsd == null) {
      return noTrade(this, ['history_recent_hour_missing'], 'UNKNOWN');
    }

    const dormancy = ratioTo(base.recentHourVolumePer5mUsd, base.priorVolumePer5mUsd)!;
    if (dormancy > p.maxDormancyActivityRatio) {
      return noTrade(this, [`not_dormant_${fmtRatio(dormancy)}`], 'VOLUME_REJECTION', 10);
    }
    if (ctx.volume5mUsd < p.minVolume5mUsd) {
      return noTrade(this, ['volume_5m_below_min'], 'VOLUME_REJECTION', 10);
    }
    const revival = ratioTo(ctx.volume5mUsd, base.recentHourVolumePer5mUsd)!;
    if (revival < p.minRevivalVolumeRatio) {
      return noTrade(this, [`no_revival_${fmtRatio(revival)}`], 'VOLUME_REJECTION', 15);
    }
    const volumeVsPrior = ratioTo(ctx.volume5mUsd, base.priorVolumePer5mUsd)!;
    if (volumeVsPrior < p.minVolumeRelativeBaseline) {
      return noTrade(this, [`volume_vs_prior_${fmtRatio(volumeVsPrior)}`], 'VOLUME_REJECTION', 15);
    }

    const accelInfo = strategyVolumeAccel(ctx);
    if (accelInfo.value == null) {
      return noTrade(this, ['accel_insufficient_data'], 'VOLUME_REJECTION', 15);
    }
    const accel = accelInfo.value;
    if (accel < p.minVolumeAcceleration) {
      return noTrade(this, ['accel_insufficient'], 'VOLUME_REJECTION', 20);
    }
    if (ctx.priceChange5mPct < p.minPriceChange5mPct) {
      return noTrade(this, ['no_price_confirmation'], 'MOMENTUM_REJECTION', 20);
    }
    if (ctx.priceChange1hPct > p.maxPriceChange1hPct) {
      return noTrade(this, ['price_1h_already_extended'], 'MOMENTUM_REJECTION', 15);
    }
    const buySellRatio = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);
    if (buySellRatio < p.minBuySellRatio) {
      return noTrade(this, ['no_buy_pressure'], 'MOMENTUM_REJECTION', 15);
    }

    // Ranking score only (orders research signals); it feeds no EV or sizing.
    const revivalScore = clamp(Math.log10(revival + 1) * 40, 0, 100);
    const regimeScore = clamp(Math.log10(volumeVsPrior + 1) * 40, 0, 100);
    const accelScore = clamp(accel * 20, 0, 100);
    const momentumScore = clamp(ctx.priceChange5mPct * 4, 0, 100);
    const buyPressureScore = clamp(buySellRatio * 15, 0, 100);
    const confidence = clamp(
      revivalScore * 0.3 + regimeScore * 0.15 + accelScore * 0.2 + momentumScore * 0.2 + buyPressureScore * 0.15,
      0,
      90,
    );

    return buySignal(this, {
      confidence,
      expectedReturn: null,
      expectedLoss: null,
      expectedHoldTimeSec: 2400,
      reasons: [
        `history_${(base.priorMinutes / 60).toFixed(1)}h`,
        `dormancy_${fmtRatio(dormancy)}`,
        `revival_${fmtRatio(revival)}`,
        `volume_vs_prior_${fmtRatio(volumeVsPrior)}`,
        `accel_${accelInfo.label}`,
        `buy_sell_${buySellRatio.toFixed(2)}`,
      ],
      scores: {
        momentum: momentumScore,
        liquidity: 50,
        volume: revivalScore,
        holderDistribution: 50,
        risk: 50,
        overall: confidence,
      },
    });
  }
}
