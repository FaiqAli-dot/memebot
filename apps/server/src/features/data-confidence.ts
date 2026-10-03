/**
 * Evidence-based data confidence. Replaces the hard-coded LOW classifications.
 *
 * LOW is a valid answer — but only when the data actually is insufficient.
 * HIGH additionally requires agreement between independent providers; with a single
 * market-data provider the best achievable level is MEDIUM.
 */
import type { AgeSource, ConfidenceLevel, LiquidityStatus } from '@memebot/shared';

export interface ConfidenceCheck {
  key: string;
  ok: boolean;
  critical: boolean;
  detail: string;
}

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  checks: ConfidenceCheck[];
  reasons: string[];
}

export interface DataConfidenceInput {
  liquidityStatus: LiquidityStatus;
  liquidityUsd: number | null;
  snapshotAgeSec: number;
  staleAfterSec: number;
  volume5mUsd: number;
  volume1hUsd: number;
  txCount5m: number;
  buys5m: number | null;
  sells5m: number | null;
  ageSource: AgeSource;
  observations10m: number;
  volumeAccelConfidence: ConfidenceLevel;
  /** Independent providers whose prices agree; 1 when only one provider is used */
  agreeingProviders: number;
}

const RECENT_SNAPSHOT_SEC = 20;
const MIN_OBSERVATIONS = 3;
const RICH_OBSERVATIONS = 6;
const MIN_TX_FOR_COUNTS = 10;

export function assessDataConfidence(i: DataConfidenceInput): ConfidenceAssessment {
  const checks: ConfidenceCheck[] = [
    {
      key: 'liquidity_known',
      critical: true,
      ok: i.liquidityStatus === 'KNOWN' && (i.liquidityUsd ?? 0) > 0,
      detail: `liquidity ${i.liquidityStatus}`,
    },
    {
      key: 'snapshot_fresh',
      critical: true,
      ok: i.snapshotAgeSec <= i.staleAfterSec,
      detail: `price/liquidity ${Math.round(i.snapshotAgeSec)}s old (max ${i.staleAfterSec}s)`,
    },
    {
      key: 'volume_available',
      critical: true,
      ok: i.volume5mUsd > 0 || i.volume1hUsd > 0,
      detail: `5m $${Math.round(i.volume5mUsd)}, 1h $${Math.round(i.volume1hUsd)}`,
    },
    {
      key: 'min_observations',
      critical: true,
      ok: i.observations10m >= MIN_OBSERVATIONS,
      detail: `${i.observations10m} snapshots in 10m (min ${MIN_OBSERVATIONS})`,
    },
    {
      key: 'snapshot_recent',
      critical: false,
      ok: i.snapshotAgeSec <= RECENT_SNAPSHOT_SEC,
      detail: `${Math.round(i.snapshotAgeSec)}s old (recent <= ${RECENT_SNAPSHOT_SEC}s)`,
    },
    {
      key: 'tx_counts_available',
      critical: false,
      ok: i.buys5m != null && i.sells5m != null && i.txCount5m >= MIN_TX_FOR_COUNTS,
      detail: `buys ${i.buys5m ?? '?'} / sells ${i.sells5m ?? '?'} in 5m`,
    },
    {
      key: 'age_authoritative',
      critical: false,
      ok: i.ageSource === 'POOL_CREATED_AT',
      detail: `age from ${i.ageSource}`,
    },
    {
      key: 'observations_rich',
      critical: false,
      ok: i.observations10m >= RICH_OBSERVATIONS,
      detail: `${i.observations10m} snapshots in 10m (rich >= ${RICH_OBSERVATIONS})`,
    },
    {
      key: 'acceleration_measured',
      critical: false,
      ok: i.volumeAccelConfidence !== 'UNKNOWN',
      detail: `volume acceleration confidence ${i.volumeAccelConfidence}`,
    },
    {
      key: 'provider_agreement',
      critical: false,
      ok: i.agreeingProviders >= 2,
      detail: `${i.agreeingProviders} agreeing provider(s)`,
    },
  ];

  const failedCritical = checks.filter((c) => c.critical && !c.ok);
  const secondary = checks.filter((c) => !c.critical);
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.key}_failed`);

  let level: ConfidenceLevel;
  if (failedCritical.length > 0) {
    level = 'LOW';
  } else if (secondary.every((c) => c.ok)) {
    level = 'HIGH';
  } else {
    const nonProvider = secondary.filter((c) => c.key !== 'provider_agreement');
    level = nonProvider.filter((c) => c.ok).length >= 3 ? 'MEDIUM' : 'LOW';
  }
  return { level, checks, reasons };
}

export interface BuySellConfidenceInput {
  buys5m: number | null;
  sells5m: number | null;
  buys1h: number | null;
  sells1h: number | null;
  txCount5m: number;
  snapshotAgeSec: number;
  staleAfterSec: number;
}

/**
 * Buy/sell evidence quality. Provider buy/sell *volume* is inferred from transaction
 * counts (equal-size assumption), so this never exceeds MEDIUM.
 */
export function assessBuySellConfidence(i: BuySellConfidenceInput): {
  level: ConfidenceLevel;
  reasons: string[];
} {
  if (i.buys5m == null || i.sells5m == null) {
    return { level: 'LOW', reasons: ['counts_unavailable'] };
  }
  if (i.snapshotAgeSec > i.staleAfterSec) return { level: 'LOW', reasons: ['stale_snapshot'] };
  if (i.txCount5m < 15) return { level: 'LOW', reasons: ['too_few_transactions'] };
  if (i.buys5m < 3 || i.sells5m < 3) return { level: 'LOW', reasons: ['one_sided_sample'] };

  const reasons = ['volume_split_inferred_from_counts'];
  let consistent = true;
  if (i.buys1h != null && i.sells1h != null && i.sells1h > 0) {
    const r5 = i.buys5m / i.sells5m;
    const r1h = i.buys1h / i.sells1h;
    consistent = (r5 >= 1) === (r1h >= 1) || Math.abs(r5 - r1h) / r1h <= 0.25;
    if (!consistent) reasons.push('5m_1h_direction_disagrees');
  } else {
    consistent = false;
    reasons.push('no_1h_counts');
  }
  if (i.txCount5m >= 30 && consistent) return { level: 'MEDIUM', reasons };
  return { level: 'LOW', reasons: [...reasons, 'insufficient_sample'] };
}
