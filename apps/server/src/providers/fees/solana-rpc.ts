import type { DataMode } from '@memebot/shared';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { withRetry } from '../../utils/helpers.js';
import type { GasFeeEstimate, GasFeeProvider, OnChainDataProvider, OnChainTokenData } from '../types.js';

/**
 * Solana RPC gas/priority fee provider.
 * Uses getRecentPrioritizationFees when available.
 */
export class SolanaRpcGasFeeProvider implements GasFeeProvider {
  readonly name = 'solana-rpc-gas';
  readonly dataMode: DataMode = 'live';

  async getFeeEstimate(): Promise<GasFeeEstimate> {
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
      const median =
        fees.length === 0
          ? env.DEFAULT_PRIORITY_FEE_LAMPORTS
          : fees[Math.floor(fees.length / 2)]!;

      return {
        chain: 'solana',
        baseFeeLamports: 5000, // Solana signature fee ~5000 lamports
        priorityFeeLamports: Math.max(median, 1),
        solPriceUsd: env.DEFAULT_SOL_PRICE_USD,
        observedAt: new Date(),
      };
    } catch (err) {
      logger.error({ err }, 'Falling back to configured priority fee');
      return {
        chain: 'solana',
        baseFeeLamports: 5000,
        priorityFeeLamports: env.DEFAULT_PRIORITY_FEE_LAMPORTS,
        solPriceUsd: env.DEFAULT_SOL_PRICE_USD,
        observedAt: new Date(),
      };
    }
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
