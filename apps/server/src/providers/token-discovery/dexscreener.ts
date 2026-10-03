import type { DataMode } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { isSolanaAddress, sanitizeString, withRetry } from '../../utils/helpers.js';
import type {
  DiscoveredToken,
  MarketDataProvider,
  MarketQuote,
  PriceProvider,
  TokenDiscoveryProvider,
} from '../types.js';

interface DexPair {
  chainId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  dexId?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as T;
    },
    {
      maxRetries: env.PROVIDER_MAX_RETRIES,
      baseMs: env.PROVIDER_RETRY_BASE_MS,
      label: 'dexscreener',
      onError: (err, attempt) =>
        logger.warn({ err, attempt, url }, 'DexScreener request failed'),
    },
  );
}

function toQuote(pair: DexPair): MarketQuote | null {
  const address = pair.baseToken?.address;
  if (!address || !isSolanaAddress(address)) return null;
  const priceUsd = Number(pair.priceUsd ?? 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const buys = pair.txns?.m5?.buys ?? 0;
  const sells = pair.txns?.m5?.sells ?? 0;
  const volume5m = Number(pair.volume?.m5 ?? 0);
  const buyShare = buys + sells > 0 ? buys / (buys + sells) : 0.5;
  const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
  return {
    chain: 'solana',
    address,
    priceUsd,
    marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    volume5mUsd: volume5m,
    volume1hUsd: Number(pair.volume?.h1 ?? 0),
    volume24hUsd: Number(pair.volume?.h24 ?? 0),
    buyVolume5mUsd: volume5m * buyShare,
    sellVolume5mUsd: volume5m * (1 - buyShare),
    txCount5m: buys + sells,
    priceChange5mPct: Number(pair.priceChange?.m5 ?? 0),
    priceChange1hPct: Number(pair.priceChange?.h1 ?? 0),
    liquidityUsd,
    observedAt: new Date(),
    poolAddress: pair.pairAddress ?? null,
    venue: pair.dexId ?? 'unknown',
    feeBps: null, // filled by fee provider / pool metadata when known
    baseReserve: null,
    quoteReserve: liquidityUsd > 0 && priceUsd > 0 ? liquidityUsd / 2 / priceUsd : null,
  };
}

export class DexScreenerTokenDiscoveryProvider implements TokenDiscoveryProvider {
  readonly name = 'dexscreener-token-discovery';
  readonly dataMode: DataMode = 'live';

  async discoverRecentTokens(limit = 20): Promise<DiscoveredToken[]> {
    // Boosted / token profiles endpoints — public, no key
    const url = `${env.DEXSCREENER_BASE_URL}/token-boosts/latest/v1`;
    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(url);
    } catch (err) {
      logger.error({ err }, 'DexScreener discovery failed');
      return [];
    }

    const items = Array.isArray(payload) ? payload : [];
    const out: DiscoveredToken[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (row.chainId !== 'solana') continue;
      const address = sanitizeString(row.tokenAddress, 64);
      if (!isSolanaAddress(address)) continue;
      out.push({
        chain: 'solana',
        address,
        symbol: sanitizeString(row.symbol ?? 'UNK', 32) || 'UNK',
        name: sanitizeString(row.description ?? row.symbol ?? 'Unknown', 64) || 'Unknown',
        decimals: 9,
        createdAt: null,
        metadata: {
          url: row.url,
          icon: row.icon,
          source: 'dexscreener-boosts',
        },
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

export class DexScreenerMarketDataProvider implements MarketDataProvider, PriceProvider {
  readonly name = 'dexscreener-market-data';
  readonly dataMode: DataMode = 'live';

  async getPriceUsd(address: string): Promise<number | null> {
    const quotes = await this.getMarketQuotes([address]);
    return quotes[0]?.priceUsd ?? null;
  }

  async getMarketQuotes(addresses: string[]): Promise<MarketQuote[]> {
    const valid = addresses.filter(isSolanaAddress);
    if (valid.length === 0) return [];
    // DexScreener allows comma-separated addresses (up to ~30)
    const chunkSize = 30;
    const quotes: MarketQuote[] = [];
    for (let i = 0; i < valid.length; i += chunkSize) {
      const chunk = valid.slice(i, i + chunkSize);
      const url = `${env.DEXSCREENER_BASE_URL}/tokens/v1/solana/${chunk.join(',')}`;
      try {
        const pairs = await fetchJson<DexPair[]>(url);
        if (!Array.isArray(pairs)) continue;
        // Keep best liquidity pair per token
        const best = new Map<string, MarketQuote>();
        for (const pair of pairs) {
          const q = toQuote(pair);
          if (!q) continue;
          const prev = best.get(q.address);
          if (!prev || q.liquidityUsd > prev.liquidityUsd) best.set(q.address, q);
        }
        quotes.push(...best.values());
      } catch (err) {
        logger.error({ err, chunk }, 'DexScreener market quotes failed');
      }
    }
    return quotes;
  }
}
