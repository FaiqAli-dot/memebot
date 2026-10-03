/**
 * Pre-trade round-trip cost estimate for a specific position size.
 *
 * Mirrors what the paper simulator (engines/cost/simulator.ts) actually charges, so
 * the EV gate and paper P&L agree: the executed price moves adversely by
 * (priceImpact + slippage) per leg, the DEX fee is deducted per leg, and network
 * base + priority + Jito tip is paid per transaction. Percentage costs scale with
 * size; network costs are fixed per transaction.
 *
 * Exit leg is approximated with the entry pool state (liquidity at decision time).
 */
import type { ExecutionCostEstimate } from '@memebot/shared';
import {
  constantProductPriceImpactPct,
  estimateSlippagePct,
  lamportsToUsd,
  resolveDexFeeBps,
} from '../engines/cost/simulator.js';
import type { GasFeeEstimate, MarketQuote } from '../providers/types.js';

/** Base + priority + Jito tip for one transaction; null when SOL/USD is unusable. */
export function networkFeePerLegUsd(
  gas: Pick<GasFeeEstimate, 'usable' | 'solPriceUsd' | 'solPriceStale' | 'baseFeeLamports' | 'priorityFeeLamports'> | null,
  opts: { priorityFeeLamports?: number; jitoTipLamports?: number } = {},
): number | null {
  if (!gas || !gas.usable || gas.solPriceStale || gas.solPriceUsd == null || gas.solPriceUsd <= 0) {
    return null;
  }
  const lamports =
    gas.baseFeeLamports + (opts.priorityFeeLamports || gas.priorityFeeLamports) + (opts.jitoTipLamports ?? 0);
  return lamportsToUsd(lamports, gas.solPriceUsd);
}

export function estimateRoundTripCost(opts: {
  positionSizeUsd: number;
  liquidityUsd: number;
  venue?: string | null;
  feeBps?: number | null;
  absPriceChange5mPct?: number;
  /** null when it cannot be priced — never invented */
  networkFeePerLegUsd: number | null;
  /** Expected adverse selection per leg from quote staleness (fraction) */
  adverseSelectionRatePerLeg?: number;
}): ExecutionCostEstimate {
  const size = Math.max(0, opts.positionSizeUsd);
  const liquidity = Math.max(0, opts.liquidityUsd);
  const feeBps = resolveDexFeeBps({ venue: opts.venue ?? null, feeBps: opts.feeBps ?? null } as MarketQuote);
  const dexFeeRateLeg = feeBps / 10_000;
  const impactPctLeg = constantProductPriceImpactPct(size, liquidity / 2);
  const slippagePctLeg = estimateSlippagePct({
    priceImpactPct: impactPctLeg,
    liquidityUsd: liquidity,
    tradeUsd: size,
    absPriceChange5mPct: Math.abs(opts.absPriceChange5mPct ?? 0),
  });

  const legs = 2;
  const dexFeeRate = dexFeeRateLeg * legs;
  const priceImpactRate = (impactPctLeg / 100) * legs;
  const slippageRate = (slippagePctLeg / 100 + (opts.adverseSelectionRatePerLeg ?? 0)) * legs;
  const networkFeePriced = opts.networkFeePerLegUsd != null;
  const networkFeeUsd = (opts.networkFeePerLegUsd ?? 0) * legs;

  const dexFeeUsd = size * dexFeeRate;
  const priceImpactUsd = size * priceImpactRate;
  const slippageUsd = size * slippageRate;
  const totalCostUsd = dexFeeUsd + priceImpactUsd + slippageUsd + networkFeeUsd;
  const totalCostRate = size > 0 ? totalCostUsd / size : 1;

  return {
    positionSizeUsd: size,
    dexFeeRate,
    dexFeeUsd,
    priceImpactRate,
    priceImpactUsd,
    slippageRate,
    slippageUsd,
    networkFeeUsd,
    totalCostUsd,
    totalCostRate,
    networkFeePriced,
  };
}
