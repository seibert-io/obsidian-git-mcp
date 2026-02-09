import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../src/utils/rateLimiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the rate limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
  });

  it("blocks requests exceeding the rate limit", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false);
  });

  it("resets after the time window expires", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter.check("ip-1")).toBe(true);
  });

  it("removes expired entries on cleanup", () => {
    const limiter = new RateLimiter(5, 1_000);
    limiter.check("ip-1");
    limiter.check("ip-2");

    vi.advanceTimersByTime(1_001);
    limiter.cleanup();

    // After cleanup, entries should be gone — new check starts fresh
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-2")).toBe(true);
  });

  it("evicts oldest entry when maxEntries capacity is reached", () => {
    const limiter = new RateLimiter(5, 60_000, 2);
    limiter.check("ip-1");
    limiter.check("ip-2");

    // Adding a third key should evict ip-1 (oldest)
    limiter.check("ip-3");

    // ip-1 was evicted — new check starts at count=1 (fresh)
    expect(limiter.check("ip-1")).toBe(true);
  });

  it("allows new keys to work after eviction", () => {
    const limiter = new RateLimiter(1, 60_000, 1);
    limiter.check("ip-1");
    expect(limiter.check("ip-1")).toBe(false); // exhausted

    // ip-2 triggers eviction of ip-1
    expect(limiter.check("ip-2")).toBe(true);

    // ip-1 is now gone — fresh start
    expect(limiter.check("ip-1")).toBe(true);
  });

  it("does not evict when under capacity", () => {
    const limiter = new RateLimiter(1, 60_000, 10);
    limiter.check("ip-1");
    limiter.check("ip-2");
    limiter.check("ip-3");

    // ip-1 should still be tracked (not evicted) — exhausted
    expect(limiter.check("ip-1")).toBe(false);
  });

  it("uses default maxEntries when not specified", () => {
    // Should not throw and should accept many entries
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 100; i++) {
      expect(limiter.check(`ip-${i}`)).toBe(true);
    }
  });
});
