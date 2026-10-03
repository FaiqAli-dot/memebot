/**
 * Parameter registry — every tunable has description, default, min, max, source, reason.
 */
export interface ConfigEntry {
  key: string;
  description: string;
  value: number | string | boolean;
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  source: string;
  lastChangedAt: string;
  changeReason: string;
}

export const DEFAULT_CONFIG_ENTRIES: ConfigEntry[] = [
  {
    key: 'MIN_LIQUIDITY',
    description: 'Minimum pool liquidity USD to consider entry',
    value: 5000,
    defaultValue: 5000,
    min: 500,
    max: 500_000,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MIN_VOLUME',
    description: 'Minimum 5m volume USD',
    value: 1500,
    defaultValue: 1500,
    min: 100,
    max: 1_000_000,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MIN_BUY_SELL_RATIO',
    description: 'Minimum buy/sell volume ratio',
    value: 1.1,
    defaultValue: 1.1,
    min: 0.5,
    max: 5,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_HOLDER_CONCENTRATION',
    description: 'Max top-holder percent',
    value: 40,
    defaultValue: 40,
    min: 5,
    max: 90,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_POSITION_SIZE',
    description: 'Max position as fraction of equity',
    value: 0.05,
    defaultValue: 0.05,
    min: 0.005,
    max: 0.25,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_PORTFOLIO_EXPOSURE',
    description: 'Max invested fraction of equity',
    value: 0.5,
    defaultValue: 0.5,
    min: 0.1,
    max: 1,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_DAILY_LOSS',
    description: 'Daily loss halt as fraction of starting balance',
    value: 0.05,
    defaultValue: 0.05,
    min: 0.01,
    max: 0.5,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_DRAWDOWN',
    description: 'Drawdown halt as fraction of peak equity',
    value: 0.15,
    defaultValue: 0.15,
    min: 0.05,
    max: 0.5,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MAX_HOLD_TIME',
    description: 'Max holding time seconds',
    value: 3600,
    defaultValue: 3600,
    min: 60,
    max: 86_400,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'MIN_EXPECTED_NET_VALUE',
    description: 'Minimum expected net value (fraction) to enter',
    value: 0.02,
    defaultValue: 0.02,
    min: -0.1,
    max: 0.5,
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'SLIPPAGE_MODEL',
    description: 'Slippage model identifier',
    value: 'dynamic-v2',
    defaultValue: 'dynamic-v2',
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'LATENCY_MODEL',
    description: 'Latency model identifier',
    value: 'staged-v1',
    defaultValue: 'staged-v1',
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
  {
    key: 'FAILURE_MODEL',
    description: 'Execution failure model identifier',
    value: 'congestion-v1',
    defaultValue: 'congestion-v1',
    source: 'default',
    lastChangedAt: new Date(0).toISOString(),
    changeReason: 'initial',
  },
];

export function configMap(entries: ConfigEntry[] = DEFAULT_CONFIG_ENTRIES): Record<string, ConfigEntry> {
  return Object.fromEntries(entries.map((e) => [e.key, e]));
}
