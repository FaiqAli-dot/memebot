/**
 * Post-decision outcome tracking for NOT-traded tokens (research only).
 * Never feeds back into strategy thresholds.
 */
import { OUTCOME_CHECKPOINT_LABELS, type OutcomeCheckpointLabel } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { getLatestMarketByToken } from '../services/token-service.js';
import { logger } from '../utils/logger.js';

const CHECKPOINT_OFFSET_MS: Record<OutcomeCheckpointLabel, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '3h': 3 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

/** Practical subset always scheduled; full set used when retention allows. */
export const PRACTICAL_CHECKPOINTS: OutcomeCheckpointLabel[] = [
  '5m',
  '15m',
  '30m',
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
];

export async function scheduleOutcomeCheckpoints(opts: {
  tokenId: string;
  decisionId: string;
  decisionPrice?: number | null;
  decisionMarketCap?: number | null;
  decisionLiquidity?: number | null;
  now?: Date;
}): Promise<number> {
  const now = opts.now ?? new Date();
  let n = 0;
  for (const label of PRACTICAL_CHECKPOINTS) {
    const due = new Date(now.getTime() + CHECKPOINT_OFFSET_MS[label]);
    await query(
      `INSERT INTO token_outcome_checkpoints (
         token_id, decision_id, checkpoint_label, due_at, status, data_mode, payload
       ) VALUES ($1,$2,$3,$4,'PENDING',$5,$6)
       ON CONFLICT (token_id, decision_id, checkpoint_label) DO NOTHING`,
      [
        opts.tokenId,
        opts.decisionId,
        label,
        due,
        dataMode,
        JSON.stringify({
          decisionPrice: opts.decisionPrice ?? null,
          decisionMarketCap: opts.decisionMarketCap ?? null,
          decisionLiquidity: opts.decisionLiquidity ?? null,
        }),
      ],
    );
    n++;
  }
  return n;
}

export async function captureDueOutcomeCheckpoints(now = new Date()): Promise<number> {
  const { rows } = await query<{
    id: string;
    token_id: string;
    decision_id: string | null;
    checkpoint_label: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, token_id, decision_id, checkpoint_label, payload
     FROM token_outcome_checkpoints
     WHERE status = 'PENDING' AND due_at <= $1 AND data_mode = $2
     ORDER BY due_at ASC
     LIMIT 100`,
    [now, dataMode],
  );

  let captured = 0;
  for (const row of rows) {
    const market = await getLatestMarketByToken(row.token_id);
    if (!market) {
      // Keep pending briefly; mark missed if >2h overdue
      continue;
    }
    const decisionPrice =
      typeof row.payload?.decisionPrice === 'number' ? row.payload.decisionPrice : null;
    const changePct =
      decisionPrice && decisionPrice > 0
        ? ((market.price_usd - decisionPrice) / decisionPrice) * 100
        : null;

    await query(
      `UPDATE token_outcome_checkpoints SET
         status = 'CAPTURED',
         observed_at = $2,
         price_usd = $3,
         market_cap_usd = $4,
         liquidity_usd = $5,
         volume_usd = $6,
         change_pct = $7
       WHERE id = $1`,
      [
        row.id,
        now,
        market.price_usd,
        market.market_cap_usd,
        market.liquidity_usd,
        market.volume_24h_usd || market.volume_1h_usd,
        changePct,
      ],
    );
    captured++;

    if (row.checkpoint_label === '24h' && row.decision_id) {
      await compactOutcomeSummary(row.token_id, row.decision_id);
    }
  }

  // Mark severely overdue pending rows as missed
  await query(
    `UPDATE token_outcome_checkpoints SET status = 'MISSED'
     WHERE status = 'PENDING' AND due_at < $1::timestamptz - INTERVAL '2 hours' AND data_mode = $2`,
    [now, dataMode],
  );

  return captured;
}

export async function compactOutcomeSummary(
  tokenId: string,
  decisionId: string,
): Promise<void> {
  const { rows } = await query<{
    checkpoint_label: string;
    price_usd: string | null;
    market_cap_usd: string | null;
    liquidity_usd: string | null;
    change_pct: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT checkpoint_label, price_usd, market_cap_usd, liquidity_usd, change_pct, payload
     FROM token_outcome_checkpoints
     WHERE token_id = $1 AND decision_id = $2 AND status = 'CAPTURED'`,
    [tokenId, decisionId],
  );
  if (rows.length === 0) return;

  const byLabel = new Map(rows.map((r) => [r.checkpoint_label, r]));
  const first = rows[0]!;
  const decisionPrice =
    typeof first.payload?.decisionPrice === 'number' ? first.payload.decisionPrice : null;
  const decisionMarketCap =
    typeof first.payload?.decisionMarketCap === 'number'
      ? first.payload.decisionMarketCap
      : null;
  const decisionLiquidity =
    typeof first.payload?.decisionLiquidity === 'number'
      ? first.payload.decisionLiquidity
      : null;

  const prices = rows
    .map((r) => (r.price_usd != null ? Number(r.price_usd) : null))
    .filter((n): n is number => n != null && Number.isFinite(n));
  const peak = prices.length ? Math.max(...prices) : null;
  const low = prices.length ? Math.min(...prices) : null;
  const maxGain =
    decisionPrice && peak != null ? ((peak - decisionPrice) / decisionPrice) * 100 : null;
  const maxDd =
    decisionPrice && low != null ? ((low - decisionPrice) / decisionPrice) * 100 : null;

  const priceAt = (label: string) => {
    const v = byLabel.get(label)?.price_usd;
    return v != null ? Number(v) : null;
  };

  let classification: string = 'NEUTRAL';
  if (maxGain != null && maxGain >= 50) classification = 'FALSE_NEGATIVE_CANDIDATE';
  if (maxDd != null && maxDd <= -50) classification = 'SUCCESSFUL_REJECTION';

  const outcomeSummary =
    maxGain != null && maxDd != null
      ? `maxGain24h=${maxGain.toFixed(2)}% maxDrawdown24h=${maxDd.toFixed(2)}%`
      : 'insufficient_checkpoints';

  await query(
    `INSERT INTO token_outcome_summaries (
       token_id, decision_id, decision_price, decision_market_cap, decision_liquidity,
       price_at_1h, price_at_6h, price_at_24h, peak_price_24h, lowest_price_24h,
       max_gain_24h, max_drawdown_24h, outcome_summary, classification, payload, data_mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (token_id, decision_id) DO UPDATE SET
       price_at_1h = EXCLUDED.price_at_1h,
       price_at_6h = EXCLUDED.price_at_6h,
       price_at_24h = EXCLUDED.price_at_24h,
       peak_price_24h = EXCLUDED.peak_price_24h,
       lowest_price_24h = EXCLUDED.lowest_price_24h,
       max_gain_24h = EXCLUDED.max_gain_24h,
       max_drawdown_24h = EXCLUDED.max_drawdown_24h,
       outcome_summary = EXCLUDED.outcome_summary,
       classification = EXCLUDED.classification,
       payload = EXCLUDED.payload`,
    [
      tokenId,
      decisionId,
      decisionPrice,
      decisionMarketCap,
      decisionLiquidity,
      priceAt('1h'),
      priceAt('6h'),
      priceAt('24h'),
      peak,
      low,
      maxGain,
      maxDd,
      outcomeSummary,
      classification,
      JSON.stringify({ checkpoints: Object.fromEntries(byLabel) }),
      dataMode,
    ],
  );

  await query(
    `UPDATE tokens SET outcome_summary = $2 WHERE id = $1`,
    [
      tokenId,
      JSON.stringify({
        decisionPrice,
        decisionMarketCap,
        decisionLiquidity,
        priceAt1h: priceAt('1h'),
        priceAt6h: priceAt('6h'),
        priceAt24h: priceAt('24h'),
        peakPrice24h: peak,
        lowestPrice24h: low,
        maxGain24h: maxGain,
        maxDrawdown24h: maxDd,
        outcomeSummary,
        classification,
      }),
    ],
  );

  await query(
    `UPDATE token_outcome_checkpoints SET status = 'COMPACTED'
     WHERE token_id = $1 AND decision_id = $2 AND status = 'CAPTURED'`,
    [tokenId, decisionId],
  );

  logger.info({ tokenId, decisionId, classification }, 'Compacted token outcome summary');
}

export function allCheckpointLabels(): readonly OutcomeCheckpointLabel[] {
  return OUTCOME_CHECKPOINT_LABELS;
}
