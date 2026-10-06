import type { PortfolioLane, PortfolioScope, PortfolioSummary } from '@memebot/shared';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export interface RecentSignal {
  id: string;
  tokenId: string;
  symbol: string | null;
  strategyId: string;
  lane: PortfolioLane | null;
  expectedValue: number | null;
  overallScore: number | null;
  confidence: string | null;
  createdAt: string;
  executionStatus: string | null;
  executionReason: string | null;
}

export interface TradeExtreme {
  positionId: string;
  tokenId: string;
  symbol: string | null;
  lane: PortfolioLane | null;
  strategyId: string | null;
  netPnlUsd: number;
  netPnlPct: number | null;
  closeReason: string | null;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  openedAt: string;
  closedAt: string | null;
  exitOrderId: string | null;
}

export interface OlderTokenResearchSummary {
  enabled: boolean;
  maxTradesPerDay: number;
  portfolio: PortfolioSummary | null;
  strategies: Array<{
    strategyId: string;
    open: number;
    closed: number;
    wins: number;
    netPnlUsd: number;
    openedToday: number;
  }>;
  signalsLastHour: Array<{ strategyId: string; count: number }>;
  maxRoundTripCostPct: number;
  candidatesLast24h: Array<{ strategyId: string; reason: string; count: number }>;
  recentCandidates: Array<{
    observedAt: string;
    strategyId: string;
    tokenId: string;
    symbol: string | null;
    signalled: boolean;
    reason: string | null;
    costRate: number | null;
    liquidityUsd: number | null;
  }>;
}

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
  portfolios: () => request<Array<PortfolioSummary & { lane: PortfolioLane | null }>>('/api/portfolios'),
  botStatus: () => request<import('@memebot/shared').BotStatusInfo>('/api/bot/status'),
  botReadiness: () => request<import('@memebot/shared').BotReadiness>('/api/bot/readiness'),
  learningStatus: () => request<import('@memebot/shared').LearningStatus>('/api/learning/status'),
  storage: () => request<import('@memebot/shared').StorageReport>('/api/storage'),
  week1Overview: (hours = 24) =>
    request<import('@memebot/shared').Week1Overview>(`/api/week1/overview?hours=${hours}`),
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
  positions: (status?: string, scope: PortfolioScope = 'production') =>
    request<import('@memebot/shared').PositionData[]>(
      `/api/positions?portfolio=${scope}${status ? `&status=${status}` : ''}`,
    ),
  livePositions: (scope: PortfolioScope = 'production') =>
    request<import('@memebot/shared').LivePositionData[]>(`/api/positions/live?portfolio=${scope}`),
  trades: (scope: PortfolioScope = 'production') => request<unknown[]>(`/api/trades?portfolio=${scope}`),
  tradeExtremes: (scope: PortfolioScope = 'production') =>
    request<{ winners: TradeExtreme[]; losers: TradeExtreme[] }>(`/api/trades/extremes?portfolio=${scope}`),
  failedTrades: (scope: PortfolioScope = 'production') =>
    request<Record<string, unknown>[]>(`/api/trades/failed?portfolio=${scope}`),
  trade: (id: string, scope: PortfolioScope = 'production') =>
    request<Record<string, unknown>>(`/api/trades/${id}?portfolio=${scope}`),
  equity: () => request<import('@memebot/shared').EquityPoint[]>('/api/equity'),
  events: (qs = '', scope: PortfolioScope = 'production') =>
    request<import('@memebot/shared').BotEventData[]>(
      `/api/events${qs ? `${qs}&` : '?'}portfolio=${scope}`,
    ),
  recentSignals: (scope: PortfolioScope = 'all', limit = 20) =>
    request<RecentSignal[]>(`/api/signals/recent?portfolio=${scope}&limit=${limit}`),
  olderTokenResearch: () => request<OlderTokenResearchSummary>('/api/research/older-token'),
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
  intelligence: () => request<Record<string, unknown>>('/api/intelligence'),
  intelligenceTokens: (qs = '') =>
    request<{ rows: Record<string, unknown>[]; total: number }>(`/api/intelligence/tokens${qs}`),
  intelligenceToken: (id: string) =>
    request<Record<string, unknown>>(`/api/intelligence/tokens/${id}`),
  intelligenceSearch: (q: string) =>
    request<{
      query: string;
      exactQuery: boolean;
      matchType: string;
      found: boolean;
      message: string | null;
      tokens: Array<Record<string, unknown> & { tokenId: string; matchedOn: string }>;
    }>(`/api/intelligence/search?q=${encodeURIComponent(q)}`),
  intelligenceStorage: () => request<Record<string, unknown>>('/api/intelligence/storage'),
  intelligenceSources: () =>
    request<{ sources: Record<string, unknown>[] }>('/api/intelligence/sources'),
  intelligenceMissed: () =>
    request<{
      falseNegatives: Record<string, unknown>[];
      successfulRejections: Record<string, unknown>[];
    }>('/api/intelligence/missed'),
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
  // Dev: vite proxies /ws; prod: the API serves the dashboard and /ws on the same origin
  return `${proto}//${location.host}/ws`;
}
