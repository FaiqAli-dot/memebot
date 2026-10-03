import { useEffect, useState } from 'react';
import type { PortfolioSettings } from '@memebot/shared';
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
          {num('minLiquidityUsd', 'Min liquidity USD', 100)}
          {num('minTokenAgeMinutes', 'Min token age (min)', 1)}
          {num('maxTokenAgeMinutes', 'Max token age (min)', 1)}
          {num('scanIntervalMs', 'Scan interval (ms)', 1000)}
          {num('priorityFeeLamports', 'Priority fee lamports', 100)}
        </div>

        <h3 style={{ marginTop: '1rem' }}>Momentum Scanner v1 parameters</h3>
        <div className="grid grid-3">
          {(
            [
              ['minVolume5mUsd', 'Min 5m volume'],
              ['minVolumeAcceleration', 'Min volume acceleration'],
              ['minPriceChange5mPct', 'Min 5m price change %'],
              ['minBuySellRatio', 'Min buy/sell ratio'],
              ['minLiquidityUsd', 'Strategy min liquidity'],
              ['minActivityTx5m', 'Min 5m tx count'],
              ['minTokenAgeMinutes', 'Strategy min age'],
              ['maxTokenAgeMinutes', 'Strategy max age'],
              ['minOverallScore', 'Min overall score'],
              ['maxTopHolderPct', 'Max top holder %'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{label}</span>
              <input
                type="number"
                value={settings.strategyParams[k]}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    strategyParams: {
                      ...settings.strategyParams,
                      [k]: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>

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
