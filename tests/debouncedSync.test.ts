import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initDebouncedSync,
  scheduleSync,
  flushDebouncedSync,
  stopDebouncedSync,
  getPendingSyncCount,
  isSyncInProgress,
} from "../src/git/debouncedSync.js";
import { createTestConfig } from "./helpers/testConfig.js";

vi.mock("../src/git/gitSync.js", () => ({
  stageCommitAndPush: vi.fn().mockResolvedValue(undefined),
}));

import { stageCommitAndPush } from "../src/git/gitSync.js";

const mockedStageCommitAndPush = vi.mocked(stageCommitAndPush);

describe("debouncedSync", () => {
  const config = createTestConfig({ gitDebounceSyncDelaySeconds: 1 });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopDebouncedSync();
    initDebouncedSync(config);
  });

  afterEach(() => {
    stopDebouncedSync();
    vi.useRealTimers();
  });

  it("does not sync immediately when scheduleSync is called", () => {
    scheduleSync("MCP: write test.md");

    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();
    expect(getPendingSyncCount()).toBe(1);
  });

  it("syncs after the debounce delay expires", async () => {
    scheduleSync("MCP: write test.md");

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
    expect(mockedStageCommitAndPush).toHaveBeenCalledWith(
      config,
      "MCP: write test.md",
    );
  });

  it("resets the timer when a new change arrives during the debounce window", async () => {
    scheduleSync("MCP: write file1.md");

    // Advance 500ms (half the delay)
    vi.advanceTimersByTime(500);
    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();

    // Schedule another sync, which resets the timer
    scheduleSync("MCP: write file2.md");

    // Advance another 500ms -- original timer would have fired, but it was reset
    vi.advanceTimersByTime(500);
    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();

    // Advance the remaining 500ms for the reset timer
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
  });

  it("batches multiple changes into a single commit", async () => {
    scheduleSync("MCP: write file1.md");
    scheduleSync("MCP: edit file2.md");
    scheduleSync("MCP: delete file3.md");

    expect(getPendingSyncCount()).toBe(3);

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
    const message = mockedStageCommitAndPush.mock.calls[0][1];
    expect(message).toContain("3 operations");
    expect(message).toContain("MCP: write file1.md");
    expect(message).toContain("MCP: edit file2.md");
    expect(message).toContain("MCP: delete file3.md");
  });

  it("uses original message when only one change is pending", async () => {
    scheduleSync("MCP: write single.md");

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledWith(
      config,
      "MCP: write single.md",
    );
  });

  it("flushDebouncedSync executes pending sync immediately", async () => {
    scheduleSync("MCP: write urgent.md");

    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();

    await flushDebouncedSync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
    expect(mockedStageCommitAndPush).toHaveBeenCalledWith(
      config,
      "MCP: write urgent.md",
    );
  });

  it("stopDebouncedSync cancels pending sync without executing", () => {
    scheduleSync("MCP: write discarded.md");
    expect(getPendingSyncCount()).toBe(1);

    stopDebouncedSync();

    expect(getPendingSyncCount()).toBe(0);
    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();
  });

  it("handles sync errors gracefully and allows subsequent syncs", async () => {
    mockedStageCommitAndPush.mockRejectedValueOnce(new Error("git push failed"));

    scheduleSync("MCP: write fail.md");
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    // First sync failed
    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();

    // Subsequent sync should still work
    mockedStageCommitAndPush.mockResolvedValueOnce(undefined);
    scheduleSync("MCP: write retry.md");
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledTimes(2);
  });

  it("picks up changes that arrive during an in-progress sync", async () => {
    let callCount = 0;
    mockedStageCommitAndPush.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate a new write arriving while the first sync is in progress
        scheduleSync("MCP: write second.md");
      }
    });

    scheduleSync("MCP: write first.md");
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    // The loop should have drained both: first from the timer, second from the loop iteration
    expect(mockedStageCommitAndPush).toHaveBeenCalledTimes(2);
    expect(mockedStageCommitAndPush).toHaveBeenNthCalledWith(1, config, "MCP: write first.md");
    expect(mockedStageCommitAndPush).toHaveBeenNthCalledWith(2, config, "MCP: write second.md");
  });

  it("flushDebouncedSync is a no-op when nothing is pending", async () => {
    await flushDebouncedSync();
    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();
  });

  it("respects configurable debounce delay", async () => {
    // Re-initialize with a different delay
    stopDebouncedSync();
    const customDelayConfig = createTestConfig({ gitDebounceSyncDelaySeconds: 2 });
    initDebouncedSync(customDelayConfig);

    scheduleSync("MCP: write custom.md");

    // After 1 second, should not have fired
    vi.advanceTimersByTime(1000);
    expect(mockedStageCommitAndPush).not.toHaveBeenCalled();

    // After 2 seconds total, should fire
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
  });

  it("forces sync after max wait time even with continuous writes", async () => {
    // With 1s debounce, max wait = 3s (MAX_WAIT_MULTIPLIER = 3)
    // Write every 900ms to keep resetting the timer
    scheduleSync("MCP: write 1.md");
    vi.advanceTimersByTime(900);

    scheduleSync("MCP: write 2.md");
    vi.advanceTimersByTime(900);

    scheduleSync("MCP: write 3.md");
    vi.advanceTimersByTime(900);

    // At 2700ms, still within max wait (3000ms), but the effective delay
    // should be capped: maxWait(3000) - elapsed(2700) = 300ms
    scheduleSync("MCP: write 4.md");

    // The effective delay should be min(1000, max(0, 3000-2700)) = 300ms
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    expect(mockedStageCommitAndPush).toHaveBeenCalledOnce();
    const message = mockedStageCommitAndPush.mock.calls[0][1];
    expect(message).toContain("4 operations");
  });

  it("scheduleSync is a no-op if not initialized", () => {
    stopDebouncedSync(); // Resets syncConfig to null
    scheduleSync("MCP: write orphan.md");
    expect(getPendingSyncCount()).toBe(0);
  });
});
