/**
 * Read-only quote provider — Jupiter quote API for simulation data only.
 * NEVER executes swaps.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { measured, type Measured } from '../domain/measured.js';
import { WSOL_MINT } from '../providers/types.js';

export const QUOTE_PROVIDER_VERSION = 'quote-v1';

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps?: number;
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number | null;
  routeLabels: string[];
  quotedAt: Date;
  provider: string;
  confidence: Measured<number>['confidence'];
  raw: Record<string, unknown>;
}

export interface QuoteProvider {
  readonly name: string;
  getQuote(req: QuoteRequest): Promise<QuoteResult | null>;
}

/** Demo quote — deterministic from mid price, labeled demo. */
export class DemoQuoteProvider implements QuoteProvider {
  readonly name = 'demo-quote';

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    const inAmt = Number(req.amountRaw);
    if (!Number.isFinite(inAmt) || inAmt <= 0) return null;
    // Assume 6-decimal USDC-like or lamports; synthetic 0.3% impact
    const outAmt = Math.floor(inAmt * 0.997);
    return {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inAmount: req.amountRaw,
      outAmount: String(outAmt),
      priceImpactPct: 0.3,
      routeLabels: ['demo-amm'],
      quotedAt: new Date(),
      provider: this.name,
      confidence: 'MEDIUM',
      raw: { demo: true },
    };
  }
}

/**
 * Jupiter v6 quote API — READ ONLY. Used only to record what a trade would receive.
 */
export class JupiterQuoteProvider implements QuoteProvider {
  readonly name = 'jupiter-quote';

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    const url = new URL(`${env.JUPITER_BASE_URL}/quote`);
    url.searchParams.set('inputMint', req.inputMint);
    url.searchParams.set('outputMint', req.outputMint);
    url.searchParams.set('amount', req.amountRaw);
    url.searchParams.set('slippageBps', String(req.slippageBps ?? 100));
    try {
      const res = await fetch(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'Jupiter quote failed');
        return null;
      }
      const data = (await res.json()) as {
        inAmount?: string;
        outAmount?: string;
        priceImpactPct?: string | number;
        routePlan?: Array<{ swapInfo?: { label?: string } }>;
      };
      if (!data.outAmount) return null;
      return {
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inAmount: data.inAmount ?? req.amountRaw,
        outAmount: data.outAmount,
        priceImpactPct:
          data.priceImpactPct != null ? Number(data.priceImpactPct) : null,
        routeLabels: (data.routePlan ?? [])
          .map((r) => r.swapInfo?.label)
          .filter((x): x is string => !!x),
        quotedAt: new Date(),
        provider: this.name,
        confidence: 'HIGH',
        raw: data as Record<string, unknown>,
      };
    } catch (err) {
      logger.warn({ err }, 'Jupiter quote error');
      return null;
    }
  }
}

export function createQuoteProvider(dataMode: 'demo' | 'live'): QuoteProvider {
  return dataMode === 'demo' ? new DemoQuoteProvider() : new JupiterQuoteProvider();
}

export { WSOL_MINT };

export function measuredQuotePrice(
  quote: QuoteResult,
  inputDecimals: number,
  outputDecimals: number,
): Measured<number> {
  const inUi = Number(quote.inAmount) / 10 ** inputDecimals;
  const outUi = Number(quote.outAmount) / 10 ** outputDecimals;
  if (inUi <= 0 || outUi <= 0) {
    return measured<number>(null, { source: quote.provider, confidence: 'UNKNOWN' });
  }
  return measured(outUi / inUi, {
    source: quote.provider,
    confidence: quote.confidence,
    timestamp: quote.quotedAt,
    freshness: 'FRESH',
  });
}
