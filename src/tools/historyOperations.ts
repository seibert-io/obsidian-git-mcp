import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { git } from "../git/gitSync.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";

const MAX_CHANGES = 20;
const MAX_DIFF_LINES_PER_FILE = 80;
const COMMIT_SEPARATOR = "---COMMIT_BOUNDARY---";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

interface FileDiff {
  filename: string;
  status: FileStatus;
  lines: string[];
}

interface ParsedCommit {
  date: string;
  message: string;
  diffs: FileDiff[];
}

function classifyDiffHeader(line: string): FileStatus | null {
  if (line.startsWith("new file")) return "added";
  if (line.startsWith("deleted file")) return "deleted";
  if (line.startsWith("rename from")) return "renamed";
  return null;
}

function parseCommitDiff(raw: string): ParsedCommit | null {
  const lines = raw.split("\n");
  if (lines.length === 0) return null;

  // First line is our formatted header: "date | message"
  const headerMatch = lines[0].match(/^(.+?) \| (.+)$/);
  if (!headerMatch) return null;

  const [, date, message] = headerMatch;
  const diffs: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let diffLineCount = 0;
  let truncated = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // New file diff starts with "diff --git"
    if (line.startsWith("diff --git")) {
      if (currentFile) diffs.push(currentFile);
      const fileMatch = line.match(/diff --git a\/.+ b\/(.+)$/);
      currentFile = {
        filename: fileMatch ? fileMatch[1] : "unknown",
        status: "modified",
        lines: [],
      };
      diffLineCount = 0;
      truncated = false;
      continue;
    }

    if (!currentFile) continue;

    // Detect file status from diff metadata lines
    const statusFromHeader = classifyDiffHeader(line);
    if (statusFromHeader) {
      currentFile.status = statusFromHeader;
      continue;
    }

    // Skip diff metadata (index, ---, +++ lines)
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    // Hunk header — include as context marker
    if (line.startsWith("@@")) {
      if (diffLineCount > 0 && currentFile.lines.length > 0) {
        currentFile.lines.push("  ...");
      }
      continue;
    }

    // Actual diff content: +, -, or context (space)
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      if (diffLineCount < MAX_DIFF_LINES_PER_FILE) {
        currentFile.lines.push(`  ${line}`);
        diffLineCount++;
      } else if (!truncated) {
        currentFile.lines.push(`  (... diff truncated after ${MAX_DIFF_LINES_PER_FILE} lines)`);
        truncated = true;
      }
    }
  }

  if (currentFile) diffs.push(currentFile);

  return { date, message, diffs };
}

function formatCommit(commit: ParsedCommit, index: number): string {
  const header = `${index + 1}. ${commit.date}`;
  const msg = `   ${commit.message}`;
  const fileSections = commit.diffs.map((d) => {
    const fileHeader = `   [${d.status}] ${d.filename}`;
    if (d.lines.length === 0) return fileHeader;
    return `${fileHeader}\n${d.lines.join("\n")}`;
  });

  const body = fileSections.length > 0
    ? fileSections.join("\n")
    : "   (no file changes)";

  return `${header}\n${msg}\n${body}`;
}

export function registerHistoryOperations(server: McpServer, config: Config): void {
  server.registerTool(
    "get_recent_changes",
    {
      description:
        "Show recent changes made to the vault with full diffs. Returns a list of recent commits showing what content was added, modified, or deleted in each file. Use this to understand what changed recently.",
      inputSchema: {
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_CHANGES)
          .default(10)
          .describe("Number of recent changes to retrieve (1–20)"),
      },
    },
    async ({ count }) => {
      try {
        const { stdout } = await git(
          [
            "log",
            `--format=${COMMIT_SEPARATOR}%ai | %s`,
            "-p",
            "--no-color",
            "-n",
            String(count),
          ],
          config.vaultPath,
        );

        if (!stdout.trim()) {
          return toolSuccess("No changes found in vault history.");
        }

        // Remove timezone offset for cleaner dates
        const cleaned = stdout.replace(
          /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) [+-]\d{4}/g,
          "$1",
        );

        const sections = cleaned.split(COMMIT_SEPARATOR).filter((s) => s.trim());
        const commits = sections
          .map(parseCommitDiff)
          .filter((c): c is ParsedCommit => c !== null);

        if (commits.length === 0) {
          return toolSuccess("No changes found in vault history.");
        }

        const output = commits.map((c, i) => formatCommit(c, i)).join("\n\n");
        return toolSuccess(output);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("get_recent_changes failed", { error: msg });
        return toolError(`Failed to get recent changes: ${msg}`);
      }
    },
  );
}
