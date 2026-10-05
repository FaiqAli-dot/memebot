/**
 * Older-Breakout Research Strategy
 *
 * Detects established tokens breaking out of their recent trading range with supporting activity.
 * RESEARCH ONLY - isolated from production lane.
 *
 * Key concepts:
 * - Relative behavior, not arbitrary absolute values
 * - Uses historical baseline for volume/activity comparisons
 * - Requires sufficient historical data (no hard age cutoff)
 */
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

export class OlderBreakoutStrategy implements Strategy {
  readonly id = 'older-breakout';
  readonly name = 'Older Breakout (Research)';
  readonly version = 'ob-r1';
  readonly activeByDefault = false; // Only active in RESEARCH lane

  evaluate(ctx: StrategyContext, params?: Record<string, number>): Signal {
    const p = paramsFor(this.id, params);

    // Base gates - same as production
    if (ctx.safety?.blocked) {
      return noTrade(this, ['safety_blocked', ...(ctx.safety.reasons ?? [])], 'SAFETY_REJECTION');
    }
    if (!liquidityIsKnown(ctx)) {
      return noTrade(this, [`liquidity_status_${ctx.liquidityStatus ?? 'UNKNOWN'}`], 'LIQUIDITY_REJECTION');
    }
    if (ctx.liquidityUsd < p.minLiquidityUsd) {
      return noTrade(this, ['liquidity_below_min'], 'LIQUIDITY_REJECTION');
    }

    // Require sufficient historical data for baseline
    // Check if we have enough market history to establish a baseline
    const hasHistory = ctx.volume1hUsd > 0;
    if (!hasHistory) {
      return noTrade(this, ['insufficient_historical_data'], 'UNKNOWN', 0);
    }

    // Volume relative to historical baseline
    const volumeRatioTo1h = safeDiv(ctx.volume5mUsd, ctx.volume1hUsd / 12, 0); // 5m vs average 5m over 1h

    // Use a hardcoded 2.0x baseline requirement for research
    if (volumeRatioTo1h < 2.0) {
      return noTrade(this, ['volume_below_historical_baseline'], 'VOLUME_REJECTION', 20);
    }

    // Volume acceleration (non-overlapping preferred)
    const accelInfo = strategyVolumeAccel(ctx);
    if (accelInfo.value == null) {
      return noTrade(this, ['accel_insufficient_data'], 'VOLUME_REJECTION', 15);
    }
    const accel = accelInfo.value;
    if (accel < p.minVolumeAcceleration) {
      return noTrade(this, ['accel_insufficient'], 'VOLUME_REJECTION', 20);
    }

    // Price breakout from recent range
    // Use 5m change as breakout indicator
    if (ctx.priceChange5mPct < p.minPriceChange5mPct) {
      return noTrade(this, ['no_breakout_momentum'], 'MOMENTUM_REJECTION', 20);
    }

    // Activity acceleration (transaction count)
    if (ctx.txCount5m < p.minActivityTx5m) {
      return noTrade(this, ['activity_insufficient'], 'VOLUME_REJECTION', 15);
    }

    // Data freshness check
    const ageMinutes = ctx.ageMinutes;
    if (ageMinutes != null && ageMinutes < p.minTokenAgeMinutes) {
      return noTrade(this, ['token_too_young_for_older_strategy'], 'MOMENTUM_REJECTION', 10);
    }

    // Confidence calculation based on relative strength
    // Higher confidence when:
    // - Volume is much higher than baseline
    // - Strong acceleration
    // - Good liquidity
    // - Strong price momentum
    const volumeScore = clamp(Math.log10(volumeRatioTo1h + 1) * 30, 0, 100);
    const accelScore = clamp(accel * 20, 0, 100);
    const momentumScore = clamp(ctx.priceChange5mPct * 5, 0, 100);
    const liquidityScore = clamp(Math.log10(ctx.liquidityUsd) * 8, 0, 100);

    const confidence = clamp(
      volumeScore * 0.35 +
        accelScore * 0.25 +
        momentumScore * 0.25 +
        liquidityScore * 0.15,
      0,
      95,
    );

    return buySignal(this, {
      confidence,
      expectedReturn: 0.15, // Placeholder - will be calibrated from research data
      expectedLoss: 0.10, // Placeholder - will be calibrated from research data
      expectedHoldTimeSec: 1800, // 30 minutes average hold for established tokens
      reasons: [
        `volume_ratio_1h_${volumeRatioTo1h.toFixed(2)}x`,
        `accel_${accelInfo.label}`,
        `5m_change_${ctx.priceChange5mPct.toFixed(1)}%`,
      ],
      scores: {
        momentum: momentumScore,
        liquidity: liquidityScore,
        volume: volumeScore,
        holderDistribution: 50, // Not primary for older tokens
        risk: 40,
        overall: confidence,
      },
    });
  }
}
