/**
 * Counts failed login attempts per key (an IP, an email) in a sliding
 * window. In memory, so with several gateway replicas each pod counts on its
 * own - an attacker gets at most `max` x replicas tries per window. Good
 * enough against online guessing (each try also costs a scrypt); a shared
 * store (Postgres/Redis) would make it exact.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly opts: {
      max: number;
      windowMs: number;
      /** Upper bound on tracked keys, so a flood of random emails can't exhaust memory. */
      maxKeys?: number;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Milliseconds until the key may try again, or 0 if it may try now. */
  retryAfterMs(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.opts.max) return 0;
    return recent[recent.length - this.opts.max] + this.opts.windowMs - this.now();
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.delete(key); // re-insert: Map order = least recently failed first
    this.failures.set(key, recent);
    const maxKeys = this.opts.maxKeys ?? 10_000;
    while (this.failures.size > maxKeys) {
      this.failures.delete(this.failures.keys().next().value!);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
