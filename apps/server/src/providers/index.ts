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
import {
  CachedSolPriceProvider,
  CoinGeckoSolPriceProvider,
  DemoSolPriceProvider,
  DexScreenerSolPriceProvider,
} from './market/sol-price.js';
import type {
  GasFeeProvider,
  MarketDataProvider,
  OnChainDataProvider,
  PriceProvider,
  SolPriceProvider,
  TokenDiscoveryProvider,
} from './types.js';

export interface ProviderBundle {
  tokenDiscovery: TokenDiscoveryProvider;
  marketData: MarketDataProvider & PriceProvider;
  onChain: OnChainDataProvider;
  gasFee: GasFeeProvider;
  solPrice: SolPriceProvider;
  dataMode: 'demo' | 'live';
}

export function createProviders(): ProviderBundle {
  if (dataMode === 'demo') {
    const market = new DemoMarketDataProvider();
    const solPrice = new DemoSolPriceProvider();
    return {
      tokenDiscovery: new DemoTokenDiscoveryProvider(),
      marketData: market,
      onChain: new DemoOnChainDataProvider(),
      gasFee: new DemoGasFeeProvider(),
      solPrice,
      dataMode: 'demo',
    };
  }

  const solPrice = new CachedSolPriceProvider(
    new DexScreenerSolPriceProvider(),
    new CoinGeckoSolPriceProvider(),
    env.SOL_PRICE_CACHE_TTL_MS,
    env.SOL_PRICE_MAX_STALE_MS,
    'live',
  );
  const market = new DexScreenerMarketDataProvider();
  return {
    tokenDiscovery: new DexScreenerTokenDiscoveryProvider(),
    marketData: market,
    onChain: new GeckoTerminalOnChainProvider(),
    gasFee: new SolanaRpcGasFeeProvider(solPrice),
    solPrice,
    dataMode: 'live',
  };
}

export function getStalePriceMaxAgeMs(): number {
  return env.STALE_PRICE_MAX_AGE_MS;
}

export function isGasUsableForTrading(gas: {
  usable: boolean;
  solPriceUsd: number | null;
  solPriceStale: boolean;
}): boolean {
  return (
    gas.usable &&
    gas.solPriceUsd != null &&
    Number.isFinite(gas.solPriceUsd) &&
    gas.solPriceUsd > 0 &&
    !gas.solPriceStale
  );
}
