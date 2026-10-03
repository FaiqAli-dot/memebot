import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScannerRow } from '@memebot/shared';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { api, money, pct } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';

export function ScannerPage() {
  const [rows, setRows] = useState<ScannerRow[]>([]);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('updated');
  const [minLiquidity, setMinLiquidity] = useState('');
  const [flash, setFlash] = useState(0);

  async function load() {
    const qs = new URLSearchParams({
      filter,
      sort,
      order: 'desc',
      limit: '80',
    });
    if (minLiquidity) qs.set('minLiquidity', minLiquidity);
    const data = await api.scanner(`?${qs}`);
    setRows(data.rows);
  }

  useEffect(() => {
    void load();
  }, [filter, sort, minLiquidity]);

  useRealtime((msg) => {
    if (msg.type === 'scanner_updated' || msg.type === 'token_discovered' || msg.type === 'signal_generated') {
      setFlash((f) => f + 1);
      void load();
    }
  });

  return (
    <div className="page">
      <div className="panel">
        <h2>Scanner</h2>
        <div className="filters">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="new_launches">New launches</option>
            <option value="high_volume">High volume</option>
            <option value="high_momentum">High momentum</option>
            <option value="min_liquidity">Min liquidity</option>
            <option value="low_holder_concentration">Low holder concentration</option>
            <option value="accelerating">Recently accelerating</option>
            <option value="high_risk">High risk</option>
            <option value="watchlist">Watchlist</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Last updated</option>
            <option value="volume5m">5m volume</option>
            <option value="momentum">Momentum</option>
            <option value="liquidity">Liquidity</option>
            <option value="age">Age</option>
            <option value="risk">Risk</option>
            <option value="score">Signal score</option>
          </select>
          <input
            placeholder="Min liquidity USD"
            value={minLiquidity}
            onChange={(e) => setMinLiquidity(e.target.value)}
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Chain</th>
                <th>Age</th>
                <th>Price</th>
                <th>MCap</th>
                <th>Liq</th>
                <th>5m Vol</th>
                <th>1h Vol</th>
                <th>Vol Accel</th>
                <th>Buy/Sell</th>
                <th>Holders</th>
                <th>Top %</th>
                <th>Δ5m</th>
                <th>Mom</th>
                <th>Risk</th>
                <th>Signal</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tokenId} className={flash ? 'flash' : ''}>
                  <td>
                    <Link to={`/tokens/${r.tokenId}`}>
                      {r.symbol}
                      <div style={{ color: 'var(--muted)', fontSize: '0.65rem' }}>{r.name}</div>
                    </Link>
                  </td>
                  <td>{r.chain}</td>
                  <td>{r.ageMinutes != null ? `${r.ageMinutes.toFixed(0)}m` : '—'}</td>
                  <td>{money(r.priceUsd, 8)}</td>
                  <td>{money(r.marketCapUsd, 0)}</td>
                  <td>{money(r.liquidityUsd, 0)}</td>
                  <td>{money(r.volume5mUsd, 0)}</td>
                  <td>{money(r.volume1hUsd, 0)}</td>
                  <td>{r.volumeAcceleration.toFixed(2)}x</td>
                  <td>
                    {money(r.buyVolume5mUsd, 0)} / {money(r.sellVolume5mUsd, 0)}
                    <div style={{ color: 'var(--muted)' }}>
                      {r.buySellRatio != null ? r.buySellRatio.toFixed(2) : '—'}
                    </div>
                  </td>
                  <td>{r.holderCount ?? '—'}</td>
                  <td>{r.topHolderConcentration != null ? pct(r.topHolderConcentration) : '—'}</td>
                  <td className={r.priceChange5mPct >= 0 ? 'pos' : 'neg'}>{pct(r.priceChange5mPct)}</td>
                  <td>{r.momentumScore.toFixed(0)}</td>
                  <td className={`risk-${r.riskLabel}`}>
                    {r.riskLabel.replace('_', ' ')} ({r.riskScore.toFixed(0)})
                  </td>
                  <td>{r.signal ?? '—'}{r.overallScore != null ? ` · ${r.overallScore.toFixed(0)}` : ''}</td>
                  <td>{new Date(r.lastUpdated).toLocaleTimeString()}</td>
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
