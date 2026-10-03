import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PositionData } from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';

export function PositionsPage() {
  const [open, setOpen] = useState<PositionData[]>([]);
  const [closed, setClosed] = useState<PositionData[]>([]);

  async function load() {
    const [o, c] = await Promise.all([api.positions('OPEN'), api.positions('CLOSED')]);
    setOpen(o);
    setClosed(c);
  }

  useEffect(() => {
    void load();
  }, []);
  const throttledLoad = useThrottled(() => void load());
  useRealtime(throttledLoad);

  return (
    <div className="page">
      <PositionTable title="Open positions" rows={open} />
      <div style={{ height: '0.75rem' }} />
      <PositionTable title="Closed positions" rows={closed} />
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
              <tr key={p.id}>
                <td>
                  <Link to={`/tokens/${p.tokenId}`}>{p.token?.symbol}</Link>
                </td>
                <td>{p.status}</td>
                <td>{money(p.entryPriceUsd, 6)}</td>
                <td>{money(p.currentPriceUsd, 6)}</td>
                <td>{p.quantity.toPrecision(4)}</td>
                <td>{money(p.currentValueUsd)}</td>
                <td className={pnlClass(p.status === 'OPEN' ? p.unrealizedPnlUsd : p.realizedPnlUsd)}>
                  {money(p.status === 'OPEN' ? p.unrealizedPnlUsd : p.realizedPnlUsd)} (
                  {pct(p.unrealizedPnlPct)})
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
                <td colSpan={10} style={{ color: 'var(--muted)' }}>
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
