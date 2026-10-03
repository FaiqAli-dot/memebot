/**
 * Shadow trading — track rejected opportunities hypothetically.
 */
import { v4 as uuid } from 'uuid';
import type { RejectionReason } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';

export interface ShadowOpenInput {
  portfolioId: string;
  tokenId: string;
  signalId?: string | null;
  strategyId?: string | null;
  rejectionReason: RejectionReason;
  rejectionDetails?: Record<string, unknown>;
  entryPriceUsd: number | null;
  sizeUsd: number | null;
  costUsd: number | null;
  journal?: Record<string, unknown>;
}

export async function openShadowTrade(input: ShadowOpenInput): Promise<string> {
  const id = uuid();
  await query(
    `INSERT INTO shadow_trades (
      id, portfolio_id, token_id, signal_id, strategy_id, rejection_reason, rejection_details,
      hypothetical_entry_price_usd, hypothetical_size_usd, hypothetical_cost_usd,
      status, journal, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11,$12)`,
    [
      id,
      input.portfolioId,
      input.tokenId,
      input.signalId ?? null,
      input.strategyId ?? null,
      input.rejectionReason,
      JSON.stringify(input.rejectionDetails ?? {}),
      input.entryPriceUsd,
      input.sizeUsd,
      input.costUsd,
      JSON.stringify(input.journal ?? {}),
      dataMode,
    ],
  );
  return id;
}

export async function updateOpenShadowTrades(
  portfolioId: string,
  priceByToken: Map<string, { priceUsd: number; liquidityUsd: number }>,
): Promise<number> {
  const { rows } = await query<{
    id: string;
    token_id: string;
    hypothetical_entry_price_usd: string | null;
    mfe_pct: string | null;
    mae_pct: string | null;
    opened_at: Date;
  }>(
    `SELECT id, token_id, hypothetical_entry_price_usd, mfe_pct, mae_pct, opened_at
     FROM shadow_trades WHERE portfolio_id = $1 AND status = 'OPEN' AND data_mode = $2`,
    [portfolioId, dataMode],
  );

  let updated = 0;
  for (const row of rows) {
    const mkt = priceByToken.get(row.token_id);
    if (!mkt || row.hypothetical_entry_price_usd == null) continue;
    const entry = Number(row.hypothetical_entry_price_usd);
    if (entry <= 0) continue;
    const ret = (mkt.priceUsd - entry) / entry;
    const prevMfe = Number(row.mfe_pct ?? 0);
    const prevMae = Number(row.mae_pct ?? 0);
    const mfe = Math.max(prevMfe, ret * 100);
    const mae = Math.min(prevMae, ret * 100);
    const ageSec = (Date.now() - row.opened_at.getTime()) / 1000;
    const collapsed = mkt.liquidityUsd <= 0 || mkt.liquidityUsd < 500;

    // Close shadow after 1h or liquidity collapse or large move settled
    let status = 'OPEN';
    let timeToPeak: number | null = null;
    let timeToFail: number | null = null;
    let exitPrice: number | null = null;
    if (collapsed) {
      status = 'FAILED';
      timeToFail = Math.round(ageSec);
      exitPrice = mkt.priceUsd;
    } else if (ageSec >= 3600 || ret <= -0.5 || ret >= 1) {
      status = 'CLOSED';
      timeToPeak = mfe > 0 ? Math.round(ageSec) : null;
      exitPrice = mkt.priceUsd;
    }

    await query(
      `UPDATE shadow_trades SET
        mfe_pct = $2, mae_pct = $3, eventual_return_pct = $4,
        time_to_peak_sec = COALESCE(time_to_peak_sec, $5),
        time_to_failure_sec = COALESCE(time_to_failure_sec, $6),
        liquidity_collapsed = $7,
        hypothetical_exit_price_usd = COALESCE($8, hypothetical_exit_price_usd),
        status = $9,
        closed_at = CASE WHEN $9 != 'OPEN' THEN NOW() ELSE closed_at END
       WHERE id = $1`,
      [
        row.id,
        mfe,
        mae,
        ret * 100,
        timeToPeak,
        timeToFail,
        collapsed,
        exitPrice,
        status,
      ],
    );
    updated++;
  }
  return updated;
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
}
