import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';

export function TradesPage() {
  const [trades, setTrades] = useState<Record<string, unknown>[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [params] = useSearchParams();

  async function load() {
    setTrades((await api.trades()) as Record<string, unknown>[]);
  }

  useEffect(() => {
    void load();
  }, []);
  useRealtime(() => {
    void load();
  });

  useEffect(() => {
    const focus = params.get('focus');
    if (focus) void openDetail(focus);
  }, [params]);

  async function openDetail(id: string) {
    setDetail(await api.trade(id));
  }

  return (
    <div className="page">
      <div className="panel">
        <h2>Trades</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th>Token</th>
                <th>Status</th>
                <th>Requested</th>
                <th>Executed</th>
                <th>Filled USD</th>
                <th>DEX</th>
                <th>Network</th>
                <th>Priority</th>
                <th>SOL/USD</th>
                <th>Slippage</th>
                <th>Impact</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={String(t.id)}>
                  <td>{new Date(String(t.created_at)).toLocaleString()}</td>
                  <td className={t.side === 'BUY' ? 'pos' : 'neg'}>{String(t.side)}</td>
                  <td>{String(t.symbol)}</td>
                  <td>{String(t.status)}</td>
                  <td>{money(Number(t.requested_price_usd), 6)}</td>
                  <td>{money(Number(t.executed_price_usd ?? 0), 6)}</td>
                  <td>{money(Number(t.filled_amount_usd))}</td>
                  <td>{money(Number(t.dex_fee_usd))}</td>
                  <td>{money(Number(t.network_fee_usd))}</td>
                  <td>{money(Number(t.priority_fee_usd))}</td>
                  <td>
                    {t.sol_price_usd != null
                      ? `${money(Number(t.sol_price_usd))} (${String(t.sol_price_source ?? '—')})`
                      : '—'}
                  </td>
                  <td>
                    {pct(Number(t.slippage_pct))} / {money(Number(t.slippage_cost_usd))}
                  </td>
                  <td>
                    {pct(Number(t.price_impact_pct))} / {money(Number(t.price_impact_cost_usd))}
                  </td>
                  <td>
                    <button className="btn" onClick={() => void openDetail(String(t.id))}>
                      Detail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="disclaimer">
          Gross vs Net: execution prices include simulated slippage and price impact. Network/priority fees are
          cash costs. {SCORE_DISCLAIMER}
        </p>
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Trade detail</h2>
            <TradeDetailBody detail={detail} />
            <button className="btn" style={{ marginTop: '0.75rem' }} onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TradeDetailBody({ detail }: { detail: Record<string, unknown> }) {
  const order = detail.order as Record<string, unknown>;
  const position = detail.position as Record<string, unknown> | null;
  const explanation = order.explanation as { reasons?: string[]; warnings?: string[] } | undefined;

  return (
    <div className="grid" style={{ gap: '0.5rem' }}>
      <div>
        <strong>
          {String(order.side)} {String(order.symbol)}
        </strong>{' '}
        · {String(order.status)}
      </div>
      <div>Signal time: {order.signal_at ? new Date(String(order.signal_at)).toLocaleString() : '—'}</div>
      <div>
        Requested {money(Number(order.requested_price_usd), 8)} → Executed{' '}
        {money(Number(order.executed_price_usd ?? 0), 8)}
      </div>
      <div>
        Amount requested {money(Number(order.requested_amount_usd))} · filled{' '}
        {money(Number(order.filled_amount_usd))} · qty {Number(order.token_quantity).toPrecision(6)}
      </div>
      <div>
        Costs — DEX {money(Number(order.dex_fee_usd))} · Network {money(Number(order.network_fee_usd))} ·
        Priority {money(Number(order.priority_fee_usd))} · Slippage {money(Number(order.slippage_cost_usd))} (
        {pct(Number(order.slippage_pct))}) · Impact {money(Number(order.price_impact_cost_usd))} (
        {pct(Number(order.price_impact_pct))})
      </div>
      <div>
        SOL/USD used for fee conversion:{' '}
        {order.sol_price_usd != null
          ? `${money(Number(order.sol_price_usd))} via ${String(order.sol_price_source ?? '—')}`
          : '—'}
      </div>
      {position && (
        <div className={pnlClass(Number(position.net_pnl_usd))}>
          Position gross P/L {money(Number(position.gross_pnl_usd))} · Net P/L{' '}
          {money(Number(position.net_pnl_usd))} · close reason {String(position.close_reason ?? '—')}
        </div>
      )}
      {explanation && (
        <div>
          <h3>Why this signal?</h3>
          <div>Score: {Number(order.overall_score ?? 0).toFixed(1)} (model score, not profit probability)</div>
          <ul>
            {(explanation.reasons ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <ul style={{ color: 'var(--warn)' }}>
            {(explanation.warnings ?? []).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="disclaimer">{String(detail.scoreDisclaimer ?? SCORE_DISCLAIMER)}</p>
    </div>
  );
}
