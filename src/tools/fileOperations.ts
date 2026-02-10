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
import { MAX_FILE_SIZE, MAX_TAIL_LINES, MAX_LINE_RANGE } from "../utils/constants.js";

async function readValidatedContent(
  vaultPath: string,
  filePath: string,
): Promise<{ content: string } | { error: string }> {
  const resolved = await resolveVaultPathSafe(vaultPath, filePath);
  const fileStat = await stat(resolved);
  if (fileStat.size > MAX_FILE_SIZE) {
    return { error: `File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})` };
  }
  return { content: await readFile(resolved, "utf-8") };
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
  endLine: number,
): Promise<{ success: boolean; content: string }> {
  try {
    const result = await readValidatedContent(vaultPath, filePath);
    if ("error" in result) {
      return { success: false, content: result.error };
    }
    const lines = result.content.split("\n");
    const totalLines = lines.length;

    if (startLine > totalLines) {
      return { success: false, content: `start_line ${startLine} exceeds total line count (${totalLines})` };
    }

    const end = Math.min(totalLines, endLine);
    const selectedLines = lines.slice(startLine - 1, end);
    const numbered = selectedLines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
    const header = `Lines ${startLine}-${end} of ${totalLines} total lines in ${filePath}:`;
    return { success: true, content: `${header}\n${numbered}` };
  } catch (error) {
    return { success: false, content: getErrorMessage(error) };
  }
}

async function readTail(
  vaultPath: string,
  filePath: string,
  lineCount: number,
): Promise<{ success: boolean; content: string }> {
  try {
    const result = await readValidatedContent(vaultPath, filePath);
    if ("error" in result) {
      return { success: false, content: result.error };
    }
    const lines = result.content.split("\n");
    const totalLines = lines.length;

    const count = Math.min(lineCount, totalLines);
    const startLine = totalLines - count + 1;
    const selectedLines = lines.slice(-count);
    const numbered = selectedLines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
    const header = `Last ${count} of ${totalLines} total lines in ${filePath}:`;
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

  // read_file_lines
  server.registerTool(
    "read_file_lines",
    {
      description:
        "Read a specific range of lines from a file. Returns numbered lines with a header showing the range and total line count. " +
        "Useful for reading frontmatter, headers, or sequentially processing large files without returning the entire content.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
        start_line: z.number().int().min(1).describe("First line to read (1-based, inclusive)"),
        end_line: z.number().int().min(1).describe("Last line to read (1-based, inclusive)"),
      },
    },
    async ({ path: filePath, start_line, end_line }) => {
      if (end_line < start_line) {
        return toolError("end_line must be >= start_line");
      }
      if (end_line - start_line + 1 > MAX_LINE_RANGE) {
        return toolError(`Line range too large (max ${MAX_LINE_RANGE} lines per request)`);
      }
      const result = await readLineRange(config.vaultPath, filePath, start_line, end_line);
      if (!result.success) {
        logger.error("read_file_lines failed", { path: filePath, error: result.content });
        return toolError(`Failed to read file lines: ${result.content}`);
      }
      return toolSuccess(result.content);
    },
  );

  // tail_file
  server.registerTool(
    "tail_file",
    {
      description:
        "Read the last N lines of a file (like the 'tail' command). Returns numbered lines with a header showing the count and total line count. " +
        "Useful for checking recent entries in logs, journals, or append-heavy files.",
      inputSchema: {
        path: z.string().describe("Path relative to vault root"),
        lines: z.number().int().min(1).max(MAX_TAIL_LINES).default(50)
          .describe(`Number of lines to read from the end (default: 50, max: ${MAX_TAIL_LINES})`),
      },
    },
    async ({ path: filePath, lines: lineCount }) => {
      const result = await readTail(config.vaultPath, filePath, lineCount);
      if (!result.success) {
        logger.error("tail_file failed", { path: filePath, error: result.content });
        return toolError(`Failed to tail file: ${result.content}`);
      }
      return toolSuccess(result.content);
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
      description: "Delete a file from the vault. Triggers git commit and push.",
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
