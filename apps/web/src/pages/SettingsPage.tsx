import { useEffect, useState } from 'react';
import { STRATEGY_PARAM_REGISTRY, type PortfolioSettings } from '@memebot/shared';
import { api } from '../lib/api';

export function SettingsPage() {
  const [settings, setSettings] = useState<PortfolioSettings | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  if (!settings) return <div className="page">Loading settings…</div>;

  async function save() {
    if (!settings) return;
    const updated = (await api.updateSettings(settings as unknown as Record<string, unknown>)) as PortfolioSettings;
    setSettings(updated);
    setSaved('Saved');
    setTimeout(() => setSaved(''), 2000);
  }

  function num(key: keyof PortfolioSettings, label: string, step = 0.01) {
    const value = settings![key];
    if (typeof value === 'object' && value !== null) return null;
    return (
      <label className="field" key={String(key)} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{label}</span>
        <input
          type="number"
          step={step}
          value={value === null || value === undefined ? '' : Number(value)}
          onChange={(e) =>
            setSettings({
              ...settings!,
              [key]: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        />
      </label>
    );
  }

  return (
    <div className="page">
      <div className="panel">
        <h2>Settings</h2>
        <p style={{ color: 'var(--muted)' }}>
          Paper trading only. Changes apply to the default local portfolio. No accounts or real funds.
        </p>
        <div className="grid grid-3">
          {num('startingBalanceUsd', 'Starting balance USD', 1)}
          {num('maxPositionPct', 'Max position size (fraction)', 0.01)}
          {num('maxSimultaneousPositions', 'Max positions', 1)}
          {num('maxRiskPerTradePct', 'Max risk per trade', 0.01)}
          {num('maxDailyLossPct', 'Max daily loss', 0.01)}
          {num('maxDrawdownPct', 'Max drawdown', 0.01)}
          {num('stopLossPct', 'Stop loss', 0.01)}
          {num('takeProfitPct', 'Take profit', 0.01)}
          {num('trailingStopPct', 'Trailing stop (blank to disable)', 0.01)}
          {num('maxHoldingTimeSec', 'Max holding time (sec)', 1)}
          {num('minLiquidityUsd', 'Emergency exit: liquidity floor USD', 100)}
          {num('priorityFeeLamports', 'Priority fee lamports', 100)}
        </div>

        {Object.entries(STRATEGY_PARAM_REGISTRY).map(([strategyId, def]) => (
          <div key={strategyId}>
            <h3 style={{ marginTop: '1rem' }}>{def.name} thresholds</h3>
            <div className="grid grid-3">
              {def.params.map((p) => (
                <label key={p.key} className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>
                    {p.label} ({p.min}–{p.max}){p.safety ? ' · safety' : ''}
                  </span>
                  <input
                    type="number"
                    min={p.min}
                    max={p.max}
                    value={settings.strategyParams[strategyId]?.[p.key] ?? p.default}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        strategyParams: {
                          ...settings.strategyParams,
                          [strategyId]: { ...settings.strategyParams[strategyId], [p.key]: Number(e.target.value) },
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        ))}

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settings.failedTxStillChargesNetwork}
            onChange={(e) =>
              setSettings({ ...settings, failedTxStillChargesNetwork: e.target.checked })
            }
          />
          Failed / unfilled txs may still incur network + priority fees
        </label>

        <div className="btn-row" style={{ marginTop: '1rem' }}>
          <button className="btn primary" onClick={() => void save()}>
            Save settings
          </button>
          <span style={{ color: 'var(--accent)' }}>{saved}</span>
        </div>
      </div>
    </div>
  );
}
