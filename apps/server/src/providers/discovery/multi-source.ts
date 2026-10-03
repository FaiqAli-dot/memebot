/**
 * Multi-source token discovery. DexScreener boosts are labeled PAID_BOOST — not organic.
 * Strategy must not know data origin; origin is stored on the token.
 *
 * Sources fail independently — one broken feed never stops the others.
 */
import type { DataMode, DiscoverySource } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { DiscoveredToken, TokenDiscoveryProvider } from '../types.js';
import { MeteoraDbcDiscoveryProvider } from './meteora-dbc.js';
import { recordSourceFailure, recordSourceSuccess } from '../../intelligence/source-health.js';

export interface EnrichedDiscoveredToken extends DiscoveredToken {
  discoverySource: DiscoverySource;
  /** All sources that contributed in this poll merge (dedup helper). */
  allDiscoverySources?: DiscoverySource[];
  poolAddress?: string | null;
  quoteToken?: string | null;
  initialLiquidityUsd?: number | null;
  creatorWallet?: string | null;
  /** Actual trading venue when determinable (separate from discoverySource). */
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

/** Infer venue from GeckoTerminal pool name / dex id when present. */
export function inferGeckoVenue(opts: {
  name?: string | null;
  dexId?: string | null;
  address?: string | null;
}): string {
  const dex = (opts.dexId ?? '').toLowerCase();
  const name = (opts.name ?? '').toLowerCase();
  if (dex.includes('meteora') || name.includes('meteora')) {
    if (name.includes('dbc') || dex.includes('dbc') || dex.includes('dynamic-bonding')) {
      return 'meteora_dbc';
    }
    if (dex.includes('damm') || name.includes('damm')) return 'meteora_damm';
    return 'meteora';
  }
  if (dex.includes('raydium') || name.includes('raydium')) return 'raydium';
  if (dex.includes('orca') || name.includes('orca')) return 'orca';
  if (dex.includes('pump') || name.includes('pump')) return 'pump';
  if (dex) return dex.replace(/[^a-z0-9_.-]+/g, '_').slice(0, 32);
  return 'unknown';
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
      throw err;
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
      throw err;
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
            dex_id?: string;
          };
          relationships?: {
            base_token?: { data?: { id?: string } };
            dex?: { data?: { id?: string } };
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
        const dexId =
          row.attributes?.dex_id ??
          row.relationships?.dex?.data?.id?.replace(/^solana_/i, '') ??
          null;
        const venue = inferGeckoVenue({
          name: row.attributes?.name,
          dexId,
          address: pool,
        });
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
          dexVenue: venue,
          metadata: {
            gecko: true,
            geckoDexId: dexId,
            launchMechanism: venue.startsWith('meteora') ? venue : null,
          },
        });
      }
      return out.slice(0, 20);
    } catch (err) {
      logger.warn({ err }, 'Gecko new pool discovery failed');
      throw err;
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
      {
        chain: 'solana',
        // Demo-only fixture shaped like a Meteora DBC pre-migration mint (NOT a real SPEC hardcode)
        address: 'DemoMeteoraDbc11111111111111111111111111',
        symbol: 'MDBC',
        name: 'Demo Meteora DBC',
        decimals: 6,
        createdAt: new Date(now - 2 * 60_000),
        discoverySource: 'METEORA_DBC',
        poolAddress: 'DemoMeteoraDbcPool11111111111111111111',
        quoteToken: 'So11111111111111111111111111111111111111112',
        initialLiquidityUsd: 8_500,
        firstLiquidityAt: new Date(now - 2 * 60_000),
        creatorWallet: 'DemoMeteoraCreator1111111111111111111',
        dexVenue: 'meteora_dbc',
        metadata: {
          meteoraDbc: true,
          launchMechanism: 'meteora_dbc',
          dbcStatus: 'PRE_BONDING_CURVE',
          migrationStatus: 'NOT_MIGRATED',
          preMigration: true,
        },
      },
    ];
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
    await Promise.all(
      this.providers.map(async (p) => {
        try {
          await p.subscribe();
        } catch (err) {
          logger.warn({ err, provider: p.name }, 'Discovery subscribe failed');
          await recordSourceFailure(p.name, err).catch(() => undefined);
        }
      }),
    );
  }

  async getRecentTokens(): Promise<EnrichedDiscoveredToken[]> {
    const batches = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const tokens = await p.getRecentTokens();
          await recordSourceSuccess(p.name, tokens.length).catch(() => undefined);
          return tokens;
        } catch (err) {
          logger.warn({ err, provider: p.name }, 'Discovery provider failed');
          await recordSourceFailure(p.name, err).catch(() => undefined);
          return [] as EnrichedDiscoveredToken[];
        }
      }),
    );

    const byAddr = new Map<string, EnrichedDiscoveredToken>();
    for (const batch of batches) {
      for (const t of batch) {
        const key = `${t.chain}:${t.address}`;
        const existing = byAddr.get(key);
        if (!existing) {
          byAddr.set(key, {
            ...t,
            allDiscoverySources: [t.discoverySource],
          });
          continue;
        }
        const sources = [
          ...new Set([
            ...(existing.allDiscoverySources ?? [existing.discoverySource]),
            t.discoverySource,
          ]),
        ];
        // Prefer organic / pool / DBC sources over paid boosts when merging primary fields
        const preferNew =
          existing.discoverySource === 'DEXSCREENER_BOOST' &&
          t.discoverySource !== 'DEXSCREENER_BOOST';
        const preferVenue =
          (!existing.dexVenue || existing.dexVenue === 'unknown') &&
          t.dexVenue &&
          t.dexVenue !== 'unknown';
        const base = preferNew ? t : existing;
        byAddr.set(key, {
          ...base,
          discoverySource: preferNew ? t.discoverySource : existing.discoverySource,
          allDiscoverySources: sources,
          dexVenue: preferVenue ? t.dexVenue : base.dexVenue,
          poolAddress: base.poolAddress ?? t.poolAddress,
          creatorWallet: base.creatorWallet ?? t.creatorWallet,
          metadata: {
            ...existing.metadata,
            ...t.metadata,
            allDiscoverySources: sources,
            alsoBoosted:
              sources.includes('DEXSCREENER_BOOST') &&
              sources.some((s) => s !== 'DEXSCREENER_BOOST'),
          },
        });
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
  const providers: StreamTokenDiscoveryProvider[] = [
    new DexScreenerBoostDiscoveryProvider(),
    new DexScreenerNewPairDiscoveryProvider(),
    new GeckoNewPoolDiscoveryProvider(),
  ];
  if (env.METEORA_DBC_ENABLED) {
    providers.push(new MeteoraDbcDiscoveryProvider());
  }
  return new AggregatedDiscoveryProvider(providers);
}
