import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe, isInsideVault } from "../utils/pathValidation.js";
import { scheduleSync } from "../git/debouncedSync.js";
import { git } from "../git/gitSync.js";
import { validateBatchSize, formatBatchResults, MAX_BATCH_SIZE } from "../utils/batchUtils.js";
import type { BatchResult } from "../utils/batchUtils.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";
import { isHiddenDirectory } from "../utils/constants.js";

interface DirEntry {
  name: string;
  type: "file" | "directory";
}

async function listRecursive(
  dirPath: string,
  vaultPath: string,
  currentDepth: number,
  maxDepth: number,
): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const items = await readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (isHiddenDirectory(item.name)) continue;

    const fullPath = path.join(dirPath, item.name);
    const relativePath = path.relative(vaultPath, fullPath);

    if (!(await isInsideVault(fullPath, vaultPath))) {
      continue;
    }

    if (item.isDirectory()) {
      entries.push({ name: relativePath + "/", type: "directory" });
      if (currentDepth < maxDepth) {
        const children = await listRecursive(
          fullPath,
          vaultPath,
          currentDepth + 1,
          maxDepth,
        );
        entries.push(...children);
      }
    } else {
      entries.push({ name: relativePath, type: "file" });
    }
  }

  return entries;
}

async function listDirectoryEntries(
  resolved: string,
  vaultPath: string,
  recursive: boolean,
  maxDepth: number,
): Promise<DirEntry[]> {
  if (recursive) {
    return listRecursive(resolved, vaultPath, 1, maxDepth);
  }

  const items = await readdir(resolved, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const item of items) {
    if (isHiddenDirectory(item.name)) continue;
    const fullPath = path.join(resolved, item.name);
    if (!(await isInsideVault(fullPath, vaultPath))) continue;
    if (item.isDirectory()) {
      entries.push({
        name: path.relative(vaultPath, fullPath) + "/",
        type: "directory",
      });
    } else {
      entries.push({
        name: path.relative(vaultPath, fullPath),
        type: "file",
      });
    }
  }
  return entries;
}

function formatEntries(entries: readonly DirEntry[]): string {
  return entries
    .map((e) => `[${e.type}] ${e.name}`)
    .join("\n");
}

export function registerDirectoryOps(server: McpServer, config: Config): void {
  // list_directory
  server.registerTool(
    "list_directory",
    {
      description: "List files and directories in vault paths. Supports batch listing via 'paths' array (max 10).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        path: z.string().default(".").optional().describe("Path relative to vault root (single directory)"),
        paths: z.array(z.string()).max(MAX_BATCH_SIZE).optional().describe("Multiple paths for batch listing (max 10)"),
        recursive: z.boolean().default(false).describe("List recursively"),
        max_depth: z.number().int().min(1).default(5).describe("Maximum depth for recursive listing"),
      },
    },
    async ({ path: singlePath, paths, recursive, max_depth }) => {
      const dirPaths = paths ?? [singlePath ?? "."];

      const sizeError = validateBatchSize(dirPaths.length);
      if (sizeError) return toolError(sizeError);

      // Single directory: original behavior (backward compatible)
      if (dirPaths.length === 1) {
        const dirPath = dirPaths[0];
        try {
          const resolved = await resolveVaultPathSafe(config.vaultPath, dirPath);
          const s = await stat(resolved);
          if (!s.isDirectory()) {
            return toolError(`Not a directory: ${dirPath}`);
          }

          const entries = await listDirectoryEntries(resolved, config.vaultPath, recursive, max_depth);
          const formatted = formatEntries(entries);
          return toolSuccess(formatted || "(empty directory)");
        } catch (error) {
          const msg = getErrorMessage(error);
          logger.error("list_directory failed", { path: dirPath, error: msg });
          return toolError(`Failed to list directory: ${msg}`);
        }
      }

      // Batch: list all directories in parallel
      const results = await Promise.all(
        dirPaths.map(async (dirPath, index): Promise<BatchResult> => {
          try {
            const resolved = await resolveVaultPathSafe(config.vaultPath, dirPath);
            const s = await stat(resolved);
            if (!s.isDirectory()) {
              return { index, path: dirPath, success: false, content: `Not a directory: ${dirPath}` };
            }

            const entries = await listDirectoryEntries(resolved, config.vaultPath, recursive, max_depth);
            const formatted = formatEntries(entries);
            return { index, path: dirPath, success: true, content: formatted || "(empty directory)" };
          } catch (error) {
            return { index, path: dirPath, success: false, content: getErrorMessage(error) };
          }
        }),
      );

      return toolSuccess(formatBatchResults(results));
    },
  );

  // create_directory
  server.registerTool(
    "create_directory",
    {
      description:
        "Create a directory in the vault (including parent directories). " +
        "Creates the full directory chain recursively — multiple levels can be created at once. " +
        "IMPORTANT — Before calling this tool, state the full directory path that will be created so the user can confirm. Do not skip this preview step.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
      },
    },
    async ({ path: dirPath }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, dirPath);
        await mkdir(resolved, { recursive: true });
        return toolSuccess(`Directory created: ${dirPath}`);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("create_directory failed", { path: dirPath, error: msg });
        return toolError(`Failed to create directory: ${msg}`);
      }
    },
  );

  // is_directory
  server.registerTool(
    "is_directory",
    {
      description: "Check whether a path exists and is a directory in the vault.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
      },
    },
    async ({ path: dirPath }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, dirPath);
        const fileStat = await stat(resolved);
        if (fileStat.isDirectory()) {
          return toolSuccess(`Directory exists: ${dirPath}`);
        }
        return toolSuccess(`Path exists but is not a directory: ${dirPath}`);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return toolSuccess(`Directory does not exist: ${dirPath}`);
        }
        const msg = getErrorMessage(error);
        logger.error("is_directory failed", { path: dirPath, error: msg });
        return toolError(`Failed to check directory: ${msg}`);
      }
    },
  );

  // move_directory
  server.registerTool(
    "move_directory",
    {
      description:
        "Move a directory and all its contents to a new location using git mv to preserve git history. " +
        "The target parent directory must already exist — use create_directory first if needed. " +
        "Triggers git commit and push. " +
        "IMPORTANT — Before calling this tool, present both the current directory path and the new directory path to the user so they can review the move. Do not skip this preview step.",
      annotations: { destructiveHint: true },
      inputSchema: {
        old_path: z.string().describe("Current directory path relative to vault root"),
        new_path: z.string().describe("New directory path relative to vault root"),
      },
    },
    async ({ old_path, new_path }) => {
      try {
        const resolvedOld = await resolveVaultPathSafe(config.vaultPath, old_path);
        const resolvedNew = await resolveVaultPathSafe(config.vaultPath, new_path);

        // Verify source exists and is a directory
        const srcStat = await stat(resolvedOld);
        if (!srcStat.isDirectory()) {
          return toolError(`Source is not a directory: ${old_path}. Use move_file for files.`);
        }

        // Verify target parent directory exists
        const targetParent = path.dirname(resolvedNew);
        try {
          const parentStat = await stat(targetParent);
          if (!parentStat.isDirectory()) {
            return toolError(`Target parent path is not a directory: ${path.dirname(new_path)}`);
          }
        } catch {
          return toolError(`Target parent directory does not exist: ${path.dirname(new_path)}. Create it first with create_directory.`);
        }

        const relOld = path.relative(config.vaultPath, resolvedOld);
        const relNew = path.relative(config.vaultPath, resolvedNew);
        await git(["mv", "--", relOld, relNew], config.vaultPath);
        scheduleSync(`MCP: move directory ${old_path} -> ${new_path}`);
        return toolSuccess(`Directory moved: ${old_path} -> ${new_path}`);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("move_directory failed", { old_path, new_path, error: msg });
        return toolError(`Failed to move directory: ${msg}`);
      }
    },
  );
}
