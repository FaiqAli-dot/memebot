import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PositionData } from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';
import {
  LaneFilterSelect,
  LaneLegend,
  LaneTags,
  laneFilterScope,
  laneRowClass,
  matchesLaneFilter,
  type LaneFilter,
} from '../components/LaneBadge';

export function PositionsPage() {
  const [open, setOpen] = useState<PositionData[]>([]);
  const [closed, setClosed] = useState<PositionData[]>([]);
  const [laneFilter, setLaneFilter] = useState<LaneFilter>('all');

  const scope = laneFilterScope(laneFilter);
  async function load() {
    const [o, c] = await Promise.all([api.positions('OPEN', scope), api.positions('CLOSED', scope)]);
    setOpen(o);
    setClosed(c);
  }

  useEffect(() => {
    void load();
  }, [scope]);
  const throttledLoad = useThrottled(() => void load());
  useRealtime(throttledLoad);

  const shown = (rows: PositionData[]) => rows.filter((p) => matchesLaneFilter(laneFilter, p.lane, p.strategyId));

  return (
    <div className="page">
      <div className="lane-legend" style={{ justifyContent: 'space-between' }}>
        <LaneLegend />
        <LaneFilterSelect value={laneFilter} onChange={setLaneFilter} />
      </div>
      <PositionTable title="Open positions" rows={shown(open)} />
      <div style={{ height: '0.75rem' }} />
      <PositionTable title="Closed positions" rows={shown(closed)} />
    </div>
  );
}

function PositionTable({ title, rows }: { title: string; rows: PositionData[] }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Lane</th>
              <th>Status</th>
              <th>Entry</th>
              <th>Mark / Exit</th>
              <th>Size</th>
              <th>Value</th>
              <th>Unreal / Realized</th>
              <th>Entry costs</th>
              <th>Opened</th>
              <th>Close reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={laneRowClass(p.lane, p.strategyId)}>
                <td>
                  <Link to={`/tokens/${p.tokenId}`}>{p.token?.symbol}</Link>
                </td>
                <td>
                  <LaneTags lane={p.lane} strategyId={p.strategyId} />
                </td>
                <td>{p.status}</td>
                <td>{money(p.entryPriceUsd, 6)}</td>
                <td>{money(p.currentPriceUsd, 6)}</td>
                <td>{p.quantity.toPrecision(4)}</td>
                <td>{money(p.currentValueUsd)}</td>
                <td className={pnlClass(p.status === 'OPEN' ? p.unrealizedPnlUsd : p.realizedPnlUsd)}>
                  {money(p.status === 'OPEN' ? p.unrealizedPnlUsd : p.realizedPnlUsd)} (
                  {pct(
                    p.status === 'OPEN'
                      ? p.unrealizedPnlPct
                      : p.costBasisUsd > 0
                        ? (p.realizedPnlUsd / p.costBasisUsd) * 100
                        : 0,
                  )}
                  )
                </td>
                <td>
                  DEX {money(p.entryCosts.dexFeeUsd)} · Net {money(p.entryCosts.networkFeeUsd)} · Slip{' '}
                  {money(p.entryCosts.slippageCostUsd)}
                </td>
                <td>{new Date(p.openedAt).toLocaleString()}</td>
                <td>{p.closeReason ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} style={{ color: 'var(--muted)' }}>
                  None
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
