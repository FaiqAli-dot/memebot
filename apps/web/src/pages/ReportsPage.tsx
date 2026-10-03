import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  DailyReport,
  DailyReportListItem,
  FeatureStat,
  Lesson,
} from '@memebot/shared';
import { api, money, pct, pnlClass } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';

type ReportsMeta = Omit<Awaited<ReturnType<typeof api.reports>>, 'reports'>;

const PARAM_LABELS: Record<string, string> = {
  minPriceChange5mPct: 'Min 5m price change',
  minBuySellRatio: 'Min buy/sell ratio',
  minVolumeAcceleration: 'Min volume acceleration',
  minLiquidityUsd: 'Min liquidity',
  minActivityTx5m: 'Min tx per 5m',
  minVolume5mUsd: 'Min 5m volume',
  minOverallScore: 'Min overall score',
  maxTopHolderPct: 'Max top holder',
  minTokenAgeMinutes: 'Min token age (min)',
  maxTokenAgeMinutes: 'Max token age (min)',
  stopLossPct: 'Stop-loss',
  takeProfitPct: 'Take-profit',
  trailingStopPct: 'Trailing stop',
  all: 'All settings',
};

const TAG_LABELS: Record<string, string> = {
  biggest_win: 'Biggest win',
  biggest_loss: 'Biggest loss',
  fast_stop_out: 'Fast stop-out',
  costs_ate_gain: 'Costs ate the gain',
};

function fmtParam(param: string, v: number | null): string {
  if (v == null) return '—';
  if (param === 'stopLossPct' || param === 'takeProfitPct' || param === 'trailingStopPct') {
    return pct(v * 100, 1);
  }
  if (param === 'minLiquidityUsd' || param === 'minVolume5mUsd') return money(v, 0);
  if (param === 'minPriceChange5mPct' || param === 'maxTopHolderPct') return pct(v, 1);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function fmtFeature(feature: string, v: number | null): string {
  if (v == null) return '—';
  if (feature === 'liquidityUsd' || feature === 'volume5mUsd') return money(v, 0);
  if (feature === 'priceChange5mPct' || feature === 'topHolderPct') return pct(v, 1);
  return v.toFixed(2);
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function ReportsPage() {
  const [list, setList] = useState<DailyReportListItem[]>([]);
  const [meta, setMeta] = useState<ReportsMeta | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const { reports, ...rest } = await api.reports();
    setList(reports);
    setMeta(rest);
    setSelectedId((cur) => cur ?? reports[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      return;
    }
    void api.report(selectedId).then(setReport);
  }, [selectedId]);

  useRealtime((msg) => {
    if (msg.type !== 'report_generated') return;
    void loadList();
    if (selectedId) void api.report(selectedId).then(setReport);
  });

  async function act(fn: () => Promise<DailyReport>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setSelectedId(r.id);
      setReport(r);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="btn-row" style={{ marginBottom: '0.75rem', alignItems: 'center' }}>
        <button className="btn primary" disabled={busy} onClick={() => void act(api.runReport)}>
          GENERATE NOW
        </button>
        {meta && (
          <span style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
            Runs daily at {meta.reportTime} ({meta.reportTimezone}) · learning{' '}
            {meta.learningEnabled ? 'ON' : 'OFF (report only)'} · needs {meta.minTrades}+ trades in 7 days
          </span>
        )}
      </div>
      {error && (
        <div className="panel" style={{ color: 'var(--danger)', marginBottom: '0.75rem' }}>
          {error}
        </div>
      )}

      <div className="reports-layout">
        <div className="panel">
          <h2>Daily reports</h2>
          {list.length === 0 && (
            <div style={{ color: 'var(--muted)' }}>
              No reports yet. The first one is written at the report time, or click Generate now.
            </div>
          )}
          <div className="report-list">
            {list.map((r) => (
              <button
                key={r.id}
                className={`report-item ${r.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(r.id)}
              >
                <span className="report-date">{r.reportDate}</span>
                <span>
                  {r.summary.tradeCount} trades · {pct(r.summary.winRatePct, 0)} win
                </span>
                <span className={pnlClass(r.summary.netPnlUsd)}>{money(r.summary.netPnlUsd)}</span>
                <span className="report-badges">
                  {r.lessonCounts.applied > 0 && (
                    <span className={`badge ${r.rolledBackAt ? 'pause' : 'run'}`}>
                      {r.lessonCounts.applied} {r.rolledBackAt ? 'rolled back' : 'changed'}
                    </span>
                  )}
                  {r.lessonCounts.reverted > 0 && (
                    <span className="badge pause">{r.lessonCounts.reverted} reverted</span>
                  )}
                  {(r.lessonCounts.validated_not_applied ?? 0) > 0 && (
                    <span className="badge">{r.lessonCounts.validated_not_applied} observed</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          {report ? (
            <ReportDetail
              report={report}
              busy={busy}
              onRollback={() => void act(() => api.rollbackReport(report.id))}
            />
          ) : (
            list.length > 0 && <div className="panel">Loading report…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportDetail({
  report,
  busy,
  onRollback,
}: {
  report: DailyReport;
  busy: boolean;
  onRollback: () => void;
}) {
  const s = report.summary;
  const { exits, review, mode, dataQuality: dq, strategies } = report.analysis;
  const canRollback = report.applied && !report.rolledBackAt;

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {mode && (
        <div className="week1-banner">
          <strong>{mode.banner}</strong>
          <span>Live trading: {mode.liveExecution}</span>
          <span>Automatic strategy promotion: {mode.automaticStrategyPromotion}</span>
        </div>
      )}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <h2 style={{ margin: 0 }}>Report {report.reportDate}</h2>
          <span className={`badge ${report.dataMode === 'demo' ? 'demo' : 'live'}`}>
            {report.dataMode === 'demo' ? 'DEMO DATA' : 'LIVE DATA'}
          </span>
          {report.rolledBackAt && <span className="badge pause">ROLLED BACK</span>}
          {canRollback && (
            <button className="btn danger" style={{ marginLeft: 'auto' }} disabled={busy} onClick={onRollback}>
              ROLL BACK CHANGES
            </button>
          )}
        </div>
        {report.dataMode === 'demo' && (
          <p className="disclaimer" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
            Built from synthetic demo prices. Lessons learned here reflect the demo generator, not real markets.
          </p>
        )}
        <div className="grid grid-4">
          <Metric label="Trades today" value={String(s.tradeCount)} />
          <Metric label="Win rate" value={`${pct(s.winRatePct, 0)} (${s.wins}W / ${s.losses}L)`} />
          <Metric label="Net P/L" value={money(s.netPnlUsd)} className={pnlClass(s.netPnlUsd)} />
          <Metric label="Costs paid" value={money(s.costsUsd)} />
          <Metric label="Avg hold" value={fmtDuration(s.avgHoldSec)} />
          <Metric
            label={`${s.windowDays}-day window`}
            value={`${s.windowTradeCount} trades · ${pct(s.windowWinRatePct, 0)} win`}
          />
          <Metric
            label="Exits today"
            value={
              Object.entries(s.byCloseReason)
                .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
                .join(' · ') || '—'
            }
          />
          <Metric label="Last changes review" value={reviewLabel(review.verdict, review.reverted)} />
        </div>
      </div>

      {dq && (
        <div className="panel">
          <h3>Learning data quality (production)</h3>
          <div className="grid grid-4">
            <Metric label="True entry snapshots" value={String(dq.trueEntrySnapshots)} />
            <Metric label="Signal backfills" value={String(dq.signalBackfills)} />
            <Metric label="Partial snapshots" value={String(dq.partialEntrySnapshots)} />
            <Metric label="Calibration-eligible" value={String(dq.calibrationEligible)} />
          </div>
          <p className="disclaimer">
            {dq.note ?? 'Only true entry snapshots feed calibration and parameter lessons.'} Research observations (
            {dq.research}) are never used for production learning.
          </p>
        </div>
      )}

      {strategies && strategies.length > 0 && (
        <div className="panel">
          <h3>Per strategy</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Today</th>
                  <th>{s.windowDays}-day trades (eligible)</th>
                  <th>Win rate [95% CI]</th>
                  <th>Avg predicted EV / realized</th>
                  <th>Avg size</th>
                  <th>Net P/L ({s.windowDays}d)</th>
                  <th>Calibration</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((st) => (
                  <tr key={st.strategyId}>
                    <td title={st.strategyId}>{st.name}</td>
                    <td>
                      {st.day.trades} · {st.day.wins}W/{st.day.losses}L ·{' '}
                      <span className={pnlClass(st.day.netPnlUsd)}>{money(st.day.netPnlUsd)}</span>
                    </td>
                    <td>
                      {st.window.trades} ({st.window.calibrationEligible})
                    </td>
                    <td>
                      {pct(st.window.winRatePct, 0)}
                      {st.window.winRateCI &&
                        ` [${st.window.winRateCI.low.toFixed(0)}–${st.window.winRateCI.high.toFixed(0)}%]`}
                    </td>
                    <td>
                      {st.window.avgPredictedEv == null ? '—' : pct(st.window.avgPredictedEv * 100, 2)} /{' '}
                      {st.window.avgRealizedReturn == null ? '—' : pct(st.window.avgRealizedReturn * 100, 2)}
                    </td>
                    <td>{st.window.avgPositionSizeUsd == null ? '—' : money(st.window.avgPositionSizeUsd)}</td>
                    <td className={pnlClass(st.window.netPnlUsd)}>{money(st.window.netPnlUsd)}</td>
                    <td className="muted">
                      {st.calibration.activeVersion ?? 'uncalibrated'}
                      {st.calibration.latestCandidate &&
                        ` · ${st.calibration.latestStatus ?? ''} ${st.calibration.latestCandidate}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>Lessons</h3>
        <div className="lesson-list">
          {report.lessons.map((l, i) => (
            <LessonRow key={i} lesson={l} rolledBack={Boolean(report.rolledBackAt)} />
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Important trades</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Why picked</th>
                <th>Net P/L</th>
                <th>Peak gain</th>
                <th>Costs</th>
                <th>Held</th>
                <th>Exit</th>
              </tr>
            </thead>
            <tbody>
              {report.importantTrades.map((t) => (
                <tr key={t.positionId}>
                  <td>
                    <Link to={`/tokens/${t.tokenId}`}>{t.symbol}</Link>
                  </td>
                  <td>{t.tags.map((tag) => TAG_LABELS[tag] ?? tag).join(', ')}</td>
                  <td className={pnlClass(t.netPnlUsd)}>
                    {money(t.netPnlUsd)} ({pct(t.netPnlPct, 1)})
                  </td>
                  <td>{pct(t.peakGainPct, 1)}</td>
                  <td>{money(t.costsUsd)}</td>
                  <td>{fmtDuration(t.holdSec)}</td>
                  <td>{t.closeReason?.replace(/_/g, ' ') ?? '—'}</td>
                </tr>
              ))}
              {report.importantTrades.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ color: 'var(--muted)' }}>
                    No closed trades on this day
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Winners vs losers at entry ({s.windowDays}-day window)</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Setting</th>
                <th>Limit</th>
                <th>Winners avg</th>
                <th>Losers avg</th>
                <th>Near the limit</th>
                <th>The rest</th>
              </tr>
            </thead>
            <tbody>
              {report.analysis.features.map((f) => (
                <FeatureRow key={`${f.strategyId ?? 'all'}:${f.param}`} f={f} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="disclaimer">
          Each row uses only that strategy's true-entry-snapshot trades. "Near the limit" means trades that one
          guarded step (10%) of tightening would have filtered out. A setting only changes with 8+ trades on each
          side, a 15-point win-rate gap on the older 70%, and confirmation on the newer, unseen 30%.
        </p>
      </div>

      <div className="panel">
        <h3>Exit behavior</h3>
        <div className="grid grid-4">
          <Metric label="Stop-loss share" value={pct(exits.stopLossSharePct, 0)} />
          <Metric label="Median stop-out hold" value={fmtDuration(exits.medianStopHoldSec)} />
          <Metric label="Median winner hold" value={fmtDuration(exits.medianWinnerHoldSec)} />
          <Metric
            label="Losers that were up first"
            value={`${exits.losersThatWereUp} / ${exits.losers} (${pct(exits.losersThatWereUpSharePct, 0)})`}
          />
        </div>
      </div>
    </div>
  );
}

function reviewLabel(verdict: string, reverted: boolean): string {
  if (reverted) return 'Worse twice: reverted';
  switch (verdict) {
    case 'better':
      return 'Helped';
    case 'worse':
      return 'Worse (watching)';
    case 'inconclusive':
      return 'Not enough data yet';
    default:
      return 'No earlier changes';
  }
}

function LessonRow({ lesson: l, rolledBack }: { lesson: Lesson; rolledBack: boolean }) {
  const status = l.status === 'applied' && rolledBack ? 'rolled back' : l.status;
  const cls =
    status === 'applied' ? 'run' : status === 'skipped' || status === 'validated_not_applied' ? '' : 'pause';
  const owner = l.strategyId ?? (l.param === 'all' ? null : 'portfolio-wide');
  return (
    <div className="lesson">
      <span className={`badge ${cls}`}>{status.replace(/_/g, ' ').toUpperCase()}</span>
      <div>
        <div className="lesson-title">
          {owner && <span className="muted">{owner} · </span>}
          {PARAM_LABELS[l.param] ?? l.param}
          {l.from != null && l.to != null && (
            <>
              {' '}
              {fmtParam(l.param, l.from)} → {fmtParam(l.param, l.to)}
            </>
          )}
        </div>
        <div className="lesson-reason">{l.reason}</div>
        {(l.trainingSampleCount != null || l.confidence) && (
          <div className="lesson-reason muted">
            {l.trainingSampleCount != null &&
              `train ${l.trainingSampleCount} / unseen ${l.validationSampleCount ?? 0} trades`}
            {l.trainingMetrics?.gapPp != null && ` · train gap ${l.trainingMetrics.gapPp.toFixed(0)}pp`}
            {l.validationMetrics?.gapPp != null && ` · unseen gap ${l.validationMetrics.gapPp.toFixed(0)}pp`}
            {l.confidence && ` · ${l.confidence} confidence`}
          </div>
        )}
      </div>
    </div>
  );
}

function FeatureRow({ f }: { f: FeatureStat }) {
  const bucket = (b: FeatureStat['band']) =>
    b.n === 0 ? '—' : `${b.n} trades · ${pct(b.winRatePct, 0)} win`;
  return (
    <tr>
      <td>{f.strategyId ?? 'all (legacy)'}</td>
      <td>{PARAM_LABELS[f.param] ?? f.param}</td>
      <td>{fmtParam(f.param, f.threshold)}</td>
      <td>{fmtFeature(f.feature, f.winners.mean)}</td>
      <td>{fmtFeature(f.feature, f.losers.mean)}</td>
      <td>{bucket(f.band)}</td>
      <td>{bucket(f.rest)}</td>
    </tr>
  );
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="panel metric">
      <span className="label">{label}</span>
      <span className={`value ${className ?? ''}`}>{value}</span>
    </div>
  );
}
