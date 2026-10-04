/**
 * Shadow trading — hypothetical trades for rejected (or research) opportunities.
 *
 * Identity: one OPEN shadow per (portfolio, token, strategy), enforced by a partial
 * unique index plus a re-entry cooldown, so repeated evaluations of the same token
 * do not create duplicate shadows.
 *
 * Realism: entry/exit use the same realistic execution simulator as paper trades
 * (DEX fee, impact, slippage, network + priority + Jito, latency, failures), and the
 * exit path uses the paper exit rules (SL / TP / trailing / max hold / liquidity).
 * Shadow P&L is NET of all simulated costs. Shadows never touch any portfolio cash.
 */
import { v4 as uuid } from 'uuid';
import type { RealismProfile, RejectionReason } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode, env } from '../config/env.js';
import { researchWrite, researchWritesAllowed } from '../db/storage-guard.js';
import { WriteDedupe } from '../db/write-dedupe.js';
import { SeededRng } from '../domain/seeded-rng.js';
import { simulateRealisticTrade, type RealisticSimResult } from '../execution/realism.js';
import { sellProceedsUsd } from '../engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../providers/types.js';
import {
  closeForMissingData,
  initExitState,
  stepExit,
  type ExitParams,
  type ExitState,
  type PathPoint,
} from './exit-sim.js';

export const SHADOW_SIM_VERSION = 'shadow-v2';
const MAX_EXIT_ATTEMPTS = 3;

/** Deterministic 32-bit FNV-1a seed from identity parts. */
export function seedFrom(...parts: string[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface ExecutionSettings {
  profile: RealismProfile;
  priorityFeeLamports: number;
  jitoTipLamports: number;
  failedTxStillChargesNetwork: boolean;
}

export interface ShadowSimInput extends ExecutionSettings {
  quote: MarketQuote;
  gas: GasFeeEstimate;
  positionSizeUsd: number;
  exit: ExitParams;
  quoteAgeMs: number;
}

export interface ShadowOpenInput {
  portfolioId: string;
  tokenId: string;
  signalId?: string | null;
  strategyId?: string | null;
  rejectionReason: RejectionReason;
  rejectionDetails?: Record<string, unknown>;
  journal?: Record<string, unknown>;
  opportunityKey?: string | null;
  cooldownSec: number;
  sim: ShadowSimInput;
  now?: Date;
}

export type ShadowOpenResult =
  | { status: 'OPENED' | 'ENTRY_FAILED'; id: string }
  | { status: 'COOLDOWN' | 'STORAGE_PAUSED'; id: null };

interface StoredPoint {
  observedAt: string;
  priceUsd: number;
  liquidityUsd: number | null;
  venue: string | null;
  priceChange5mPct: number;
}

interface ShadowJournal {
  exitParams: ExitParams;
  exitState: ExitState;
  lastPoint: StoredPoint;
  exitPoint?: StoredPoint;
  seed: number;
  [k: string]: unknown;
}

export async function openShadowTrade(input: ShadowOpenInput): Promise<ShadowOpenResult> {
  if (!researchWritesAllowed()) return { status: 'STORAGE_PAUSED', id: null };
  const strategyKey = input.strategyId ?? '-';
  const now = input.now ?? new Date();
  const recent = await query(
    `SELECT 1 FROM shadow_trades
     WHERE portfolio_id = $1 AND token_id = $2 AND strategy_key = $3
       AND (status = 'OPEN' OR opened_at > $4::timestamptz - ($5::text || ' seconds')::interval)
     LIMIT 1`,
    [input.portfolioId, input.tokenId, strategyKey, now, String(input.cooldownSec)],
  );
  if (recent.rows.length > 0) return { status: 'COOLDOWN', id: null };

  const s = input.sim;
  const seed = seedFrom(input.portfolioId, input.tokenId, strategyKey, now.toISOString());
  const entry = simulateRealisticTrade({
    side: 'BUY',
    requestedAmountUsd: s.positionSizeUsd,
    midPriceUsd: s.quote.priceUsd,
    quote: s.quote,
    gas: s.gas,
    priorityFeeLamports: s.priorityFeeLamports,
    failedTxStillChargesNetwork: s.failedTxStillChargesNetwork,
    profile: s.profile,
    rng: new SeededRng(seed),
    jitoTipLamports: s.jitoTipLamports,
    quoteAgeMs: s.quoteAgeMs,
  });

  const id = uuid();
  const failed = entry.execution.failed;
  const costBasis = failed
    ? entry.costs.totalCostUsd
    : entry.execution.filledAmountUsd + entry.costs.networkFeeUsd + entry.costs.priorityFeeUsd;
  const point: StoredPoint = {
    observedAt: s.quote.observedAt.toISOString(),
    priceUsd: s.quote.priceUsd,
    liquidityUsd: s.quote.liquidityUsd,
    venue: s.quote.venue ?? null,
    priceChange5mPct: s.quote.priceChange5mPct,
  };
  const journal: ShadowJournal = {
    ...(input.journal ?? {}),
    exitParams: s.exit,
    exitState: initExitState(entry.execution.executedPriceUsd || s.quote.priceUsd, now),
    lastPoint: point,
    seed,
    latency: entry.latency,
  };

  const res = await query(
    `INSERT INTO shadow_trades (
      id, portfolio_id, token_id, signal_id, strategy_id, strategy_key, opportunity_key,
      rejection_reason, rejection_details,
      hypothetical_entry_price_usd, hypothetical_size_usd, hypothetical_cost_usd,
      position_size_usd, quantity, entry_exec_price_usd, cost_basis_usd, entry_costs,
      stop_loss_pct, take_profit_pct, trailing_stop_pct, max_hold_sec, highest_price_usd,
      status, opened_at, closed_at, net_pnl_usd, net_return_pct, failure_mode, latency_ms,
      last_processed_at, sim_version, journal, data_mode
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
      $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33
    )
    ON CONFLICT (portfolio_id, token_id, strategy_key) WHERE status = 'OPEN' DO NOTHING`,
    [
      id,
      input.portfolioId,
      input.tokenId,
      input.signalId ?? null,
      input.strategyId ?? null,
      strategyKey,
      input.opportunityKey ?? null,
      input.rejectionReason,
      JSON.stringify(input.rejectionDetails ?? {}),
      s.quote.priceUsd,
      s.positionSizeUsd,
      entry.costs.totalCostUsd,
      s.positionSizeUsd,
      failed ? 0 : entry.execution.tokenQuantity,
      failed ? null : entry.execution.executedPriceUsd,
      costBasis,
      JSON.stringify(entry.costs),
      s.exit.stopLossPct,
      s.exit.takeProfitPct,
      s.exit.trailingStopPct,
      s.exit.maxHoldSec,
      failed ? null : entry.execution.executedPriceUsd,
      failed ? 'ENTRY_FAILED' : 'OPEN',
      now,
      failed ? now : null,
      failed ? -costBasis : null,
      failed ? (s.positionSizeUsd > 0 ? (-costBasis / s.positionSizeUsd) * 100 : 0) : null,
      entry.failureMode ?? (failed ? entry.execution.failureReason : null),
      entry.latency.totalMs,
      now,
      SHADOW_SIM_VERSION,
      JSON.stringify(journal),
      dataMode,
    ],
  );
  if ((res.rowCount ?? 0) === 0) return { status: 'COOLDOWN', id: null };
  return { status: failed ? 'ENTRY_FAILED' : 'OPENED', id };
}

interface OpenShadowRow {
  id: string;
  token_id: string;
  opened_at: Date;
  hypothetical_entry_price_usd: string | null;
  quantity: string | null;
  cost_basis_usd: string | null;
  last_processed_at: Date | null;
  sim_version: string | null;
  journal: Partial<ShadowJournal>;
}

interface SnapshotPointRow {
  token_id: string;
  observed_at: Date;
  price_usd: string;
  liquidity_usd: string;
  liquidity_status: string | null;
  venue: string | null;
  price_change_5m_pct: string;
}

function toPathPoint(r: SnapshotPointRow): PathPoint {
  const known = r.liquidity_status == null || r.liquidity_status === 'KNOWN';
  return {
    observedAt: r.observed_at,
    priceUsd: Number(r.price_usd),
    liquidityUsd: known ? Number(r.liquidity_usd) : null,
  };
}

function toStoredPoint(r: SnapshotPointRow): StoredPoint {
  return {
    observedAt: r.observed_at.toISOString(),
    priceUsd: Number(r.price_usd),
    liquidityUsd: Number(r.liquidity_usd),
    venue: r.venue,
    priceChange5mPct: Number(r.price_change_5m_pct),
  };
}

function quoteFromPoint(p: StoredPoint, midPriceUsd: number): MarketQuote {
  const liq = p.liquidityUsd ?? 0;
  return {
    chain: 'solana',
    address: '',
    priceUsd: midPriceUsd,
    marketCapUsd: null,
    volume5mUsd: 0,
    volume1hUsd: 0,
    volume24hUsd: 0,
    buyVolume5mUsd: 0,
    sellVolume5mUsd: 0,
    txCount5m: 0,
    priceChange5mPct: p.priceChange5mPct,
    priceChange1hPct: 0,
    liquidityUsd: liq,
    observedAt: new Date(p.observedAt),
    venue: p.venue,
    feeBps: null,
    quoteReserve: liq > 0 ? liq / 2 : null,
  };
}

/** Simulate the exit sale; retries random execution failures, charging their network costs. */
export function simulateShadowExit(opts: {
  quantity: number;
  exitMidPriceUsd: number;
  point: StoredPoint;
  gas: GasFeeEstimate;
  exec: ExecutionSettings;
  seed: number;
}): { sim: RealisticSimResult; proceedsUsd: number; attempts: number; failedCostUsd: number } | null {
  const rng = new SeededRng(opts.seed);
  const quote = quoteFromPoint(opts.point, opts.exitMidPriceUsd);
  let failedCostUsd = 0;
  for (let attempt = 1; attempt <= MAX_EXIT_ATTEMPTS; attempt++) {
    const sim = simulateRealisticTrade({
      side: 'SELL',
      requestedAmountUsd: opts.quantity * opts.exitMidPriceUsd,
      midPriceUsd: opts.exitMidPriceUsd,
      quote,
      gas: opts.gas,
      priorityFeeLamports: opts.exec.priorityFeeLamports,
      failedTxStillChargesNetwork: opts.exec.failedTxStillChargesNetwork,
      profile: opts.exec.profile,
      rng,
      jitoTipLamports: opts.exec.jitoTipLamports,
      quoteAgeMs: 0,
    });
    if (!sim.execution.failed) {
      return { sim, proceedsUsd: sellProceedsUsd(sim) - failedCostUsd, attempts: attempt, failedCostUsd };
    }
    // SOL/USD unusable: cannot price the exit — defer, do not invent costs
    if (!sim.failureMode) return null;
    failedCostUsd += sim.costs.totalCostUsd;
  }
  return null;
}

/**
 * Advance all OPEN shadow trades through the snapshots observed since their last
 * processed point (chronological, no look-ahead) and close those whose exit rule fired.
 */
export async function updateOpenShadowTrades(opts: {
  gas: GasFeeEstimate;
  exec: ExecutionSettings;
  now?: Date;
}): Promise<{ updated: number; closed: number; legacyClosed: number }> {
  const now = opts.now ?? new Date();
  const legacy = await query(
    `UPDATE shadow_trades SET status = 'LEGACY_CLOSED', closed_at = NOW()
     WHERE status = 'OPEN' AND data_mode = $1 AND (sim_version IS NULL OR sim_version <> $2)`,
    [dataMode, SHADOW_SIM_VERSION],
  );

  const { rows } = await query<OpenShadowRow>(
    `SELECT id, token_id, opened_at, hypothetical_entry_price_usd, quantity, cost_basis_usd,
            last_processed_at, sim_version, journal
     FROM shadow_trades WHERE status = 'OPEN' AND data_mode = $1 AND sim_version = $2`,
    [dataMode, SHADOW_SIM_VERSION],
  );
  if (rows.length === 0) return { updated: 0, closed: 0, legacyClosed: legacy.rowCount ?? 0 };

  const since = rows.reduce(
    (min, r) => Math.min(min, (r.last_processed_at ?? r.opened_at).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const { rows: points } = await query<SnapshotPointRow>(
    `SELECT token_id, observed_at, price_usd, liquidity_usd, liquidity_status, venue, price_change_5m_pct
     FROM market_snapshots
     WHERE token_id = ANY($1::uuid[]) AND observed_at > $2 AND observed_at <= $3
     ORDER BY observed_at ASC`,
    [[...new Set(rows.map((r) => r.token_id))], new Date(since), now],
  );
  const byToken = new Map<string, SnapshotPointRow[]>();
  for (const p of points) {
    const list = byToken.get(p.token_id) ?? [];
    list.push(p);
    byToken.set(p.token_id, list);
  }

  let updated = 0;
  let closed = 0;
  for (const row of rows) {
    const j = row.journal;
    if (!j.exitParams || !j.exitState || !j.lastPoint) continue;
    let state = j.exitState;
    let lastPoint = j.lastPoint;
    let exitPoint = j.exitPoint;
    const fromMs = (row.last_processed_at ?? row.opened_at).getTime();
    for (const p of byToken.get(row.token_id) ?? []) {
      if (p.observed_at.getTime() <= fromMs) continue;
      if (state.exited) break;
      state = stepExit(state, toPathPoint(p), j.exitParams);
      lastPoint = toStoredPoint(p);
      if (state.exited) exitPoint = lastPoint;
    }
    if (!state.exited) {
      state = closeForMissingData(state, now, j.exitParams);
      if (state.exited) exitPoint = lastPoint;
    }

    const journal = { ...j, exitState: state, lastPoint, exitPoint };
    if (!state.exited || !exitPoint || state.exitMidPriceUsd == null) {
      await query(
        `UPDATE shadow_trades SET
           mfe_pct = $2, mae_pct = $3, time_to_peak_sec = $4, time_to_failure_sec = $5,
           highest_price_usd = $6, last_processed_at = $7, journal = $8
         WHERE id = $1`,
        [
          row.id,
          state.mfePct,
          state.maePct,
          state.timeToMfeSec,
          state.timeToMaeSec,
          state.highestPriceUsd,
          state.lastProcessedAt ?? row.last_processed_at,
          JSON.stringify(journal),
        ],
      );
      updated++;
      continue;
    }

    const quantity = Number(row.quantity ?? 0);
    const costBasis = Number(row.cost_basis_usd ?? 0);
    const entryMid = Number(row.hypothetical_entry_price_usd ?? 0);
    const exit = simulateShadowExit({
      quantity,
      exitMidPriceUsd: state.exitMidPriceUsd,
      point: exitPoint,
      gas: opts.gas,
      exec: opts.exec,
      seed: seedFrom(row.id, 'exit'),
    });
    if (!exit) {
      // Exit decided but cannot be priced yet (fees unusable); retry next tick at the same mid
      await query(`UPDATE shadow_trades SET journal = $2, last_processed_at = $3 WHERE id = $1`, [
        row.id,
        JSON.stringify(journal),
        state.lastProcessedAt ?? row.last_processed_at,
      ]);
      updated++;
      continue;
    }

    const netPnl = exit.proceedsUsd - costBasis;
    const grossReturnPct = entryMid > 0 ? ((state.exitMidPriceUsd - entryMid) / entryMid) * 100 : 0;
    const collapsed = state.exitReason === 'emergency_liquidity_collapse';
    await query(
      `UPDATE shadow_trades SET
         status = $2, exit_reason = $3, hypothetical_exit_price_usd = $4, exit_costs = $5,
         net_pnl_usd = $6, net_return_pct = $7, gross_return_pct = $8, eventual_return_pct = $8,
         mfe_pct = $9, mae_pct = $10, time_to_peak_sec = $11, time_to_failure_sec = $12,
         liquidity_collapsed = $13, highest_price_usd = $14, last_processed_at = $15,
         closed_at = $16, journal = $17
       WHERE id = $1`,
      [
        row.id,
        collapsed ? 'FAILED' : 'CLOSED',
        state.exitReason,
        state.exitMidPriceUsd,
        JSON.stringify({ ...exit.sim.costs, attempts: exit.attempts, failedAttemptCostUsd: exit.failedCostUsd }),
        netPnl,
        costBasis > 0 ? (netPnl / costBasis) * 100 : 0,
        grossReturnPct,
        state.mfePct,
        state.maePct,
        state.timeToMfeSec,
        state.timeToMaeSec,
        collapsed,
        state.highestPriceUsd,
        state.lastProcessedAt ?? now,
        state.exitAt ? new Date(state.exitAt) : now,
        JSON.stringify(journal),
      ],
    );
    updated++;
    closed++;
  }
  return { updated, closed, legacyClosed: legacy.rowCount ?? 0 };
}

/** Same token + reason is one missed opportunity per window, not one per signal tick. */
const missedDedupe = new WriteDedupe();

export function resetMissedOpportunityDedupeForTests(): void {
  missedDedupe.clear();
}

export async function recordMissedOpportunity(opts: {
  portfolioId: string;
  tokenId: string;
  rejectionReason: RejectionReason;
  filterName?: string;
  wouldHaveReturnedPct?: number | null;
  helped?: boolean | null;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  const key = `${opts.portfolioId}|${opts.tokenId}|${opts.rejectionReason}`;
  if (missedDedupe.recent(key, '', env.MISSED_OPPORTUNITY_DEDUPE_MINUTES * 60_000)) return;
  await researchWrite('missed_opportunity', async () => {
    missedDedupe.remember(key, '');
    await query(
      `INSERT INTO missed_opportunities (
        portfolio_id, token_id, rejection_reason, filter_name,
        would_have_returned_pct, helped, evidence, data_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        opts.portfolioId,
        opts.tokenId,
        opts.rejectionReason,
        opts.filterName ?? null,
        opts.wouldHaveReturnedPct ?? null,
        opts.helped ?? null,
        JSON.stringify(opts.evidence ?? {}),
        dataMode,
      ],
    );
  });
}
