import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, pct, pnlClass, type OlderTokenResearchSummary } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';
import { LaneBadge, StrategyBadge } from './LaneBadge';

const STRATEGIES = ['older-breakout', 'older-revival'] as const;

/** Stats for the older-token research portfolio only; production figures live elsewhere. */
export function OlderTokenResearchPanel() {
  const [data, setData] = useState<OlderTokenResearchSummary | null>(null);
  const load = useCallback(async () => setData(await api.olderTokenResearch()), []);

  useEffect(() => {
    void load();
  }, [load]);
  const throttled = useThrottled(() => void load());
  useRealtime(throttled);

  const p = data?.portfolio ?? null;
  const signalCount = (id: string) => data?.signalsLastHour.find((s) => s.strategyId === id)?.count ?? 0;
  const candidateCount = (id: string) =>
    (data?.candidatesLast24h ?? []).filter((c) => c.strategyId === id).reduce((n, c) => n + c.count, 0);
  const rejections = new Map<string, number>();
  for (const c of data?.candidatesLast24h ?? []) {
    if (c.reason !== 'signal_emitted') rejections.set(c.reason, (rejections.get(c.reason) ?? 0) + c.count);
  }
  const recent = data?.recentCandidates ?? [];

  return (
    <div className="panel research-panel" style={{ marginBottom: '0.75rem' }}>
      <h2>OLDER TOKEN RESEARCH</h2>
      <div className="research-sub">Breakouts + Dormant Revivals</div>
      <span className="research-paper">PAPER ONLY · DOES NOT AFFECT PRODUCTION</span>
      <div className="lane-legend" style={{ marginBottom: '0.5rem' }}>
        <LaneBadge lane="OLDER_TOKEN_RESEARCH" />
        <span>{data == null ? '…' : data.enabled ? 'Lane enabled' : 'Lane disabled'}</span>
        <span>· separate portfolio, never counted in production stats</span>
      </div>
      <div className="grid grid-4" style={{ marginBottom: '0.6rem' }}>
        <Stat label="Research equity" value={money(p?.equityUsd)} />
        <Stat label="Research cash" value={money(p?.cashUsd)} />
        <Stat
          label="Research realized P/L"
          value={money(p?.realizedPnlUsd)}
          className={pnlClass(p?.realizedPnlUsd)}
        />
        <Stat label="Research return" value={pct(p?.returnPct)} className={pnlClass(p?.returnPct)} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Candidates (24h)</th>
              <th>Signals (60m)</th>
              <th>Open</th>
              <th>Opened today</th>
              <th>Closed</th>
              <th>Win rate</th>
              <th>Net P/L</th>
            </tr>
          </thead>
          <tbody>
            {STRATEGIES.map((id) => {
              const s = data?.strategies.find((x) => x.strategyId === id);
              return (
                <tr key={id} className={id === 'older-revival' ? 'row-older row-revival' : 'row-older'}>
                  <td>
                    <StrategyBadge strategyId={id} />
                  </td>
                  <td>{candidateCount(id)}</td>
                  <td>{signalCount(id)}</td>
                  <td>{s?.open ?? 0}</td>
                  <td>{s?.openedToday ?? 0}</td>
                  <td>{s?.closed ?? 0}</td>
                  <td>{s && s.closed > 0 ? pct((s.wins / s.closed) * 100, 0) : '—'}</td>
                  <td className={pnlClass(s?.netPnlUsd)}>{money(s?.netPnlUsd ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rejections.size > 0 && (
        <div className="research-sub" style={{ marginTop: '0.5rem' }}>
          Rejected (24h):{' '}
          {[...rejections.entries()]
            .map(([reason, n]) => `${n} × ${rejectionLabel(reason, data?.maxRoundTripCostPct)}`)
            .join(' · ')}
        </div>
      )}
      <div className="table-wrap" style={{ marginTop: '0.5rem', maxHeight: 220 }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Token</th>
              <th>Strategy</th>
              <th>Round-trip cost</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((c) => (
              <tr key={`${c.tokenId}-${c.strategyId}-${c.observedAt}`} className="row-older">
                <td>{new Date(c.observedAt).toLocaleTimeString()}</td>
                <td>
                  <Link to={`/tokens/${c.tokenId}`}>{c.symbol ?? c.tokenId.slice(0, 6)}</Link>
                </td>
                <td>
                  <StrategyBadge strategyId={c.strategyId} />
                </td>
                <td>{c.costRate != null ? pct(c.costRate * 100) : '—'}</td>
                <td>{c.signalled ? 'signal emitted' : `rejected: ${rejectionLabel(c.reason, data?.maxRoundTripCostPct)}`}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--muted)' }}>
                  {data?.enabled === false
                    ? 'Lane disabled (OLDER_TOKEN_RESEARCH_ENABLED=false)'
                    : 'No older token has matched a breakout/revival setup yet'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rejectionLabel(reason: string | null, maxCostPct?: number): string {
  switch (reason) {
    case 'round_trip_cost_too_high':
      return `round-trip cost above ${maxCostPct ?? '?'}% cap`;
    case 'network_fee_unpriced':
      return 'network fee unpriced';
    case 'critical_data_check_failed':
      return 'critical data check failed';
    case 'signal_cooldown':
      return 'signal cooldown';
    default:
      return reason ?? 'unknown';
  }
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="panel metric">
      <span className="label">{label}</span>
      <span className={`value ${className ?? ''}`}>{value}</span>
    </div>
  );
}
