import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024; // 2 MiB
const MAX_COMMIT_MESSAGE_LENGTH = 200;

let lastSyncTimestamp: Date | null = null;
let syncIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function getLastSyncTimestamp(): Date | null {
  return lastSyncTimestamp;
}

/** Redact credentials from URLs in error messages. */
function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/[^@]+@/g, "https://***@");
}

/** Strip control characters and truncate commit messages to prevent injection. */
export function sanitizeCommitMessage(message: string): string {
  const cleaned = message.replace(/[\x00-\x1f\x7f]/g, " ");
  return cleaned.length > MAX_COMMIT_MESSAGE_LENGTH
    ? cleaned.slice(0, MAX_COMMIT_MESSAGE_LENGTH)
    : cleaned;
}

/** Execute a git command with timeout and sanitized error messages. */
export function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitSyncError(
              `git ${args[0]} failed: ${sanitizeError(stderr || error.message)}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSyncError";
  }
}

/**
 * Initialize the vault by cloning or pulling the repo.
 */
export async function initializeVault(config: Config): Promise<void> {
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, ".git");

  let isRepo = false;
  try {
    await access(gitDir);
    isRepo = true;
  } catch {
    // not a git repo yet
  }

  if (isRepo) {
    logger.info("Vault directory exists, pulling latest changes", {
      vaultPath,
    });
    await git(
      ["config", "user.name", config.gitUserName],
      vaultPath,
    );
    await git(
      ["config", "user.email", config.gitUserEmail],
      vaultPath,
    );
    await pullVault(config);
  } else {
    logger.info("Cloning vault repository", {
      branch: config.gitBranch,
    });
    await git(
      [
        "clone",
        "--branch",
        config.gitBranch,
        "--single-branch",
        "--",
        config.gitRepoUrl,
        vaultPath,
      ],
      "/",
    );
    await git(
      ["config", "user.name", config.gitUserName],
      vaultPath,
    );
    await git(
      ["config", "user.email", config.gitUserEmail],
      vaultPath,
    );
  }

  lastSyncTimestamp = new Date();
  logger.info("Vault initialized successfully");
}

/**
 * Pull latest changes from remote.
 */
export async function pullVault(config: Config): Promise<void> {
  logger.debug("Pulling vault changes");
  try {
    await git(["pull", "--rebase", "origin", "--", config.gitBranch], config.vaultPath);
    lastSyncTimestamp = new Date();
    logger.debug("Pull completed successfully");
  } catch (error) {
    logger.error("Pull failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Stage all changes, commit with the given message, rebase-pull, and push.
 * Shared implementation for single and batch commits.
 */
async function stageCommitAndPush(config: Config, message: string): Promise<void> {
  const cwd = config.vaultPath;

  await git(["add", "."], cwd);

  try {
    const { stdout } = await git(["status", "--porcelain"], cwd);
    if (!stdout.trim()) {
      logger.debug("No changes to commit");
      return;
    }
  } catch {
    // proceed with commit attempt
  }

  await git(["commit", "-m", sanitizeCommitMessage(message)], cwd);

  try {
    await git(["pull", "--rebase", "origin", "--", config.gitBranch], cwd);
  } catch (error) {
    logger.error("Pre-push pull failed, attempting push anyway", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await git(["push", "origin", "--", config.gitBranch], cwd);
  lastSyncTimestamp = new Date();
}

/**
 * Commit and push changes after a single write operation.
 */
export async function commitAndPush(
  config: Config,
  message: string,
): Promise<void> {
  logger.debug("Committing and pushing changes", { message });
  await stageCommitAndPush(config, message);
  logger.info("Changes committed and pushed", { message });
}

/**
 * Commit and push changes for a batch of file operations.
 * Uses a single commit for all changes instead of one per file.
 */
export async function commitAndPushBatch(
  config: Config,
  paths: readonly string[],
): Promise<void> {
  logger.debug("Committing batch changes", { fileCount: paths.length });
  await stageCommitAndPush(config, `MCP: batch update ${paths.length} files`);
  logger.info("Batch changes committed and pushed", { fileCount: paths.length });
}

/**
 * Start periodic sync interval.
 */
export function startPeriodicSync(config: Config): void {
  if (config.gitSyncIntervalSeconds <= 0) {
    logger.info("Periodic sync disabled (interval is 0)");
    return;
  }

  const intervalMs = config.gitSyncIntervalSeconds * 1000;
  logger.info("Starting periodic sync", {
    intervalSeconds: config.gitSyncIntervalSeconds,
  });

  syncIntervalHandle = setInterval(async () => {
    try {
      await pullVault(config);
    } catch (error) {
      logger.error("Periodic sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);
}

/**
 * Stop periodic sync.
 */
export function stopPeriodicSync(): void {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
    logger.info("Periodic sync stopped");
  }
}
