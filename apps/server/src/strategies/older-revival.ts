/**
 * Older-Revival Research Strategy
 *
 * Detects previously active tokens that became relatively dormant and are now experiencing renewed activity.
 * RESEARCH ONLY - isolated from production lane.
 *
 * Pattern:
 * previous activity → quiet/dormant period → activity returns → volume acceleration → price/momentum confirmation
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

export class OlderRevivalStrategy implements Strategy {
  readonly id = 'older-revival';
  readonly name = 'Older Revival (Research)';
  readonly version = 'or-r1';
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

    // Require sufficient historical data to detect dormant period
    const hasHistory = ctx.volume1hUsd > 0;
    if (!hasHistory) {
      return noTrade(this, ['insufficient_historical_data'], 'UNKNOWN', 0);
    }

    // Detect dormant period: 1h volume much lower than recent 5m
    const avg5mOver1h = ctx.volume1hUsd / 12;
    const currentVsDormant = safeDiv(ctx.volume5mUsd, avg5mOver1h, 0);

    // If current is not significantly higher than recent average, not a revival
    if (currentVsDormant < 3.0) {
      return noTrade(this, ['no_revival_activity'], 'VOLUME_REJECTION', 20);
    }

    // Volume acceleration
    const accelInfo = strategyVolumeAccel(ctx);
    if (accelInfo.value == null) {
      return noTrade(this, ['accel_insufficient_data'], 'VOLUME_REJECTION', 15);
    }
    const accel = accelInfo.value;
    if (accel < p.minVolumeAcceleration) {
      return noTrade(this, ['accel_insufficient'], 'VOLUME_REJECTION', 20);
    }

    // Price momentum confirmation
    // Revivals should show price lift with volume return
    if (ctx.priceChange5mPct < p.minPriceChange5mPct) {
      return noTrade(this, ['no_price_confirmation'], 'MOMENTUM_REJECTION', 20);
    }

    // Check distance from recent highs (don't buy at peak of previous pump)
    // Use 1h change as proxy for distance from recent highs
    if (ctx.priceChange1hPct > 30) {
      return noTrade(this, ['too_close_to_recent_highs'], 'MOMENTUM_REJECTION', 15);
    }

    // Buy/sell imbalance if available
    const buySellRatio = safeDiv(ctx.buyVolume5mUsd, Math.max(ctx.sellVolume5mUsd, 1), 0);
    if (buySellRatio < p.minBuySellRatio) {
      return noTrade(this, ['no_buy_pressure'], 'MOMENTUM_REJECTION', 15);
    }

    // Data freshness
    const ageMinutes = ctx.ageMinutes;
    if (ageMinutes != null && ageMinutes < p.minTokenAgeMinutes) {
      return noTrade(this, ['token_too_young_for_revival'], 'MOMENTUM_REJECTION', 10);
    }

    // Confidence calculation
    // Higher confidence when:
    // - Strong revival from dormancy
    // - Good volume acceleration
    // - Price confirmation without being at peak
    // - Buy pressure
    const revivalScore = clamp(Math.log10(currentVsDormant + 1) * 30, 0, 100);
    const accelScore = clamp(accel * 20, 0, 100);
    const momentumScore = clamp(ctx.priceChange5mPct * 4, 0, 100);
    const buyPressureScore = clamp(buySellRatio * 15, 0, 100);

    const confidence = clamp(
      revivalScore * 0.35 +
        accelScore * 0.25 +
        momentumScore * 0.25 +
        buyPressureScore * 0.15,
      0,
      90,
    );

    return buySignal(this, {
      confidence,
      expectedReturn: 0.12, // Placeholder - will be calibrated from research data
      expectedLoss: 0.09, // Placeholder - will be calibrated from research data
      expectedHoldTimeSec: 2400, // 40 minutes average hold for revivals
      reasons: [
        `revival_${currentVsDormant.toFixed(2)}x`,
        `accel_${accelInfo.label}`,
        `5m_change_${ctx.priceChange5mPct.toFixed(1)}%`,
        `buy_sell_${buySellRatio.toFixed(2)}`,
      ],
      scores: {
        momentum: momentumScore,
        liquidity: 60,
        volume: revivalScore,
        holderDistribution: 50,
        risk: 45,
        overall: confidence,
      },
    });
  }
}
