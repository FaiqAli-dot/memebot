import { useCallback, useEffect, useState } from 'react';
import type { LearningInterval, LearningStatus } from '@memebot/shared';
import { api } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';

const POLL_MS = 30_000;

const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const ci = (i: LearningInterval | null, d = 0) => (i ? `${pct(i.low, d)}–${pct(i.high, d)}` : 'n/a');

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

const DECISION_LABEL: Record<string, string> = {
  PERFORMED: 'Eligible — will calibrate at the next evaluation',
  SKIPPED_INSUFFICIENT_OBSERVATIONS: 'Waiting for data',
  SKIPPED_INTERVAL_NOT_REACHED: 'Waiting for the learning interval',
  SKIPPED_DISABLED: 'Learning disabled',
};

export function LearningPanel() {
  const [data, setData] = useState<LearningStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.learningStatus());
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
    if (msg.type === 'learning_updated' || msg.type === 'trade_closed' || msg.type === 'report_generated') throttled();
  });

  if (!data) {
    return (
      <div className="panel readiness" style={{ marginBottom: '0.75rem' }}>
        <h2>Learning</h2>
        <div style={{ color: 'var(--muted)' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }

  const { observation: o, health: h, calibration: c, config } = data;
  const lastRunSkipped = c.lastRun && c.lastRun.decision !== 'PERFORMED';

  return (
    <div className="panel readiness" style={{ marginBottom: '0.75rem' }}>
      <div className="readiness-head">
        <span className="readiness-state">LEARNING</span>
        <span className="readiness-headline">
          Stage {c.stage.replace('_', ' ')} · {c.productionObservations} calibration-grade of {o.production} production
          observations
        </span>
        <span className="readiness-meta">
          {data.mode.observationMode ? 'observation mode · automatic promotion disabled' : 'paper only'} · losing streaks
          never change settings by themselves
        </span>
      </div>
      <p className="readiness-detail">{c.stageNote}</p>

      <div className="readiness-grid three">
        <div>
          <h3>1 · Observation (every trade)</h3>
          <div className="funnel-row funnel-total">
            <span>Completed trades observed</span>
            <span>{o.completed}</span>
          </div>
          <div className="funnel-row">
            <span>Production / research</span>
            <span>
              {o.production} / {o.research}
            </span>
          </div>
          <div className="funnel-row">
            <span>New since last calibration</span>
            <span>{o.newSinceCalibration}</span>
          </div>
          <div className="funnel-row">
            <span>Open trades (excluded until closed)</span>
            <span>{o.openTrades}</span>
          </div>
          <div className="funnel-row funnel-pass">
            <span>True entry snapshots (calibration-grade)</span>
            <span>{o.quality.trueEntrySnapshots}</span>
          </div>
          <div className="funnel-row">
            <span>Signal backfills / partial (descriptive only)</span>
            <span>
              {o.quality.signalBackfills} / {o.quality.partialEntrySnapshots}
            </span>
          </div>
          <div className="muted small">
            Last observation {ago(o.lastObservationAt)} · backfilled observations feed health checks and reports, never
            calibration or parameter lessons
          </div>

          <h3 style={{ marginTop: '0.6rem' }}>Per strategy (all completed trades, 95% intervals)</h3>
          {h.strategies.length === 0 && <div className="muted small">No completed trades yet.</div>}
          {h.strategies.map((s) => (
            <div key={`${s.scope}:${s.strategyId}`} className="muted small" style={{ marginBottom: '0.25rem' }}>
              <strong>{s.strategyId}</strong> {s.scope === 'RESEARCH' ? '(research)' : ''} · n={s.n}
              {s.lowSample && <span className="neg"> · LOW SAMPLE</span>}
              <br />
              win {pct(s.winRate, 0)} [{ci(s.winRateCI)}] vs predicted {pct(s.avgPredictedWinProbability, 0)} · avg
              return {pct(s.avgReturn, 2)} [{ci(s.avgReturnCI, 1)}] vs predicted EV {pct(s.avgPredictedEv, 2)}
            </div>
          ))}
        </div>

        <div>
          <h3>2 · Health check (every {config.anomalyCheckEvery} trades)</h3>
          <div className="funnel-row">
            <span>Last check</span>
            <span>{ago(h.lastCheckAt)}</span>
          </div>
          <div className="funnel-row">
            <span>Trades since last check</span>
            <span>
              {h.observationsSinceLastCheck} / {config.anomalyCheckEvery}
            </span>
          </div>
          <div className={`funnel-row ${h.critical > 0 ? '' : 'funnel-pass'}`}>
            <span>Warnings / critical</span>
            <span>
              {h.warnings} / {h.critical}
            </span>
          </div>
          <div className="muted small">
            Execution {h.byType.execution} · prediction {h.byType.prediction} · data {h.byType.data} · risk{' '}
            {h.byType.risk} · degradation {h.byType.degradation} — recent {config.recentWindow} vs baseline{' '}
            {config.baselineWindow} trades, alerts deduplicated for {config.alertCooldownMinutes}m
          </div>
          {h.protectionAction && <div className="neg small">Protection: {h.protectionAction}</div>}
          <h3 style={{ marginTop: '0.6rem' }}>Alerts (24h)</h3>
          {h.recentAnomalies.length === 0 && <div className="muted small">No anomalies emitted.</div>}
          {h.recentAnomalies.slice(0, 8).map((a, i) => (
            <div key={i} className="small" style={{ marginBottom: '0.25rem' }}>
              <span className={a.severity === 'INFO' ? 'muted' : 'neg'}>{a.severity}</span>{' '}
              <span className="muted">
                {a.type}
                {a.strategyId ? ` · ${a.strategyId}` : ''} · {ago(a.createdAt)}
              </span>
              <br />
              {a.message}
            </div>
          ))}
          <div className="muted small">Alerts never change thresholds, EV, risk multipliers or stops.</div>
        </div>

        <div>
          <h3>3 · Calibration (≥{config.minNewObservations} new obs AND ≥{config.learningIntervalHours}h)</h3>
          <div className="funnel-row funnel-total">
            <span>Status</span>
            <span>{DECISION_LABEL[c.gate.decision] ?? c.gate.decision}</span>
          </div>
          <div className="funnel-row">
            <span>New calibration-grade observations</span>
            <span>
              {c.gate.newObservations} / {c.gate.requiredObservations}
            </span>
          </div>
          <div className="funnel-row">
            <span>Hours since last calibration</span>
            <span>
              {c.gate.hoursSinceLast == null ? '—' : c.gate.hoursSinceLast.toFixed(1)} / {c.gate.requiredHours}
            </span>
          </div>
          <div className="funnel-row">
            <span>Current calibration</span>
            <span>{c.active.length ? c.active.map((a) => a.version).join(', ') : 'none (uncalibrated model)'}</span>
          </div>
          <div className="muted small">
            Last calibration {ago(c.lastPerformedAt)} · next evaluation {c.nextEvaluation}
            {c.observationsNeeded > 0 && <> · needs {c.observationsNeeded} more calibration-grade observations</>}
            {c.nextEligibleAt && <> · interval reached {new Date(c.nextEligibleAt).toLocaleString()}</>}
          </div>
          {lastRunSkipped && c.lastRun && (
            <div className="small" style={{ marginTop: '0.4rem' }}>
              <strong>CALIBRATION SKIPPED</strong> {ago(c.lastRun.createdAt)} — {c.lastRun.reason}
            </div>
          )}
          <h3 style={{ marginTop: '0.6rem' }}>Candidates</h3>
          {c.candidates.length === 0 && <div className="muted small">No candidate calibrations yet.</div>}
          {c.candidates.slice(0, 5).map((v) => (
            <div key={v.version} className="small" style={{ marginBottom: '0.25rem' }}>
              <span className={v.status === 'PROMOTED' ? 'pos' : v.status === 'REJECTED' ? 'neg' : 'muted'}>{v.status}</span>{' '}
              <span className="muted">
                {v.version} · train {v.trainingCount} / unseen {v.validationCount}
              </span>
              <br />
              {v.promotionDecision}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
