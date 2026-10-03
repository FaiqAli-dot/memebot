/**
 * Event-based buy/sell flow features across time windows.
 * When only tx-count approximations exist, confidence=LOW and source notes it.
 */
import { FLOW_WINDOWS_MS, type ConfidenceLevel, type FlowWindow } from '@memebot/shared';
import { measured, unavailable, type Measured } from '../domain/measured.js';

export interface TradeTick {
  side: 'BUY' | 'SELL' | 'UNKNOWN';
  amountUsd: number | null;
  priceUsd: number | null;
  traderWallet: string | null;
  observedAt: Date;
  /** true when amountUsd was inferred from tx counts / share split */
  approximated?: boolean;
  source: string;
}

export interface WindowFlow {
  window: FlowWindow;
  buyVolumeUsd: Measured<number>;
  sellVolumeUsd: Measured<number>;
  totalVolumeUsd: Measured<number>;
  netFlowUsd: Measured<number>;
  buySellRatio: Measured<number>;
  buyAcceleration: Measured<number>;
  sellAcceleration: Measured<number>;
  uniqueBuyers: Measured<number>;
  uniqueSellers: Measured<number>;
  newBuyers: Measured<number>;
  repeatBuyers: Measured<number>;
  buyerConcentration: Measured<number>;
  sellerConcentration: Measured<number>;
  medianTradeSizeUsd: Measured<number>;
  avgTradeSizeUsd: Measured<number>;
  largestTradeUsd: Measured<number>;
  largeBuyCount: Measured<number>;
  largeSellCount: Measured<number>;
  whaleFlowPct: Measured<number>;
}

const WINDOW_KEYS = Object.keys(FLOW_WINDOWS_MS) as FlowWindow[];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function concentration(volumes: Map<string, number>, total: number): number | null {
  if (total <= 0 || volumes.size === 0) return null;
  const top = [...volumes.values()].sort((a, b) => b - a).slice(0, 5);
  return (top.reduce((a, b) => a + b, 0) / total) * 100;
}

function computeWindow(
  trades: TradeTick[],
  window: FlowWindow,
  now: Date,
  priorBuyVol: number | null,
  priorSellVol: number | null,
): WindowFlow {
  const ms = FLOW_WINDOWS_MS[window];
  const cutoff = now.getTime() - ms;
  const inWin = trades.filter((t) => t.observedAt.getTime() >= cutoff);
  const approx = inWin.some((t) => t.approximated);
  const conf: ConfidenceLevel =
    approx || inWin.length === 0
      ? 'LOW'
      : inWin.every((t) => t.amountUsd != null)
        ? 'HIGH'
        : 'MEDIUM';
  const source = approx ? 'tx_count_approximation' : inWin[0]?.source ?? 'unavailable';
  const ts = inWin[0]?.observedAt ?? null;

  if (inWin.length === 0) {
    return emptyWindow(window);
  }

  let buyVol = 0;
  let sellVol = 0;
  const buyWallets = new Map<string, number>();
  const sellWallets = new Map<string, number>();
  const sizes: number[] = [];
  let largeBuys = 0;
  let largeSells = 0;
  let whaleUsd = 0;
  const seenBuyers = new Set<string>();
  const repeatBuyers = new Set<string>();

  for (const t of inWin) {
    const usd = t.amountUsd ?? 0;
    if (t.amountUsd != null) sizes.push(t.amountUsd);
    if (t.side === 'BUY') {
      buyVol += usd;
      if (t.traderWallet) {
        if (seenBuyers.has(t.traderWallet)) repeatBuyers.add(t.traderWallet);
        seenBuyers.add(t.traderWallet);
        buyWallets.set(t.traderWallet, (buyWallets.get(t.traderWallet) ?? 0) + usd);
      }
      if (usd >= 500) largeBuys++;
      if (usd >= 1000) whaleUsd += usd;
    } else if (t.side === 'SELL') {
      sellVol += usd;
      if (t.traderWallet) {
        sellWallets.set(t.traderWallet, (sellWallets.get(t.traderWallet) ?? 0) + usd);
      }
      if (usd >= 500) largeSells++;
      if (usd >= 1000) whaleUsd += usd;
    }
  }

  const total = buyVol + sellVol;
  const ratio = sellVol > 0 ? buyVol / sellVol : buyVol > 0 ? null : null;
  const buyAccel =
    priorBuyVol != null && priorBuyVol > 0 ? buyVol / priorBuyVol : null;
  const sellAccel =
    priorSellVol != null && priorSellVol > 0 ? sellVol / priorSellVol : null;

  const m = <T,>(value: T | null, c: ConfidenceLevel = conf): Measured<T> =>
    measured(value, { source, confidence: c, timestamp: ts, freshness: 'FRESH' });

  return {
    window,
    buyVolumeUsd: m(buyVol),
    sellVolumeUsd: m(sellVol),
    totalVolumeUsd: m(total),
    netFlowUsd: m(buyVol - sellVol),
    buySellRatio: ratio == null ? unavailable(source) : m(ratio),
    buyAcceleration: buyAccel == null ? unavailable('prior_window') : m(buyAccel, 'LOW'),
    sellAcceleration: sellAccel == null ? unavailable('prior_window') : m(sellAccel, 'LOW'),
    uniqueBuyers: m(seenBuyers.size || null, seenBuyers.size ? conf : 'UNKNOWN'),
    uniqueSellers: m(sellWallets.size || null, sellWallets.size ? conf : 'UNKNOWN'),
    newBuyers: m(seenBuyers.size - repeatBuyers.size, 'LOW'),
    repeatBuyers: m(repeatBuyers.size, 'LOW'),
    buyerConcentration: m(concentration(buyWallets, buyVol), buyWallets.size ? 'MEDIUM' : 'UNKNOWN'),
    sellerConcentration: m(concentration(sellWallets, sellVol), sellWallets.size ? 'MEDIUM' : 'UNKNOWN'),
    medianTradeSizeUsd: m(median(sizes)),
    avgTradeSizeUsd: m(sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null),
    largestTradeUsd: m(sizes.length ? Math.max(...sizes) : null),
    largeBuyCount: m(largeBuys),
    largeSellCount: m(largeSells),
    whaleFlowPct: m(total > 0 ? (whaleUsd / total) * 100 : null),
  };
}

function emptyWindow(window: FlowWindow): WindowFlow {
  const u = unavailable('no_trades');
  return {
    window,
    buyVolumeUsd: u,
    sellVolumeUsd: u,
    totalVolumeUsd: u,
    netFlowUsd: u,
    buySellRatio: u,
    buyAcceleration: u,
    sellAcceleration: u,
    uniqueBuyers: u,
    uniqueSellers: u,
    newBuyers: u,
    repeatBuyers: u,
    buyerConcentration: u,
    sellerConcentration: u,
    medianTradeSizeUsd: u,
    avgTradeSizeUsd: u,
    largestTradeUsd: u,
    largeBuyCount: u,
    largeSellCount: u,
    whaleFlowPct: u,
  };
}

/**
 * Build flow features for all windows.
 * Mark tx-count-based approximations as LOW confidence.
 */
export function computeFlowFeatures(
  trades: TradeTick[],
  now: Date = new Date(),
): Record<FlowWindow, WindowFlow> {
  const out = {} as Record<FlowWindow, WindowFlow>;
  for (const w of WINDOW_KEYS) {
    const ms = FLOW_WINDOWS_MS[w];
    const priorCutoff = now.getTime() - ms * 2;
    const cutoff = now.getTime() - ms;
    const prior = trades.filter(
      (t) => t.observedAt.getTime() >= priorCutoff && t.observedAt.getTime() < cutoff,
    );
    const priorBuy = prior.filter((t) => t.side === 'BUY').reduce((s, t) => s + (t.amountUsd ?? 0), 0);
    const priorSell = prior.filter((t) => t.side === 'SELL').reduce((s, t) => s + (t.amountUsd ?? 0), 0);
    out[w] = computeWindow(trades, w, now, priorBuy || null, priorSell || null);
  }
  return out;
}

/**
 * Synthesize low-confidence trade ticks from snapshot buy/sell volume split.
 * Explicitly marks approximated=true — strategy/risk may treat as weak evidence.
 */
export function approximateTradesFromSnapshot(opts: {
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  txCount5m: number;
  priceUsd: number;
  observedAt: Date;
}): TradeTick[] {
  const buys = Math.max(1, Math.round(opts.txCount5m * (opts.buyVolume5mUsd / Math.max(1, opts.buyVolume5mUsd + opts.sellVolume5mUsd))));
  const sells = Math.max(0, opts.txCount5m - buys);
  const ticks: TradeTick[] = [];
  const buySize = buys > 0 ? opts.buyVolume5mUsd / buys : 0;
  const sellSize = sells > 0 ? opts.sellVolume5mUsd / sells : 0;
  for (let i = 0; i < buys; i++) {
    ticks.push({
      side: 'BUY',
      amountUsd: buySize,
      priceUsd: opts.priceUsd,
      traderWallet: null,
      observedAt: new Date(opts.observedAt.getTime() - i * 1000),
      approximated: true,
      source: 'tx_count_approximation',
    });
  }
  for (let i = 0; i < sells; i++) {
    ticks.push({
      side: 'SELL',
      amountUsd: sellSize,
      priceUsd: opts.priceUsd,
      traderWallet: null,
      observedAt: new Date(opts.observedAt.getTime() - i * 1000),
      approximated: true,
      source: 'tx_count_approximation',
    });
  }
  return ticks;
}
