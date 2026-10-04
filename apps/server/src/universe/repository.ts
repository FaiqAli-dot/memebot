/**
 * Token universe persistence: tracking set, polling budget bookkeeping, lifecycle
 * transitions, evaluation candidates. Decisions live in universe/lifecycle.ts.
 */
import type { LiquidityStatus, TokenLifecycleState, TradingEligibility } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { deriveLifecycleState, tokenAge } from './lifecycle.js';

export interface TrackedTokenRow {
  id: string;
  address: string;
  symbol: string;
  chain: string;
  discovered_at: Date;
  first_observed_at: Date | null;
  pool_created_at: Date | null;
  created_at_onchain: Date | null;
  lifecycle_state: TokenLifecycleState;
  activity_score: number;
  last_polled_at: Date | null;
  last_market_at: Date | null;
  last_evaluated_at: Date | null;
  liquidity_status: LiquidityStatus;
  trading_eligibility: TradingEligibility;
  discovery_source: string | null;
  age_source: string | null;
}

const TRACKED_COLUMNS = `id, address, symbol, chain, discovered_at, first_observed_at, pool_created_at,
  created_at_onchain, lifecycle_state, activity_score::float8 AS activity_score, last_polled_at,
  last_market_at, last_evaluated_at, liquidity_status, trading_eligibility, discovery_source, age_source`;

/** Tokens with an open position (any portfolio), open shadow, or pending opportunity tracker. */
export async function getExposureTokenIds(): Promise<Set<string>> {
  const { rows } = await query<{ token_id: string }>(
    `SELECT token_id FROM positions WHERE status = 'OPEN'
     UNION SELECT token_id FROM shadow_trades WHERE status = 'OPEN' AND data_mode = $1
     UNION SELECT token_id FROM opportunity_trackers WHERE status = 'PENDING'`,
    [dataMode],
  );
  return new Set(rows.map((r) => r.token_id));
}

/** Non-archived tracked tokens, plus any archived token that still has exposure. */
export async function listTrackedTokens(exposures: Set<string>): Promise<TrackedTokenRow[]> {
  const { rows } = await query<TrackedTokenRow>(
    `SELECT ${TRACKED_COLUMNS} FROM tokens
     WHERE data_mode = $1 AND (lifecycle_state <> 'ARCHIVED' OR id = ANY($2::uuid[]))`,
    [dataMode, [...exposures]],
  );
  return rows;
}

export async function listEvaluationCandidates(staleAfterSec: number): Promise<TrackedTokenRow[]> {
  const { rows } = await query<TrackedTokenRow>(
    `SELECT ${TRACKED_COLUMNS} FROM tokens
     WHERE data_mode = $1
       AND lifecycle_state IN ('ELIGIBLE','ACTIVE')
       AND last_market_at > NOW() - ($2::text || ' seconds')::interval`,
    [dataMode, String(staleAfterSec)],
  );
  return rows;
}

export async function getTrackedToken(tokenId: string): Promise<TrackedTokenRow | null> {
  const { rows } = await query<TrackedTokenRow>(
    `SELECT ${TRACKED_COLUMNS} FROM tokens WHERE id = $1 AND data_mode = $2`,
    [tokenId, dataMode],
  );
  return rows[0] ?? null;
}

export async function applyQuoteToToken(opts: {
  tokenId: string;
  observedAt: Date;
  liquidityStatus: LiquidityStatus;
  eligibility: TradingEligibility;
  eligibilityReasons: string[];
  activityScore: number;
  basicDataOk: boolean;
  poolCreatedAt: Date | null;
  venue: string | null;
}): Promise<void> {
  const target: TokenLifecycleState =
    opts.eligibility === 'TRADING_ELIGIBLE' && opts.basicDataOk ? 'ELIGIBLE' : 'TRACKING';
  await query(
    `UPDATE tokens SET
       last_polled_at = NOW(),
       last_market_at = $2,
       missing_quote_count = 0,
       migration_at = CASE
         WHEN migration_at IS NULL AND liquidity_status = 'BONDING_CURVE' AND $3 = 'KNOWN' THEN $2
         ELSE migration_at END,
       liquidity_status = $3,
       trading_eligibility = $4,
       eligibility_reasons = $5::jsonb,
       activity_score = $6,
       pool_created_at = COALESCE(pool_created_at, $7),
       age_source = CASE WHEN COALESCE(pool_created_at, $7) IS NOT NULL THEN 'POOL_CREATED_AT'
                         ELSE 'FIRST_OBSERVED_AT' END,
       dex_venue = COALESCE($8, dex_venue),
       lifecycle_state = CASE
         WHEN $9 = 'ELIGIBLE' AND lifecycle_state = 'ACTIVE' THEN 'ACTIVE'
         ELSE $9 END,
       lifecycle_changed_at = CASE
         WHEN lifecycle_state = $9 OR ($9 = 'ELIGIBLE' AND lifecycle_state = 'ACTIVE')
           THEN lifecycle_changed_at ELSE NOW() END
     WHERE id = $1`,
    [
      opts.tokenId,
      opts.observedAt,
      opts.liquidityStatus,
      opts.eligibility,
      JSON.stringify(opts.eligibilityReasons),
      opts.activityScore,
      opts.poolCreatedAt,
      opts.venue,
      target,
    ],
  );
}

export async function markPolledWithoutQuote(tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  await query(
    `UPDATE tokens SET last_polled_at = NOW(), missing_quote_count = missing_quote_count + 1
     WHERE id = ANY($1::uuid[])`,
    [tokenIds],
  );
}

export async function markEvaluated(tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  await query(
    `UPDATE tokens SET
       last_evaluated_at = NOW(),
       lifecycle_changed_at = CASE WHEN lifecycle_state = 'ELIGIBLE' THEN NOW() ELSE lifecycle_changed_at END,
       lifecycle_state = CASE WHEN lifecycle_state = 'ELIGIBLE' THEN 'ACTIVE' ELSE lifecycle_state END
     WHERE id = ANY($1::uuid[])`,
    [tokenIds],
  );
}

export interface LifecycleConfig {
  maxAgeHours: number;
  staleAfterSec: number;
  archiveStaleAfterMin: number;
  activeWindowSec: number;
  trackingCap: number;
}

export interface LifecycleTickResult {
  examined: number;
  transitions: Record<string, number>;
  archivedByCap: number;
}

/** Time-based transitions (STALE / ARCHIVED / ACTIVE→ELIGIBLE) and tracking-cap enforcement. */
export async function runLifecycleTick(cfg: LifecycleConfig, now = new Date()): Promise<LifecycleTickResult> {
  const exposures = await getExposureTokenIds();
  const tokens = await listTrackedTokens(exposures);
  const byTarget = new Map<TokenLifecycleState, string[]>();
  const transitions: Record<string, number> = {};

  for (const t of tokens) {
    const age = tokenAge(
      {
        poolCreatedAt: t.pool_created_at ?? t.created_at_onchain,
        firstObservedAt: t.first_observed_at,
        discoveredAt: t.discovered_at,
      },
      now,
    );
    const next = deriveLifecycleState({
      currentState: t.lifecycle_state,
      now,
      discoveredAt: t.discovered_at,
      ageMinutes: age.minutes,
      lastMarketAt: t.last_market_at,
      lastEvaluatedAt: t.last_evaluated_at,
      eligibility: t.trading_eligibility,
      basicDataOk: t.lifecycle_state === 'ELIGIBLE' || t.lifecycle_state === 'ACTIVE',
      hasOpenExposure: exposures.has(t.id),
      maxAgeHours: cfg.maxAgeHours,
      staleAfterSec: cfg.staleAfterSec,
      archiveStaleAfterMin: cfg.archiveStaleAfterMin,
      activeWindowSec: cfg.activeWindowSec,
    });
    if (next === t.lifecycle_state) continue;
    const list = byTarget.get(next) ?? [];
    list.push(t.id);
    byTarget.set(next, list);
    const key = `${t.lifecycle_state}->${next}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
  }

  for (const [state, ids] of byTarget) {
    await query(
      `UPDATE tokens SET lifecycle_state = $2, lifecycle_changed_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids, state],
    );
  }

  // Tracking cap: archive the least active, least recently priced tokens without exposure
  const { rows: cnt } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM tokens WHERE data_mode = $1 AND lifecycle_state <> 'ARCHIVED'`,
    [dataMode],
  );
  const excess = Number(cnt[0]?.n ?? 0) - cfg.trackingCap;
  let archivedByCap = 0;
  if (excess > 0) {
    const res = await query(
      `UPDATE tokens SET lifecycle_state = 'ARCHIVED', lifecycle_changed_at = NOW()
       WHERE id IN (
         SELECT id FROM tokens
         WHERE data_mode = $1 AND lifecycle_state <> 'ARCHIVED' AND NOT (id = ANY($2::uuid[]))
         ORDER BY activity_score ASC, last_market_at ASC NULLS FIRST, discovered_at ASC
         LIMIT $3
       )`,
      [dataMode, [...exposures], excess],
    );
    archivedByCap = res.rowCount ?? 0;
  }

  return { examined: tokens.length, transitions, archivedByCap };
}

export interface UniverseCounts {
  byState: Record<string, number>;
  byLiquidityStatus: Record<string, number>;
  byEligibility: Record<string, number>;
  tracked: number;
  discoveredLast10m: number;
  freshMarketData: number;
}

/** Highest-activity tracked tokens (for auxiliary jobs: holders, safety, flow, regime). */
export async function listTopActiveTokens(
  limit: number,
  states: TokenLifecycleState[] = ['ELIGIBLE', 'ACTIVE', 'TRACKING'],
): Promise<TrackedTokenRow[]> {
  const { rows } = await query<TrackedTokenRow>(
    `SELECT ${TRACKED_COLUMNS} FROM tokens
     WHERE data_mode = $1 AND lifecycle_state = ANY($2::text[])
     ORDER BY activity_score DESC, last_market_at DESC NULLS LAST
     LIMIT $3`,
    [dataMode, states, limit],
  );
  return rows;
}

export async function getUniverseCounts(staleAfterSec = 300): Promise<UniverseCounts> {
  const { rows } = await query<{
    lifecycle_state: string;
    liquidity_status: string;
    trading_eligibility: string;
    n: string;
  }>(
    `SELECT lifecycle_state, liquidity_status, trading_eligibility, COUNT(*) AS n
     FROM tokens WHERE data_mode = $1
     GROUP BY lifecycle_state, liquidity_status, trading_eligibility`,
    [dataMode],
  );
  const byState: Record<string, number> = {};
  const byLiquidityStatus: Record<string, number> = {};
  const byEligibility: Record<string, number> = {};
  let tracked = 0;
  for (const r of rows) {
    const n = Number(r.n);
    byState[r.lifecycle_state] = (byState[r.lifecycle_state] ?? 0) + n;
    if (r.lifecycle_state === 'ARCHIVED') continue;
    tracked += n;
    byLiquidityStatus[r.liquidity_status] = (byLiquidityStatus[r.liquidity_status] ?? 0) + n;
    byEligibility[r.trading_eligibility] = (byEligibility[r.trading_eligibility] ?? 0) + n;
  }
  const { rows: d } = await query<{ discovered: string; fresh: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE discovered_at > NOW() - INTERVAL '10 minutes') AS discovered,
       COUNT(*) FILTER (WHERE lifecycle_state <> 'ARCHIVED'
                          AND last_market_at > NOW() - ($2::text || ' seconds')::interval) AS fresh
     FROM tokens WHERE data_mode = $1`,
    [dataMode, String(staleAfterSec)],
  );
  return {
    byState,
    byLiquidityStatus,
    byEligibility,
    tracked,
    discoveredLast10m: Number(d[0]?.discovered ?? 0),
    freshMarketData: Number(d[0]?.fresh ?? 0),
  };
}
