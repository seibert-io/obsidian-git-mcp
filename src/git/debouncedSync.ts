import type { Config } from "../config.js";
import { stageCommitAndPush } from "./gitSync.js";
import { logger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/toolResponse.js";

/**
 * After MAX_WAIT_MULTIPLIER * debounceDelay since the first pending change,
 * a sync fires regardless of ongoing writes. This prevents an authenticated
 * user from indefinitely delaying pushes by continuously resetting the timer.
 */
const MAX_WAIT_MULTIPLIER = 3;

/** Cap on accumulated descriptions to prevent unbounded memory growth. */
const MAX_PENDING_DESCRIPTIONS = 1000;

let syncConfig: Config | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDescriptions: string[] = [];
let firstPendingTimestamp: number | null = null;
let syncInProgress = false;
let activeSyncPromise: Promise<void> | null = null;

/**
 * Initialize the debounced sync module with the application config.
 * Must be called once at startup before any `scheduleSync` calls.
 */
export function initDebouncedSync(config: Config): void {
  syncConfig = config;
}

/**
 * Schedule a debounced git commit and push.
 *
 * Each call resets the debounce timer. When the timer fires (after
 * `gitDebounceSyncDelaySeconds` of inactivity), all accumulated changes
 * are committed and pushed in a single git operation.
 *
 * A maximum wait time (3x the debounce delay) ensures that continuous
 * writes cannot indefinitely prevent syncing.
 */
export function scheduleSync(description: string): void {
  if (syncConfig === null) {
    logger.error("scheduleSync called before initDebouncedSync");
    return;
  }

  if (pendingDescriptions.length < MAX_PENDING_DESCRIPTIONS) {
    pendingDescriptions.push(description);
  }

  if (firstPendingTimestamp === null) {
    firstPendingTimestamp = Date.now();
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }

  const delayMs = syncConfig.gitDebounceSyncDelaySeconds * 1000;
  const maxWaitMs = delayMs * MAX_WAIT_MULTIPLIER;
  const elapsed = Date.now() - firstPendingTimestamp;
  const effectiveDelay = Math.min(delayMs, Math.max(0, maxWaitMs - elapsed));

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    triggerSync();
  }, effectiveDelay);

  logger.debug("Debounced sync scheduled", {
    description,
    effectiveDelayMs: effectiveDelay,
    pendingCount: pendingDescriptions.length,
  });
}

/**
 * Start a sync if one is not already in progress.
 * Called by the debounce timer callback.
 */
function triggerSync(): void {
  if (syncInProgress) {
    return;
  }
  activeSyncPromise = executePendingSync().finally(() => {
    activeSyncPromise = null;
  });
}

/**
 * Execute all pending syncs in a loop until no more descriptions remain.
 * Uses a loop (not recursion) to drain descriptions that arrive during
 * an in-progress sync.
 */
async function executePendingSync(): Promise<void> {
  if (syncConfig === null) {
    return;
  }

  syncInProgress = true;
  try {
    while (pendingDescriptions.length > 0) {
      const descriptions = pendingDescriptions.splice(0);
      firstPendingTimestamp = null;
      const message = buildCommitMessage(descriptions);

      try {
        await stageCommitAndPush(syncConfig, message);
        logger.info("Debounced sync completed", {
          operationCount: descriptions.length,
          message,
        });
      } catch (error) {
        logger.error("Debounced sync failed", {
          error: getErrorMessage(error),
          operationCount: descriptions.length,
        });
      }
    }
  } finally {
    syncInProgress = false;
  }
}

function buildCommitMessage(descriptions: string[]): string {
  if (descriptions.length === 1) {
    return descriptions[0];
  }
  const summary = descriptions.join(", ");
  return `MCP: ${descriptions.length} operations - ${summary}`;
}

/**
 * Flush any pending debounced sync immediately.
 *
 * Waits for any in-progress sync to complete, then executes remaining
 * pending descriptions. Used during graceful shutdown to ensure no
 * changes are lost.
 */
export async function flushDebouncedSync(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (activeSyncPromise !== null) {
    await activeSyncPromise;
  }

  if (pendingDescriptions.length > 0) {
    await executePendingSync();
  }
}

/**
 * Stop the debounced sync and reset all module state.
 *
 * Cancels any pending timer and discards pending descriptions.
 * Used in tests to provide a clean slate between test cases.
 */
export function stopDebouncedSync(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingDescriptions = [];
  firstPendingTimestamp = null;
  syncInProgress = false;
  activeSyncPromise = null;
  syncConfig = null;
}

/** Visible for testing: returns number of pending (not yet synced) descriptions. */
export function getPendingSyncCount(): number {
  return pendingDescriptions.length;
}

/** Visible for testing: returns whether a sync is currently in progress. */
export function isSyncInProgress(): boolean {
  return syncInProgress;
}
