/**
 * Cost / fee / slippage / price-impact simulator.
 *
 * Assumptions (documented in README):
 * - DEX fee: pool fee_bps when known; otherwise venue default (Raydium 25 bps, Pump.fun-like 100 bps, unknown 30 bps).
 * - Network fee: Solana base signature fee (5000 lamports) * SOL/USD.
 * - Priority fee: observed median prioritization fee (or configured default) * SOL/USD.
 * - Price impact: constant-product AMM (x*y=k) using quoteReserve/baseReserve when available;
 *   otherwise approximate impact = tradeUsd / (liquidityUsd + tradeUsd).
 * - Slippage: impact + volatility buffer from recent |priceChange5m| + size/liquidity ratio.
 * - Failed txs may still incur network+priority fees when configured.
 * - Partial fills when trade size > ~15% of liquidity (fill up to 12% of liquidity).
 */
import type { CostBreakdown, ExecutionRecord } from '@memebot/shared';
import { round, clamp, safeDiv } from '../../utils/helpers.js';
import type { GasFeeEstimate, MarketQuote } from '../../providers/types.js';

export interface SimulateTradeInput {
  side: 'BUY' | 'SELL';
  requestedAmountUsd: number;
  midPriceUsd: number;
  quote: MarketQuote;
  gas: GasFeeEstimate;
  priorityFeeLamports: number;
  failedTxStillChargesNetwork: boolean;
  /** Force failure for edge-case tests */
  forceFail?: boolean;
  forceFailReason?: string;
}

export interface SimulateTradeResult {
  execution: ExecutionRecord;
  costs: CostBreakdown;
}

function venueDefaultFeeBps(venue: string | null | undefined): number {
  const v = (venue ?? '').toLowerCase();
  if (v.includes('raydium')) return 25;
  if (v.includes('orca')) return 30;
  if (v.includes('pump')) return 100;
  if (v.includes('demo')) return 25;
  return 30;
}

export function resolveDexFeeBps(quote: MarketQuote): number {
  if (quote.feeBps != null && Number.isFinite(quote.feeBps) && quote.feeBps >= 0) {
    return quote.feeBps;
  }
  return venueDefaultFeeBps(quote.venue);
}

/** Constant-product price impact for buying `amountUsd` of base with quote reserve. */
export function constantProductPriceImpactPct(
  amountUsd: number,
  quoteReserveUsd: number,
): number {
  if (quoteReserveUsd <= 0 || amountUsd <= 0) return 100;
  // Buying base with quote: newPrice/oldPrice - 1 ≈ amount / (reserve - amount) for small moves;
  // exact: impact = amount / (reserve + amount) for average execution vs mid.
  return (amountUsd / (quoteReserveUsd + amountUsd)) * 100;
}

export function estimateSlippagePct(opts: {
  priceImpactPct: number;
  liquidityUsd: number;
  tradeUsd: number;
  absPriceChange5mPct: number;
}): number {
  const sizeRatio = safeDiv(opts.tradeUsd, opts.liquidityUsd, 1);
  const volBuffer = clamp(opts.absPriceChange5mPct * 0.15, 0, 5);
  const liquidityBuffer = clamp(sizeRatio * 8, 0.05, 15);
  return clamp(opts.priceImpactPct + volBuffer + liquidityBuffer * 0.25, 0.05, 50);
}

export function lamportsToUsd(lamports: number, solPriceUsd: number): number {
  return (lamports / 1_000_000_000) * solPriceUsd;
}

export function simulateTrade(input: SimulateTradeInput): SimulateTradeResult {
  const {
    side,
    requestedAmountUsd,
    midPriceUsd,
    quote,
    gas,
    priorityFeeLamports,
    failedTxStillChargesNetwork,
    forceFail,
    forceFailReason,
  } = input;

  const networkFeeUsd = lamportsToUsd(gas.baseFeeLamports, gas.solPriceUsd);
  const priorityFeeUsd = lamportsToUsd(
    priorityFeeLamports || gas.priorityFeeLamports,
    gas.solPriceUsd,
  );

  const liquidityUsd = Math.max(0, quote.liquidityUsd);
  const quoteReserve =
    quote.quoteReserve && quote.quoteReserve > 0
      ? quote.quoteReserve
      : liquidityUsd / 2;

  // Untradeable / zero liquidity
  if (liquidityUsd <= 0 || midPriceUsd <= 0 || !Number.isFinite(midPriceUsd)) {
    const costs: CostBreakdown = {
      dexFeeUsd: 0,
      networkFeeUsd: failedTxStillChargesNetwork ? networkFeeUsd : 0,
      priorityFeeUsd: failedTxStillChargesNetwork ? priorityFeeUsd : 0,
      slippageCostUsd: 0,
      priceImpactPct: 0,
      priceImpactCostUsd: 0,
      totalCostUsd:
        (failedTxStillChargesNetwork ? networkFeeUsd + priorityFeeUsd : 0),
    };
    return {
      costs,
      execution: {
        requestedPriceUsd: midPriceUsd,
        executedPriceUsd: 0,
        requestedAmountUsd,
        filledAmountUsd: 0,
        tokenQuantity: 0,
        priceImpactPct: 0,
        slippagePct: 0,
        dexFeeUsd: 0,
        networkFeeUsd: costs.networkFeeUsd,
        priorityFeeUsd: costs.priorityFeeUsd,
        totalCostUsd: costs.totalCostUsd,
        partial: false,
        failed: true,
        failureReason: forceFailReason ?? 'Token unavailable: zero or missing liquidity',
      },
    };
  }

  if (forceFail) {
    const costs: CostBreakdown = {
      dexFeeUsd: 0,
      networkFeeUsd: failedTxStillChargesNetwork ? networkFeeUsd : 0,
      priorityFeeUsd: failedTxStillChargesNetwork ? priorityFeeUsd : 0,
      slippageCostUsd: 0,
      priceImpactPct: 0,
      priceImpactCostUsd: 0,
      totalCostUsd: failedTxStillChargesNetwork ? networkFeeUsd + priorityFeeUsd : 0,
    };
    return {
      costs,
      execution: {
        requestedPriceUsd: midPriceUsd,
        executedPriceUsd: 0,
        requestedAmountUsd,
        filledAmountUsd: 0,
        tokenQuantity: 0,
        priceImpactPct: 0,
        slippagePct: 0,
        dexFeeUsd: 0,
        networkFeeUsd: costs.networkFeeUsd,
        priorityFeeUsd: costs.priorityFeeUsd,
        totalCostUsd: costs.totalCostUsd,
        partial: false,
        failed: true,
        failureReason: forceFailReason ?? 'Simulated execution failure',
      },
    };
  }

  // Partial fill if trade is large vs liquidity
  let fillUsd = requestedAmountUsd;
  let partial = false;
  const maxFill = liquidityUsd * 0.12;
  if (requestedAmountUsd > liquidityUsd * 0.15) {
    fillUsd = Math.min(requestedAmountUsd, maxFill);
    partial = fillUsd < requestedAmountUsd;
  }
  if (fillUsd < liquidityUsd * 0.0001 || fillUsd <= 0) {
    const costs: CostBreakdown = {
      dexFeeUsd: 0,
      networkFeeUsd: failedTxStillChargesNetwork ? networkFeeUsd : 0,
      priorityFeeUsd: failedTxStillChargesNetwork ? priorityFeeUsd : 0,
      slippageCostUsd: 0,
      priceImpactPct: 0,
      priceImpactCostUsd: 0,
      totalCostUsd: failedTxStillChargesNetwork ? networkFeeUsd + priorityFeeUsd : 0,
    };
    return {
      costs,
      execution: {
        requestedPriceUsd: midPriceUsd,
        executedPriceUsd: 0,
        requestedAmountUsd,
        filledAmountUsd: 0,
        tokenQuantity: 0,
        priceImpactPct: 0,
        slippagePct: 0,
        dexFeeUsd: 0,
        networkFeeUsd: costs.networkFeeUsd,
        priorityFeeUsd: costs.priorityFeeUsd,
        totalCostUsd: costs.totalCostUsd,
        partial: false,
        failed: true,
        failureReason: 'Unfillable: trade size below minimum or liquidity too low',
      },
    };
  }

  const priceImpactPct = constantProductPriceImpactPct(fillUsd, quoteReserve);
  const slippagePct = estimateSlippagePct({
    priceImpactPct,
    liquidityUsd,
    tradeUsd: fillUsd,
    absPriceChange5mPct: Math.abs(quote.priceChange5mPct),
  });

  const adversePct = (priceImpactPct + slippagePct) / 100;
  const executedPriceUsd =
    side === 'BUY'
      ? midPriceUsd * (1 + adversePct)
      : midPriceUsd * (1 - adversePct);

  const feeBps = resolveDexFeeBps(quote);
  const dexFeeUsd = fillUsd * (feeBps / 10_000);
  const priceImpactCostUsd = fillUsd * (priceImpactPct / 100);
  const slippageCostUsd = fillUsd * (slippagePct / 100);

  // Token quantity from executed price after DEX fee on notional
  const effectiveUsd = Math.max(0, fillUsd - dexFeeUsd);
  const tokenQuantity = executedPriceUsd > 0 ? effectiveUsd / executedPriceUsd : 0;

  const totalCostUsd =
    dexFeeUsd + networkFeeUsd + priorityFeeUsd + slippageCostUsd;

  const costs: CostBreakdown = {
    dexFeeUsd: round(dexFeeUsd),
    networkFeeUsd: round(networkFeeUsd),
    priorityFeeUsd: round(priorityFeeUsd),
    slippageCostUsd: round(slippageCostUsd),
    priceImpactPct: round(priceImpactPct, 6),
    priceImpactCostUsd: round(priceImpactCostUsd),
    totalCostUsd: round(totalCostUsd),
  };

  return {
    costs,
    execution: {
      requestedPriceUsd: round(midPriceUsd, 12),
      executedPriceUsd: round(executedPriceUsd, 12),
      requestedAmountUsd: round(requestedAmountUsd),
      filledAmountUsd: round(fillUsd),
      tokenQuantity: round(tokenQuantity, 12),
      priceImpactPct: costs.priceImpactPct,
      slippagePct: round(slippagePct, 6),
      dexFeeUsd: costs.dexFeeUsd,
      networkFeeUsd: costs.networkFeeUsd,
      priorityFeeUsd: costs.priorityFeeUsd,
      totalCostUsd: costs.totalCostUsd,
      partial,
      failed: false,
      failureReason: null,
    },
  };
}

export function emptyCosts(): CostBreakdown {
  return {
    dexFeeUsd: 0,
    networkFeeUsd: 0,
    priorityFeeUsd: 0,
    slippageCostUsd: 0,
    priceImpactPct: 0,
    priceImpactCostUsd: 0,
    totalCostUsd: 0,
  };
}
