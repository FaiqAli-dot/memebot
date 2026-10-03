import type { DataMode, LiquidityStatus } from '@memebot/shared';

export interface DiscoveredToken {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  createdAt: Date | null;
  metadata?: Record<string, unknown>;
}

export interface MarketQuote {
  chain: string;
  address: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  txCount5m: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  /** 0 when the provider reports none — check liquidityStatus before trusting it */
  liquidityUsd: number;
  /** KNOWN / UNKNOWN / BONDING_CURVE (pump.fun has no AMM pool liquidity) */
  liquidityStatus?: LiquidityStatus;
  buys5m?: number | null;
  sells5m?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  buys24h?: number | null;
  sells24h?: number | null;
  /** Pool/pair creation time from the provider (authoritative age source) */
  pairCreatedAt?: Date | null;
  observedAt: Date;
  poolAddress?: string | null;
  venue?: string | null;
  feeBps?: number | null;
  baseReserve?: number | null;
  quoteReserve?: number | null;
}

export interface OnChainTokenData {
  chain: string;
  address: string;
  holderCount: number | null;
  topHolderPct: number | null;
  top10HolderPct: number | null;
  observedAt: Date;
}

export interface SolPriceQuote {
  priceUsd: number;
  source: string;
  observedAt: Date;
  stale: boolean;
  dataMode: DataMode;
}

export interface GasFeeEstimate {
  chain: string;
  baseFeeLamports: number;
  priorityFeeLamports: number;
  /** null when SOL/USD unavailable — live path must not invent a price */
  solPriceUsd: number | null;
  solPriceSource: string | null;
  solPriceObservedAt: Date | null;
  solPriceStale: boolean;
  /** false when fees cannot safely be converted to USD */
  usable: boolean;
  observedAt: Date;
}

export interface TokenDiscoveryProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  discoverRecentTokens(limit?: number): Promise<DiscoveredToken[]>;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  getMarketQuotes(addresses: string[], chain?: string): Promise<MarketQuote[]>;
}

export interface PriceProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  getPriceUsd(address: string, chain?: string): Promise<number | null>;
}

/** Native SOL/USD for fee conversion (separate from meme-token PriceProvider). */
export interface SolPriceProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  getSolPriceUsd(): Promise<SolPriceQuote | null>;
}

export interface OnChainDataProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  getHolderData(address: string, chain?: string): Promise<OnChainTokenData | null>;
}

export interface GasFeeProvider {
  readonly name: string;
  readonly dataMode: DataMode;
  getFeeEstimate(chain?: string): Promise<GasFeeEstimate>;
}

/** Wrapped SOL mint on Solana mainnet */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
