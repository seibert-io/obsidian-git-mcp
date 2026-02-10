import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath } from "../utils/pathValidation.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";
import { MAX_FILE_SIZE, HIDDEN_DIRECTORY_GLOBS } from "../utils/constants.js";
import { validateBatchSize, formatBatchResults, MAX_BATCH_SIZE } from "../utils/batchUtils.js";
import type { BatchResult } from "../utils/batchUtils.js";
const MAX_REGEX_LENGTH = 500;
const MAX_GREP_RESULTS = 500;
const MAX_FIND_RESULTS = 500;

/**
 * Validate a glob pattern to prevent path traversal.
 * Rejects patterns containing `..` segments or absolute paths.
 */
function validateGlobPattern(pattern: string): string | null {
  // Reject absolute paths
  if (path.isAbsolute(pattern)) {
    return "Glob pattern must not be an absolute path";
  }
  // Reject `..` path traversal in any segment
  const segments = pattern.split(/[/\\]/);
  if (segments.some((s) => s === "..")) {
    return "Glob pattern must not contain '..' path traversal";
  }
  return null;
}

export function registerSearchOperations(server: McpServer, config: Config): void {
  // search_files
  server.registerTool(
    "search_files",
    {
      description: "Find files by name pattern (glob). Supports batch searches via 'searches' array (max 10).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        pattern: z.string().optional().describe("Glob pattern to match file names (single search)"),
        path: z.string().default(".").optional().describe("Directory to search in, relative to vault root"),
        searches: z.array(z.object({
          pattern: z.string(),
          path: z.string().default("."),
        })).max(MAX_BATCH_SIZE).optional().describe("Multiple searches for batch (max 10)"),
      },
    },
    async ({ pattern: singlePattern, path: singlePath, searches }) => {
      const searchEntries = searches ?? (singlePattern
        ? [{ pattern: singlePattern, path: singlePath ?? "." }]
        : []);

      const sizeError = validateBatchSize(searchEntries.length);
      if (sizeError) return toolError(sizeError);

      // Single search: original behavior
      if (searchEntries.length === 1) {
        const { pattern, path: searchPath } = searchEntries[0];
        try {
          const patternError = validateGlobPattern(pattern);
          if (patternError) return toolError(patternError);
          const resolved = resolveVaultPath(config.vaultPath, searchPath);
          const matches = await fg(pattern, {
            cwd: resolved,
            dot: false,
            ignore: HIDDEN_DIRECTORY_GLOBS,
            followSymbolicLinks: false,
          });
          if (matches.length === 0) {
            return toolSuccess("No files matched the pattern");
          }

          const relativeBase = path.relative(config.vaultPath, resolved);
          const results = matches.map((m) =>
            relativeBase && relativeBase !== "."
              ? path.join(relativeBase, m)
              : m,
          );
          return toolSuccess(results.join("\n"));
        } catch (error) {
          const msg = getErrorMessage(error);
          logger.error("search_files failed", { pattern, error: msg });
          return toolError(`Search failed: ${msg}`);
        }
      }

      // Batch: search in parallel
      const results = await Promise.all(
        searchEntries.map(async ({ pattern, path: searchPath }, index): Promise<BatchResult> => {
          try {
            const patternError = validateGlobPattern(pattern);
            if (patternError) return { index, path: searchPath, success: false, content: patternError };
            const resolved = resolveVaultPath(config.vaultPath, searchPath);
            const matches = await fg(pattern, {
              cwd: resolved,
              dot: false,
              ignore: HIDDEN_DIRECTORY_GLOBS,
              followSymbolicLinks: false,
            });
            if (matches.length === 0) {
              return { index, path: `${pattern} in ${searchPath}`, success: true, content: "No files matched the pattern" };
            }

            const relativeBase = path.relative(config.vaultPath, resolved);
            const matchResults = matches.map((m) =>
              relativeBase && relativeBase !== "."
                ? path.join(relativeBase, m)
                : m,
            );
            return { index, path: `${pattern} in ${searchPath}`, success: true, content: matchResults.join("\n") };
          } catch (error) {
            return { index, path: `${pattern} in ${searchPath}`, success: false, content: getErrorMessage(error) };
          }
        }),
      );

      return toolSuccess(formatBatchResults(results));
    },
  );

  // grep
  server.registerTool(
    "grep",
    {
      description: "Search file contents by text or regex pattern. Returns matching lines with file paths and line numbers.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("Search query (text or regex)"),
        path: z.string().default(".").describe("Directory to search in, relative to vault root"),
        is_regex: z.boolean().default(false).describe("Treat query as regex"),
        case_sensitive: z.boolean().default(true).describe("Case sensitive search"),
        include_pattern: z.string().optional().describe("Glob pattern to filter which files to search (e.g. *.md)"),
      },
    },
    async ({ query, path: searchPath, is_regex, case_sensitive, include_pattern }) => {
      try {
        const resolved = resolveVaultPath(config.vaultPath, searchPath);

        // Find files to search
        const globPattern = include_pattern ?? "**/*";
        const globError = validateGlobPattern(globPattern);
        if (globError) return toolError(globError);
        const files = await fg(globPattern, {
          cwd: resolved,
          dot: false,
          ignore: HIDDEN_DIRECTORY_GLOBS,
          onlyFiles: true,
          followSymbolicLinks: false,
        });

        // Validate regex length to mitigate ReDoS
        if (is_regex && query.length > MAX_REGEX_LENGTH) {
          return toolError(`Regex pattern too long (max ${MAX_REGEX_LENGTH} characters)`);
        }

        let regex: RegExp;
        try {
          const flags = case_sensitive ? "" : "i";
          regex = is_regex ? new RegExp(query, flags) : new RegExp(escapeRegExp(query), flags);
        } catch {
          return toolError(`Invalid regex pattern: ${query}`);
        }

        const results: string[] = [];

        for (const file of files) {
          if (results.length >= MAX_GREP_RESULTS) break;

          const filePath = path.join(resolved, file);

          // Skip large files
          try {
            const fileStat = await stat(filePath);
            if (fileStat.size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }

          try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_GREP_RESULTS) break;
              if (regex.test(lines[i])) {
                const relPath = path.relative(config.vaultPath, filePath);
                results.push(`${relPath}:${i + 1}: ${lines[i]}`);
              }
            }
          } catch {
            // Skip binary/unreadable files
          }
        }

        if (results.length === 0) {
          return toolSuccess("No matches found");
        }

        let output = results.join("\n");
        if (results.length >= MAX_GREP_RESULTS) {
          output += `\n\n(Results truncated at ${MAX_GREP_RESULTS} matches)`;
        }
        return toolSuccess(output);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("grep failed", { query, error: msg });
        return toolError(`Grep failed: ${msg}`);
      }
    },
  );

  // find_files
  server.registerTool(
    "find_files",
    {
      description: "Advanced file finder with filters. Supports batch queries via 'queries' array (max 10).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        path: z.string().default(".").optional().describe("Directory to search in, relative to vault root"),
        name: z.string().optional().describe("File name glob pattern"),
        modified_after: z.string().optional().describe("ISO date string — only files modified after this date"),
        modified_before: z.string().optional().describe("ISO date string — only files modified before this date"),
        size_min: z.number().optional().describe("Minimum file size in bytes"),
        size_max: z.number().optional().describe("Maximum file size in bytes"),
        queries: z.array(z.object({
          path: z.string().default("."),
          name: z.string().optional(),
          modified_after: z.string().optional(),
          modified_before: z.string().optional(),
          size_min: z.number().optional(),
          size_max: z.number().optional(),
        })).max(MAX_BATCH_SIZE).optional().describe("Multiple queries for batch find (max 10)"),
      },
    },
    async ({ path: singlePath, name, modified_after, modified_before, size_min, size_max, queries }) => {
      const queryEntries = queries ?? [{
        path: singlePath ?? ".",
        name,
        modified_after,
        modified_before,
        size_min,
        size_max,
      }];

      const sizeError = validateBatchSize(queryEntries.length);
      if (sizeError) return toolError(sizeError);

      // Single query: original behavior
      if (queryEntries.length === 1) {
        const q = queryEntries[0];
        try {
          const resolved = resolveVaultPath(config.vaultPath, q.path);
          const globPattern = q.name ?? "**/*";
          const globError = validateGlobPattern(globPattern);
          if (globError) return toolError(globError);
          const files = await fg(globPattern, {
            cwd: resolved,
            dot: false,
            ignore: HIDDEN_DIRECTORY_GLOBS,
            onlyFiles: true,
            stats: true,
            followSymbolicLinks: false,
          });

          const afterDate = q.modified_after ? new Date(q.modified_after) : null;
          const beforeDate = q.modified_before ? new Date(q.modified_before) : null;

          const results: string[] = [];

          for (const entry of files) {
            if (results.length >= MAX_FIND_RESULTS) break;

            const filePath = path.join(resolved, entry.path);
            const fileStat = await stat(filePath);

            if (afterDate && fileStat.mtime < afterDate) continue;
            if (beforeDate && fileStat.mtime > beforeDate) continue;
            if (q.size_min !== undefined && fileStat.size < q.size_min) continue;
            if (q.size_max !== undefined && fileStat.size > q.size_max) continue;

            const relPath = path.relative(config.vaultPath, filePath);
            results.push(
              `${relPath}  (${fileStat.size} bytes, modified: ${fileStat.mtime.toISOString()})`,
            );
          }

          if (results.length === 0) {
            return toolSuccess("No files found matching criteria");
          }
          let output = results.join("\n");
          if (results.length >= MAX_FIND_RESULTS) {
            output += `\n\n(Results truncated at ${MAX_FIND_RESULTS} files)`;
          }
          return toolSuccess(output);
        } catch (error) {
          const msg = getErrorMessage(error);
          logger.error("find_files failed", { error: msg });
          return toolError(`Find failed: ${msg}`);
        }
      }

      // Batch: find in parallel
      const batchResults = await Promise.all(
        queryEntries.map(async (q, index): Promise<BatchResult> => {
          try {
            const resolved = resolveVaultPath(config.vaultPath, q.path);
            const globPattern = q.name ?? "**/*";
            const globError = validateGlobPattern(globPattern);
            if (globError) return { index, path: q.path, success: false, content: globError };
            const files = await fg(globPattern, {
              cwd: resolved,
              dot: false,
              ignore: HIDDEN_DIRECTORY_GLOBS,
              onlyFiles: true,
              stats: true,
              followSymbolicLinks: false,
            });

            const afterDate = q.modified_after ? new Date(q.modified_after) : null;
            const beforeDate = q.modified_before ? new Date(q.modified_before) : null;

            const results: string[] = [];

            for (const entry of files) {
              if (results.length >= MAX_FIND_RESULTS) break;

              const filePath = path.join(resolved, entry.path);
              const fileStat = await stat(filePath);

              if (afterDate && fileStat.mtime < afterDate) continue;
              if (beforeDate && fileStat.mtime > beforeDate) continue;
              if (q.size_min !== undefined && fileStat.size < q.size_min) continue;
              if (q.size_max !== undefined && fileStat.size > q.size_max) continue;

              const relPath = path.relative(config.vaultPath, filePath);
              results.push(
                `${relPath}  (${fileStat.size} bytes, modified: ${fileStat.mtime.toISOString()})`,
              );
            }

            if (results.length === 0) {
              return { index, path: q.path, success: true, content: "No files found matching criteria" };
            }
            let output = results.join("\n");
            if (results.length >= MAX_FIND_RESULTS) {
              output += `\n\n(Results truncated at ${MAX_FIND_RESULTS} files)`;
            }
            return { index, path: q.path, success: true, content: output };
          } catch (error) {
            return { index, path: q.path, success: false, content: getErrorMessage(error) };
          }
        }),
      );

      return toolSuccess(formatBatchResults(batchResults));
    },
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
