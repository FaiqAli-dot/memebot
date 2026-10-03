import type { ReportReview } from '@memebot/shared';
import { MIN_BUCKET_TRADES } from './analyze.js';
import { type ClosedTrade, bucketStats } from './types.js';

/** Win-rate drop (percentage points) that counts as "worse". */
export const WORSE_WIN_RATE_PP = 5;

export interface ReviewInput {
  targetReportId: string | null;
  /** Trades closed since the target report's lessons were applied. */
  since: ClosedTrade[];
  /** Trades closed in the window before the target report. */
  before: ClosedTrade[];
  previousVerdict: ReportReview['verdict'] | null;
  /** Trades required on each side before a verdict (and therefore a revert) is possible */
  minTrades?: number;
}

/**
 * Judges whether the most recently applied lessons helped. Two consecutive
 * "worse" verdicts trigger a revert.
 */
export function reviewLessons(input: ReviewInput): ReportReview {
  const since = bucketStats(input.since);
  const before = bucketStats(input.before);
  if (!input.targetReportId) {
    return { targetReportId: null, verdict: 'none', since, before, reverted: false };
  }
  const minTrades = input.minTrades ?? MIN_BUCKET_TRADES;
  if (since.n < minTrades || before.n < minTrades) {
    return { targetReportId: input.targetReportId, verdict: 'inconclusive', since, before, reverted: false };
  }

  const worse =
    since.winRatePct <= before.winRatePct - WORSE_WIN_RATE_PP && since.avgPnlUsd < before.avgPnlUsd;
  const better =
    !worse &&
    (since.winRatePct >= before.winRatePct + WORSE_WIN_RATE_PP || since.avgPnlUsd > before.avgPnlUsd);
  const verdict: ReportReview['verdict'] = worse ? 'worse' : better ? 'better' : 'inconclusive';

  return {
    targetReportId: input.targetReportId,
    verdict,
    since,
    before,
    reverted: verdict === 'worse' && input.previousVerdict === 'worse',
  };
}
