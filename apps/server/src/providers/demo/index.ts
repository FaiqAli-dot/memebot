/**
 * Deterministic demo market data for local development without API keys.
 * Results are labeled data_mode='demo' and never mixed with live rows.
 */
import type { DataMode } from '@memebot/shared';
import type {
  DiscoveredToken,
  GasFeeEstimate,
  GasFeeProvider,
  MarketDataProvider,
  MarketQuote,
  OnChainDataProvider,
  OnChainTokenData,
  PriceProvider,
  TokenDiscoveryProvider,
} from '../types.js';

const DEMO_TOKENS: Array<{
  address: string;
  symbol: string;
  name: string;
  seed: number;
  ageMinutesOffset: number;
}> = [
  { address: 'Demo1111111111111111111111111111111111111', symbol: 'PEPE2', name: 'Pepe Two Demo', seed: 11, ageMinutesOffset: 8 },
  { address: 'Demo2222222222222222222222222222222222222', symbol: 'WIFX', name: 'Wif Extended Demo', seed: 22, ageMinutesOffset: 25 },
  { address: 'Demo3333333333333333333333333333333333333', symbol: 'BONK2', name: 'Bonk Remix Demo', seed: 33, ageMinutesOffset: 45 },
  { address: 'Demo4444444444444444444444444444444444444', symbol: 'MOON', name: 'Moon Shot Demo', seed: 44, ageMinutesOffset: 12 },
  { address: 'Demo5555555555555555555555555555555555555', symbol: 'FROG', name: 'Frog Coin Demo', seed: 55, ageMinutesOffset: 90 },
  { address: 'Demo6666666666666666666666666666666666666', symbol: 'CHAD', name: 'Chad Meme Demo', seed: 66, ageMinutesOffset: 18 },
  { address: 'Demo7777777777777777777777777777777777777', symbol: 'RUG?', name: 'Risky Demo Token', seed: 77, ageMinutesOffset: 5 },
  { address: 'Demo8888888888888888888888888888888888888', symbol: 'DEGEN', name: 'Degen Play Demo', seed: 88, ageMinutesOffset: 60 },
  { address: 'Demo9999999999999999999999999999999999999', symbol: 'CATS', name: 'Cats On Sol Demo', seed: 99, ageMinutesOffset: 35 },
  { address: 'DemoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', symbol: 'PUMP', name: 'Pump Demo', seed: 101, ageMinutesOffset: 15 },
];

function hashSeed(n: number, t: number): number {
  const x = Math.sin(n * 12.9898 + t * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function wave(seed: number, nowMs: number, periodMs: number, amp = 1): number {
  const phase = (nowMs / periodMs + seed) * Math.PI * 2;
  return Math.sin(phase) * amp;
}

export class DemoTokenDiscoveryProvider implements TokenDiscoveryProvider {
  readonly name = 'demo-token-discovery';
  readonly dataMode: DataMode = 'demo';

  async discoverRecentTokens(limit = 10): Promise<DiscoveredToken[]> {
    const now = Date.now();
    // Gradually "discover" tokens over time based on elapsed minutes
    const unlocked = Math.min(
      DEMO_TOKENS.length,
      Math.max(3, 3 + Math.floor((now / 60_000) % DEMO_TOKENS.length)),
    );
    return DEMO_TOKENS.slice(0, Math.min(limit, unlocked)).map((t) => ({
      chain: 'solana',
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: 9,
      createdAt: new Date(now - t.ageMinutesOffset * 60_000),
      metadata: { demo: true, seed: t.seed },
    }));
  }
}

export class DemoMarketDataProvider implements MarketDataProvider, PriceProvider {
  readonly name = 'demo-market-data';
  readonly dataMode: DataMode = 'demo';

  async getPriceUsd(address: string): Promise<number | null> {
    const quotes = await this.getMarketQuotes([address]);
    return quotes[0]?.priceUsd ?? null;
  }

  async getMarketQuotes(addresses: string[]): Promise<MarketQuote[]> {
    const now = Date.now();
    const out: MarketQuote[] = [];
    for (const address of addresses) {
      const meta = DEMO_TOKENS.find((t) => t.address === address);
      if (!meta) continue;
      const h = hashSeed(meta.seed, Math.floor(now / 5000));
      const basePrice = 0.00001 + (meta.seed % 50) * 0.000002;
      const priceUsd = Math.max(
        1e-9,
        basePrice * (1 + wave(meta.seed, now, 120_000, 0.12) + (h - 0.5) * 0.04),
      );
      const liquidityUsd = 8_000 + meta.seed * 120 + wave(meta.seed + 1, now, 180_000, 3_000);
      const volume5mUsd = Math.max(
        100,
        2_000 + meta.seed * 40 + wave(meta.seed + 2, now, 90_000, 4_000) + h * 1500,
      );
      const volume1hUsd = volume5mUsd * (8 + h * 4);
      const buyRatio = 0.45 + wave(meta.seed + 3, now, 100_000, 0.2) + (h - 0.5) * 0.1;
      const buyVolume5mUsd = volume5mUsd * Math.min(0.9, Math.max(0.1, buyRatio));
      const sellVolume5mUsd = volume5mUsd - buyVolume5mUsd;
      const priceChange5mPct =
        wave(meta.seed + 4, now, 80_000, 8) + (meta.seed % 7) - 2;
      const feeBps = meta.seed % 2 === 0 ? 25 : 30;
      const liq =
        meta.symbol === 'RUG?'
          ? Math.max(200, liquidityUsd * (0.2 + h * 0.3))
          : Math.max(500, liquidityUsd);

      out.push({
        chain: 'solana',
        address,
        priceUsd,
        marketCapUsd: priceUsd * (50_000_000 + meta.seed * 100_000),
        volume5mUsd,
        volume1hUsd,
        volume24hUsd: volume1hUsd * 6,
        buyVolume5mUsd,
        sellVolume5mUsd,
        txCount5m: Math.floor(20 + h * 80 + meta.seed / 10),
        priceChange5mPct,
        priceChange1hPct: priceChange5mPct * 2.2,
        liquidityUsd: liq,
        observedAt: new Date(now),
        poolAddress: `DemoPool${meta.seed}`,
        venue: 'demo-amm',
        feeBps,
        baseReserve: liq / 2 / priceUsd,
        quoteReserve: liq / 2,
      });
    }
    return out;
  }
}

export class DemoOnChainDataProvider implements OnChainDataProvider {
  readonly name = 'demo-onchain';
  readonly dataMode: DataMode = 'demo';

  async getHolderData(address: string): Promise<OnChainTokenData | null> {
    const meta = DEMO_TOKENS.find((t) => t.address === address);
    if (!meta) return null;
    const now = Date.now();
    const h = hashSeed(meta.seed, Math.floor(now / 30_000));
    const topHolderPct =
      meta.symbol === 'RUG?' ? 35 + h * 20 : 5 + (meta.seed % 15) + h * 5;
    return {
      chain: 'solana',
      address,
      holderCount: Math.floor(80 + meta.seed * 3 + h * 40),
      topHolderPct,
      top10HolderPct: Math.min(95, topHolderPct * 2.5 + 10),
      observedAt: new Date(now),
    };
  }
}

export class DemoGasFeeProvider implements GasFeeProvider {
  readonly name = 'demo-gas';
  readonly dataMode: DataMode = 'demo';

  async getFeeEstimate(): Promise<GasFeeEstimate> {
    const now = Date.now();
    const h = hashSeed(7, Math.floor(now / 10_000));
    return {
      chain: 'solana',
      baseFeeLamports: 5000,
      priorityFeeLamports: Math.floor(2000 + h * 8000),
      solPriceUsd: 150 + wave(1, now, 600_000, 5),
      observedAt: new Date(now),
    };
  }
}
