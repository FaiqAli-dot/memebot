import type { DataMode } from '@memebot/shared';

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
  liquidityUsd: number;
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

export interface GasFeeEstimate {
  chain: string;
  baseFeeLamports: number;
  priorityFeeLamports: number;
  solPriceUsd: number;
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
