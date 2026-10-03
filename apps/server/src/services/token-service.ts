import type { DataMode } from '@memebot/shared';
import { query } from '../db/client.js';
import { dataMode } from '../config/env.js';
import { sanitizeString, isSolanaAddress } from '../utils/helpers.js';
import type { DiscoveredToken, MarketQuote, OnChainTokenData } from '../providers/types.js';
import type { EnrichedDiscoveredToken } from '../providers/discovery/multi-source.js';
import { classifyLiquidity, tokenAge, type TokenAge } from '../universe/lifecycle.js';
import type { LiquidityStatus } from '@memebot/shared';

export function quoteLiquidityStatus(quote: MarketQuote): LiquidityStatus {
  return quote.liquidityStatus ?? classifyLiquidity({ venue: quote.venue, liquidityUsd: quote.liquidityUsd });
}

export async function upsertDiscoveredToken(
  token: DiscoveredToken | EnrichedDiscoveredToken,
): Promise<string | null> {
  if (dataMode === 'live' && !isSolanaAddress(token.address)) return null;
  const symbol = sanitizeString(token.symbol, 32) || 'UNK';
  const name = sanitizeString(token.name, 64) || symbol;
  const enriched = token as EnrichedDiscoveredToken;
  const discoverySource = enriched.discoverySource ?? 'UNKNOWN';
  const { rows } = await query<{ id: string }>(
    `INSERT INTO tokens (
      chain, address, symbol, name, decimals, created_at_onchain, data_mode, metadata,
      discovery_source, first_observed_at, migration_at, first_liquidity_at,
      pool_address, quote_token, initial_liquidity_usd, creator_wallet, dex_venue
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (chain, address, data_mode)
     DO UPDATE SET
       symbol = EXCLUDED.symbol,
       name = EXCLUDED.name,
       metadata = tokens.metadata || EXCLUDED.metadata,
       created_at_onchain = COALESCE(tokens.created_at_onchain, EXCLUDED.created_at_onchain),
       discovery_source = CASE
         WHEN tokens.discovery_source = 'DEXSCREENER_BOOST' AND EXCLUDED.discovery_source != 'DEXSCREENER_BOOST'
           THEN EXCLUDED.discovery_source
         ELSE tokens.discovery_source
       END,
       pool_address = COALESCE(tokens.pool_address, EXCLUDED.pool_address),
       first_liquidity_at = COALESCE(tokens.first_liquidity_at, EXCLUDED.first_liquidity_at),
       initial_liquidity_usd = COALESCE(tokens.initial_liquidity_usd, EXCLUDED.initial_liquidity_usd),
       creator_wallet = COALESCE(tokens.creator_wallet, EXCLUDED.creator_wallet),
       dex_venue = COALESCE(tokens.dex_venue, EXCLUDED.dex_venue)
     RETURNING id`,
    [
      token.chain,
      token.address,
      symbol,
      name,
      token.decimals,
      token.createdAt,
      dataMode,
      JSON.stringify(token.metadata ?? {}),
      discoverySource,
      enriched.migrationAt ?? null,
      enriched.firstLiquidityAt ?? null,
      enriched.poolAddress ?? null,
      enriched.quoteToken ?? null,
      enriched.initialLiquidityUsd ?? null,
      enriched.creatorWallet ?? null,
      enriched.dexVenue ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Pool creation time is authoritative; first-observed is only a fallback. */
export function effectiveAgeMinutes(
  token: {
    pool_created_at?: Date | null;
    created_at_onchain: Date | null;
    first_observed_at?: Date | null;
    discovered_at: Date;
  },
  now: Date = new Date(),
): number {
  return tokenAgeOf(token, now).minutes;
}

export function tokenAgeOf(
  token: {
    pool_created_at?: Date | null;
    created_at_onchain: Date | null;
    first_observed_at?: Date | null;
    discovered_at: Date;
  },
  now: Date = new Date(),
): TokenAge {
  return tokenAge(
    {
      poolCreatedAt: token.pool_created_at ?? token.created_at_onchain ?? null,
      firstObservedAt: token.first_observed_at ?? null,
      discoveredAt: token.discovered_at,
    },
    now,
  );
}

export async function listActiveTokenIds(limit = 100): Promise<
  Array<{ id: string; address: string; symbol: string; chain: string; created_at_onchain: Date | null; discovered_at: Date }>
> {
  const { rows } = await query<{
    id: string;
    address: string;
    symbol: string;
    chain: string;
    created_at_onchain: Date | null;
    discovered_at: Date;
  }>(
    `SELECT id, address, symbol, chain, created_at_onchain, discovered_at
     FROM tokens WHERE data_mode = $1
     ORDER BY discovered_at DESC LIMIT $2`,
    [dataMode, limit],
  );
  return rows;
}

export async function insertMarketSnapshot(
  tokenId: string,
  quote: MarketQuote,
  stale = false,
): Promise<void> {
  await query(
    `INSERT INTO market_snapshots (
      token_id, price_usd, market_cap_usd, volume_5m_usd, volume_1h_usd, volume_24h_usd,
      buy_volume_5m_usd, sell_volume_5m_usd, tx_count_5m, price_change_5m_pct, price_change_1h_pct,
      liquidity_usd, observed_at, data_mode, stale,
      buys_5m, sells_5m, buys_1h, sells_1h, buys_24h, sells_24h, liquidity_status, venue, pool_address
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      tokenId,
      quote.priceUsd,
      quote.marketCapUsd,
      quote.volume5mUsd,
      quote.volume1hUsd,
      quote.volume24hUsd,
      quote.buyVolume5mUsd,
      quote.sellVolume5mUsd,
      quote.txCount5m,
      quote.priceChange5mPct,
      quote.priceChange1hPct,
      quote.liquidityUsd,
      quote.observedAt,
      dataMode,
      stale,
      quote.buys5m ?? null,
      quote.sells5m ?? null,
      quote.buys1h ?? null,
      quote.sells1h ?? null,
      quote.buys24h ?? null,
      quote.sells24h ?? null,
      quoteLiquidityStatus(quote),
      quote.venue ?? null,
      quote.poolAddress ?? null,
    ],
  );

  await query(
    `INSERT INTO liquidity_snapshots (
      token_id, pool_address, venue, liquidity_usd, base_reserve, quote_reserve, fee_bps, observed_at, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tokenId,
      quote.poolAddress ?? null,
      quote.venue ?? null,
      quote.liquidityUsd,
      quote.baseReserve ?? null,
      quote.quoteReserve ?? null,
      quote.feeBps ?? null,
      quote.observedAt,
      dataMode,
    ],
  );
}

export async function insertHolderSnapshot(
  tokenId: string,
  data: OnChainTokenData,
): Promise<void> {
  await query(
    `INSERT INTO holder_snapshots (
      token_id, holder_count, top_holder_pct, top10_holder_pct, observed_at, data_mode
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      tokenId,
      data.holderCount,
      data.topHolderPct,
      data.top10HolderPct,
      data.observedAt,
      dataMode,
    ],
  );
}

export async function getLatestMarketByToken(
  tokenId: string,
): Promise<{
  price_usd: number;
  liquidity_usd: number;
  volume_5m_usd: number;
  volume_1h_usd: number;
  buy_volume_5m_usd: number;
  sell_volume_5m_usd: number;
  tx_count_5m: number;
  price_change_5m_pct: number;
  price_change_1h_pct: number;
  market_cap_usd: number | null;
  observed_at: Date;
  stale: boolean;
  pool_address: string | null;
  venue: string | null;
  fee_bps: number | null;
  base_reserve: number | null;
  quote_reserve: number | null;
  liquidity_status: LiquidityStatus;
  volume_24h_usd: number;
  buys_5m: number | null;
  sells_5m: number | null;
  buys_1h: number | null;
  sells_1h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
} | null> {
  const { rows } = await query<{
    price_usd: string;
    liquidity_usd: string;
    volume_5m_usd: string;
    volume_1h_usd: string;
    volume_24h_usd: string;
    buy_volume_5m_usd: string;
    sell_volume_5m_usd: string;
    tx_count_5m: number;
    price_change_5m_pct: string;
    price_change_1h_pct: string;
    market_cap_usd: string | null;
    observed_at: Date;
    stale: boolean;
    liquidity_status: LiquidityStatus | null;
    venue: string | null;
    buys_5m: number | null;
    sells_5m: number | null;
    buys_1h: number | null;
    sells_1h: number | null;
    buys_24h: number | null;
    sells_24h: number | null;
  }>(
    `SELECT * FROM market_snapshots WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [tokenId],
  );
  const m = rows[0];
  if (!m) return null;

  const liq = await query<{
    pool_address: string | null;
    venue: string | null;
    fee_bps: number | null;
    base_reserve: string | null;
    quote_reserve: string | null;
  }>(
    `SELECT pool_address, venue, fee_bps, base_reserve, quote_reserve
     FROM liquidity_snapshots WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [tokenId],
  );
  const l = liq.rows[0];

  return {
    price_usd: Number(m.price_usd),
    liquidity_usd: Number(m.liquidity_usd),
    volume_5m_usd: Number(m.volume_5m_usd),
    volume_1h_usd: Number(m.volume_1h_usd),
    buy_volume_5m_usd: Number(m.buy_volume_5m_usd),
    sell_volume_5m_usd: Number(m.sell_volume_5m_usd),
    tx_count_5m: m.tx_count_5m,
    price_change_5m_pct: Number(m.price_change_5m_pct),
    price_change_1h_pct: Number(m.price_change_1h_pct),
    market_cap_usd: m.market_cap_usd != null ? Number(m.market_cap_usd) : null,
    observed_at: m.observed_at,
    stale: m.stale,
    pool_address: l?.pool_address ?? null,
    venue: m.venue ?? l?.venue ?? null,
    fee_bps: l?.fee_bps ?? null,
    base_reserve: l?.base_reserve != null ? Number(l.base_reserve) : null,
    quote_reserve: l?.quote_reserve != null ? Number(l.quote_reserve) : null,
    liquidity_status:
      m.liquidity_status ??
      classifyLiquidity({ venue: m.venue ?? l?.venue ?? null, liquidityUsd: Number(m.liquidity_usd) }),
    volume_24h_usd: Number(m.volume_24h_usd ?? 0),
    buys_5m: m.buys_5m,
    sells_5m: m.sells_5m,
    buys_1h: m.buys_1h,
    sells_1h: m.sells_1h,
    buys_24h: m.buys_24h,
    sells_24h: m.sells_24h,
  };
}

/**
 * Volume of the *previous completed* 5-minute window: a rolling-5m snapshot taken
 * at least 5 minutes before `before` (and not older than 10 minutes), so the two
 * windows do not overlap. Only snapshots at or before `before` — no look-ahead.
 */
export async function getPriorVolume5m(tokenId: string, before: Date): Promise<number | null> {
  const { rows } = await query<{ volume_5m_usd: string }>(
    `SELECT volume_5m_usd FROM market_snapshots
     WHERE token_id = $1
       AND observed_at <= $2::timestamptz - INTERVAL '5 minutes'
       AND observed_at >= $2::timestamptz - INTERVAL '10 minutes'
     ORDER BY observed_at DESC LIMIT 1`,
    [tokenId, before],
  );
  return rows[0] ? Number(rows[0].volume_5m_usd) : null;
}

export interface SnapshotHistoryRow {
  token_id: string;
  observed_at: Date;
  price_usd: number;
  liquidity_usd: number;
  volume_5m_usd: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  tx_count_5m: number;
  buys_5m: number | null;
  sells_5m: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
}

/** Batched recent history (≤ 16 min, newest first) for many tokens; no look-ahead. */
export async function getSnapshotHistory(
  tokenIds: string[],
  before: Date,
  windowMinutes = 16,
): Promise<Map<string, SnapshotHistoryRow[]>> {
  const out = new Map<string, SnapshotHistoryRow[]>();
  if (tokenIds.length === 0) return out;
  const { rows } = await query<Record<string, string | number | Date | null>>(
    `SELECT token_id, observed_at, price_usd, liquidity_usd, volume_5m_usd, volume_1h_usd,
            volume_24h_usd, tx_count_5m, buys_5m, sells_5m, buys_24h, sells_24h
     FROM market_snapshots
     WHERE token_id = ANY($1::uuid[])
       AND observed_at <= $2
       AND observed_at >= $2::timestamptz - ($3::text || ' minutes')::interval
     ORDER BY token_id, observed_at DESC`,
    [tokenIds, before, String(windowMinutes)],
  );
  const num = (v: unknown) => (v == null ? null : Number(v));
  for (const r of rows) {
    const id = String(r.token_id);
    const list = out.get(id) ?? [];
    list.push({
      token_id: id,
      observed_at: r.observed_at as Date,
      price_usd: Number(r.price_usd),
      liquidity_usd: Number(r.liquidity_usd),
      volume_5m_usd: Number(r.volume_5m_usd),
      volume_1h_usd: Number(r.volume_1h_usd),
      volume_24h_usd: Number(r.volume_24h_usd ?? 0),
      tx_count_5m: Number(r.tx_count_5m ?? 0),
      buys_5m: num(r.buys_5m),
      sells_5m: num(r.sells_5m),
      buys_24h: num(r.buys_24h),
      sells_24h: num(r.sells_24h),
    });
    out.set(id, list);
  }
  return out;
}

export async function getLatestHolders(tokenId: string): Promise<{
  holder_count: number | null;
  top_holder_pct: number | null;
  top10_holder_pct: number | null;
} | null> {
  const { rows } = await query<{
    holder_count: number | null;
    top_holder_pct: string | null;
    top10_holder_pct: string | null;
  }>(
    `SELECT holder_count, top_holder_pct, top10_holder_pct
     FROM holder_snapshots WHERE token_id = $1 ORDER BY observed_at DESC LIMIT 1`,
    [tokenId],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    holder_count: h.holder_count,
    top_holder_pct: h.top_holder_pct != null ? Number(h.top_holder_pct) : null,
    top10_holder_pct: h.top10_holder_pct != null ? Number(h.top10_holder_pct) : null,
  };
}

export async function logBotEvent(opts: {
  portfolioId?: string | null;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  details?: Record<string, unknown>;
  mode?: DataMode;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO bot_events (portfolio_id, level, category, message, details, data_mode)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      opts.portfolioId ?? null,
      opts.level,
      opts.category,
      opts.message,
      JSON.stringify(opts.details ?? {}),
      opts.mode ?? dataMode,
    ],
  );
  return rows[0]!.id;
}
