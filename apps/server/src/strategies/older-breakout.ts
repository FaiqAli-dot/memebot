/**
 * Older-Breakout research strategy: a token with an established trading history whose
 * current 5m activity breaks well above its own prior-history regime, with momentum.
 *
 * RESEARCH ONLY. Eligibility is "enough prior history to measure a regime" (coverage and
 * volume before the last hour), never a minimum token age. All thresholds come from the
 * strategy parameter registry. No return/loss estimate is emitted until one can be fitted
 * from research outcomes, so EV stays unknown rather than fabricated.
 */
import { clamp } from '../utils/helpers.js';
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

export class OlderBreakoutStrategy implements Strategy {
  readonly id = 'older-breakout';
  readonly name = 'Older Breakout (Research)';
  readonly version = 'ob-r2';
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

    if (ctx.volume5mUsd < p.minVolume5mUsd) {
      return noTrade(this, ['volume_5m_below_min'], 'VOLUME_REJECTION', 10);
    }
    const volumeVsPrior = ratioTo(ctx.volume5mUsd, base.priorVolumePer5mUsd)!;
    if (volumeVsPrior < p.minVolumeRelativeBaseline) {
      return noTrade(this, [`volume_vs_prior_${fmtRatio(volumeVsPrior)}`], 'VOLUME_REJECTION', 15);
    }
    const txVsPrior = ratioTo(ctx.txCount5m, base.priorTxPer5m);
    if (txVsPrior == null) {
      return noTrade(this, ['history_tx_baseline_missing'], 'UNKNOWN', 15);
    }
    if (txVsPrior < p.minActivityAcceleration) {
      return noTrade(this, [`activity_vs_prior_${fmtRatio(txVsPrior)}`], 'VOLUME_REJECTION', 15);
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
      return noTrade(this, ['no_breakout_momentum'], 'MOMENTUM_REJECTION', 20);
    }
    if (ctx.txCount5m < p.minActivityTx5m) {
      return noTrade(this, ['activity_low'], 'VOLUME_REJECTION', 20);
    }

    // Ranking score only (orders research signals); it feeds no EV or sizing.
    const volumeScore = clamp(Math.log10(volumeVsPrior + 1) * 40, 0, 100);
    const activityScore = clamp(Math.log10(txVsPrior + 1) * 40, 0, 100);
    const accelScore = clamp(accel * 20, 0, 100);
    const momentumScore = clamp(ctx.priceChange5mPct * 5, 0, 100);
    const confidence = clamp(volumeScore * 0.3 + activityScore * 0.2 + accelScore * 0.25 + momentumScore * 0.25, 0, 95);

    return buySignal(this, {
      confidence,
      expectedReturn: null,
      expectedLoss: null,
      expectedHoldTimeSec: 1800,
      reasons: [
        `history_${(base.priorMinutes / 60).toFixed(1)}h`,
        `volume_vs_prior_${fmtRatio(volumeVsPrior)}`,
        `activity_vs_prior_${fmtRatio(txVsPrior)}`,
        `accel_${accelInfo.label}`,
        `5m_change_${ctx.priceChange5mPct.toFixed(1)}%`,
      ],
      scores: {
        momentum: momentumScore,
        liquidity: 50,
        volume: volumeScore,
        holderDistribution: 50,
        risk: 50,
        overall: confidence,
      },
    });
  }
}
