import { readFile, writeFile, unlink, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe } from "../utils/pathValidation.js";
import { commitAndPush } from "../git/gitSync.js";
import { logger } from "../utils/logger.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerFileOperations(server: McpServer, config: Config): void {
  // read_file
  server.registerTool(
    "read_file",
    {
      description: "Read a single file's content from the vault",
      inputSchema: { path: z.string().describe("Path relative to vault root") },
    },
    async ({ path: filePath }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, filePath);
        const fileStat = await stat(resolved);
        if (fileStat.size > MAX_FILE_SIZE) {
          return toolError(`File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})`);
        }
        const content = await readFile(resolved, "utf-8");
        return toolSuccess(content);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("read_file failed", { path: filePath, error: msg });
        return toolError(`Failed to read file: ${msg}`);
      }
    },
  );

  // write_file
  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a file in the vault. Auto-creates parent directories. Triggers git commit and push.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
        content: z.string().describe("File content to write"),
      },
    },
    async ({ path: filePath, content }) => {
      try {
        if (content.length > MAX_FILE_SIZE) {
          return toolError(`Content too large (${content.length} bytes, max ${MAX_FILE_SIZE})`);
        }
        const resolved = await resolveVaultPathSafe(config.vaultPath, filePath);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf-8");
        await commitAndPush(config, `MCP: write ${filePath}`);
        return toolSuccess(`File written: ${filePath}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("write_file failed", { path: filePath, error: msg });
        return toolError(`Failed to write file: ${msg}`);
      }
    },
  );

  // edit_file
  server.registerTool(
    "edit_file",
    {
      description: "Find-and-replace in a file. old_text must match exactly once. Triggers git commit and push.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
        old_text: z.string().describe("Exact text to find (must match exactly once)"),
        new_text: z.string().describe("Replacement text"),
      },
    },
    async ({ path: filePath, old_text, new_text }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, filePath);
        const fileStat = await stat(resolved);
        if (fileStat.size > MAX_FILE_SIZE) {
          return toolError(`File too large to edit (${fileStat.size} bytes, max ${MAX_FILE_SIZE})`);
        }
        const content = await readFile(resolved, "utf-8");

        const occurrences = content.split(old_text).length - 1;
        if (occurrences === 0) {
          return toolError("old_text not found in file");
        }
        if (occurrences > 1) {
          return toolError(
            `old_text found ${occurrences} times, must match exactly once`,
          );
        }

        const newContent = content.replace(old_text, new_text);
        await writeFile(resolved, newContent, "utf-8");
        await commitAndPush(config, `MCP: edit ${filePath}`);
        return toolSuccess(`File edited: ${filePath}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("edit_file failed", { path: filePath, error: msg });
        return toolError(`Failed to edit file: ${msg}`);
      }
    },
  );

  // delete_file
  server.registerTool(
    "delete_file",
    {
      description: "Delete a file from the vault. Triggers git commit and push.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
      },
    },
    async ({ path: filePath }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, filePath);
        await unlink(resolved);
        await commitAndPush(config, `MCP: delete ${filePath}`);
        return toolSuccess(`File deleted: ${filePath}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("delete_file failed", { path: filePath, error: msg });
        return toolError(`Failed to delete file: ${msg}`);
      }
    },
  );

  // rename_file
  server.registerTool(
    "rename_file",
    {
      description: "Move or rename a file in the vault. Triggers git commit and push.",
      inputSchema: {
        old_path: z.string().describe("Current path relative to vault root"),
        new_path: z.string().describe("New path relative to vault root"),
      },
    },
    async ({ old_path, new_path }) => {
      try {
        const resolvedOld = await resolveVaultPathSafe(config.vaultPath, old_path);
        const resolvedNew = await resolveVaultPathSafe(config.vaultPath, new_path);
        await mkdir(path.dirname(resolvedNew), { recursive: true });
        await rename(resolvedOld, resolvedNew);
        await commitAndPush(config, `MCP: rename ${old_path} -> ${new_path}`);
        return toolSuccess(`File renamed: ${old_path} -> ${new_path}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("rename_file failed", { old_path, new_path, error: msg });
        return toolError(`Failed to rename file: ${msg}`);
      }
    },
  );
}
