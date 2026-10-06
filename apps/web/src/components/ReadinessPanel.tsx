import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotReadiness, ReadinessNearMiss, ReadinessState } from '@memebot/shared';
import { api } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';
import { LaneBadge } from './LaneBadge';

const POLL_MS = 10_000;

const STATE_LABEL: Record<ReadinessState, string> = {
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  WARMING_UP: 'WARMING UP',
  HUNTING: 'SCANNING',
  TRADING: 'TRADING',
};

function fmtPct(fraction: number): string {
  const v = fraction * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function stamp(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${ago(iso)} (${sameDay ? clock : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`})`;
}

function EvLine({ label, c }: { label: string; c: ReadinessNearMiss }) {
  const pct = c.threshold > 0 ? Math.max(0, Math.min(100, (c.expectedNetValue / c.threshold) * 100)) : 0;
  return (
    <div className="near-miss">
      <div>
        {label}: <Link to={`/tokens/${c.tokenId}`}>{c.symbol}</Link>
        {c.strategyId && <span className="muted"> · {c.strategyId}</span>}
        <span className="muted"> · {ago(c.observedAt)}</span>
      </div>
      <div className="near-miss-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="muted">
        EV {fmtPct(c.expectedNetValue)} net vs {fmtPct(c.threshold)} needed
        {c.dataConfidence && <> · data {c.dataConfidence}</>}
        {c.executionCostRate != null && <> · cost {fmtPct(c.executionCostRate)}</>}
        {c.positionSizeUsd != null && <> · size ${c.positionSizeUsd.toFixed(2)}</>}
      </div>
    </div>
  );
}

export function ReadinessPanel() {
  const [data, setData] = useState<BotReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.botReadiness());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const throttled = useThrottled(() => void load(), 5000);
  useRealtime((msg) => {
    if (
      msg.type === 'signal_generated' ||
      msg.type === 'trade_opened' ||
      msg.type === 'trade_closed' ||
      msg.type === 'bot_status' ||
      msg.type === 'kill_switch'
    ) {
      throttled();
    }
  });

  if (!data) {
    return (
      <div className="panel readiness" style={{ marginBottom: '0.75rem' }}>
        <h2>Trading readiness</h2>
        <div style={{ color: 'var(--muted)' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }

  const { funnel, warmup, ev, research } = data;
  const nowStages = funnel.stages.filter((s) => s.scope === 'now');
  const windowStages = funnel.stages.filter((s) => s.scope === 'window');
  const maxNow = Math.max(1, ...nowStages.map((s) => s.count));
  const maxWindow = Math.max(1, ...windowStages.map((s) => s.count));
  const maxRej = Math.max(1, ...funnel.rejections.map((r) => r.count));
  const warmed = warmup.tokensReady > 0 || warmup.tokensEligible === 0;

  return (
    <div className={`panel readiness state-${data.state.toLowerCase()}`} style={{ marginBottom: '0.75rem' }}>
      <div className="readiness-head">
        <span className="readiness-dot" />
        <span className="readiness-state">{STATE_LABEL[data.state]}</span>
        <span className="readiness-headline">Production: {data.headline}</span>
        <span className="readiness-meta">
          last signal {stamp(data.lastSignalAt)} · last trade {stamp(data.lastTradeAt)}
        </span>
      </div>
      {data.researchLanes && data.researchLanes.length > 0 && (
        <div className="readiness-research-lanes">
          {data.researchLanes.map((l) => (
            <div key={l.key} className="readiness-research-lane">
              <LaneBadge lane={l.key === 'exploration' ? 'EXPLORATION_RESEARCH' : 'OLDER_TOKEN_RESEARCH'} />
              <span>
                last trade <strong>{stamp(l.lastTradeAt)}</strong>
              </span>
              <span>last signal {stamp(l.lastSignalAt)}</span>
              <span>{l.openPositions} open</span>
              <span>
                {l.tradesToday}/{l.dailyCap} trades today
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="readiness-detail">{data.detail}</p>

      <div className="readiness-grid three">
        <div>
          <h3>Checks that can block trading</h3>
          <ul className="readiness-gates">
            {data.gates.map((g) => (
              <li key={g.key} className={g.ok ? 'ok' : 'fail'} title={g.detail}>
                <span className="mark">{g.ok ? '✓' : '✗'}</span>
                <span className="gate-label">{g.label}</span>
                <span className="gate-detail">{g.detail}</span>
              </li>
            ))}
            <li className={warmed ? 'ok' : 'fail'}>
              <span className="mark">{warmed ? '✓' : '…'}</span>
              <span className="gate-label">Acceleration baseline</span>
              <span className="gate-detail">
                {warmup.tokensReady}/{warmup.tokensEligible} tradeable tokens have ≥{warmup.minHistoryMinutes}m history
              </span>
            </li>
          </ul>

          <h3 style={{ marginTop: '0.75rem' }}>
            Exploration research lane (borderline new-token signals · separate portfolio){' '}
            <LaneBadge lane="EXPLORATION_RESEARCH" short />
          </h3>
          <div className="funnel-row funnel-total">
            <span>{research.enabled ? 'Enabled' : 'Disabled'} · EV shortfall ≤ {fmtPct(research.maxEvShortfall)}</span>
            <span>
              {research.tradesToday}/{research.maxTradesPerDay} today
            </span>
          </div>
          <div className="muted small">
            {research.signalsInWindow} research signal(s) in window · {research.openPositions} open · never counted in
            production stats
          </div>
        </div>

        <div>
          <h3>Universe now</h3>
          {nowStages.map((s) => (
            <div key={s.key} className="funnel-row">
              <span>{s.label}</span>
              <span className="funnel-bar pass">
                <span style={{ width: `${(s.count / maxNow) * 100}%` }} />
              </span>
              <span>{s.count}</span>
            </div>
          ))}
          <h3 style={{ marginTop: '0.6rem' }}>
            Pipeline (last {data.windowMinutes} min, {funnel.ticks} ticks)
          </h3>
          {windowStages.map((s) => (
            <div key={s.key} className="funnel-row">
              <span>{s.label}</span>
              <span className="funnel-bar pass">
                <span style={{ width: `${(s.count / maxWindow) * 100}%` }} />
              </span>
              <span>{s.count}</span>
            </div>
          ))}
          <div className="funnel-row funnel-pass">
            <span>Production signals → trades opened</span>
            <span>
              {funnel.signals} → {funnel.tradesOpened}
            </span>
          </div>
        </div>

        <div>
          <h3>Why candidates were rejected</h3>
          {funnel.rejections.length === 0 && <div className="muted small">No rejections recorded yet.</div>}
          {funnel.rejections.map((r) => (
            <div key={r.key} className="funnel-row">
              <span>{r.label}</span>
              <span className="funnel-bar">
                <span style={{ width: `${(r.count / maxRej) * 100}%` }} />
              </span>
              <span>{r.count}</span>
            </div>
          ))}
          {funnel.byStrategy.length > 0 && (
            <details className="by-strategy">
              <summary>By strategy</summary>
              {funnel.byStrategy.map((s) => (
                <div key={s.strategyId} className="muted small">
                  <strong>{s.strategyId}</strong>: {s.rejections.map((r) => `${r.label} ${r.count}`).join(' · ')}
                </div>
              ))}
            </details>
          )}

          <h3 style={{ marginTop: '0.6rem' }}>Expected value (distinct candidates: {ev.candidates})</h3>
          <div className="muted small">
            Threshold {fmtPct(ev.minExpectedNetValue)} (×{ev.lowConfidenceMultiplier} when data confidence is LOW) ·
            within 0.5pp: {ev.within0_5pct} · 1pp: {ev.within1pct} · 2pp: {ev.within2pct}
          </div>
          {ev.best && <EvLine label="Best candidate" c={ev.best} />}
          {ev.closestMiss && ev.closestMiss.tokenId !== ev.best?.tokenId && (
            <EvLine label="Closest miss" c={ev.closestMiss} />
          )}
        </div>
      </div>
      <RiskSection risk={data.risk} />
    </div>
  );
}

const usd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
const rate = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(0)}%`);

function RiskSection({ risk }: { risk: BotReadiness['risk'] }) {
  const maxRej = Math.max(1, ...risk.rejections.map((r) => r.count));
  return (
    <div className="readiness-grid three" style={{ marginTop: '0.75rem' }}>
      <div>
        <h3>Risk sizing (last {risk.windowMinutes} min, unique signals)</h3>
        <div className="funnel-row funnel-total">
          <span>Candidates reaching risk</span>
          <span>{risk.candidates}</span>
        </div>
        <div className="funnel-row">
          <span>Sized as requested / resized / rejected</span>
          <span>
            {risk.sized} / {risk.resized} / {risk.rejected}
          </span>
        </div>
        <div className="funnel-row">
          <span>Pass · resize · reject rate</span>
          <span>
            {rate(risk.passRate)} · {rate(risk.resizeRate)} · {rate(risk.rejectRate)}
          </span>
        </div>
        <div className="funnel-row funnel-pass">
          <span>Would fail at requested size, pass smaller</span>
          <span>{risk.passIfSmaller}</span>
        </div>
        <div className="muted small">
          After sizing: {risk.executed} executed · {risk.evFailedAtFinalSize} failed EV at final size ·{' '}
          {risk.limitBlocked} blocked by atomic limit check
        </div>
      </div>

      <div>
        <h3>Position sizes</h3>
        <div className="funnel-row">
          <span>Avg requested → final</span>
          <span>
            {usd(risk.avgRequestedSizeUsd)} → {usd(risk.avgFinalSizeUsd)}
          </span>
        </div>
        <div className="funnel-row">
          <span>Avg size multiplier vs base</span>
          <span>{risk.avgPositionMultiplier == null ? '—' : `×${risk.avgPositionMultiplier.toFixed(2)}`}</span>
        </div>
        <div className="funnel-row">
          <span>Avg max planned loss (at stop, incl. costs)</span>
          <span>
            {usd(risk.avgMaxPlannedLossUsd)} / {usd(risk.maxRiskPerTradeUsd)} allowed
          </span>
        </div>
        <div className="funnel-row">
          <span>Avg round-trip execution cost</span>
          <span>{rate(risk.avgExecutionCostRate)}</span>
        </div>
        <div className="muted small">
          Base {usd(risk.baseSizeUsd)} · min {usd(risk.minSizeUsd)} · open exposure {usd(risk.openExposureUsd)} of{' '}
          {usd(risk.maxPortfolioExposureUsd)}
        </div>
      </div>

      <div>
        <h3>Risk rejections</h3>
        {risk.rejections.length === 0 && <div className="muted small">No risk rejections in window.</div>}
        {risk.rejections.map((r) => (
          <div key={r.key} className="funnel-row">
            <span>{r.label}</span>
            <span className="funnel-bar">
              <span style={{ width: `${(r.count / maxRej) * 100}%` }} />
            </span>
            <span>{r.count}</span>
          </div>
        ))}
        {risk.resizedBy.length > 0 && (
          <div className="muted small">
            Resized by: {risk.resizedBy.map((r) => `${r.label} ${r.count}`).join(' · ')}
          </div>
        )}
        {risk.examples.length > 0 && (
          <details className="by-strategy">
            <summary>Recent decisions</summary>
            {risk.examples.map((e, i) => (
              <div key={i} className="muted small">
                <strong>{e.symbol}</strong> {e.decision}
                {e.reason && <> ({e.reason})</>} · EV {e.expectedNetValue == null ? '—' : fmtPct(e.expectedNetValue)} ·{' '}
                {usd(e.requestedSizeUsd)} → {usd(e.decision === 'REJECTED' ? e.maxViableSizeUsd : e.finalSizeUsd)} · max
                loss {usd(e.maximumPlannedLossUsd)}
                {e.executionStatus && <> · {e.executionStatus}</>}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
