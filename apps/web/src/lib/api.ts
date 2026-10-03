const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => request<Record<string, unknown>>('/api/meta'),
  portfolio: () => request<import('@memebot/shared').PortfolioSummary>('/api/portfolio'),
  botStatus: () => request<import('@memebot/shared').BotStatusInfo>('/api/bot/status'),
  control: (action: 'start' | 'pause') =>
    request('/api/bot/control', { method: 'POST', body: JSON.stringify({ action }) }),
  reset: (scope: 'paper_account' | 'all_simulation') =>
    request('/api/bot/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, scope }),
    }),
  settings: () => request<import('@memebot/shared').PortfolioSettings>('/api/settings'),
  updateSettings: (body: Record<string, unknown>) =>
    request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  scanner: (qs = '') =>
    request<{ rows: import('@memebot/shared').ScannerRow[]; scoreDisclaimer: string; dataMode: string }>(
      `/api/scanner${qs}`,
    ),
  positions: (status?: string) =>
    request<import('@memebot/shared').PositionData[]>(
      `/api/positions${status ? `?status=${status}` : ''}`,
    ),
  livePositions: () =>
    request<import('@memebot/shared').LivePositionData[]>('/api/positions/live'),
  trades: () => request<unknown[]>('/api/trades'),
  trade: (id: string) => request<Record<string, unknown>>(`/api/trades/${id}`),
  equity: () => request<import('@memebot/shared').EquityPoint[]>('/api/equity'),
  events: (qs = '') =>
    request<import('@memebot/shared').BotEventData[]>(`/api/events${qs}`),
  analytics: () => request<import('@memebot/shared').AnalyticsSummary & { scoreDisclaimer: string }>('/api/analytics'),
  strategies: () =>
    request<{ strategies: import('@memebot/shared').StrategyLabStats[]; scoreDisclaimer: string; note: string }>(
      '/api/strategies',
    ),
  token: (id: string) => request<Record<string, unknown>>(`/api/tokens/${id}`),
  reports: () =>
    request<{
      reports: import('@memebot/shared').DailyReportListItem[];
      reportTime: string;
      reportTimezone: string;
      learningEnabled: boolean;
      minTrades: number;
      dataMode: string;
    }>('/api/reports'),
  report: (id: string) => request<import('@memebot/shared').DailyReport>(`/api/reports/${id}`),
  runReport: () =>
    request<import('@memebot/shared').DailyReport>('/api/reports/run', { method: 'POST' }),
  rollbackReport: (id: string) =>
    request<import('@memebot/shared').DailyReport>(`/api/reports/${id}/rollback`, {
      method: 'POST',
    }),
  solPrice: () =>
    request<{
      solPriceUsd: number | null;
      source: string | null;
      observedAt: string | null;
      stale: boolean;
      usable: boolean;
      dataMode: string;
      note: string;
    }>('/api/fees/sol-price'),
  shadowTrades: () =>
    request<{ rows: unknown[]; note: string }>('/api/shadow-trades'),
  missedOpportunities: () =>
    request<{ rows: unknown[] }>('/api/missed-opportunities'),
  regimes: () => request<{ rows: unknown[] }>('/api/regimes'),
  strategyCatalog: () =>
    request<{
      strategies: Array<{
        id: string;
        name: string;
        version: string;
        activeByDefault: boolean;
      }>;
      note: string;
    }>('/api/strategies/catalog'),
  configRegistry: () => request<{ entries: unknown[] }>('/api/config'),
  walkForwardPlan: () =>
    request<{ plan: unknown; note: string }>('/api/experiments/walk-forward-plan'),
  killSwitch: (active: boolean) =>
    request<import('@memebot/shared').BotStatusInfo>('/api/bot/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),
  health: () => request<Record<string, unknown>>('/api/health'),
};

export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

export function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Dev: vite proxies /ws; prod: same host assumes API serves WS or use env
  if (import.meta.env.DEV) return `${proto}//${location.host}/ws`;
  return `${proto}//${location.hostname}:3001/ws`;
}
