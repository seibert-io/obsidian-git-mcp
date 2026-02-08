import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath } from "../utils/pathValidation.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — skip files larger than this in search
const MAX_REGEX_LENGTH = 500;
const MAX_GREP_RESULTS = 500;

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
      description: "Find files by name pattern (glob). Example patterns: *.md, **/daily/*.md",
      inputSchema: {
        pattern: z.string().describe("Glob pattern to match file names"),
        path: z.string().default(".").describe("Directory to search in, relative to vault root"),
      },
    },
    async ({ pattern, path: searchPath }) => {
      try {
        const patternError = validateGlobPattern(pattern);
        if (patternError) return toolError(patternError);
        const resolved = resolveVaultPath(config.vaultPath, searchPath);
        const matches = await fg(pattern, {
          cwd: resolved,
          dot: false,
          ignore: [".git/**"],
          followSymbolicLinks: false,
        });
        if (matches.length === 0) {
          return toolSuccess("No files matched the pattern");
        }

        // Return paths relative to vault
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
    },
  );

  // grep
  server.registerTool(
    "grep",
    {
      description: "Search file contents by text or regex pattern. Returns matching lines with file paths and line numbers.",
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
          ignore: [".git/**"],
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
      description: "Advanced file finder with filters for name, modification time, and size",
      inputSchema: {
        path: z.string().default(".").describe("Directory to search in, relative to vault root"),
        name: z.string().optional().describe("File name glob pattern"),
        modified_after: z.string().optional().describe("ISO date string — only files modified after this date"),
        modified_before: z.string().optional().describe("ISO date string — only files modified before this date"),
        size_min: z.number().optional().describe("Minimum file size in bytes"),
        size_max: z.number().optional().describe("Maximum file size in bytes"),
      },
    },
    async ({ path: searchPath, name, modified_after, modified_before, size_min, size_max }) => {
      try {
        const resolved = resolveVaultPath(config.vaultPath, searchPath);
        const globPattern = name ?? "**/*";
        const globError = validateGlobPattern(globPattern);
        if (globError) return toolError(globError);
        const files = await fg(globPattern, {
          cwd: resolved,
          dot: false,
          ignore: [".git/**"],
          onlyFiles: true,
          stats: true,
          followSymbolicLinks: false,
        });

        const afterDate = modified_after ? new Date(modified_after) : null;
        const beforeDate = modified_before ? new Date(modified_before) : null;

        const results: string[] = [];

        for (const entry of files) {
          const filePath = path.join(resolved, entry.path);
          const fileStat = await stat(filePath);

          // Filter by modification time
          if (afterDate && fileStat.mtime < afterDate) continue;
          if (beforeDate && fileStat.mtime > beforeDate) continue;

          // Filter by size
          if (size_min !== undefined && fileStat.size < size_min) continue;
          if (size_max !== undefined && fileStat.size > size_max) continue;

          const relPath = path.relative(config.vaultPath, filePath);
          results.push(
            `${relPath}  (${fileStat.size} bytes, modified: ${fileStat.mtime.toISOString()})`,
          );
        }

        if (results.length === 0) {
          return toolSuccess("No files found matching criteria");
        }
        return toolSuccess(results.join("\n"));
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("find_files failed", { error: msg });
        return toolError(`Find failed: ${msg}`);
      }
    },
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
