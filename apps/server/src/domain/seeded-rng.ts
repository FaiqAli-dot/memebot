/**
 * Deterministic seeded PRNG for replay / latency / failure simulation.
 * Same seed + same call sequence → same results.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Uniform [0, 1) */
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  /** Inclusive integer range */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Sample from triangular-ish latency distribution around mean */
  latencyMs(mean: number, spread: number): number {
    const u = this.next();
    const v = this.next();
    const tri = (u + v) / 2;
    return Math.max(0, Math.round(mean + (tri - 0.5) * 2 * spread));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}

export function createRng(seed: number): SeededRng {
  return new SeededRng(seed);
}
