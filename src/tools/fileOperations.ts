import { readFile, writeFile, unlink, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPathSafe } from "../utils/pathValidation.js";
import { scheduleSync } from "../git/debouncedSync.js";
import { validateBatchSize, formatBatchResults, MAX_BATCH_SIZE } from "../utils/batchUtils.js";
import type { BatchResult } from "../utils/batchUtils.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";
import { MAX_FILE_SIZE, MAX_LINES_PER_PARTIAL_READ } from "../utils/constants.js";

async function readValidatedContent(
  vaultPath: string,
  filePath: string,
): Promise<{ content: string; resolvedPath: string } | { error: string }> {
  const resolvedPath = await resolveVaultPathSafe(vaultPath, filePath);
  const fileStat = await stat(resolvedPath);
  if (fileStat.size > MAX_FILE_SIZE) {
    return { error: `File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})` };
  }
  const content = await readFile(resolvedPath, "utf-8");
  if (content.includes("\0")) {
    return { error: "Binary file detected (contains null bytes)" };
  }
  return { content, resolvedPath };
}

async function readSingleFile(vaultPath: string, filePath: string): Promise<BatchResult> {
  try {
    const result = await readValidatedContent(vaultPath, filePath);
    if ("error" in result) {
      return { index: 0, path: filePath, success: false, content: result.error };
    }
    return { index: 0, path: filePath, success: true, content: result.content };
  } catch (error) {
    return { index: 0, path: filePath, success: false, content: getErrorMessage(error) };
  }
}

async function readLineRange(
  vaultPath: string,
  filePath: string,
  startLine: number,
  endLine: number | undefined,
): Promise<{ success: boolean; content: string }> {
  try {
    const result = await readValidatedContent(vaultPath, filePath);
    if ("error" in result) {
      return { success: false, content: result.error };
    }
    const lines = result.content.split("\n");
    const totalLines = lines.length;

    // Resolve negative start_line (from end, like Python slicing)
    const resolvedStart = startLine < 0
      ? Math.max(1, totalLines + startLine + 1)
      : startLine;
    const resolvedEnd = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;

    if (resolvedStart > totalLines) {
      return { success: false, content: `start_line ${startLine} resolves beyond total line count (${totalLines})` };
    }

    const rangeSize = resolvedEnd - resolvedStart + 1;
    if (rangeSize > MAX_LINES_PER_PARTIAL_READ) {
      return { success: false, content: `Requested ${rangeSize} lines exceeds maximum (${MAX_LINES_PER_PARTIAL_READ} per request)` };
    }

    const selectedLines = lines.slice(resolvedStart - 1, resolvedEnd);
    const numbered = selectedLines.map((line, i) => `${resolvedStart + i}: ${line}`).join("\n");
    const header = `Lines ${resolvedStart}-${resolvedEnd} of ${totalLines} total lines in ${filePath}:`;
    return { success: true, content: `${header}\n${numbered}` };
  } catch (error) {
    return { success: false, content: getErrorMessage(error) };
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
    const result = await readValidatedContent(vaultPath, filePath);
    if ("error" in result) {
      return { index: 0, path: filePath, success: false, content: result.error };
    }

    const occurrences = result.content.split(oldText).length - 1;
    if (occurrences === 0) {
      return { index: 0, path: filePath, success: false, content: "old_text not found in file" };
    }
    if (occurrences > 1) {
      return { index: 0, path: filePath, success: false, content: `old_text found ${occurrences} times, must match exactly once` };
    }

    const newContent = result.content.replace(oldText, () => newText);
    await writeFile(result.resolvedPath, newContent, "utf-8");
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
      annotations: { readOnlyHint: true },
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

  // read_file_lines
  server.registerTool(
    "read_file_lines",
    {
      description:
        "Read a range of lines from a file. Returns numbered lines with a header showing the range and total line count. " +
        "Supports negative start_line for reading from the end (e.g., start_line: -50 reads the last 50 lines). " +
        "Useful for reading frontmatter, tailing logs, or sequentially processing large files.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
        start_line: z.number().int().refine((v) => v !== 0, "start_line cannot be 0")
          .describe("First line (1-based). Positive: from start. Negative: from end (-50 = last 50 lines)"),
        end_line: z.number().int().min(1).optional()
          .describe("Last line (1-based, inclusive). Omit to read to end of file"),
      },
    },
    async ({ path: filePath, start_line, end_line }) => {
      if (start_line > 0 && end_line !== undefined && end_line < start_line) {
        return toolError("end_line must be >= start_line");
      }
      if (start_line < 0 && end_line !== undefined) {
        return toolError("end_line cannot be used with negative start_line");
      }
      const result = await readLineRange(config.vaultPath, filePath, start_line, end_line);
      if (!result.success) {
        logger.error("read_file_lines failed", { path: filePath, error: result.content });
        return toolError(`Failed to read file lines: ${result.content}`);
      }
      return toolSuccess(result.content);
    },
  );

  // write_file
  server.registerTool(
    "write_file",
    {
      description:
        "Create or overwrite files in the vault. Supports batch writes via 'files' array (max 10, single git commit). " +
        "Clients SHOULD present the intended file content to the user for review before calling this tool — for small files the full content, for large files a representative excerpt.",
      annotations: { destructiveHint: true },
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
        scheduleSync(`MCP: write ${filePath}`);
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
        scheduleSync(`MCP: batch write ${writtenPaths.length} files`);
      }

      return toolSuccess(formatBatchResults(results));
    },
  );

  // edit_file
  server.registerTool(
    "edit_file",
    {
      description:
        "Find-and-replace in files. old_text must match exactly once per file. Supports batch edits via 'edits' array (max 10, single git commit). " +
        "Clients SHOULD show the user how the file will look after the edit before calling this tool — for small files the full resulting content, for large files a relevant excerpt around the changed section.",
      annotations: { destructiveHint: true },
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
        scheduleSync(`MCP: edit ${filePath}`);
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
        scheduleSync(`MCP: batch edit ${editedPaths.length} files`);
      }

      return toolSuccess(formatBatchResults(results));
    },
  );

  // delete_file
  server.registerTool(
    "delete_file",
    {
      description:
        "Delete a file from the vault. Triggers git commit and push. " +
        "Clients SHOULD inform the user which file will be deleted before calling this tool.",
      annotations: { destructiveHint: true },
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
      },
    },
    async ({ path: filePath }) => {
      try {
        const resolved = await resolveVaultPathSafe(config.vaultPath, filePath);
        await unlink(resolved);
        scheduleSync(`MCP: delete ${filePath}`);
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
      description:
        "Move or rename a file in the vault. Triggers git commit and push. " +
        "Clients SHOULD inform the user about the source and destination paths before calling this tool.",
      annotations: { destructiveHint: true },
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
        scheduleSync(`MCP: rename ${old_path} -> ${new_path}`);
        return toolSuccess(`File renamed: ${old_path} -> ${new_path}`);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("rename_file failed", { old_path, new_path, error: msg });
        return toolError(`Failed to rename file: ${msg}`);
      }
    },
  );
}
