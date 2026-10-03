/** Small-sample-aware descriptive statistics shared by the health check and calibration. */

export interface Interval {
  low: number;
  high: number;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Sample variance (n − 1). */
export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

export function stdev(xs: number[]): number | null {
  const v = variance(xs);
  return v == null ? null : Math.sqrt(v);
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, n: number, z = 1.96): Interval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Normal-approximation interval for a mean; null below 2 samples. */
export function meanInterval(xs: number[], z = 1.96): Interval | null {
  const m = mean(xs);
  const sd = stdev(xs);
  if (m == null || sd == null) return null;
  const half = (z * sd) / Math.sqrt(xs.length);
  return { low: m - half, high: m + half };
}

export function profitFactor(pnls: number[]): number | null {
  const gains = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  return losses > 0 ? gains / losses : null;
}

/** Welch-style z statistic for "a has a lower mean than b". Null when either side is too small. */
export function meanDropZ(recent: number[], baseline: number[]): number | null {
  const vr = variance(recent);
  const vb = variance(baseline);
  if (vr == null || vb == null) return null;
  const se = Math.sqrt(vr / recent.length + vb / baseline.length);
  if (se <= 0) return null;
  return (mean(baseline)! - mean(recent)!) / se;
}

export function finite(xs: Array<number | null | undefined>): number[] {
  return xs.filter((x): x is number => x != null && Number.isFinite(x));
}
