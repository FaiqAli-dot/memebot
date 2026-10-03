import type { LearningDataQuality } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';

/** Observation counts by quality: calibration-grade evidence vs descriptive-only evidence. */
export async function getDataQuality(): Promise<LearningDataQuality> {
  const { rows } = await query<{ portfolio_type: string; observation_quality: string; n: string }>(
    `SELECT portfolio_type, observation_quality, COUNT(*) AS n
     FROM trade_observations WHERE data_mode = $1 GROUP BY 1, 2`,
    [dataMode],
  );
  const count = (type: string, quality?: string) =>
    rows
      .filter((r) => r.portfolio_type === type && (!quality || r.observation_quality === quality))
      .reduce((a, r) => a + Number(r.n), 0);
  const trueEntry = count('PRODUCTION', 'TRUE_ENTRY_SNAPSHOT');
  return {
    production: count('PRODUCTION'),
    trueEntrySnapshots: trueEntry,
    partialEntrySnapshots: count('PRODUCTION', 'PARTIAL_ENTRY_SNAPSHOT'),
    signalBackfills: count('PRODUCTION', 'SIGNAL_BACKFILL'),
    calibrationEligible: trueEntry,
    research: count('RESEARCH'),
    note:
      trueEntry < env.MIN_NEW_OBSERVATIONS_FOR_LEARNING
        ? `Calibration skipped: insufficient TRUE_ENTRY_SNAPSHOT observations (${trueEntry}; ${env.MIN_NEW_OBSERVATIONS_FOR_LEARNING} required). Backfilled observations are descriptive only and are not substituted.`
        : null,
  };
}
