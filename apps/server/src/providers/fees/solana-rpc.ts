import type { DataMode } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { withRetry } from '../../utils/helpers.js';
import type {
  GasFeeEstimate,
  GasFeeProvider,
  OnChainDataProvider,
  OnChainTokenData,
  SolPriceProvider,
} from '../types.js';

/**
 * Solana RPC gas/priority fee provider.
 * SOL/USD comes from SolPriceProvider — never silently invents a live price.
 */
export class SolanaRpcGasFeeProvider implements GasFeeProvider {
  readonly name = 'solana-rpc-gas';
  readonly dataMode: DataMode = 'live';

  constructor(private readonly solPrice: SolPriceProvider) {}

  async getFeeEstimate(): Promise<GasFeeEstimate> {
    const sol = await this.solPrice.getSolPriceUsd();
    const solPriceUsd = sol && !sol.stale ? sol.priceUsd : sol?.priceUsd ?? null;
    const solPriceStale = sol?.stale ?? true;
    const usable =
      sol != null &&
      sol.priceUsd > 0 &&
      Number.isFinite(sol.priceUsd) &&
      !sol.stale;

    let priorityFeeLamports = env.DEFAULT_PRIORITY_FEE_LAMPORTS;
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getRecentPrioritizationFees',
        params: [[]],
      };
      const data = await withRetry(
        async () => {
          const res = await fetch(env.SOLANA_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
          return res.json() as Promise<{
            result?: Array<{ prioritizationFee: number }>;
          }>;
        },
        {
          maxRetries: env.PROVIDER_MAX_RETRIES,
          baseMs: env.PROVIDER_RETRY_BASE_MS,
          label: 'solana-rpc-priority-fees',
          onError: (err, attempt) =>
            logger.warn({ err, attempt }, 'Solana RPC fee request failed'),
        },
      );

      const fees = (data.result ?? [])
        .map((r) => r.prioritizationFee)
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
      if (fees.length > 0) {
        priorityFeeLamports = Math.max(fees[Math.floor(fees.length / 2)]!, 1);
      }
    } catch (err) {
      logger.error({ err }, 'Using configured priority fee lamports (RPC unavailable)');
    }

    if (!usable) {
      logger.warn(
        { solPriceUsd, solPriceStale, source: sol?.source ?? null },
        'SOL/USD unavailable or stale — fee estimate not usable for new paper trades',
      );
    }

    return {
      chain: 'solana',
      baseFeeLamports: 5000,
      priorityFeeLamports,
      solPriceUsd: usable ? solPriceUsd : null,
      solPriceSource: sol?.source ?? null,
      solPriceObservedAt: sol?.observedAt ?? null,
      solPriceStale: !usable,
      usable,
      observedAt: new Date(),
    };
  }
}

/**
 * Holder concentration — best-effort via GeckoTerminal pool data when available.
 * Returns nulls when data is unavailable (never invents holders).
 */
export class GeckoTerminalOnChainProvider implements OnChainDataProvider {
  readonly name = 'geckoterminal-onchain';
  readonly dataMode: DataMode = 'live';

  async getHolderData(address: string): Promise<OnChainTokenData | null> {
    try {
      const url = `${env.GECKOTERMINAL_BASE_URL}/networks/solana/tokens/${address}/info`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { attributes?: Record<string, unknown> };
      };
      const attrs = json.data?.attributes ?? {};
      const holders = attrs.holders;
      const holderCount =
        typeof holders === 'number'
          ? holders
          : typeof holders === 'object' && holders && 'count' in holders
            ? Number((holders as { count?: number }).count)
            : null;
      return {
        chain: 'solana',
        address,
        holderCount: Number.isFinite(holderCount as number) ? (holderCount as number) : null,
        topHolderPct: null,
        top10HolderPct: null,
        observedAt: new Date(),
      };
    } catch (err) {
      logger.warn({ err, address }, 'GeckoTerminal holder fetch failed');
      return null;
    }
  }
}
