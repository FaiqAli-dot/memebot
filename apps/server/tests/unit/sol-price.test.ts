import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CachedSolPriceProvider,
  DemoSolPriceProvider,
  DexScreenerSolPriceProvider,
  CoinGeckoSolPriceProvider,
} from '../../src/providers/market/sol-price.js';
import type { SolPriceProvider, SolPriceQuote } from '../../src/providers/types.js';

function stubProvider(
  name: string,
  result: SolPriceQuote | null,
): SolPriceProvider {
  return {
    name,
    dataMode: 'live',
    getSolPriceUsd: async () => result,
  };
}

describe('SolPriceProvider', () => {
  it('demo provider returns deterministic labeled price', async () => {
    const p = new DemoSolPriceProvider();
    const q = await p.getSolPriceUsd();
    expect(q.priceUsd).toBeGreaterThan(0);
    expect(q.source).toBe('demo-deterministic');
    expect(q.dataMode).toBe('demo');
    expect(q.stale).toBe(false);
  });

  it('cache serves fresh TTL hit without calling primary again', async () => {
    let calls = 0;
    const primary: SolPriceProvider = {
      name: 'p',
      dataMode: 'live',
      getSolPriceUsd: async () => {
        calls++;
        return {
          priceUsd: 140,
          source: 'primary',
          observedAt: new Date(),
          stale: false,
          dataMode: 'live',
        };
      },
    };
    const cached = new CachedSolPriceProvider(primary, null, 60_000, 120_000);
    await cached.getSolPriceUsd();
    await cached.getSolPriceUsd();
    expect(calls).toBe(1);
  });

  it('falls back when primary fails', async () => {
    const cached = new CachedSolPriceProvider(
      stubProvider('primary', null),
      stubProvider('fallback', {
        priceUsd: 155,
        source: 'coingecko-solana',
        observedAt: new Date(),
        stale: false,
        dataMode: 'live',
      }),
      1000,
      5000,
    );
    const q = await cached.getSolPriceUsd();
    expect(q?.priceUsd).toBe(155);
    expect(q?.source).toBe('coingecko-solana');
  });

  it('returns null when both sources fail and cache empty', async () => {
    const cached = new CachedSolPriceProvider(
      stubProvider('primary', null),
      stubProvider('fallback', null),
      1000,
      5000,
    );
    expect(await cached.getSolPriceUsd()).toBeNull();
  });

  it('marks stale when serving aged cache after fetch failure', async () => {
    const cached = new CachedSolPriceProvider(
      stubProvider('primary', null),
      null,
      1, // tiny TTL
      60_000,
    );
    cached.seedCache(
      {
        priceUsd: 120,
        source: 'dexscreener-wsol',
        observedAt: new Date(Date.now() - 10_000),
        stale: false,
        dataMode: 'live',
      },
      Date.now() - 10_000,
    );
    // Wait past TTL
    await new Promise((r) => setTimeout(r, 5));
    const q = await cached.getSolPriceUsd();
    expect(q).not.toBeNull();
    expect(q!.stale).toBe(true);
    expect(q!.priceUsd).toBe(120);
  });

  it('returns null when cache exceeds max stale window', async () => {
    const cached = new CachedSolPriceProvider(
      stubProvider('primary', null),
      null,
      1,
      50, // max stale 50ms
    );
    cached.seedCache(
      {
        priceUsd: 120,
        source: 'old',
        observedAt: new Date(Date.now() - 10_000),
        stale: false,
        dataMode: 'live',
      },
      Date.now() - 10_000,
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(await cached.getSolPriceUsd()).toBeNull();
  });
});

describe('live SOL price providers (network, best-effort)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('DexScreenerSolPriceProvider parses WSOL pair response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            priceUsd: '148.25',
            liquidity: { usd: 5_000_000 },
            quoteToken: { symbol: 'USDC' },
          },
        ],
      })),
    );
    const p = new DexScreenerSolPriceProvider();
    const q = await p.getSolPriceUsd();
    expect(q?.priceUsd).toBeCloseTo(148.25);
    expect(q?.source).toBe('dexscreener-wsol');
  });

  it('CoinGeckoSolPriceProvider parses simple price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ solana: { usd: 149.1 } }),
      })),
    );
    const p = new CoinGeckoSolPriceProvider();
    const q = await p.getSolPriceUsd();
    expect(q?.priceUsd).toBeCloseTo(149.1);
    expect(q?.source).toBe('coingecko-solana');
  });

  it('returns null on HTTP failure without inventing a price', async () => {
    const prevRetries = process.env.PROVIDER_MAX_RETRIES;
    const prevBase = process.env.PROVIDER_RETRY_BASE_MS;
    process.env.PROVIDER_MAX_RETRIES = '0';
    process.env.PROVIDER_RETRY_BASE_MS = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    );
    // Re-import helpers already bound env at module load — just assert null result
    const p = new DexScreenerSolPriceProvider();
    const q = await p.getSolPriceUsd();
    expect(q).toBeNull();
    process.env.PROVIDER_MAX_RETRIES = prevRetries;
    process.env.PROVIDER_RETRY_BASE_MS = prevBase;
  }, 15_000);
});
