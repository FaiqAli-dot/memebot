/**
 * In-process memory of the last research row written per key. Lets high-frequency observers
 * (every market tick) store a row only when the observed outcome changes or the window elapses.
 * A restart forgets the cache, which at worst writes one extra row per key.
 */
export class WriteDedupe<V = string> {
  private readonly last = new Map<string, { signature: string; at: number; value: V | undefined }>();

  constructor(private readonly maxEntries = 50_000) {}

  /**
   * Returns the remembered value when `key` was already written with the same signature
   * within `windowMs`; otherwise null (caller should write, then call `remember`).
   */
  recent(key: string, signature: string, windowMs: number, now = Date.now()): { value: V | undefined } | null {
    if (windowMs <= 0) return null;
    const prev = this.last.get(key);
    if (prev && prev.signature === signature && now - prev.at < windowMs) return { value: prev.value };
    return null;
  }

  remember(key: string, signature: string, value?: V, now = Date.now()): void {
    if (this.last.size >= this.maxEntries) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    this.last.delete(key);
    this.last.set(key, { signature, at: now, value });
  }

  clear(): void {
    this.last.clear();
  }
}
