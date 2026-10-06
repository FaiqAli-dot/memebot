import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  BotEventData,
  LivePositionData,
  PositionUpdatePayload,
  WsMessage,
} from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';
import { LaneLegend, LaneTags, laneCardClass } from '../components/LaneBadge';
import { EventLine } from '../components/EventLine';

type Flash = 'up' | 'down' | null;

interface CardState {
  position: LivePositionData;
  lastTickAt: number | null;
  tickCount: number;
  flash: Flash;
  closedReason: string | null;
}

const CLOSED_CARD_MS = 6000;

export function LivePage() {
  const [cards, setCards] = useState<CardState[]>([]);
  const [events, setEvents] = useState<BotEventData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const closeReasons = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const live = await api.livePositions('all');
    const liveIds = new Set(live.map((p) => p.id));
    setCards((prev) => {
      const prevById = new Map(prev.map((c) => [c.position.id, c]));
      const next: CardState[] = live.map((position) => {
        const existing = prevById.get(position.id);
        return existing
          ? { ...existing, position }
          : { position, lastTickAt: null, tickCount: 0, flash: null, closedReason: null };
      });
      for (const c of prev) {
        if (liveIds.has(c.position.id)) continue;
        next.push(
          c.closedReason
            ? c
            : { ...c, closedReason: closeReasons.current.get(c.position.id) ?? 'closed' },
        );
      }
      return next;
    });
    setLoaded(true);
  }, []);

  const removalScheduled = useRef(new Set<string>());
  useEffect(() => {
    for (const c of cards) {
      const id = c.position.id;
      if (!c.closedReason || removalScheduled.current.has(id)) continue;
      removalScheduled.current.add(id);
      setTimeout(() => {
        setCards((cur) => cur.filter((x) => x.position.id !== id));
        closeReasons.current.delete(id);
        removalScheduled.current.delete(id);
      }, CLOSED_CARD_MS);
    }
  }, [cards]);

  const loadEvents = useCallback(async () => {
    setEvents(await api.events('?limit=15', 'all'));
  }, []);

  useEffect(() => {
    void load();
    void loadEvents();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [load, loadEvents]);

  const throttledEvents = useThrottled(() => void loadEvents());
  const { connected } = useRealtime((msg: WsMessage) => {
    if (msg.payload == null) {
      void load();
      return;
    }
    if (msg.type === 'position_updated') {
      applyTick(msg.payload as PositionUpdatePayload);
    } else if (msg.type === 'trade_opened') {
      void load();
      throttledEvents();
    } else if (msg.type === 'trade_closed') {
      const p = msg.payload as { positionId?: string; closeReason?: string };
      if (p.positionId) closeReasons.current.set(p.positionId, p.closeReason ?? 'closed');
      void load();
      throttledEvents();
    } else if (msg.type === 'bot_event' || msg.type === 'signal_generated') {
      throttledEvents();
    }
  });

  function applyTick(u: PositionUpdatePayload) {
    if (!u?.positionId || u.priceUsd == null) return;
    setCards((prev) =>
      prev.map((c) => {
        if (c.position.id !== u.positionId || c.closedReason) return c;
        const p = c.position;
        const last = p.history.at(-1);
        const history =
          last && last.t === u.observedAt
            ? p.history
            : [...p.history, { t: u.observedAt, price: u.priceUsd }].slice(-500);
        const flash: Flash =
          u.priceUsd > p.currentPriceUsd ? 'up' : u.priceUsd < p.currentPriceUsd ? 'down' : null;
        const highest = Math.max(p.highestPriceUsd, u.highestPriceUsd ?? u.priceUsd);
        return {
          ...c,
          lastTickAt: Date.now(),
          tickCount: c.tickCount + 1,
          flash,
          position: {
            ...p,
            history,
            currentPriceUsd: u.priceUsd,
            currentValueUsd: p.quantity * u.priceUsd,
            unrealizedPnlUsd: u.unrealizedPnlUsd,
            unrealizedPnlPct: u.unrealizedPnlPct,
            highestPriceUsd: highest,
            trailingStopPriceUsd:
              p.trailingStopPct != null ? highest * (1 - p.trailingStopPct) : null,
          },
        };
      }),
    );
  }

  const openCount = cards.filter((c) => !c.closedReason).length;

  return (
    <div className="page">
      <LaneLegend />
      <div className="live-header">
        <h2 style={{ margin: 0 }}>Live positions</h2>
        <span className="badge">{openCount} open</span>
        <span className={`badge ${connected ? 'run' : 'pause'}`}>
          {connected ? 'STREAMING' : 'RECONNECTING…'}
        </span>
      </div>

      {loaded && cards.length === 0 && (
        <div className="panel">
          <div style={{ color: 'var(--muted)', marginBottom: '0.6rem' }}>
            No open positions — bot is scanning…
          </div>
          <div className="log-panel">
            {events.map((e) => (
              <EventLine key={e.id} event={e} />
            ))}
          </div>
        </div>
      )}

      <div className="live-grid">
        {cards.map((c) => (
          <PositionCard key={c.position.id} card={c} now={now} />
        ))}
      </div>
    </div>
  );
}

function PositionCard({ card, now }: { card: CardState; now: number }) {
  const p = card.position;
  const changePct = p.entryPriceUsd > 0 ? (p.currentPriceUsd / p.entryPriceUsd - 1) * 100 : 0;
  const openedMs = new Date(p.openedAt).getTime();
  const data = p.history.map((h) => ({ t: new Date(h.t).getTime(), price: h.price }));
  const prices = data.map((d) => d.price);
  const lo = Math.min(...prices, p.stopLossPriceUsd, p.entryPriceUsd);
  const hi = Math.max(...prices, p.takeProfitPriceUsd, p.entryPriceUsd);
  const pad = (hi - lo) * 0.05 || hi * 0.05;
  const tickAge = card.lastTickAt != null ? Math.floor((now - card.lastTickAt) / 1000) : null;

  return (
    <div className={`panel live-card ${card.closedReason ? 'closed' : ''} ${laneCardClass(p.lane, p.strategyId)}`}>
      <div className="live-card-head">
        <div>
          <Link to={`/tokens/${p.tokenId}`} className="live-symbol">
            {p.token?.symbol ?? p.tokenId.slice(0, 6)}
          </Link>
          <div style={{ marginTop: '0.25rem' }}>
            <LaneTags lane={p.lane} strategyId={p.strategyId} />
          </div>
        </div>
        {card.closedReason ? (
          <span className="badge pause">CLOSED · {card.closedReason}</span>
        ) : (
          <span className="live-tick">
            <span className={`live-dot ${tickAge != null && tickAge < 15 ? 'on' : ''}`} />
            {tickAge != null ? `last tick ${tickAge}s ago` : 'waiting for tick…'}
          </span>
        )}
      </div>

      <div className="live-prices">
        <div className="metric">
          <span className="label">Bought at</span>
          <span className="value">{fmtPrice(p.entryPriceUsd)}</span>
        </div>
        <div className="metric">
          <span className="label">Current</span>
          <span
            key={card.tickCount}
            className={`value ${card.flash ? `flash-${card.flash}` : ''}`}
          >
            {fmtPrice(p.currentPriceUsd)}
          </span>
        </div>
        <div className="metric">
          <span className="label">Change</span>
          <span className={`value ${pnlClass(changePct)}`}>{pct(changePct)}</span>
        </div>
        <div className="metric">
          <span className="label">Unrealized P/L</span>
          <span className={`value ${pnlClass(p.unrealizedPnlUsd)}`}>
            {money(p.unrealizedPnlUsd)} ({pct(p.unrealizedPnlPct)})
          </span>
        </div>
      </div>

      <div style={{ height: 200 }}>
        {data.length < 2 ? (
          <div style={{ color: 'var(--muted)' }}>Collecting price ticks…</div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t: number) => new Date(t).toLocaleTimeString()}
                stroke="#8fa3b8"
                fontSize={10}
                minTickGap={40}
              />
              <YAxis
                domain={[lo - pad, hi + pad]}
                tickFormatter={(v: number) => fmtPrice(v)}
                width={78}
                stroke="#8fa3b8"
                fontSize={10}
              />
              <Tooltip
                contentStyle={{ background: '#0d141c', border: '1px solid #243447' }}
                labelFormatter={(t: number) => new Date(t).toLocaleTimeString()}
                formatter={(v: number) => [fmtPrice(v), 'Price']}
              />
              <ReferenceLine
                y={p.takeProfitPriceUsd}
                stroke="#2fe39b"
                strokeDasharray="4 4"
                label={{ value: 'TP', position: 'right', fill: '#2fe39b', fontSize: 10 }}
              />
              <ReferenceLine
                y={p.entryPriceUsd}
                stroke="#e7eef7"
                strokeDasharray="2 3"
                label={{ value: 'Entry', position: 'right', fill: '#e7eef7', fontSize: 10 }}
              />
              <ReferenceLine
                y={p.stopLossPriceUsd}
                stroke="#ff5c7a"
                strokeDasharray="4 4"
                label={{ value: 'SL', position: 'right', fill: '#ff5c7a', fontSize: 10 }}
              />
              {p.trailingStopPriceUsd != null && p.trailingStopPriceUsd > p.stopLossPriceUsd && (
                <ReferenceLine
                  y={p.trailingStopPriceUsd}
                  stroke="#f0b429"
                  strokeDasharray="1 3"
                  label={{ value: 'Trail', position: 'right', fill: '#f0b429', fontSize: 10 }}
                />
              )}
              {openedMs >= data[0]!.t && (
                <ReferenceLine x={openedMs} stroke="#5b8cff" strokeDasharray="3 3" />
              )}
              <Line
                type="monotone"
                dataKey="price"
                stroke={changePct >= 0 ? '#2fe39b' : '#ff5c7a'}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="live-foot">
        <span>Size {money(p.costBasisUsd)}</span>
        <span>Value {money(p.currentValueUsd)}</span>
        <span>
          SL {fmtPrice(p.stopLossPriceUsd)} · TP {fmtPrice(p.takeProfitPriceUsd)}
        </span>
        <span>Held {fmtDuration(now - openedMs)}</span>
      </div>
    </div>
  );
}

function fmtPrice(n: number): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1) return money(n, 4);
  return `$${n.toPrecision(4)}`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
