/**
 * Older-token research lane gates. Research-only strategies emit no return/loss estimate, so
 * the lane never trades on EV; it trades a strategy-qualified candidate only when its measured
 * round-trip cost is within the lane's limit and the inputs are trustworthy.
 */
import { tokenAge } from '../universe/lifecycle.js';

/** Minutes of provider-window history a token can have: token age, or observed span if longer. */
export function historyCoverageMinutes(
  token: {
    pool_created_at?: Date | null;
    created_at_onchain: Date | null;
    first_observed_at?: Date | null;
    discovered_at: Date;
  },
  now: Date,
): { ageMinutes: number; observedSpanMinutes: number | null; coverage: number } {
  const ageMinutes = tokenAge(
    {
      poolCreatedAt: token.pool_created_at ?? token.created_at_onchain ?? null,
      firstObservedAt: token.first_observed_at ?? null,
      discoveredAt: token.discovered_at,
    },
    now,
  ).minutes;
  const observedSpanMinutes = token.first_observed_at
    ? Math.max(0, (now.getTime() - token.first_observed_at.getTime()) / 60_000)
    : null;
  return { ageMinutes, observedSpanMinutes, coverage: Math.max(ageMinutes, observedSpanMinutes ?? 0, 0) };
}

/** Why the lane won't trade a strategy-qualified candidate, or null to trade it. */
export function olderLaneRejection(c: {
  costRate: number;
  networkFeePriced: boolean;
  maxRoundTripCostPct: number;
  criticalDataOk: boolean;
  inCooldown: boolean;
}): string | null {
  if (!c.networkFeePriced) return 'network_fee_unpriced';
  if (c.costRate * 100 > c.maxRoundTripCostPct) return 'round_trip_cost_too_high';
  if (!c.criticalDataOk) return 'critical_data_check_failed';
  if (c.inCooldown) return 'signal_cooldown';
  return null;
}
