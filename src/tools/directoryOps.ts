import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe } from "../utils/pathValidation.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";
import { HIDDEN_DIRECTORIES } from "../utils/constants.js";

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
    if ((HIDDEN_DIRECTORIES as readonly string[]).includes(item.name)) continue;

    const relativePath = path.relative(vaultPath, path.join(dirPath, item.name));

    if (item.isDirectory()) {
      entries.push({ name: relativePath + "/", type: "directory" });
      if (currentDepth < maxDepth) {
        const children = await listRecursive(
          path.join(dirPath, item.name),
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

export function registerDirectoryOps(server: McpServer, config: Config): void {
  // list_directory
  server.registerTool(
    "list_directory",
    {
      description: "List files and directories in a vault path",
      inputSchema: {
        path: z.string().default(".").describe("Path relative to vault root"),
        recursive: z.boolean().default(false).describe("List recursively"),
        max_depth: z.number().int().min(1).default(5).describe("Maximum depth for recursive listing"),
      },
    },
    async ({ path: dirPath, recursive, max_depth }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, dirPath);
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          return toolError(`Not a directory: ${dirPath}`);
        }

        let entries: DirEntry[];
        if (recursive) {
          entries = await listRecursive(resolved, config.vaultPath, 1, max_depth);
        } else {
          const items = await readdir(resolved, { withFileTypes: true });
          entries = items
            .filter((item) => !(HIDDEN_DIRECTORIES as readonly string[]).includes(item.name))
            .map((item) => ({
              name: item.isDirectory()
                ? path.relative(config.vaultPath, path.join(resolved, item.name)) + "/"
                : path.relative(config.vaultPath, path.join(resolved, item.name)),
              type: item.isDirectory() ? ("directory" as const) : ("file" as const),
            }));
        }

        const formatted = entries
          .map((e) => `[${e.type}] ${e.name}`)
          .join("\n");
        return toolSuccess(formatted || "(empty directory)");
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("list_directory failed", { path: dirPath, error: msg });
        return toolError(`Failed to list directory: ${msg}`);
      }
    },
  );

  // create_directory
  server.registerTool(
    "create_directory",
    {
      description: "Create a directory in the vault (including parent directories)",
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
