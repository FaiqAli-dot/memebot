import { useCallback, useEffect, useState } from 'react';
import { api, pct } from '../lib/api';

export function LabPage() {
  const [catalog, setCatalog] = useState<
    Array<{ id: string; name: string; version: string; activeByDefault: boolean }>
  >([]);
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>[]>([]);
  const [strategies, setStrategies] = useState<
    import('@memebot/shared').StrategyLabStats[]
  >([]);
  const [regimes, setRegimes] = useState<Record<string, unknown>[]>([]);

  const refresh = useCallback(async () => {
    const [c, p, cfg, s, r] = await Promise.all([
      api.strategyCatalog(),
      api.walkForwardPlan(),
      api.configRegistry(),
      api.strategies(),
      api.regimes(),
    ]);
    setCatalog(c.strategies);
    setPlan(p.plan as Record<string, unknown>);
    setConfig(cfg.entries as Record<string, unknown>[]);
    setStrategies(s.strategies);
    setRegimes(r.rows as Record<string, unknown>[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const folds = (plan?.folds as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="page">
      <div className="panel" style={{ marginBottom: '0.75rem' }}>
        <h2>Experiment Lab</h2>
        <p style={{ color: 'var(--muted)', margin: '0.35rem 0 0' }}>
          Compare strategies and configs on identical opportunities. Walk-forward folds keep
          learning from using future data. Results are paper-only.
        </p>
      </div>

      <div className="grid grid-2" style={{ marginBottom: '0.75rem' }}>
        <div className="panel">
          <h3>Strategy catalog</h3>
          <table className="data">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Version</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((s) => (
                <tr key={s.id}>
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td>{s.name}</td>
                  <td>{s.version}</td>
                  <td>{s.activeByDefault ? 'ON' : 'off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Live strategy comparison</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Trades</th>
                <th>Win%</th>
                <th>Net</th>
                <th>PF</th>
                <th>DD</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <tr key={`${s.strategyName}-${s.strategyVersion}`}>
                  <td>
                    {s.strategyName} <small>{s.strategyVersion}</small>
                  </td>
                  <td>{s.trades}</td>
                  <td>{pct(s.winRate)}</td>
                  <td>${s.netPnlUsd.toFixed(2)}</td>
                  <td>{s.profitFactor?.toFixed(2) ?? '—'}</td>
                  <td>{pct(s.drawdownPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: '0.75rem' }}>
        <h3>Walk-forward plan</h3>
        <p style={{ color: 'var(--muted)' }}>
          Train → validate rolling windows, then untouched out-of-sample.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Fold</th>
              <th>Train</th>
              <th>Validate</th>
            </tr>
          </thead>
          <tbody>
            {folds.map((f, i) => {
              const train = f.train as { start: string; end: string; label: string };
              const validate = f.validate as { start: string; end: string; label: string };
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    {train.label}: {new Date(train.start).toLocaleDateString()} →{' '}
                    {new Date(train.end).toLocaleDateString()}
                  </td>
                  <td>
                    {validate.label}: {new Date(validate.start).toLocaleDateString()} →{' '}
                    {new Date(validate.end).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
            {plan?.outOfSample ? (
              <tr>
                <td>OOS</td>
                <td colSpan={2}>
                  {(plan.outOfSample as { label: string }).label}:{' '}
                  {new Date((plan.outOfSample as { start: string }).start).toLocaleDateString()} →{' '}
                  {new Date((plan.outOfSample as { end: string }).end).toLocaleDateString()}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <h3>Config registry</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Min–Max</th>
              </tr>
            </thead>
            <tbody>
              {config.slice(0, 20).map((c) => (
                <tr key={String(c.key)}>
                  <td>
                    <code>{String(c.key)}</code>
                  </td>
                  <td>{String(c.value)}</td>
                  <td>
                    {c.min != null ? `${String(c.min)}–${String(c.max)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Regime history</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Regime</th>
              </tr>
            </thead>
            <tbody>
              {regimes.slice(0, 20).map((r, i) => (
                <tr key={i}>
                  <td>{new Date(String(r.observed_at)).toLocaleString()}</td>
                  <td>
                    <strong>{String(r.regime)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
