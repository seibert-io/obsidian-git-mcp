/**
 * Reusable per-key rate limiter with sliding window.
 * Tracks request counts per key (e.g., IP address) and rejects
 * requests that exceed the configured maximum within the time window.
 */
export class RateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.maxAttempts) {
      return false;
    }
    entry.count++;
    return true;
  }

  /** Remove expired entries to prevent slow memory leak. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (now > entry.resetAt) {
        this.attempts.delete(key);
      }
    }
  }
}
