import { logger } from "./logger.js";
import { DEFAULT_MAX_RATE_LIMIT_ENTRIES } from "./constants.js";

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
    private readonly maxEntries: number = DEFAULT_MAX_RATE_LIMIT_ENTRIES,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (entry && now <= entry.resetAt) {
      if (entry.count >= this.maxAttempts) {
        return false;
      }
      entry.count++;
      return true;
    }

    this.evictIfAtCapacity();
    this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
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

  private evictIfAtCapacity(): void {
    if (this.attempts.size < this.maxEntries) return;

    const oldestKey = this.attempts.keys().next().value;
    if (oldestKey !== undefined) {
      this.attempts.delete(oldestKey);
      logger.warn("Rate limiter evicted oldest entry due to capacity", {
        maxEntries: this.maxEntries,
      });
    }
  }
}
