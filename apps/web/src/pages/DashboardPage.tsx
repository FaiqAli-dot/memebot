import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  BotEventData,
  BotStatusInfo,
  EquityPoint,
  PortfolioSummary,
  PositionData,
} from '@memebot/shared';
import { SCORE_DISCLAIMER } from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';
import { ReadinessPanel } from '../components/ReadinessPanel';
import { LearningPanel } from '../components/LearningPanel';
import { Week1Panel } from '../components/Week1Panel';

const BOARD_TABS = [
  { id: 'observation', label: 'Observation mode' },
  { id: 'trading', label: 'Trading' },
  { id: 'learning', label: 'Learning' },
] as const;
type BoardTab = (typeof BOARD_TABS)[number]['id'];

export function DashboardPage() {
  const [board, setBoard] = useState<BoardTab>('trading');
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [bot, setBot] = useState<BotStatusInfo | null>(null);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [trades, setTrades] = useState<Record<string, unknown>[]>([]);
  const [events, setEvents] = useState<BotEventData[]>([]);
  const [solPrice, setSolPrice] = useState<{
    solPriceUsd: number | null;
    source: string | null;
    stale: boolean;
    usable: boolean;
    note: string;
  } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [p, b, e, pos, t, ev, sol] = await Promise.all([
      api.portfolio(),
      api.botStatus(),
      api.equity(),
      api.positions('OPEN'),
      api.trades(),
      api.events(q ? `?q=${encodeURIComponent(q)}&limit=80` : '?limit=80'),
      api.solPrice(),
    ]);
    setPortfolio(p);
    setBot(b);
    setEquity(e);
    setPositions(pos);
    setTrades(t as Record<string, unknown>[]);
    setEvents(ev);
    setSolPrice(sol);
  }, [q]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const throttledRefresh = useThrottled(() => void refresh());
  useRealtime(throttledRefresh);

  async function control(action: 'start' | 'pause') {
    setBusy(true);
    try {
      await api.control(action);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reset(scope: 'paper_account' | 'all_simulation') {
    const label =
      scope === 'paper_account'
        ? 'Reset paper account? This clears positions and trades.'
        : 'Reset ALL simulation data (tokens, signals, trades)?';
    if (!window.confirm(label)) return;
    setBusy(true);
    try {
      await api.reset(scope);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleKill(active: boolean) {
    setBusy(true);
    try {
      await api.killSwitch(active);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const chartData = equity.map((e) => ({
    t: new Date(e.observedAt).toLocaleTimeString(),
    equity: e.equityUsd,
  }));

  return (
    <div className="page">
      <div className="btn-row" style={{ marginBottom: '0.75rem' }}>
        <button className="btn primary" disabled={busy} onClick={() => void control('start')}>
          START BOT
        </button>
        <button className="btn" disabled={busy} onClick={() => void control('pause')}>
          PAUSE BOT
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() => void toggleKill(!(bot?.killSwitchActive ?? false))}
        >
          {bot?.killSwitchActive ? 'CLEAR KILL SWITCH' : 'KILL SWITCH'}
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void reset('paper_account')}>
          RESET PAPER ACCOUNT
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void reset('all_simulation')}>
          RESET ALL SIMULATION DATA
        </button>
      </div>

      <div className="tabs" role="tablist">
        {BOARD_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={board === t.id}
            className={`tab ${board === t.id ? 'active' : ''}`}
            onClick={() => setBoard(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {board === 'observation' && <Week1Panel />}
      {board === 'trading' && <ReadinessPanel />}
      {board === 'learning' && <LearningPanel />}

      <div className="grid grid-4" style={{ marginBottom: '0.75rem' }}>
        <Metric label="Starting balance" value={money(portfolio?.startingBalanceUsd)} />
        <Metric label="Cash" value={money(portfolio?.cashUsd)} />
        <Metric label="Equity" value={money(portfolio?.equityUsd)} />
        <Metric label="Invested" value={money(portfolio?.investedValueUsd)} />
        <Metric label="Unrealized P/L" value={money(portfolio?.unrealizedPnlUsd)} className={pnlClass(portfolio?.unrealizedPnlUsd)} />
        <Metric label="Realized P/L" value={money(portfolio?.realizedPnlUsd)} className={pnlClass(portfolio?.realizedPnlUsd)} />
        <Metric label="Total P/L" value={`${money(portfolio?.totalPnlUsd)} (${pct(portfolio?.returnPct)})`} className={pnlClass(portfolio?.totalPnlUsd)} />
        <Metric label="Max drawdown" value={pct(portfolio?.maxDrawdownPct)} />
        <Metric label="Total fees" value={money(portfolio?.totalFeesUsd)} />
        <Metric label="Network/gas" value={money(portfolio?.totalNetworkCostUsd)} />
        <Metric label="Slippage cost" value={money(portfolio?.totalSlippageCostUsd)} />
        <Metric label="Price impact cost" value={money(portfolio?.totalPriceImpactCostUsd)} />
        <Metric
          label="SOL/USD (fee conversion)"
          value={
            solPrice?.solPriceUsd != null
              ? `${money(solPrice.solPriceUsd)} · ${solPrice.source ?? '—'}${solPrice.stale ? ' · STALE' : ''}`
              : 'unavailable'
          }
        />
      </div>
      {solPrice && (
        <p className="disclaimer" style={{ marginTop: 0, marginBottom: '0.75rem', borderTop: 'none', paddingTop: 0 }}>
          {solPrice.note}
          {!solPrice.usable ? ' New paper trades are blocked until SOL/USD is fresh.' : ''}
        </p>
      )}

      <div className="grid grid-2" style={{ marginBottom: '0.75rem' }}>
        <div className="panel">
          <h2>Bot status</h2>
          <div className="grid grid-2">
            <Metric label="Status" value={bot?.status ?? '—'} />
            <Metric label="Strategy" value={bot?.currentStrategy ?? '—'} />
            <Metric label="Last scan" value={bot?.lastScanAt ? new Date(bot.lastScanAt).toLocaleTimeString() : '—'} />
            <Metric label="Tokens scanned" value={String(bot?.tokensScanned ?? 0)} />
            <Metric label="Signals generated" value={String(bot?.signalsGenerated ?? 0)} />
            <Metric label="Trades today" value={String(bot?.tradesToday ?? 0)} />
            <Metric label="Risk state" value={bot?.riskState ?? '—'} />
            <Metric label="Regime" value={bot?.marketRegime ?? '—'} />
            <Metric label="Realism" value={bot?.realismProfile ?? '—'} />
            <Metric label="Kill switch" value={bot?.killSwitchActive ? 'ACTIVE' : 'off'} />
            <Metric label="Trading mode" value={bot?.tradingMode ?? 'PAPER'} />
            <Metric label="Data mode" value={(bot?.dataMode ?? 'demo').toUpperCase()} />
          </div>
        </div>
        <div className="panel">
          <h2>Equity (elapsed time only)</h2>
          <div style={{ width: '100%', height: 220 }}>
            {chartData.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>No equity samples yet — chart grows as the bot runs.</div>
            ) : (
              <ResponsiveContainer>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3dffa8" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#3dffa8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={['auto', 'auto']} width={50} stroke="#8fa3b8" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: '#0d141c', border: '1px solid #243447' }}
                  />
                  <Area type="monotone" dataKey="equity" stroke="#3dffa8" fill="url(#eq)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: '0.75rem' }}>
        <div className="panel">
          <h2>Active positions</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>Value</th>
                  <th>Unreal P/L</th>
                  <th>SL / TP</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/tokens/${p.tokenId}`}>{p.token?.symbol ?? p.tokenId.slice(0, 6)}</Link>
                    </td>
                    <td>{money(p.entryPriceUsd, 6)}</td>
                    <td>{money(p.currentPriceUsd, 6)}</td>
                    <td>{money(p.currentValueUsd)}</td>
                    <td className={pnlClass(p.unrealizedPnlUsd)}>
                      {money(p.unrealizedPnlUsd)} ({pct(p.unrealizedPnlPct)})
                    </td>
                    <td>
                      {pct(p.stopLossPct * 100)} / {pct(p.takeProfitPct * 100)}
                    </td>
                  </tr>
                ))}
                {positions.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: 'var(--muted)' }}>
                      No open positions
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Recent trades</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Side</th>
                  <th>Token</th>
                  <th>Filled</th>
                  <th>Exec px</th>
                  <th>Fees</th>
                  <th>Slippage</th>
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, 12).map((t) => (
                  <tr key={String(t.id)}>
                    <td className={t.side === 'BUY' ? 'pos' : 'neg'}>{String(t.side)}</td>
                    <td>
                      <Link to={`/trades?focus=${String(t.id)}`}>{String(t.symbol)}</Link>
                    </td>
                    <td>{money(Number(t.filled_amount_usd))}</td>
                    <td>{money(Number(t.executed_price_usd ?? 0), 6)}</td>
                    <td>{money(Number(t.dex_fee_usd) + Number(t.network_fee_usd) + Number(t.priority_fee_usd))}</td>
                    <td>{pct(Number(t.slippage_pct))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h2 style={{ margin: 0 }}>Live bot log</h2>
          <input
            placeholder="Filter logs…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ marginLeft: 'auto', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 6, padding: '0.35rem 0.5rem' }}
          />
        </div>
        <div className="log-panel">
          {events.map((e) => (
            <div key={e.id} className={`log-line ${e.level}`}>
              <span>{new Date(e.createdAt).toLocaleTimeString()}</span>
              <span className="cat">{e.category}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
        <p className="disclaimer">{SCORE_DISCLAIMER}</p>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="panel metric">
      <span className="label">{label}</span>
      <span className={`value ${className ?? ''}`}>{value}</span>
    </div>
  );
}
