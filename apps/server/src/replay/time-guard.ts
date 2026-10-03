/**
 * Time-guarded data accessor — look-ahead / leakage tests FAIL if future timestamps are accessed.
 */
export class LookAheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookAheadError';
  }
}

export interface Timestamped {
  observedAt: Date;
}

export class TimeGuardedAccessor<T extends Timestamped> {
  private readonly asOfMs: number;
  private readonly items: T[];
  private accessLog: Date[] = [];

  constructor(items: T[], asOf: Date) {
    this.items = [...items].sort(
      (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
    );
    this.asOfMs = asOf.getTime();
  }

  get asOf(): Date {
    return new Date(this.asOfMs);
  }

  /** Returns only items with observedAt <= asOf. Throws if code tries to read future. */
  getAvailable(): T[] {
    return this.items.filter((i) => i.observedAt.getTime() <= this.asOfMs);
  }

  /**
   * Explicit access by timestamp — throws LookAheadError if ts > asOf.
   */
  requireAtOrBefore(ts: Date): void {
    this.accessLog.push(ts);
    if (ts.getTime() > this.asOfMs) {
      throw new LookAheadError(
        `Look-ahead violation: attempted access at ${ts.toISOString()} while asOf=${new Date(this.asOfMs).toISOString()}`,
      );
    }
  }

  getAtOrBefore(ts: Date): T[] {
    this.requireAtOrBefore(ts);
    return this.items.filter((i) => i.observedAt.getTime() <= ts.getTime());
  }

  latest(ts: Date = new Date(this.asOfMs)): T | null {
    const available = this.getAtOrBefore(ts);
    return available[available.length - 1] ?? null;
  }

  getAccessLog(): Date[] {
    return [...this.accessLog];
  }
}
