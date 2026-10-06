import { useEffect, useState } from 'react';
import type { StrategyLabStats } from '@memebot/shared';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { api, money, pct } from '../lib/api';
import { LaneBadge } from '../components/LaneBadge';

export function StrategiesPage() {
  const [rows, setRows] = useState<StrategyLabStats[]>([]);
  const [note, setNote] = useState('');
  const [sort, setSort] = useState<keyof StrategyLabStats>('netPnlUsd');

  useEffect(() => {
    void api.strategies().then((d) => {
      setRows(d.strategies);
      setNote(d.note);
    });
  }, []);

  const sorted = [...rows].sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    return Number(bv ?? 0) - Number(av ?? 0);
  });

  return (
    <div className="page">
      <div className="panel">
        <h2>Strategy Lab</h2>
        <div className="lane-legend">
          <span>Stats for</span>
          <LaneBadge lane="PRODUCTION" />
          <span>only</span>
        </div>
        <p style={{ color: 'var(--muted)' }}>{note}</p>
        <div className="filters">
          <label>
            Sort metric{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as keyof StrategyLabStats)}>
              <option value="netPnlUsd">Net P/L</option>
              <option value="winRate">Historical win rate</option>
              <option value="trades">Trades</option>
              <option value="feesUsd">Fees</option>
              <option value="slippageUsd">Slippage</option>
              <option value="avgTradeUsd">Avg trade</option>
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Version</th>
                <th>Trades</th>
                <th>Win rate</th>
                <th>Net P/L</th>
                <th>Drawdown</th>
                <th>Fees</th>
                <th>Slippage</th>
                <th>Avg trade</th>
                <th>Avg hold (s)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={`${s.strategyName}-${s.strategyVersion}`}>
                  <td>{s.strategyName}</td>
                  <td>{s.strategyVersion}</td>
                  <td>{s.trades}</td>
                  <td>{s.winRate != null ? pct(s.winRate * 100) : '—'}</td>
                  <td>{money(s.netPnlUsd)}</td>
                  <td>{pct(s.drawdownPct)}</td>
                  <td>{money(s.feesUsd)}</td>
                  <td>{money(s.slippageUsd)}</td>
                  <td>{money(s.avgTradeUsd)}</td>
                  <td>{s.avgHoldingTimeSec != null ? s.avgHoldingTimeSec.toFixed(0) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="disclaimer">{SCORE_DISCLAIMER}</p>
      </div>
    </div>
  );
}
