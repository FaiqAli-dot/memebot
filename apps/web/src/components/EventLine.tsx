import type { BotEventData } from '@memebot/shared';
import { LaneBadge, StrategyBadge } from './LaneBadge';

// Discovery, market data, learning and control events are shared across lanes even when stored
// under the production portfolio, so only trade-path events are tagged.
const LANE_TAGGED_CATEGORIES = new Set(['signal', 'execution']);

export function EventLine({ event: e }: { event: BotEventData }) {
  const tagged = LANE_TAGGED_CATEGORIES.has(e.category) && e.lane != null;
  const older = tagged && e.lane === 'OLDER_TOKEN_RESEARCH';
  return (
    <div className={`log-line ${e.level} ${older ? 'log-older' : ''}`}>
      <span>{new Date(e.createdAt).toLocaleTimeString()}</span>
      <span className="cat">{e.category}</span>
      <span>
        {tagged && (
          <span className="lane-tags" style={{ marginRight: '0.4rem' }}>
            <StrategyBadge strategyId={e.strategyId} suffix={e.category === 'signal' ? 'SIGNAL' : undefined} />
            <LaneBadge lane={e.lane} short />
          </span>
        )}
        {e.message}
      </span>
    </div>
  );
}
