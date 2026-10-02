import { env, dataMode } from '../config/env.js';
import {
  DemoGasFeeProvider,
  DemoMarketDataProvider,
  DemoOnChainDataProvider,
  DemoTokenDiscoveryProvider,
} from './demo/index.js';
import {
  DexScreenerMarketDataProvider,
  DexScreenerTokenDiscoveryProvider,
} from './token-discovery/dexscreener.js';
import {
  GeckoTerminalOnChainProvider,
  SolanaRpcGasFeeProvider,
} from './fees/solana-rpc.js';
import type {
  GasFeeProvider,
  MarketDataProvider,
  OnChainDataProvider,
  PriceProvider,
  TokenDiscoveryProvider,
} from './types.js';

export interface ProviderBundle {
  tokenDiscovery: TokenDiscoveryProvider;
  marketData: MarketDataProvider & PriceProvider;
  onChain: OnChainDataProvider;
  gasFee: GasFeeProvider;
  dataMode: 'demo' | 'live';
}

export function createProviders(): ProviderBundle {
  if (dataMode === 'demo') {
    const market = new DemoMarketDataProvider();
    return {
      tokenDiscovery: new DemoTokenDiscoveryProvider(),
      marketData: market,
      onChain: new DemoOnChainDataProvider(),
      gasFee: new DemoGasFeeProvider(),
      dataMode: 'demo',
    };
  }

  const market = new DexScreenerMarketDataProvider();
  return {
    tokenDiscovery: new DexScreenerTokenDiscoveryProvider(),
    marketData: market,
    onChain: new GeckoTerminalOnChainProvider(),
    gasFee: new SolanaRpcGasFeeProvider(),
    dataMode: 'live',
  };
}

export function getStalePriceMaxAgeMs(): number {
  return env.STALE_PRICE_MAX_AGE_MS;
}
