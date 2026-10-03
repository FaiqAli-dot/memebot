/**
 * Measured values with provenance. Never invent precision the provider lacks.
 */
import type { ConfidenceLevel, FreshnessLevel } from '@memebot/shared';

export interface Measured<T> {
  value: T | null;
  timestamp: Date | null;
  source: string;
  confidence: ConfidenceLevel;
  freshness: FreshnessLevel;
}

export function measured<T>(
  value: T | null,
  opts: {
    timestamp?: Date | null;
    source: string;
    confidence?: ConfidenceLevel;
    freshness?: FreshnessLevel;
  },
): Measured<T> {
  return {
    value,
    timestamp: opts.timestamp ?? (value != null ? new Date() : null),
    source: opts.source,
    confidence: opts.confidence ?? (value == null ? 'UNKNOWN' : 'MEDIUM'),
    freshness: opts.freshness ?? (value == null ? 'UNKNOWN' : 'FRESH'),
  };
}

export function unavailable<T = never>(source = 'unavailable'): Measured<T> {
  return {
    value: null,
    timestamp: null,
    source,
    confidence: 'UNKNOWN',
    freshness: 'UNKNOWN',
  };
}

export function classifyFreshness(
  observedAt: Date | null | undefined,
  nowMs: number,
  freshMs: number,
  staleMs: number,
): FreshnessLevel {
  if (!observedAt) return 'UNKNOWN';
  const age = nowMs - observedAt.getTime();
  if (age < 0) return 'UNKNOWN';
  if (age <= freshMs) return 'FRESH';
  if (age <= staleMs) return 'STALE';
  return 'VERY_STALE';
}

export function toMeasuredJson<T>(m: Measured<T>) {
  return {
    value: m.value,
    timestamp: m.timestamp?.toISOString() ?? null,
    source: m.source,
    confidence: m.confidence,
    freshness: m.freshness,
  };
}

/** Critical fields that must be FRESH to enter a trade. */
export const CRITICAL_ENTRY_FIELDS = [
  'priceUsd',
  'liquidityUsd',
  'solPriceUsd',
] as const;

export function isCriticalFresh(freshness: FreshnessLevel): boolean {
  return freshness === 'FRESH';
}
