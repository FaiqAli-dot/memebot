import { useCallback, useEffect, useState } from 'react';
import type { Week1Overview, Week1PerformanceStats } from '@memebot/shared';
import { api, money, pnlClass } from '../lib/api';
import { useRealtime, useThrottled } from '../hooks/useRealtime';

const POLL_MS = 60_000;
const WINDOWS = [24, 72, 168] as const;

const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${x.toFixed(d)}%`);
const rate = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = (x: number | null | undefined) => (x == null ? '—' : money(x));

function dur(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="funnel-row">
      <span>{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}

function Perf({ s }: { s: Week1PerformanceStats }) {
  return (
    <>
      <Row label="Closed trades (W / L)" value={`${s.closedTrades} (${s.wins} / ${s.losses})`} />
      <Row
        label="Win rate [95% CI]"
        value={`${pct(s.winRatePct, 0)} [${s.winRateCI ? `${s.winRateCI.low.toFixed(0)}–${s.winRateCI.high.toFixed(0)}%` : 'n/a'}]`}
      />
      <Row label="Realized P/L" value={money(s.realizedPnlUsd)} className={pnlClass(s.realizedPnlUsd)} />
      <Row label="Avg win / avg loss" value={`${usd(s.avgWinUsd)} / ${usd(s.avgLossUsd)}`} />
      <Row label="Profit factor" value={s.profitFactor == null ? '—' : s.profitFactor.toFixed(2)} />
      <Row label="Avg hold" value={dur(s.avgHoldSec)} />
    </>
  );
}

/** Week-1 daily review: everything worth checking once a day, on one panel. */
export function Week1Panel() {
  const [hours, setHours] = useState<number>(24);
  const [data, setData] = useState<Week1Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.week1Overview(hours));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hours]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const throttled = useThrottled(() => void load(), 10_000);
  useRealtime((msg) => {
    if (msg.type === 'trade_closed' || msg.type === 'trade_opened' || msg.type === 'learning_updated') throttled();
  });

  if (!data) {
    return (
      <div className="panel readiness" style={{ marginBottom: '0.75rem' }}>
        <h2>Week-1 observation</h2>
        <div style={{ color: 'var(--muted)' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }

  const { mode, trading: t, performance: p, execution: e, risk: r, learning: l } = data;
  const label = hours === 24 ? '24h' : `${hours / 24}d`;

  return (
    <div className="panel readiness week1" style={{ marginBottom: '0.75rem' }}>
      <div className="week1-banner">
        <strong>{mode.banner}</strong>
        <span>Live trading: {mode.liveExecution}</span>
        <span>Automatic strategy promotion: {mode.automaticStrategyPromotion}</span>
        <span>Automatic risk expansion: {mode.automaticRiskExpansion}</span>
        <span className="week1-windows">
          {WINDOWS.map((h) => (
            <button key={h} className={`btn ${h === hours ? 'primary' : ''}`} onClick={() => setHours(h)}>
              {h === 24 ? '24h' : `${h / 24}d`}
            </button>
          ))}
        </span>
      </div>
      <p className="readiness-detail">{p.sampleNote}</p>

      <div className="readiness-grid three">
        <div>
          <h3>Trading ({label})</h3>
          <Row label="Tokens discovered" value={String(t.tokensDiscovered)} />
          <Row label="Tokens tracked (now)" value={String(t.tokensTracked)} />
          <Row label="Trading-eligible tokens (now)" value={String(t.tokensEligible)} />
          <Row label="Signals (production / research)" value={`${t.signals} (${t.productionSignals} / ${t.researchSignals})`} />
          <Row label="Paper trades opened / closed" value={`${t.tradesOpened} / ${t.tradesClosed}`} />
          <Row label="Open positions" value={String(t.openPositions)} />

          <h3 style={{ marginTop: '0.6rem' }}>Performance ({label})</h3>
          <Perf s={p.window} />
          <Row label="Unrealized P/L (now)" value={money(p.unrealizedPnlUsd)} className={pnlClass(p.unrealizedPnlUsd)} />
          <div className="muted small">
            All time: {p.allTime.closedTrades} trades · {pct(p.allTime.winRatePct, 0)} win · {money(p.allTime.realizedPnlUsd)}
          </div>
        </div>

        <div>
          <h3>Execution ({label})</h3>
          <Row label="Avg slippage / price impact" value={`${rate(e.avgSlippageRate)} / ${rate(e.avgPriceImpactRate)}`} />
          <Row label="DEX fees" value={money(e.feesUsd)} />
          <Row label="Network costs" value={money(e.networkCostsUsd)} />
          <Row label="Slippage / impact costs" value={`${money(e.slippageCostsUsd)} / ${money(e.priceImpactCostsUsd)}`} />
          <Row label="Total trading costs" value={money(e.totalTradingCostsUsd)} />

          <h3 style={{ marginTop: '0.6rem' }}>Risk</h3>
          <Row label="Exposure now / max" value={`${money(r.currentExposureUsd)} / ${money(r.maxPortfolioExposureUsd)}`} />
          <Row label="Largest planned loss" value={usd(r.largestPlannedLossUsd)} />
          <Row
            label="Largest realized loss"
            value={usd(r.largestRealizedLossUsd)}
            className={
              r.largestRealizedLossUsd != null && r.largestPlannedLossUsd != null && -r.largestRealizedLossUsd > r.largestPlannedLossUsd
                ? 'neg'
                : undefined
            }
          />
          <Row label="Risk-gate rejections" value={String(r.riskRejections)} />
          <div className="muted small">
            {r.rejectionsByReason.map((x) => `${x.key} ${x.count}`).join(' · ') || 'none'}
          </div>
          <div className="muted small">
            Sizes: {r.positionSizeDistribution.map((b) => `${b.bucket} ${b.count}`).join(' · ')}
          </div>
        </div>

        <div>
          <h3>Learning</h3>
          <Row label="Observations (production / research)" value={`${l.observations} (${l.observations - l.research} / ${l.research})`} />
          <Row label="True entry snapshots (calibration-grade)" value={String(l.trueEntrySnapshots)} />
          <Row label="Signal backfills / partial (descriptive only)" value={`${l.signalBackfills} / ${l.partialEntrySnapshots}`} />
          <Row label={`Level-2 checks (${label}) · warnings / critical`} value={`${l.healthChecksWindow} · ${l.warningsWindow} / ${l.criticalWindow}`} />
          <Row label="Calibration" value={l.calibrationStatus.replace(/_/g, ' ')} />
          <div className="muted small">{l.calibrationReason}</div>
          <div className="muted small">
            Last calibration {l.lastCalibrationAt ? new Date(l.lastCalibrationAt).toLocaleString() : 'never'} · interval
            reached {l.nextEligibleAt ? new Date(l.nextEligibleAt).toLocaleString() : '—'}
          </div>
          <div className="muted small">
            Versions: candidate {l.versionCounts.CANDIDATE} · validated {l.versionCounts.VALIDATED} · promoted{' '}
            {l.versionCounts.PROMOTED} · rejected {l.versionCounts.REJECTED}
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: '0.6rem' }}>Per strategy ({label}, production)</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Signals</th>
              <th>Trades</th>
              <th>W / L</th>
              <th>Win rate</th>
              <th>Avg EV</th>
              <th>Realized P/L</th>
              <th>Avg size</th>
            </tr>
          </thead>
          <tbody>
            {data.strategies.map((s) => (
              <tr key={s.strategyId}>
                <td>{s.strategyId}</td>
                <td>{s.signals}</td>
                <td>{s.trades}</td>
                <td>
                  {s.wins} / {s.losses}
                </td>
                <td>{pct(s.winRatePct, 0)}</td>
                <td>{rate(s.avgPredictedEv)}</td>
                <td className={pnlClass(s.realizedPnlUsd)}>{money(s.realizedPnlUsd)}</td>
                <td>{usd(s.avgPositionSizeUsd)}</td>
              </tr>
            ))}
            {data.strategies.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No production activity in this window
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
