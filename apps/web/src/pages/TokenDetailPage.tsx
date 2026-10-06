import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SCORE_DISCLAIMER, type PortfolioLane } from '@memebot/shared';
import { api, money, pct } from '../lib/api';
import { LaneTags } from '../components/LaneBadge';

export function TokenDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!id) return;
    void api.token(id).then(setData);
  }, [id]);

  if (!data) return <div className="page">Loading token…</div>;
  const token = data.token as Record<string, unknown>;
  const history = (data.marketHistory as Record<string, unknown>[]) ?? [];
  const holders = data.holders as Record<string, unknown> | null;
  const signal = data.signal as Record<string, unknown> | null;
  const safety = (data.safety as Record<string, unknown>[]) ?? [];
  const phases = (data.phases as Record<string, unknown>[]) ?? [];
  const timeline = (data.timeline as Record<string, unknown>[]) ?? [];
  const explanation = (signal?.explanation ?? {}) as {
    reasons?: string[];
    warnings?: string[];
  };
  const latestSafety = safety[0];

  const priceData = history.map((h) => ({
    t: new Date(String(h.observed_at)).toLocaleTimeString(),
    price: Number(h.price_usd),
    volume: Number(h.volume_5m_usd),
    liquidity: Number(h.liquidity_usd),
  }));

  return (
    <div className="page">
      <div className="panel" style={{ marginBottom: '0.75rem' }}>
        <h2>
          {String(token.symbol)} · {String(token.name)}
        </h2>
        {signal && (
          <div style={{ marginBottom: '0.4rem' }}>
            <LaneTags
              lane={signal.portfolio_lane as PortfolioLane | null}
              strategyId={String(signal.strategy_name ?? '') || null}
            />
            <span style={{ color: 'var(--muted)', fontSize: '0.68rem', marginLeft: '0.4rem' }}>latest signal</span>
          </div>
        )}
        <div style={{ color: 'var(--muted)' }}>
          {String(token.chain)} · {String(token.address)} · mode {String(token.data_mode).toUpperCase()} ·
          source {String(token.discovery_source ?? 'UNKNOWN')}
        </div>
        <div className="grid grid-4" style={{ marginTop: '0.75rem' }}>
          <KV label="Holders" value={holders?.holder_count != null ? String(holders.holder_count) : '—'} />
          <KV
            label="Top holder"
            value={holders?.top_holder_pct != null ? pct(Number(holders.top_holder_pct)) : '—'}
          />
          <KV
            label="Safety"
            value={
              latestSafety
                ? `${Number(latestSafety.score).toFixed(0)} · ${String(latestSafety.safety_class)}`
                : 'UNKNOWN'
            }
          />
          <KV
            label="Latest liquidity"
            value={money(priceData.at(-1)?.liquidity ?? 0, 0)}
          />
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: '0.75rem' }}>
        <div className="panel">
          <h3>Price</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <AreaChart data={priceData}>
                <XAxis dataKey="t" hide />
                <YAxis domain={['auto', 'auto']} width={60} stroke="#8fa3b8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#0d141c', border: '1px solid #243447' }} />
                <Area type="monotone" dataKey="price" stroke="#3dffa8" fill="#3dffa822" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="panel">
          <h3>Volume (5m)</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={priceData}>
                <XAxis dataKey="t" hide />
                <YAxis width={50} stroke="#8fa3b8" fontSize={11} />
                <Tooltip contentStyle={{ background: '#0d141c', border: '1px solid #243447' }} />
                <Bar dataKey="volume" fill="#5b8cff" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: '0.75rem' }}>
        <div className="panel">
          <h3>Why this signal?</h3>
          {signal ? (
            <>
              <div style={{ marginBottom: '0.3rem' }}>
                <LaneTags
                  lane={signal.portfolio_lane as PortfolioLane | null}
                  strategyId={String(signal.strategy_name ?? '') || null}
                />
              </div>
              <div>
                Model score {Number(signal.overall_score).toFixed(1)} · risk {String(signal.risk_label)} ·{' '}
                {String(signal.strategy_name)} {String(signal.strategy_version)}
              </div>
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
            </>
          ) : (
            <div style={{ color: 'var(--muted)' }}>No signal yet for this token.</div>
          )}
          {latestSafety ? (
            <div style={{ marginTop: '0.75rem' }}>
              <strong>Safety:</strong> {String(latestSafety.safety_class)} (
              {Number(latestSafety.score).toFixed(0)})
              <ul>
                {((latestSafety.reasons as string[]) ?? []).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="disclaimer">{String(data.scoreDisclaimer ?? SCORE_DISCLAIMER)}</p>
        </div>
        <div className="panel">
          <h3>Lifecycle timeline</h3>
          <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>
              TOKEN CREATED:{' '}
              {token.created_at_onchain
                ? new Date(String(token.created_at_onchain)).toLocaleString()
                : 'unknown'}
            </li>
            <li>
              FIRST OBSERVED:{' '}
              {token.first_observed_at || token.discovered_at
                ? new Date(String(token.first_observed_at ?? token.discovered_at)).toLocaleString()
                : '—'}
            </li>
            <li>
              LIQUIDITY ADDED:{' '}
              {token.first_liquidity_at
                ? new Date(String(token.first_liquidity_at)).toLocaleString()
                : 'unknown'}
            </li>
            <li>
              FIRST TRADES:{' '}
              {token.first_trade_at
                ? new Date(String(token.first_trade_at)).toLocaleString()
                : 'unknown'}
            </li>
            {phases.map((p, i) => (
              <li key={i}>
                PHASE {String(p.phase)} @ {new Date(String(p.observed_at)).toLocaleTimeString()}
              </li>
            ))}
            {latestSafety ? (
              <li>
                SAFETY {String(latestSafety.safety_class)}
                {latestSafety.blocked ? ' (BLOCKED)' : ''}
              </li>
            ) : null}
            {signal ? (
              <li>
                SIGNAL {String(signal.strategy_name)} score {Number(signal.overall_score).toFixed(0)}
              </li>
            ) : (
              <li>SIGNAL / PAPER ENTRY — none yet</li>
            )}
            {timeline.map((e, i) => (
              <li key={`e-${i}`}>
                {String(e.event_type)} · {String(e.source)}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
