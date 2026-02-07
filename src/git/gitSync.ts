import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

const GIT_TIMEOUT_MS = 30_000;

let lastSyncTimestamp: Date | null = null;
let syncIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function getLastSyncTimestamp(): Date | null {
  return lastSyncTimestamp;
}

/** Redact credentials from URLs in error messages. */
function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/[^@]+@/g, "https://***@");
}

function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS },
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
 * Commit and push changes after a write operation.
 */
export async function commitAndPush(
  config: Config,
  message: string,
): Promise<void> {
  const cwd = config.vaultPath;

  logger.debug("Committing and pushing changes", { message });

  // Stage all changes
  await git(["add", "."], cwd);

  // Check if there's anything to commit
  try {
    const { stdout } = await git(["status", "--porcelain"], cwd);
    if (!stdout.trim()) {
      logger.debug("No changes to commit");
      return;
    }
  } catch {
    // proceed with commit attempt
  }

  // Commit
  await git(["commit", "-m", message], cwd);

  // Pull before push to handle any remote changes
  try {
    await git(["pull", "--rebase", "origin", "--", config.gitBranch], cwd);
  } catch (error) {
    logger.error("Pre-push pull failed, attempting push anyway", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Push
  await git(["push", "origin", "--", config.gitBranch], cwd);

  lastSyncTimestamp = new Date();
  logger.info("Changes committed and pushed", { message });
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
