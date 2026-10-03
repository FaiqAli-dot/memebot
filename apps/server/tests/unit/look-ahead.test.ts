import { describe, expect, it } from 'vitest';
import {
  LookAheadError,
  TimeGuardedAccessor,
} from '../../src/replay/time-guard.js';

describe('look-ahead / leakage guard', () => {
  const items = [
    { observedAt: new Date('2026-01-01T00:00:00Z'), v: 1 },
    { observedAt: new Date('2026-01-01T01:00:00Z'), v: 2 },
    { observedAt: new Date('2026-01-01T02:00:00Z'), v: 3 },
  ];

  it('returns only data at or before asOf', () => {
    const g = new TimeGuardedAccessor(items, new Date('2026-01-01T01:00:00Z'));
    expect(g.getAvailable().map((i) => i.v)).toEqual([1, 2]);
  });

  it('FAILS when future timestamp is accessed', () => {
    const g = new TimeGuardedAccessor(items, new Date('2026-01-01T01:00:00Z'));
    expect(() => g.requireAtOrBefore(new Date('2026-01-01T02:00:00Z'))).toThrow(
      LookAheadError,
    );
  });

  it('FAILS getAtOrBefore on future', () => {
    const g = new TimeGuardedAccessor(items, new Date('2026-01-01T00:30:00Z'));
    expect(() => g.getAtOrBefore(new Date('2026-01-01T03:00:00Z'))).toThrow(
      LookAheadError,
    );
  });
});
