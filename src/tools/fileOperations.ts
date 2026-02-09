import { readFile, writeFile, unlink, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe } from "../utils/pathValidation.js";
import { commitAndPush, commitAndPushBatch } from "../git/gitSync.js";
import { validateBatchSize, formatBatchResults, MAX_BATCH_SIZE } from "../utils/batchUtils.js";
import type { BatchResult } from "../utils/batchUtils.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";
import { MAX_FILE_SIZE } from "../utils/constants.js";

async function readSingleFile(vaultPath: string, filePath: string): Promise<BatchResult> {
  try {
    const resolved = await resolveVaultPathSafe(vaultPath, filePath);
    const fileStat = await stat(resolved);
    if (fileStat.size > MAX_FILE_SIZE) {
      return { index: 0, path: filePath, success: false, content: `File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})` };
    }
    const content = await readFile(resolved, "utf-8");
    return { index: 0, path: filePath, success: true, content };
  } catch (error) {
    return { index: 0, path: filePath, success: false, content: getErrorMessage(error) };
  }
}

async function writeSingleFile(
  vaultPath: string,
  filePath: string,
  content: string,
): Promise<BatchResult> {
  try {
    if (content.length > MAX_FILE_SIZE) {
      return { index: 0, path: filePath, success: false, content: `Content too large (${content.length} bytes, max ${MAX_FILE_SIZE})` };
    }
    const resolved = await resolveVaultPathSafe(vaultPath, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
    return { index: 0, path: filePath, success: true, content: `File written: ${filePath}` };
  } catch (error) {
    return { index: 0, path: filePath, success: false, content: getErrorMessage(error) };
  }
}

async function editSingleFile(
  vaultPath: string,
  filePath: string,
  oldText: string,
  newText: string,
): Promise<BatchResult> {
  try {
    const resolved = await resolveVaultPathSafe(vaultPath, filePath);
    const fileStat = await stat(resolved);
    if (fileStat.size > MAX_FILE_SIZE) {
      return { index: 0, path: filePath, success: false, content: `File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})` };
    }
    const content = await readFile(resolved, "utf-8");

    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      return { index: 0, path: filePath, success: false, content: "old_text not found in file" };
    }
    if (occurrences > 1) {
      return { index: 0, path: filePath, success: false, content: `old_text found ${occurrences} times, must match exactly once` };
    }

    const newContent = content.replace(oldText, () => newText);
    await writeFile(resolved, newContent, "utf-8");
    return { index: 0, path: filePath, success: true, content: `File edited: ${filePath}` };
  } catch (error) {
    return { index: 0, path: filePath, success: false, content: getErrorMessage(error) };
  }
}

export function registerFileOperations(server: McpServer, config: Config): void {
  // read_file
  server.registerTool(
    "read_file",
    {
      description: "Read file content from the vault. Supports batch reads via 'paths' array (max 10).",
      inputSchema: {
        path: z.string().optional().describe("Path relative to vault root (single file)"),
        paths: z.array(z.string()).max(MAX_BATCH_SIZE).optional().describe("Multiple paths for batch read (max 10)"),
      },
    },
    async ({ path: singlePath, paths }) => {
      const filePaths = paths ?? (singlePath ? [singlePath] : []);

      const sizeError = validateBatchSize(filePaths.length);
      if (sizeError) return toolError(sizeError);

      if (filePaths.length === 1) {
        const result = await readSingleFile(config.vaultPath, filePaths[0]);
        if (!result.success) {
          logger.error("read_file failed", { path: filePaths[0], error: result.content });
          return toolError(`Failed to read file: ${result.content}`);
        }
        return toolSuccess(result.content);
      }

      const results = await Promise.all(
        filePaths.map(async (filePath, index) => {
          const result = await readSingleFile(config.vaultPath, filePath);
          return { ...result, index };
        }),
      );
      return toolSuccess(formatBatchResults(results));
    },
  );

  // write_file
  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite files in the vault. Supports batch writes via 'files' array (max 10, single git commit).",
      inputSchema: {
        path: z.string().optional().describe("Path relative to vault root (single file)"),
        content: z.string().optional().describe("File content (single file)"),
        files: z.array(z.object({
          path: z.string(),
          content: z.string(),
        })).max(MAX_BATCH_SIZE).optional().describe("Multiple files for batch write (max 10)"),
      },
    },
    async ({ path: singlePath, content: singleContent, files }) => {
      const fileEntries = files ?? (singlePath && singleContent !== undefined
        ? [{ path: singlePath, content: singleContent }]
        : []);

      const sizeError = validateBatchSize(fileEntries.length);
      if (sizeError) return toolError(sizeError);

      if (fileEntries.length === 1) {
        const { path: filePath, content } = fileEntries[0];
        const result = await writeSingleFile(config.vaultPath, filePath, content);
        if (!result.success) {
          logger.error("write_file failed", { path: filePath, error: result.content });
          return toolError(`Failed to write file: ${result.content}`);
        }
        await commitAndPush(config, `MCP: write ${filePath}`);
        return toolSuccess(result.content);
      }

      const results: BatchResult[] = [];
      const writtenPaths: string[] = [];

      for (let index = 0; index < fileEntries.length; index++) {
        const { path: filePath, content } = fileEntries[index];
        const result = await writeSingleFile(config.vaultPath, filePath, content);
        results.push({ ...result, index });
        if (result.success) writtenPaths.push(filePath);
      }

      if (writtenPaths.length > 0) {
        await commitAndPushBatch(config, writtenPaths);
      }

      return toolSuccess(formatBatchResults(results));
    },
  );

  // edit_file
  server.registerTool(
    "edit_file",
    {
      description: "Find-and-replace in files. old_text must match exactly once per file. Supports batch edits via 'edits' array (max 10, single git commit).",
      inputSchema: {
        path: z.string().optional().describe("Path relative to vault root (single file)"),
        old_text: z.string().optional().describe("Exact text to find (must match exactly once)"),
        new_text: z.string().optional().describe("Replacement text"),
        edits: z.array(z.object({
          path: z.string(),
          old_text: z.string(),
          new_text: z.string(),
        })).max(MAX_BATCH_SIZE).optional().describe("Multiple edits for batch (max 10)"),
      },
    },
    async ({ path: singlePath, old_text, new_text, edits }) => {
      const editEntries = edits ?? (singlePath && old_text !== undefined && new_text !== undefined
        ? [{ path: singlePath, old_text, new_text }]
        : []);

      const sizeError = validateBatchSize(editEntries.length);
      if (sizeError) return toolError(sizeError);

      if (editEntries.length === 1) {
        const { path: filePath, old_text: oldText, new_text: newText } = editEntries[0];
        const result = await editSingleFile(config.vaultPath, filePath, oldText, newText);
        if (!result.success) {
          logger.error("edit_file failed", { path: filePath, error: result.content });
          return toolError(`Failed to edit file: ${result.content}`);
        }
        await commitAndPush(config, `MCP: edit ${filePath}`);
        return toolSuccess(result.content);
      }

      const results: BatchResult[] = [];
      const editedPaths: string[] = [];

      for (let index = 0; index < editEntries.length; index++) {
        const { path: filePath, old_text: oldText, new_text: newText } = editEntries[index];
        const result = await editSingleFile(config.vaultPath, filePath, oldText, newText);
        results.push({ ...result, index });
        if (result.success) editedPaths.push(filePath);
      }

      if (editedPaths.length > 0) {
        await commitAndPushBatch(config, editedPaths);
      }

      return toolSuccess(formatBatchResults(results));
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
        const msg = getErrorMessage(error);
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
        const msg = getErrorMessage(error);
        logger.error("rename_file failed", { old_path, new_path, error: msg });
        return toolError(`Failed to rename file: ${msg}`);
      }
    },
  );
}
