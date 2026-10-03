/**
 * Live SOL/USD price for fee conversion.
 * Primary: DexScreener WSOL pairs. Fallback: CoinGecko simple/price.
 * Cached with TTL; never invents a price when both sources fail.
 */
import type { DataMode } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { withRetry } from '../../utils/helpers.js';
import type { SolPriceProvider, SolPriceQuote } from '../types.js';
import { WSOL_MINT } from '../types.js';

interface CacheEntry {
  quote: SolPriceQuote;
  fetchedAtMs: number;
}

export class DemoSolPriceProvider implements SolPriceProvider {
  readonly name = 'demo-sol-price';
  readonly dataMode: DataMode = 'demo';

  async getSolPriceUsd(): Promise<SolPriceQuote> {
    // Deterministic demo SOL price — clearly labeled, never mixed with live
    return {
      priceUsd: env.DEFAULT_SOL_PRICE_USD,
      source: 'demo-deterministic',
      observedAt: new Date(),
      stale: false,
      dataMode: 'demo',
    };
  }
}

export class DexScreenerSolPriceProvider implements SolPriceProvider {
  readonly name = 'dexscreener-sol-price';
  readonly dataMode: DataMode = 'live';

  async getSolPriceUsd(): Promise<SolPriceQuote | null> {
    try {
      const url = `${env.DEXSCREENER_BASE_URL}/tokens/v1/solana/${WSOL_MINT}`;
      const pairs = await withRetry(
        async () => {
          const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`DexScreener SOL price HTTP ${res.status}`);
          return (await res.json()) as Array<{
            priceUsd?: string;
            liquidity?: { usd?: number };
            quoteToken?: { symbol?: string };
          }>;
        },
        {
          maxRetries: env.PROVIDER_MAX_RETRIES,
          baseMs: env.PROVIDER_RETRY_BASE_MS,
          label: 'dexscreener-sol-price',
          onError: (err, attempt) =>
            logger.warn({ err, attempt }, 'DexScreener SOL price failed'),
        },
      );

      if (!Array.isArray(pairs) || pairs.length === 0) return null;
      // Prefer USDC/USDT quoted pairs with highest liquidity
      const ranked = pairs
        .filter((p) => {
          const q = (p.quoteToken?.symbol ?? '').toUpperCase();
          return q === 'USDC' || q === 'USDT' || q === 'USD';
        })
        .sort(
          (a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
        );
      const best = ranked[0] ?? pairs[0];
      const price = Number(best?.priceUsd ?? NaN);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        priceUsd: price,
        source: 'dexscreener-wsol',
        observedAt: new Date(),
        stale: false,
        dataMode: 'live',
      };
    } catch (err) {
      logger.error({ err }, 'DexScreener SOL price unavailable');
      return null;
    }
  }
}

export class CoinGeckoSolPriceProvider implements SolPriceProvider {
  readonly name = 'coingecko-sol-price';
  readonly dataMode: DataMode = 'live';

  async getSolPriceUsd(): Promise<SolPriceQuote | null> {
    try {
      const url = `${env.COINGECKO_BASE_URL}/simple/price?ids=solana&vs_currencies=usd`;
      const data = await withRetry(
        async () => {
          const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`CoinGecko SOL price HTTP ${res.status}`);
          return (await res.json()) as { solana?: { usd?: number } };
        },
        {
          maxRetries: env.PROVIDER_MAX_RETRIES,
          baseMs: env.PROVIDER_RETRY_BASE_MS,
          label: 'coingecko-sol-price',
          onError: (err, attempt) =>
            logger.warn({ err, attempt }, 'CoinGecko SOL price failed'),
        },
      );
      const price = Number(data.solana?.usd ?? NaN);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        priceUsd: price,
        source: 'coingecko-solana',
        observedAt: new Date(),
        stale: false,
        dataMode: 'live',
      };
    } catch (err) {
      logger.error({ err }, 'CoinGecko SOL price unavailable');
      return null;
    }
  }
}

/**
 * Cached SOL price with primary + fallback. Fail-safe: returns null when stale/unavailable
 * rather than inventing DEFAULT_SOL_PRICE_USD for live trading.
 */
export class CachedSolPriceProvider implements SolPriceProvider {
  readonly name = 'cached-sol-price';
  readonly dataMode: DataMode;
  private cache: CacheEntry | null = null;

  constructor(
    private readonly primary: SolPriceProvider,
    private readonly fallback: SolPriceProvider | null,
    private readonly ttlMs: number,
    private readonly maxStaleMs: number,
    dataMode: DataMode = 'live',
  ) {
    this.dataMode = dataMode;
  }

  /** Test helper */
  clearCache(): void {
    this.cache = null;
  }

  /** Test helper — inject a cached quote */
  seedCache(quote: SolPriceQuote, fetchedAtMs = Date.now()): void {
    this.cache = { quote, fetchedAtMs };
  }

  async getSolPriceUsd(): Promise<SolPriceQuote | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAtMs < this.ttlMs) {
      return { ...this.cache.quote, stale: false };
    }

    let fresh =
      (await this.primary.getSolPriceUsd()) ??
      (this.fallback ? await this.fallback.getSolPriceUsd() : null);

    if (fresh) {
      this.cache = { quote: fresh, fetchedAtMs: now };
      return { ...fresh, stale: false };
    }

    // Serve stale cache only if within maxStale window — still marked stale
    if (this.cache && now - this.cache.fetchedAtMs < this.maxStaleMs) {
      return {
        ...this.cache.quote,
        stale: true,
        observedAt: this.cache.quote.observedAt,
      };
    }

    return null;
  }
}
