/**
 * Token universe: discovery → tracking → evaluation are separate concerns.
 *
 * - Discovery finds tokens.
 * - Tracking keeps them (and polls market data) until they are stale or too old.
 * - Evaluation is a per-tick compute budget over the tracked set, ranked by activity
 *   with a rotation share so lower-ranked tokens are not permanently starved.
 *
 * Pure functions only — DB access lives in universe/repository.ts.
 */
import type {
  AgeSource,
  LiquidityStatus,
  TokenLifecycleState,
  TradingEligibility,
} from '@memebot/shared';

export interface TokenAgeInput {
  poolCreatedAt: Date | null;
  firstObservedAt: Date | null;
  discoveredAt: Date;
}

export interface TokenAge {
  minutes: number;
  source: AgeSource;
  /** Timestamp the age is measured from */
  since: Date;
}

/**
 * Pool creation time is authoritative. First-observed time is only an age fallback —
 * it never decides whether a token stays tracked.
 */
export function tokenAge(input: TokenAgeInput, now: Date = new Date()): TokenAge {
  if (input.poolCreatedAt) {
    return {
      minutes: (now.getTime() - input.poolCreatedAt.getTime()) / 60_000,
      source: 'POOL_CREATED_AT',
      since: input.poolCreatedAt,
    };
  }
  const since = input.firstObservedAt ?? input.discoveredAt;
  return {
    minutes: (now.getTime() - since.getTime()) / 60_000,
    source: 'FIRST_OBSERVED_AT',
    since,
  };
}

const BONDING_CURVE_VENUES = new Set(['pumpfun', 'pump.fun', 'pumpdotfun', 'pump']);

/**
 * Pump.fun pre-migration tokens trade on a bonding curve, not an AMM pool, and
 * DexScreener reports no liquidity for them. A missing value is UNKNOWN — never zero.
 */
export function classifyLiquidity(opts: {
  venue: string | null | undefined;
  liquidityUsd: number | null | undefined;
}): LiquidityStatus {
  const venue = (opts.venue ?? '').toLowerCase();
  if (BONDING_CURVE_VENUES.has(venue)) return 'BONDING_CURVE';
  if (opts.liquidityUsd != null && Number.isFinite(opts.liquidityUsd) && opts.liquidityUsd > 0) {
    return 'KNOWN';
  }
  return 'UNKNOWN';
}

export function classifyTradingEligibility(liquidityStatus: LiquidityStatus): {
  eligibility: TradingEligibility;
  reasons: string[];
} {
  switch (liquidityStatus) {
    case 'KNOWN':
      return { eligibility: 'TRADING_ELIGIBLE', reasons: [] };
    case 'BONDING_CURVE':
      return {
        eligibility: 'RESEARCH_ONLY',
        reasons: ['pumpfun_bonding_curve_no_execution_model'],
      };
    default:
      return { eligibility: 'UNKNOWN', reasons: ['liquidity_unknown'] };
  }
}

export interface LifecycleInput {
  currentState: TokenLifecycleState;
  now: Date;
  discoveredAt: Date;
  ageMinutes: number;
  lastMarketAt: Date | null;
  lastEvaluatedAt: Date | null;
  eligibility: TradingEligibility;
  /** Price > 0, known liquidity at/above the lowest strategy minimum, some volume */
  basicDataOk: boolean;
  /** Open position / open shadow / pending opportunity — never archive these */
  hasOpenExposure: boolean;
  maxAgeHours: number;
  staleAfterSec: number;
  archiveStaleAfterMin: number;
  activeWindowSec: number;
}

export function deriveLifecycleState(i: LifecycleInput): TokenLifecycleState {
  const nowMs = i.now.getTime();
  const canArchive = !i.hasOpenExposure;

  if (i.currentState === 'ARCHIVED' && canArchive) return 'ARCHIVED';
  if (canArchive && i.ageMinutes > i.maxAgeHours * 60) return 'ARCHIVED';

  if (!i.lastMarketAt) {
    const sinceDiscoveryMin = (nowMs - i.discoveredAt.getTime()) / 60_000;
    if (canArchive && sinceDiscoveryMin > i.archiveStaleAfterMin) return 'ARCHIVED';
    return 'DISCOVERED';
  }

  const dataAgeSec = (nowMs - i.lastMarketAt.getTime()) / 1000;
  if (canArchive && dataAgeSec > i.archiveStaleAfterMin * 60) return 'ARCHIVED';
  if (dataAgeSec > i.staleAfterSec) return 'STALE';

  if (i.eligibility === 'TRADING_ELIGIBLE' && i.basicDataOk) {
    const recentlyEvaluated =
      i.lastEvaluatedAt != null && (nowMs - i.lastEvaluatedAt.getTime()) / 1000 <= i.activeWindowSec;
    return recentlyEvaluated ? 'ACTIVE' : 'ELIGIBLE';
  }
  return 'TRACKING';
}

/** Lowest liquidity minimum among production strategies (base gate). */
export const BASIC_MIN_LIQUIDITY_USD = 3000;

/** Enough data for a production strategy to evaluate the token at all. */
export function hasBasicTradingData(m: {
  priceUsd: number;
  liquidityStatus: LiquidityStatus;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
}): boolean {
  return (
    m.priceUsd > 0 &&
    m.liquidityStatus === 'KNOWN' &&
    m.liquidityUsd >= BASIC_MIN_LIQUIDITY_USD &&
    (m.volume5mUsd > 0 || m.volume1hUsd > 0)
  );
}

export interface ActivityInput {
  liquidityUsd: number | null;
  volume5mUsd: number;
  txCount5m: number;
  priceChange5mPct: number;
  volumeAccelCapped: number | null;
  dataAgeSec: number;
}

/** Heuristic priority for budget allocation only — not a trading signal. */
export function computeActivityScore(a: ActivityInput): number {
  const liq = a.liquidityUsd != null && a.liquidityUsd > 0 ? a.liquidityUsd : 0;
  let score =
    2 * Math.log10(1 + liq) +
    3 * Math.log10(1 + Math.max(0, a.volume5mUsd)) +
    1.5 * Math.log10(1 + Math.max(0, a.txCount5m)) +
    0.5 * Math.min(a.volumeAccelCapped ?? 0, 10) +
    Math.min(Math.abs(a.priceChange5mPct), 50) / 10;
  if (a.dataAgeSec > 60) score *= 0.5;
  return Math.round(score * 10_000) / 10_000;
}

export interface EvaluationCandidate {
  id: string;
  activityScore: number;
  lastEvaluatedAt: Date | null;
}

export interface Selected<T> {
  item: T;
  reason: 'must_include' | 'new' | 'priority' | 'rotation';
}

/**
 * Evaluation budget: top (1 - rotationShare) by activity, remainder from the
 * least-recently-evaluated so every tracked token eventually gets a turn.
 */
export function selectForEvaluation<T extends EvaluationCandidate>(
  candidates: T[],
  cap: number,
  rotationShare: number,
): Selected<T>[] {
  if (cap <= 0 || candidates.length === 0) return [];
  if (candidates.length <= cap) {
    return candidates.map((item) => ({ item, reason: 'priority' as const }));
  }
  const rotationCount = Math.floor(cap * Math.min(1, Math.max(0, rotationShare)));
  const priorityCount = cap - rotationCount;

  const byScore = [...candidates].sort(
    (a, b) => b.activityScore - a.activityScore || a.id.localeCompare(b.id),
  );
  const chosen = new Set<string>();
  const out: Selected<T>[] = [];
  for (const c of byScore) {
    if (out.length >= priorityCount) break;
    chosen.add(c.id);
    out.push({ item: c, reason: 'priority' });
  }
  const byStaleness = candidates
    .filter((c) => !chosen.has(c.id))
    .sort((a, b) => {
      const at = a.lastEvaluatedAt?.getTime() ?? 0;
      const bt = b.lastEvaluatedAt?.getTime() ?? 0;
      return at - bt || a.id.localeCompare(b.id);
    });
  for (const c of byStaleness) {
    if (out.length >= cap) break;
    out.push({ item: c, reason: 'rotation' });
  }
  return out;
}

export interface PollingCandidate {
  id: string;
  mustInclude: boolean;
  activityScore: number;
  lastPolledAt: Date | null;
}

/**
 * Market-data budget: exposures first, then never-polled tokens (new discoveries),
 * then half by activity and half by least-recently-polled.
 */
export function selectForPolling<T extends PollingCandidate>(candidates: T[], cap: number): Selected<T>[] {
  if (cap <= 0) return [];
  const out: Selected<T>[] = [];
  const chosen = new Set<string>();
  const take = (c: T, reason: Selected<T>['reason']) => {
    if (out.length >= cap || chosen.has(c.id)) return;
    chosen.add(c.id);
    out.push({ item: c, reason });
  };

  const byLastPolled = (a: T, b: T) =>
    (a.lastPolledAt?.getTime() ?? 0) - (b.lastPolledAt?.getTime() ?? 0) || a.id.localeCompare(b.id);

  for (const c of candidates.filter((x) => x.mustInclude).sort(byLastPolled)) take(c, 'must_include');

  const newLimit = out.length + Math.ceil(cap * 0.25);
  for (const c of candidates.filter((x) => !x.lastPolledAt)) {
    if (out.length >= newLimit) break;
    take(c, 'new');
  }

  const remaining = cap - out.length;
  const priorityLimit = out.length + Math.ceil(remaining / 2);
  for (const c of [...candidates].sort((a, b) => b.activityScore - a.activityScore || a.id.localeCompare(b.id))) {
    if (out.length >= priorityLimit) break;
    take(c, 'priority');
  }
  for (const c of [...candidates].sort(byLastPolled)) take(c, 'rotation');
  return out;
}
