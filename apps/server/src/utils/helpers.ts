export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    baseMs: number;
    label: string;
    onError?: (err: unknown, attempt: number) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      opts.onError?.(err, attempt);
      if (attempt === opts.maxRetries) break;
      const delay = opts.baseMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.label} failed after retries`);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function round(n: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function safeDiv(a: number, b: number, fallback = 0): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback;
  return a / b;
}

export function sanitizeString(input: unknown, max = 128): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>\0]/g, '').slice(0, max).trim();
}

export function isSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}
