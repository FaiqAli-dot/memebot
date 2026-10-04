import { money } from '../lib/api';

type Row = Record<string, unknown>;

function ts(v: unknown): string {
  if (v == null) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function txt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function num(v: unknown, digits = 2): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : String(v);
}

function short(v: unknown): string {
  return v == null ? '—' : String(v).slice(0, 8);
}

function Table({ title, rows, cols }: { title: string; rows: Row[]; cols: Array<[string, (r: Row) => string]> }) {
  return (
    <div style={{ marginTop: '1rem' }}>
      <h4>
        {title} ({rows.length})
      </h4>
      {rows.length === 0 ? (
        <div className="muted">None recorded</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {cols.map(([h]) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={String(r.id ?? i)}>
                  {cols.map(([h, f]) => (
                    <td key={h}>{f(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Consolidated view of everything recorded about one token, newest data model first. */
export function TokenInvestigation({ detail }: { detail: Row }) {
  const t = (detail.token ?? {}) as Row;
  const list = (k: string) => (Array.isArray(detail[k]) ? (detail[k] as Row[]) : []);
  const market = (detail.latestMarket ?? null) as Row | null;
  const pools = list('pools');

  const identity: Array<[string, unknown]> = [
    ['Mint / address', t.address],
    ['Symbol', t.symbol],
    ['Name', t.name],
    ['Chain', t.chain],
    ['Token ID', t.id],
    ['Pool', t.pool_address ?? pools[0]?.pool_address],
    ['Venue', t.dex_venue],
    ['Launch mechanism', t.launch_mechanism],
    ['Discovery source', t.discovery_source],
    ['All sources', t.discovery_sources],
    ['First discovered', ts(t.discovered_at)],
    ['Last discovered', ts(t.last_discovered_at)],
    ['First observed', ts(t.first_observed_at)],
    ['Created on-chain', ts(t.pool_created_at ?? t.created_at_onchain)],
    ['Migration', t.migration_status],
    ['Lifecycle', t.lifecycle_state],
    ['Eligibility', t.trading_eligibility],
    ['Intelligence status', t.intelligence_status],
    ['Last rejection', t.last_rejection_reason],
    ['Trade status', t.trade_status],
    ['Latest price', market ? `${num(market.price_usd, 10)} @ ${ts(market.observed_at)}` : null],
    ['Latest liquidity', market ? money(Number(market.liquidity_usd), 0) : null],
  ];

  return (
    <div>
      <div className="stat-grid">
        {identity.map(([label, value]) => (
          <div key={label} className="stat">
            <div className="stat-label">{label}</div>
            <div style={{ wordBreak: 'break-all' }}>{txt(value)}</div>
          </div>
        ))}
      </div>

      <Table
        title="Timeline"
        rows={list('timeline')}
        cols={[
          ['When', (r) => ts(r.at)],
          ['Event', (r) => txt(r.kind)],
          ['Result', (r) => txt(r.result)],
          ['Detail', (r) => txt(r.summary)],
        ]}
      />

      <Table
        title="Signals"
        rows={list('signals')}
        cols={[
          ['Created', (r) => ts(r.created_at)],
          ['Signal', (r) => short(r.id)],
          ['Lane', (r) => txt(r.lane)],
          ['Strategy', (r) => txt(r.strategy_id)],
          ['Score', (r) => num(r.overall_score)],
          ['Liq at signal', (r) => money(Number((r.market_state as Row | null)?.liquidityUsd ?? NaN), 0)],
          ['Vol5m at signal', (r) => money(Number((r.market_state as Row | null)?.volume5mUsd ?? NaN), 0)],
          ['Price at signal', (r) => num((r.market_state as Row | null)?.priceUsd, 10)],
        ]}
      />

      <Table
        title="Execution attempts (strategy revalidation → risk → order)"
        rows={list('executionAttempts')}
        cols={[
          ['Signal', (r) => short(r.signal_id)],
          ['Signal at', (r) => ts(r.signal_created_at)],
          ['Ticks', (r) => txt(r.attempts)],
          ['First / last', (r) => `${ts(r.first_attempt_at)} → ${ts(r.last_attempt_at)}`],
          ['Signal age (s)', (r) => num(Number(r.signal_age_ms) / 1000, 0)],
          ['Revalidation', (r) => `${txt(r.revalidation_result)} ${r.revalidation_reason ? `(${r.revalidation_reason})` : ''}`],
          ['Revalidated at', (r) => ts(r.revalidated_at)],
          ['Liq / Vol5m now', (r) => {
            const f = (r.revalidation_features ?? {}) as Row;
            return `${money(Number(f.liquidityUsd ?? NaN), 0)} / ${money(Number(f.volume5mUsd ?? NaN), 0)}`;
          }],
          ['Risk', (r) => `${txt(r.risk_result)} ${r.risk_reason ? `(${r.risk_reason})` : ''}`],
          ['Status', (r) => `${txt(r.status)} ${r.status_reason ? `(${r.status_reason})` : ''}`],
          ['Order', (r) => short(r.order_id)],
          ['Position', (r) => short(r.position_id)],
        ]}
      />

      <Table
        title="Risk decisions"
        rows={list('riskDecisions')}
        cols={[
          ['Decision', (r) => short(r.id)],
          ['Signal', (r) => short(r.signal_id)],
          ['Result', (r) => `${txt(r.decision)} ${r.rejection_reason ? `(${r.rejection_reason})` : ''}`],
          ['Evaluations', (r) => txt(r.attempts)],
          ['First / last', (r) => `${ts(r.first_evaluated_at)} → ${ts(r.evaluated_at)}`],
          ['Size', (r) => money(Number(r.final_size_usd), 2)],
          ['EV / threshold', (r) => `${num(r.expected_net_value, 4)} / ${num(r.ev_threshold, 4)}`],
          ['Execution', (r) => `${txt(r.execution_status)} ${r.execution_reason ? `(${r.execution_reason})` : ''}`],
        ]}
      />

      <Table
        title="Orders and fills"
        rows={list('orders')}
        cols={[
          ['Created', (r) => ts(r.created_at)],
          ['Order', (r) => short(r.id)],
          ['Side', (r) => txt(r.side)],
          ['Status', (r) => `${txt(r.status)} ${r.failure_reason ? `(${r.failure_reason})` : ''}`],
          ['Attempts', (r) => txt(r.attempt_count)],
          ['Requested', (r) => money(Number(r.requested_amount_usd), 2)],
          ['Filled', (r) => money(Number(r.filled_amount_usd), 2)],
          ['Exec price', (r) => num(r.executed_price_usd, 10)],
          ['Costs', (r) => money(Number(r.total_cost_usd), 4)],
          ['Fills', (r) => txt(Array.isArray(r.fills) ? r.fills.length : 0)],
        ]}
      />

      <Table
        title="Positions"
        rows={list('positions')}
        cols={[
          ['Position', (r) => short(r.id)],
          ['Opened', (r) => ts(r.opened_at)],
          ['Closed', (r) => ts(r.closed_at)],
          ['Status', (r) => txt(r.status)],
          ['Entry', (r) => num(r.entry_price_usd, 10)],
          ['Last / exit mark', (r) => num(r.current_price_usd, 10)],
          ['Close reason', (r) => txt(r.close_reason)],
          ['Net P&L', (r) => money(Number(r.net_pnl_usd ?? r.realized_pnl_usd), 4)],
        ]}
      />

      <Table
        title="Outcome checkpoints"
        rows={list('outcomeCheckpoints')}
        cols={[
          ['Label', (r) => txt(r.checkpoint_label)],
          ['Due', (r) => ts(r.due_at)],
          ['Status', (r) => txt(r.status)],
          ['Price', (r) => num(r.price_usd, 10)],
          ['Change %', (r) => num(r.change_pct, 1)],
        ]}
      />

      <Table
        title="Outcome summaries"
        rows={list('outcomeSummaries')}
        cols={[
          ['Created', (r) => ts(r.created_at)],
          ['Peak 24h', (r) => num(r.peak_price_24h, 10)],
          ['Trough 24h', (r) => num(r.lowest_price_24h, 10)],
          ['Max gain', (r) => num(r.max_gain_24h, 2)],
          ['Max drawdown', (r) => num(r.max_drawdown_24h, 2)],
          ['Classification', (r) => txt(r.classification)],
        ]}
      />

      <details style={{ marginTop: '1rem' }}>
        <summary>Raw record</summary>
        <pre className="code-block">{JSON.stringify(detail, null, 2)}</pre>
      </details>
    </div>
  );
}
