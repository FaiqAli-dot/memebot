/**
 * Opportunity recorder: immutable snapshot of every meaningful candidate, then
 * forward outcomes at fixed horizons (what actually happened afterwards).
 *
 * Outcomes use only snapshots observed AFTER the opportunity (no look-ahead into
 * the decision) and are measured on mid prices. The SL/TP/trailing/max-hold path
 * is simulated with the paper exit rules in chronological order. Costs are not
 * deducted from horizon returns; `estNetReturnPct` subtracts the decision-time
 * round-trip cost estimate and is labelled as an estimate.
 */
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { initExitState, stepExit, type ExitParams, type ExitState } from './exit-sim.js';

export const OUTCOME_HORIZONS_SEC = [10, 30, 60, 180, 300, 600, 1200, 1800] as const;
const MAX_HORIZON_SEC = OUTCOME_HORIZONS_SEC[OUTCOME_HORIZONS_SEC.length - 1]!;

export interface OpportunityInput {
  tokenId: string;
  strategyId: string;
  strategyVersion?: string | null;
  decision: string;
  observedAt: Date;
  priceUsd: number;
  liquidityUsd: number | null;
  liquidityStatus: string;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number | null;
  sells5m: number | null;
  txCount5m: number;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  marketRegime: string | null;
  tokenAgeMin: number | null;
  ageSource: string;
  sinceFirstObservedSec: number | null;
  dataConfidence: string;
  buySellConfidence: string;
  volumeAccelRaw: number | null;
  volumeAccelCapped: number | null;
  volumeAccelConfidence: string;
  expectedValue: unknown;
  evNet: number | null;
  evThreshold: number | null;
  executionCostRate: number | null;
  executionCostUsd: number | null;
  positionSizeUsd: number | null;
  features: Record<string, unknown>;
  exitParams: ExitParams;
  cooldownSec: number;
}

/** Returns the new opportunity id, or null when inside the per token/strategy cooldown. */
export async function recordOpportunity(o: OpportunityInput): Promise<string | null> {
  const recent = await query(
    `SELECT 1 FROM opportunities
     WHERE token_id = $1 AND strategy_id = $2
       AND observed_at > $3::timestamptz - ($4::text || ' seconds')::interval
     LIMIT 1`,
    [o.tokenId, o.strategyId, o.observedAt, String(o.cooldownSec)],
  );
  if (recent.rows.length > 0) return null;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO opportunities (
      token_id, strategy_id, strategy_version, decision, observed_at, price_usd, liquidity_usd,
      liquidity_status, volume_5m_usd, volume_1h_usd, buys_5m, sells_5m, tx_count_5m,
      unique_buyers, unique_sellers, market_regime, token_age_min, age_source,
      since_first_observed_sec, data_confidence, buy_sell_confidence, volume_accel_raw,
      volume_accel_capped, volume_accel_confidence, expected_value, ev_net, ev_threshold,
      execution_cost_rate, execution_cost_usd, position_size_usd, features, sim_params, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
              $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
    RETURNING id`,
    [
      o.tokenId,
      o.strategyId,
      o.strategyVersion ?? null,
      o.decision,
      o.observedAt,
      o.priceUsd,
      o.liquidityUsd,
      o.liquidityStatus,
      o.volume5mUsd,
      o.volume1hUsd,
      o.buys5m,
      o.sells5m,
      o.txCount5m,
      o.uniqueBuyers,
      o.uniqueSellers,
      o.marketRegime,
      o.tokenAgeMin,
      o.ageSource,
      o.sinceFirstObservedSec,
      o.dataConfidence,
      o.buySellConfidence,
      finiteOrNull(o.volumeAccelRaw, 1e12),
      o.volumeAccelCapped,
      o.volumeAccelConfidence,
      JSON.stringify(o.expectedValue ?? null),
      o.evNet,
      o.evThreshold,
      o.executionCostRate,
      o.executionCostUsd,
      o.positionSizeUsd,
      JSON.stringify(o.features),
      JSON.stringify({ exit: o.exitParams, horizonsSec: OUTCOME_HORIZONS_SEC }),
      dataMode,
    ],
  );
  const id = rows[0]!.id;
  await query(
    `INSERT INTO opportunity_trackers (opportunity_id, token_id, status, sim_state)
     VALUES ($1, $2, 'PENDING', $3)`,
    [id, o.tokenId, JSON.stringify({ exit: initExitState(o.priceUsd, o.observedAt), missing: [] })],
  );
  return id;
}

function finiteOrNull(n: number | null, max: number): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.min(n, max);
}

export interface OutcomePoint {
  observedAt: Date;
  priceUsd: number;
  liquidityUsd: number | null;
  volume5mUsd: number;
}

export interface HorizonOutcome {
  horizonSec: number;
  observedAt: Date;
  lagSec: number;
  priceUsd: number;
  returnPct: number;
  liquidityUsd: number | null;
  volume5mUsd: number;
  mfePct: number;
  maePct: number;
  timeToMfeSec: number | null;
  timeToMaeSec: number | null;
}

/** Max lag allowed between the horizon target and the first snapshot at/after it. */
export function horizonTolerance(horizonSec: number): number {
  return Math.max(15, horizonSec * 0.5);
}

/**
 * Horizon outcome from points strictly after the entry: first point at/after the
 * target time (within tolerance), with MFE/MAE over all points up to it.
 * Returns 'pending' if that point may still arrive, 'missing' if it never can.
 */
export function computeHorizonOutcome(
  entry: { observedAt: Date; priceUsd: number },
  points: OutcomePoint[],
  horizonSec: number,
  now: Date,
): HorizonOutcome | 'pending' | 'missing' {
  const entryMs = entry.observedAt.getTime();
  const target = entryMs + horizonSec * 1000;
  const tol = horizonTolerance(horizonSec) * 1000;
  const after = points
    .filter((p) => p.observedAt.getTime() > entryMs)
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const hit = after.find((p) => p.observedAt.getTime() >= target);
  if (!hit) return now.getTime() > target + tol ? 'missing' : 'pending';
  if (hit.observedAt.getTime() - target > tol) return 'missing';

  let mfe = 0;
  let mae = 0;
  let tMfe: number | null = null;
  let tMae: number | null = null;
  for (const p of after) {
    if (p.observedAt.getTime() > hit.observedAt.getTime()) break;
    const r = ((p.priceUsd - entry.priceUsd) / entry.priceUsd) * 100;
    const t = Math.round((p.observedAt.getTime() - entryMs) / 1000);
    if (r > mfe) {
      mfe = r;
      tMfe = t;
    }
    if (r < mae) {
      mae = r;
      tMae = t;
    }
  }
  return {
    horizonSec,
    observedAt: hit.observedAt,
    lagSec: (hit.observedAt.getTime() - target) / 1000,
    priceUsd: hit.priceUsd,
    returnPct: ((hit.priceUsd - entry.priceUsd) / entry.priceUsd) * 100,
    liquidityUsd: hit.liquidityUsd,
    volume5mUsd: hit.volume5mUsd,
    mfePct: mfe,
    maePct: mae,
    timeToMfeSec: tMfe,
    timeToMaeSec: tMae,
  };
}

interface TrackerRow {
  opportunity_id: string;
  token_id: string;
  observed_at: Date;
  price_usd: string;
  execution_cost_rate: string | null;
  sim_params: { exit?: ExitParams };
  sim_state: { exit?: ExitState; missing?: number[] };
  done_horizons: number[] | null;
}

/** Process pending trackers: record due horizons, advance the SL/TP path, complete. */
export async function processOpportunityOutcomes(now = new Date()): Promise<{
  recorded: number;
  completed: number;
  pending: number;
}> {
  const { rows } = await query<TrackerRow>(
    `SELECT t.opportunity_id, t.token_id, o.observed_at, o.price_usd, o.execution_cost_rate,
            o.sim_params, t.sim_state,
            (SELECT array_agg(horizon_sec) FROM opportunity_outcomes oo
              WHERE oo.opportunity_id = t.opportunity_id) AS done_horizons
     FROM opportunity_trackers t JOIN opportunities o ON o.id = t.opportunity_id
     WHERE t.status = 'PENDING' AND o.data_mode = $1
     ORDER BY o.observed_at ASC
     LIMIT 500`,
    [dataMode],
  );
  if (rows.length === 0) return { recorded: 0, completed: 0, pending: 0 };

  const minObserved = rows.reduce((m, r) => Math.min(m, r.observed_at.getTime()), Number.POSITIVE_INFINITY);
  const { rows: snaps } = await query<{
    token_id: string;
    observed_at: Date;
    price_usd: string;
    liquidity_usd: string;
    liquidity_status: string | null;
    volume_5m_usd: string;
  }>(
    `SELECT token_id, observed_at, price_usd, liquidity_usd, liquidity_status, volume_5m_usd
     FROM market_snapshots
     WHERE token_id = ANY($1::uuid[]) AND observed_at > $2 AND observed_at <= $3
     ORDER BY observed_at ASC`,
    [[...new Set(rows.map((r) => r.token_id))], new Date(minObserved), now],
  );
  const byToken = new Map<string, OutcomePoint[]>();
  for (const s of snaps) {
    const list = byToken.get(s.token_id) ?? [];
    const known = s.liquidity_status == null || s.liquidity_status === 'KNOWN';
    list.push({
      observedAt: s.observed_at,
      priceUsd: Number(s.price_usd),
      liquidityUsd: known ? Number(s.liquidity_usd) : null,
      volume5mUsd: Number(s.volume_5m_usd),
    });
    byToken.set(s.token_id, list);
  }

  let recorded = 0;
  let completed = 0;
  for (const r of rows) {
    const entry = { observedAt: r.observed_at, priceUsd: Number(r.price_usd) };
    if (!(entry.priceUsd > 0)) continue;
    const endMs = entry.observedAt.getTime() + MAX_HORIZON_SEC * 1000;
    const points = (byToken.get(r.token_id) ?? []).filter(
      (p) => p.observedAt.getTime() > entry.observedAt.getTime() && p.observedAt.getTime() <= endMs + 60_000,
    );
    const done = new Set(r.done_horizons ?? []);
    const missing = new Set(r.sim_state.missing ?? []);

    for (const h of OUTCOME_HORIZONS_SEC) {
      if (done.has(h) || missing.has(h)) continue;
      const out = computeHorizonOutcome(entry, points, h, now);
      if (out === 'pending') continue;
      if (out === 'missing') {
        missing.add(h);
        continue;
      }
      await query(
        `INSERT INTO opportunity_outcomes (
          opportunity_id, horizon_sec, observed_at, lag_sec, price_usd, return_pct, liquidity_usd,
          volume_5m_usd, mfe_pct, mae_pct, time_to_mfe_sec, time_to_mae_sec
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (opportunity_id, horizon_sec) DO NOTHING`,
        [
          r.opportunity_id,
          h,
          out.observedAt,
          out.lagSec,
          out.priceUsd,
          out.returnPct,
          out.liquidityUsd,
          out.volume5mUsd,
          out.mfePct,
          out.maePct,
          out.timeToMfeSec,
          out.timeToMaeSec,
        ],
      );
      done.add(h);
      recorded++;
    }

    // SL/TP/trailing/max-hold path on mid prices, chronological
    let exit = r.sim_state.exit ?? initExitState(entry.priceUsd, entry.observedAt);
    const params = r.sim_params.exit;
    if (params) {
      for (const p of points) {
        if (exit.exited) break;
        exit = stepExit(exit, p, params);
      }
    }

    const allResolved = OUTCOME_HORIZONS_SEC.every((h) => done.has(h) || missing.has(h));
    const pathDone = !params || exit.exited || now.getTime() > endMs + 120_000;
    const isComplete = allResolved && pathDone;
    const costRate = r.execution_cost_rate != null ? Number(r.execution_cost_rate) : null;
    const exitReturnPct =
      exit.exited && exit.exitMidPriceUsd != null
        ? ((exit.exitMidPriceUsd - entry.priceUsd) / entry.priceUsd) * 100
        : null;
    const simResult = isComplete
      ? {
          exited: exit.exited,
          exitReason: exit.exitReason,
          exitAt: exit.exitAt,
          exitReturnPct,
          estNetReturnPct: exitReturnPct != null && costRate != null ? exitReturnPct - costRate * 100 : null,
          note: 'mid-price path; estNet subtracts decision-time round-trip cost estimate',
        }
      : null;

    await query(
      `UPDATE opportunity_trackers SET
         status = $2, last_processed_at = $3, sim_state = $4, sim_result = $5,
         mfe_pct = $6, mae_pct = $7, time_to_mfe_sec = $8, time_to_mae_sec = $9,
         completed_at = CASE WHEN $2 = 'COMPLETE' THEN NOW() ELSE completed_at END
       WHERE opportunity_id = $1`,
      [
        r.opportunity_id,
        isComplete ? 'COMPLETE' : 'PENDING',
        now,
        JSON.stringify({ exit, missing: [...missing] }),
        simResult ? JSON.stringify(simResult) : null,
        exit.mfePct,
        exit.maePct,
        exit.timeToMfeSec,
        exit.timeToMaeSec,
      ],
    );
    if (isComplete) completed++;
  }
  return { recorded, completed, pending: rows.length - completed };
}
