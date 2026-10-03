/**
 * Multi-source token discovery. DexScreener boosts are labeled PAID_BOOST — not organic.
 * Strategy must not know data origin; origin is stored on the token.
 */
import type { DataMode, DiscoverySource } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { DiscoveredToken, TokenDiscoveryProvider } from '../types.js';

export interface EnrichedDiscoveredToken extends DiscoveredToken {
  discoverySource: DiscoverySource;
  poolAddress?: string | null;
  quoteToken?: string | null;
  initialLiquidityUsd?: number | null;
  creatorWallet?: string | null;
  dexVenue?: string | null;
  firstLiquidityAt?: Date | null;
  migrationAt?: Date | null;
}

export interface StreamTokenDiscoveryProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  subscribe(): Promise<void>;
  getRecentTokens(): Promise<EnrichedDiscoveredToken[]>;
  unsubscribe?(): Promise<void>;
}

function isSolAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

/** Wrap legacy discoverRecentTokens as subscribe/getRecentTokens. */
export function asStreamProvider(
  legacy: TokenDiscoveryProvider,
  source: DiscoverySource,
): StreamTokenDiscoveryProvider {
  return {
    name: legacy.name,
    dataMode: legacy.dataMode,
    async subscribe() {
      /* polling providers no-op subscribe */
    },
    async getRecentTokens() {
      const tokens = await legacy.discoverRecentTokens(20);
      return tokens.map((t) => ({
        ...t,
        discoverySource: source,
      }));
    },
  };
}

/**
 * DexScreener token boosts — PAID promotions, must be labeled.
 */
export class DexScreenerBoostDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'dexscreener-boosts';
  readonly dataMode: DataMode = 'live';

  async subscribe(): Promise<void> {}

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const url = `${env.DEXSCREENER_BASE_URL}/token-boosts/latest/v1`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
      }>;
      return (data ?? [])
        .filter((d) => d.chainId === 'solana' && d.tokenAddress && isSolAddress(d.tokenAddress))
        .slice(0, 15)
        .map((d) => ({
          chain: 'solana',
          address: d.tokenAddress!,
          symbol: d.tokenAddress!.slice(0, 6),
          name: d.description?.slice(0, 64) || 'Boosted Token',
          decimals: 9,
          createdAt: null,
          discoverySource: 'DEXSCREENER_BOOST' as const,
          metadata: {
            paidBoost: true,
            label: 'PAID_BOOST_NOT_ORGANIC_LAUNCH',
          },
        }));
    } catch (err) {
      logger.warn({ err }, 'DexScreener boost discovery failed');
      return [];
    }
  }
}

/**
 * DexScreener latest token profiles / new pairs (best-effort organic).
 */
export class DexScreenerNewPairDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'dexscreener-new-pairs';
  readonly dataMode: DataMode = 'live';

  async subscribe(): Promise<void> {}

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const url = `${env.DEXSCREENER_BASE_URL}/token-profiles/latest/v1`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
        url?: string;
      }>;
      return (data ?? [])
        .filter((d) => d.chainId === 'solana' && d.tokenAddress && isSolAddress(d.tokenAddress))
        .slice(0, 15)
        .map((d) => ({
          chain: 'solana',
          address: d.tokenAddress!,
          symbol: d.tokenAddress!.slice(0, 6),
          name: d.description?.slice(0, 64) || 'New Profile',
          decimals: 9,
          createdAt: null,
          discoverySource: 'DEXSCREENER_NEW_PAIR' as const,
          metadata: { profile: true },
        }));
    } catch (err) {
      logger.warn({ err }, 'DexScreener new pair discovery failed');
      return [];
    }
  }
}

/**
 * GeckoTerminal new pools on Solana.
 */
export class GeckoNewPoolDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'gecko-new-pools';
  readonly dataMode: DataMode = 'live';

  async subscribe(): Promise<void> {}

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const url = `${env.GECKOTERMINAL_BASE_URL}/networks/solana/new_pools?page=1`;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        data?: Array<{
          attributes?: {
            address?: string;
            name?: string;
            base_token_price_usd?: string;
            reserve_in_usd?: string;
            pool_created_at?: string;
          };
          relationships?: {
            base_token?: { data?: { id?: string } };
          };
        }>;
      };
      const out: EnrichedDiscoveredToken[] = [];
      for (const row of body.data ?? []) {
        const pool = row.attributes?.address;
        const tokenId = row.relationships?.base_token?.data?.id; // e.g. solana_ADDRESS
        const address = tokenId?.includes('_') ? tokenId.split('_')[1] : tokenId;
        if (!address || !isSolAddress(address)) continue;
        const created = row.attributes?.pool_created_at
          ? new Date(row.attributes.pool_created_at)
          : null;
        out.push({
          chain: 'solana',
          address,
          symbol: (row.attributes?.name ?? address).slice(0, 12),
          name: row.attributes?.name ?? 'New Pool',
          decimals: 9,
          createdAt: created,
          discoverySource: 'GECKO_NEW_POOL',
          poolAddress: pool ?? null,
          initialLiquidityUsd: row.attributes?.reserve_in_usd
            ? Number(row.attributes.reserve_in_usd)
            : null,
          firstLiquidityAt: created,
          dexVenue: 'unknown',
          metadata: { gecko: true },
        });
      }
      return out.slice(0, 20);
    } catch (err) {
      logger.warn({ err }, 'Gecko new pool discovery failed');
      return [];
    }
  }
}

/** Demo organic + synthetic launches with proper source labels. */
export class DemoMultiDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'demo-multi-discovery';
  readonly dataMode: DataMode = 'demo';

  async subscribe(): Promise<void> {}

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const now = Date.now();
    const organic: EnrichedDiscoveredToken[] = [
      {
        chain: 'solana',
        address: 'DemoOrganic111111111111111111111111111111',
        symbol: 'ORGA',
        name: 'Organic Launch Demo',
        decimals: 9,
        createdAt: new Date(now - 6 * 60_000),
        discoverySource: 'DEMO_ORGANIC',
        poolAddress: 'DemoPoolOrganic11111111111111111111111',
        quoteToken: 'So11111111111111111111111111111111111111112',
        initialLiquidityUsd: 12_000,
        firstLiquidityAt: new Date(now - 5 * 60_000),
        creatorWallet: 'DemoCreator111111111111111111111111111',
        dexVenue: 'raydium',
        metadata: { organic: true },
      },
      {
        chain: 'solana',
        address: 'DemoPump111111111111111111111111111111111',
        symbol: 'PFUN',
        name: 'Pump-style Demo',
        decimals: 9,
        createdAt: new Date(now - 3 * 60_000),
        discoverySource: 'PUMPFUN_LAUNCH',
        poolAddress: 'DemoPumpPool11111111111111111111111111',
        initialLiquidityUsd: 4_000,
        firstLiquidityAt: new Date(now - 3 * 60_000),
        dexVenue: 'pump',
        metadata: { pumpStyle: true },
      },
    ];
    // Also include classic demo tokens as DEMO_SYNTHETIC
    const { DemoTokenDiscoveryProvider } = await import('../demo/index.js');
    const legacy = new DemoTokenDiscoveryProvider();
    const base = await legacy.discoverRecentTokens(10);
    return [
      ...organic,
      ...base.map((t) => ({
        ...t,
        discoverySource: 'DEMO_SYNTHETIC' as const,
        dexVenue: 'demo',
      })),
    ];
  }
}

export class AggregatedDiscoveryProvider implements StreamTokenDiscoveryProvider {
  readonly name = 'aggregated-discovery';
  readonly dataMode: DataMode;

  constructor(private readonly providers: StreamTokenDiscoveryProvider[]) {
    this.dataMode = providers[0]?.dataMode ?? 'demo';
  }

  async subscribe(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.subscribe()));
  }

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const batches = await Promise.all(
      this.providers.map(async (p) => {
        try {
          return await p.getRecentTokens();
        } catch (err) {
          logger.warn({ err, provider: p.name }, 'Discovery provider failed');
          return [];
        }
      }),
    );
    const byAddr = new Map<string, EnrichedDiscoveredToken>();
    for (const batch of batches) {
      for (const t of batch) {
        const key = `${t.chain}:${t.address}`;
        const existing = byAddr.get(key);
        // Prefer organic / pool sources over paid boosts when merging
        if (!existing) {
          byAddr.set(key, t);
        } else if (
          existing.discoverySource === 'DEXSCREENER_BOOST' &&
          t.discoverySource !== 'DEXSCREENER_BOOST'
        ) {
          byAddr.set(key, {
            ...t,
            metadata: {
              ...t.metadata,
              alsoBoosted: true,
              boostSource: existing.discoverySource,
            },
          });
        }
      }
    }
    return [...byAddr.values()];
  }
}

export function createDiscoveryProviders(
  dataMode: DataMode,
): StreamTokenDiscoveryProvider {
  if (dataMode === 'demo') {
    return new DemoMultiDiscoveryProvider();
  }
  return new AggregatedDiscoveryProvider([
    new DexScreenerBoostDiscoveryProvider(),
    new DexScreenerNewPairDiscoveryProvider(),
    new GeckoNewPoolDiscoveryProvider(),
  ]);
}
