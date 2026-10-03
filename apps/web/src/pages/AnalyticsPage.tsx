import { useEffect, useState } from 'react';
import type { AnalyticsSummary } from '@memebot/shared';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';

export function AnalyticsPage() {
  const [a, setA] = useState<(AnalyticsSummary & { scoreDisclaimer?: string }) | null>(null);

  useEffect(() => {
    void api.analytics().then(setA);
  }, []);

  if (!a) return <div className="page">Loading analytics…</div>;
  const w = a.costWaterfall;

  return (
    <div className="page">
      <div className="grid grid-4" style={{ marginBottom: '0.75rem' }}>
        <Stat label="Total trades" value={String(a.totalTrades)} />
        <Stat label="Winning / Losing" value={`${a.winningTrades} / ${a.losingTrades}`} />
        <Stat label="Historical win rate" value={a.winRate != null ? pct(a.winRate * 100) : '—'} />
        <Stat label="Net profit" value={money(a.netProfitUsd)} className={pnlClass(a.netProfitUsd)} />
        <Stat label="Gross profit" value={money(a.grossProfitUsd)} className="pos" />
        <Stat label="Gross loss" value={money(a.grossLossUsd)} className="neg" />
        <Stat label="Profit factor" value={a.profitFactor != null ? a.profitFactor.toFixed(2) : '—'} />
        <Stat label="Expectancy" value={money(a.expectancyUsd)} />
        <Stat label="Avg winner" value={money(a.avgWinnerUsd)} />
        <Stat label="Avg loser" value={money(a.avgLoserUsd)} />
        <Stat label="Largest win" value={money(a.largestWinUsd)} />
        <Stat label="Largest loss" value={money(a.largestLossUsd)} />
        <Stat label="Max drawdown" value={pct(a.maxDrawdownPct)} />
        <Stat label="Sharpe (if enough data)" value={a.sharpeRatio != null ? a.sharpeRatio.toFixed(2) : '—'} />
        <Stat label="Avg holding time (s)" value={a.avgHoldingTimeSec != null ? a.avgHoldingTimeSec.toFixed(0) : '—'} />
        <Stat label="Total DEX fees" value={money(a.totalFeesUsd)} />
      </div>

      <div className="panel">
        <h2>Cost analysis waterfall</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <td>Gross trading P/L</td>
                <td className={pnlClass(w.grossTradingPnlUsd)}>{money(w.grossTradingPnlUsd)}</td>
              </tr>
              <tr>
                <td>− DEX fees</td>
                <td>{money(w.dexFeesUsd)}</td>
              </tr>
              <tr>
                <td>− Network fees</td>
                <td>{money(w.networkFeesUsd)}</td>
              </tr>
              <tr>
                <td>− Priority fees</td>
                <td>{money(w.priorityFeesUsd)}</td>
              </tr>
              <tr>
                <td>− Slippage</td>
                <td>{money(w.slippageUsd)}</td>
              </tr>
              <tr>
                <td>− Price impact</td>
                <td>{money(w.priceImpactUsd)}</td>
              </tr>
              <tr>
                <td>
                  <strong>= Net P/L</strong>
                </td>
                <td className={pnlClass(w.netPnlUsd)}>
                  <strong>{money(w.netPnlUsd)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="disclaimer">{a.scoreDisclaimer ?? SCORE_DISCLAIMER}</p>
      </div>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="panel metric">
      <span className="label">{label}</span>
      <span className={`value ${className ?? ''}`}>{value}</span>
    </div>
  );
}
