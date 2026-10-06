import {
  OLDER_TOKEN_RESEARCH_PORTFOLIO_ID,
  RESEARCH_PORTFOLIO_ID,
  type PortfolioLane,
  type PortfolioScope,
} from '@memebot/shared';
import { env } from '../config/env.js';

export function portfolioLane(portfolioId: string | null | undefined): PortfolioLane | null {
  if (!portfolioId) return null;
  if (portfolioId === env.DEFAULT_PORTFOLIO_ID) return 'PRODUCTION';
  if (portfolioId === OLDER_TOKEN_RESEARCH_PORTFOLIO_ID) return 'OLDER_TOKEN_RESEARCH';
  if (portfolioId === RESEARCH_PORTFOLIO_ID) return 'EXPLORATION_RESEARCH';
  return null;
}

/**
 * The portfolio a signal was routed to. Untargeted signals predate per-portfolio routing and
 * belong to their lane's original portfolio, matching execution's `ownsUntargetedSignals`.
 */
export function signalPortfolioId(lane: string | null | undefined, targetPortfolioId: string | null | undefined): string | null {
  if (targetPortfolioId) return targetPortfolioId;
  if (lane === 'PRODUCTION') return env.DEFAULT_PORTFOLIO_ID;
  if (lane === 'RESEARCH') return RESEARCH_PORTFOLIO_ID;
  return null;
}

/** SQL form of `signalPortfolioId`; `prodParam`/`researchParam` are bound to the production and exploration ids. */
export function signalPortfolioSql(alias: string, prodParam: string, researchParam: string): string {
  return `COALESCE(${alias}.target_portfolio_id, CASE ${alias}.lane
    WHEN 'PRODUCTION' THEN ${prodParam}::uuid WHEN 'RESEARCH' THEN ${researchParam}::uuid END)`;
}

export function signalLane(lane: string | null | undefined, targetPortfolioId: string | null | undefined): PortfolioLane | null {
  return portfolioLane(signalPortfolioId(lane, targetPortfolioId));
}

export function parsePortfolioScope(v: unknown): PortfolioScope {
  return v === 'older-research' || v === 'exploration' || v === 'all' ? v : 'production';
}

export function scopePortfolioIds(scope: PortfolioScope): string[] {
  switch (scope) {
    case 'older-research':
      return [OLDER_TOKEN_RESEARCH_PORTFOLIO_ID];
    case 'exploration':
      return [RESEARCH_PORTFOLIO_ID];
    case 'all':
      return [env.DEFAULT_PORTFOLIO_ID, OLDER_TOKEN_RESEARCH_PORTFOLIO_ID, RESEARCH_PORTFOLIO_ID];
    default:
      return [env.DEFAULT_PORTFOLIO_ID];
  }
}

export function eventStrategyId(details: Record<string, unknown> | null | undefined): string | null {
  const v = details?.strategy ?? details?.strategyId;
  return typeof v === 'string' ? v : null;
}
