import type { ImportantTrade } from '@memebot/shared';
import { type ClosedTrade, holdSec, isWin, peakGainPct } from './types.js';

export const MAX_IMPORTANT_TRADES = 10;

/**
 * Picks the trades worth reviewing: biggest wins/losses, fastest stop-outs,
 * and trades where costs turned a gross gain into a net loss.
 */
export function selectImportantTrades(closed: ClosedTrade[]): ImportantTrade[] {
  const picked = new Map<string, { trade: ClosedTrade; tags: string[] }>();
  const add = (list: ClosedTrade[], tag: string) => {
    for (const t of list) {
      const entry = picked.get(t.positionId);
      if (entry) {
        if (!entry.tags.includes(tag)) entry.tags.push(tag);
      } else {
        picked.set(t.positionId, { trade: t, tags: [tag] });
      }
    }
  };

  const winners = closed.filter(isWin).sort((a, b) => b.netPnlUsd - a.netPnlUsd);
  const losers = closed.filter((t) => !isWin(t)).sort((a, b) => a.netPnlUsd - b.netPnlUsd);
  const fastStops = closed
    .filter((t) => t.closeReason === 'stop_loss')
    .sort((a, b) => holdSec(a) - holdSec(b));
  const costsAteGain = closed
    .filter((t) => t.netPnlUsd <= 0 && t.netPnlUsd + t.costsUsd > 0)
    .sort((a, b) => b.costsUsd - a.costsUsd);

  add(winners.slice(0, 3), 'biggest_win');
  add(losers.slice(0, 3), 'biggest_loss');
  add(fastStops.slice(0, 2), 'fast_stop_out');
  add(costsAteGain.slice(0, 2), 'costs_ate_gain');

  return [...picked.values()].slice(0, MAX_IMPORTANT_TRADES).map(({ trade: t, tags }) => ({
    positionId: t.positionId,
    tokenId: t.tokenId,
    symbol: t.symbol,
    netPnlUsd: t.netPnlUsd,
    netPnlPct: t.costBasisUsd > 0 ? (t.netPnlUsd / t.costBasisUsd) * 100 : 0,
    closeReason: t.closeReason,
    holdSec: holdSec(t),
    peakGainPct: peakGainPct(t),
    costsUsd: t.costsUsd,
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt.toISOString(),
    tags,
  }));
}
