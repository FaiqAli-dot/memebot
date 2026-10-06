import {
  PORTFOLIO_LANE_LABELS,
  PORTFOLIO_LANE_SHORT_LABELS,
  strategyLabel,
  type PortfolioLane,
  type PortfolioScope,
} from '@memebot/shared';

// Lanes come from the API (the row's paper portfolio); this file only renders them.

const LANE_CLASS: Record<PortfolioLane, string> = {
  PRODUCTION: 'lane-production',
  OLDER_TOKEN_RESEARCH: 'lane-older',
  EXPLORATION_RESEARCH: 'lane-exploration',
};

const STRATEGY_STYLE: Record<string, { className: string; icon: string }> = {
  'older-breakout': { className: 'strategy-breakout', icon: '▲' },
  'older-revival': { className: 'strategy-revival', icon: '↻' },
};

export function LaneBadge({ lane, short = false }: { lane: PortfolioLane | null | undefined; short?: boolean }) {
  if (!lane) return null;
  const label = short ? PORTFOLIO_LANE_SHORT_LABELS[lane] : PORTFOLIO_LANE_LABELS[lane];
  return <span className={`lane-badge ${LANE_CLASS[lane]}`}>{label}</span>;
}

export function StrategyBadge({ strategyId, suffix }: { strategyId: string | null | undefined; suffix?: string }) {
  const label = strategyLabel(strategyId);
  if (!label) return null;
  const style = strategyId ? STRATEGY_STYLE[strategyId] : undefined;
  return (
    <span className={`lane-badge ${style?.className ?? ''}`}>
      {style ? <span aria-hidden>{style.icon}</span> : null}
      {suffix ? `${label} ${suffix}` : label}
    </span>
  );
}

export function LaneTags({
  lane,
  strategyId,
  short = false,
  showStrategy = true,
}: {
  lane: PortfolioLane | null | undefined;
  strategyId?: string | null;
  short?: boolean;
  showStrategy?: boolean;
}) {
  if (!lane && !(showStrategy && strategyId)) return null;
  return (
    <span className="lane-tags">
      <LaneBadge lane={lane} short={short} />
      {showStrategy ? <StrategyBadge strategyId={strategyId} /> : null}
    </span>
  );
}

/** Row tint for older-token research rows; production rows keep the default look. */
export function laneRowClass(lane: PortfolioLane | null | undefined, strategyId?: string | null): string {
  if (lane !== 'OLDER_TOKEN_RESEARCH') return '';
  return strategyId === 'older-revival' ? 'row-older row-revival' : 'row-older';
}

export function laneCardClass(lane: PortfolioLane | null | undefined, strategyId?: string | null): string {
  if (lane !== 'OLDER_TOKEN_RESEARCH') return '';
  return strategyId === 'older-revival' ? 'card-older card-revival' : 'card-older';
}

export function LaneLegend() {
  return (
    <div className="lane-legend" aria-label="Experiment legend">
      <span>Experiments:</span>
      <LaneBadge lane="PRODUCTION" />
      <LaneBadge lane="OLDER_TOKEN_RESEARCH" />
      <StrategyBadge strategyId="older-breakout" />
      <StrategyBadge strategyId="older-revival" />
    </div>
  );
}

export const LANE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'production', label: 'Production' },
  { id: 'older', label: 'Older Research' },
  { id: 'older-breakout', label: 'Older Breakout' },
  { id: 'older-revival', label: 'Revival' },
  { id: 'exploration', label: 'Exploration' },
] as const;
export type LaneFilter = (typeof LANE_FILTERS)[number]['id'];

export function matchesLaneFilter(
  filter: LaneFilter,
  lane: PortfolioLane | null | undefined,
  strategyId?: string | null,
): boolean {
  switch (filter) {
    case 'production':
      return lane === 'PRODUCTION';
    case 'older':
      return lane === 'OLDER_TOKEN_RESEARCH';
    case 'older-breakout':
    case 'older-revival':
      return lane === 'OLDER_TOKEN_RESEARCH' && strategyId === filter;
    case 'exploration':
      return lane === 'EXPLORATION_RESEARCH';
    default:
      return true;
  }
}

/** Server-side portfolio scope for a filter, so capped lists aren't crowded out by other lanes. */
export function laneFilterScope(filter: LaneFilter): PortfolioScope {
  switch (filter) {
    case 'production':
      return 'production';
    case 'older':
    case 'older-breakout':
    case 'older-revival':
      return 'older-research';
    case 'exploration':
      return 'exploration';
    default:
      return 'all';
  }
}

export function LaneFilterSelect({ value, onChange }: { value: LaneFilter; onChange: (v: LaneFilter) => void }) {
  return (
    <label className="lane-filter">
      Experiment
      <select value={value} onChange={(e) => onChange(e.target.value as LaneFilter)}>
        {LANE_FILTERS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
    </label>
  );
}
