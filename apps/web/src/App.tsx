import { NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { useRealtime } from './hooks/useRealtime';
import { DashboardPage } from './pages/DashboardPage';
import { ScannerPage } from './pages/ScannerPage';
import { LivePage } from './pages/LivePage';
import { PositionsPage } from './pages/PositionsPage';
import { TradesPage } from './pages/TradesPage';
import { StrategiesPage } from './pages/StrategiesPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TokenDetailPage } from './pages/TokenDetailPage';
import { ShadowPage } from './pages/ShadowPage';
import { LabPage } from './pages/LabPage';

const links = [
  ['/', 'Dashboard'],
  ['/scanner', 'Scanner'],
  ['/live', 'Live'],
  ['/positions', 'Positions'],
  ['/trades', 'Trades'],
  ['/shadow', 'Shadow'],
  ['/lab', 'Lab'],
  ['/strategies', 'Strategies'],
  ['/analytics', 'Analytics'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const [dataMode, setDataMode] = useState<string>('demo');
  const [botStatus, setBotStatus] = useState<string>('PAUSED');
  const [statusTick, setStatusTick] = useState(0);
  const { connected } = useRealtime((msg) => {
    if (msg.type === 'bot_status' && msg.payload && typeof msg.payload === 'object') {
      const p = msg.payload as { status?: string; dataMode?: string };
      if (p.status) setBotStatus(p.status);
      if (p.dataMode) setDataMode(p.dataMode);
      setStatusTick((t) => t + 1);
    }
  });

  useEffect(() => {
    void api.meta().then((m) => setDataMode(String(m.dataMode ?? 'demo')));
    void api.botStatus().then((b) => {
      setBotStatus(b.status);
      setDataMode(b.dataMode);
    });
  }, [statusTick]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-name">MemeBot</div>
          <div className="brand-sub">Meme Coin Paper Trading & Research</div>
        </div>
        <div className="badges">
          <span className={`badge ${dataMode === 'demo' ? 'demo' : 'live'}`}>
            {dataMode === 'demo' ? 'DEMO DATA' : 'LIVE DATA'}
          </span>
          <span className={`badge ${botStatus === 'RUNNING' ? 'run' : 'pause'}`}>
            {botStatus}
          </span>
          <span className="badge">PAPER ONLY</span>
          <span className="badge">{connected ? 'LIVE WS' : 'WS…'}</span>
        </div>
        <nav className="nav">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <nav className="mobile-nav">
        {links.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/scanner" element={<ScannerPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/trades" element={<TradesPage />} />
          <Route path="/shadow" element={<ShadowPage />} />
          <Route path="/lab" element={<LabPage />} />
          <Route path="/strategies" element={<StrategiesPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/tokens/:id" element={<TokenDetailPage />} />
        </Routes>
      </main>
    </div>
  );
}
