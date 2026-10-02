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
