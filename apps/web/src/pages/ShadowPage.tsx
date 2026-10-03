import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';

export function ShadowPage() {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [missed, setMissed] = useState<Record<string, unknown>[]>([]);

  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([api.shadowTrades(), api.missedOpportunities()]);
    setRows(s.rows as Record<string, unknown>[]);
    setMissed(m.rows as Record<string, unknown>[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime(useThrottled(() => void refresh()));

  const closed = rows.filter((r) => r.status !== 'OPEN');
  const avgMfe =
    closed.length > 0
      ? closed.reduce((a, r) => a + Number(r.mfe_pct ?? 0), 0) / closed.length
      : null;
  const avgReturn =
    closed.length > 0
      ? closed.reduce((a, r) => a + Number(r.eventual_return_pct ?? 0), 0) / closed.length
      : null;

  return (
    <div className="page">
      <div className="panel" style={{ marginBottom: '0.75rem' }}>
        <h2>Shadow Trades</h2>
        <p style={{ color: 'var(--muted)', margin: '0.35rem 0 0' }}>
          Hypothetical outcomes for rejected opportunities. Taken vs rejected comparison —
          evidence, not auto-removal of filters.
        </p>
        <div className="grid grid-4" style={{ marginTop: '0.75rem' }}>
          <div className="stat">
            <div className="stat-label">Shadow rows</div>
            <div className="stat-value">{rows.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Closed shadows</div>
            <div className="stat-value">{closed.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Avg MFE</div>
            <div className={`stat-value ${pnlClass(avgMfe)}`}>{pct(avgMfe)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Avg eventual return</div>
            <div className={`stat-value ${pnlClass(avgReturn)}`}>{pct(avgReturn)}</div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: '0.75rem', overflowX: 'auto' }}>
        <h3>Rejected → what would have happened</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Token</th>
              <th>Reason</th>
              <th>Entry</th>
              <th>MFE</th>
              <th>MAE</th>
              <th>Return</th>
              <th>Status</th>
              <th>Liq collapse</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 80).map((r) => (
              <tr key={String(r.id)}>
                <td>
                  <Link to={`/tokens/${r.token_id}`}>{String(r.symbol)}</Link>
                </td>
                <td>
                  <code>{String(r.rejection_reason)}</code>
                </td>
                <td>{money(Number(r.hypothetical_entry_price_usd), 6)}</td>
                <td className={pnlClass(Number(r.mfe_pct))}>{pct(Number(r.mfe_pct))}</td>
                <td className={pnlClass(Number(r.mae_pct))}>{pct(Number(r.mae_pct))}</td>
                <td className={pnlClass(Number(r.eventual_return_pct))}>
                  {pct(Number(r.eventual_return_pct))}
                </td>
                <td>{String(r.status)}</td>
                <td>{r.liquidity_collapsed ? 'YES' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ overflowX: 'auto' }}>
        <h3>Missed-opportunity classifications</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Token</th>
              <th>Rejection</th>
              <th>Filter</th>
              <th>Would-have %</th>
              <th>Helped?</th>
            </tr>
          </thead>
          <tbody>
            {missed.slice(0, 60).map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.symbol)}</td>
                <td>
                  <code>{String(r.rejection_reason)}</code>
                </td>
                <td>{String(r.filter_name ?? '—')}</td>
                <td>{pct(r.would_have_returned_pct != null ? Number(r.would_have_returned_pct) : null)}</td>
                <td>
                  {r.helped == null ? 'UNKNOWN' : r.helped ? 'helped' : 'hurt'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
