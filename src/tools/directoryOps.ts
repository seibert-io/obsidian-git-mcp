import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe, isInsideVault } from "../utils/pathValidation.js";
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
        "Clients SHOULD inform the user which directory will be created before calling this tool.",
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
}
