import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath } from "../utils/pathValidation.js";
import { getLastSyncTimestamp } from "../git/gitSync.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";
import { logger } from "../utils/logger.js";

async function countFiles(
  dirPath: string,
): Promise<{ total: number; markdown: number; folders: number }> {
  let total = 0;
  let markdown = 0;
  let folders = 0;

  const items = await readdir(dirPath, { withFileTypes: true });
  for (const item of items) {
    if (item.name === ".git") continue;

    if (item.isDirectory()) {
      folders++;
      const sub = await countFiles(path.join(dirPath, item.name));
      total += sub.total;
      markdown += sub.markdown;
      folders += sub.folders;
    } else {
      total++;
      if (item.name.endsWith(".md")) {
        markdown++;
      }
    }
  }

  return { total, markdown, folders };
}

async function getTopLevelFolders(dirPath: string): Promise<string[]> {
  const items = await readdir(dirPath, { withFileTypes: true });
  return items
    .filter((item) => item.isDirectory() && item.name !== ".git")
    .map((item) => item.name);
}

export function registerVaultOperations(server: McpServer, config: Config): void {
  // get_vault_info
  server.registerTool(
    "get_vault_info",
    {
      description: "Return vault statistics: total files, markdown files, folder structure, last sync time",
    },
    async () => {
      try {
        const counts = await countFiles(config.vaultPath);
        const topFolders = await getTopLevelFolders(config.vaultPath);
        const lastSync = getLastSyncTimestamp();

        const info = [
          `Total files: ${counts.total}`,
          `Markdown files: ${counts.markdown}`,
          `Total folders: ${counts.folders}`,
          `Top-level folders: ${topFolders.join(", ") || "(none)"}`,
          `Last sync: ${lastSync ? lastSync.toISOString() : "never"}`,
        ].join("\n");

        return toolSuccess(info);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("get_vault_info failed", { error: msg });
        return toolError(`Failed to get vault info: ${msg}`);
      }
    },
  );

  // get_backlinks
  server.registerTool(
    "get_backlinks",
    {
      description: "Find all notes that link to a given note using [[filename]] or [[filename|alias]] patterns",
      inputSchema: {
        path: z.string().describe("Path of the target note, relative to vault root"),
      },
    },
    async ({ path: notePath }) => {
      try {
        // Validate the path
        resolveVaultPath(config.vaultPath, notePath);

        // Get the filename without extension for wikilink matching
        const basename = path.basename(notePath, path.extname(notePath));

        // Build regex to match [[basename]] and [[basename|alias]]
        const escapedName = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\[\\[${escapedName}(\\|[^\\]]*)?\\]\\]`, "g");

        // Find all markdown files
        const files = await fg("**/*.md", {
          cwd: config.vaultPath,
          dot: false,
          ignore: [".git/**"],
          followSymbolicLinks: false,
        });

        const backlinks: string[] = [];

        for (const file of files) {
          // Skip the target file itself
          if (file === notePath) continue;

          const filePath = path.join(config.vaultPath, file);
          try {
            const content = await readFile(filePath, "utf-8");
            const matches = content.match(regex);
            if (matches) {
              backlinks.push(`${file} (${matches.length} link${matches.length > 1 ? "s" : ""})`);
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (backlinks.length === 0) {
          return toolSuccess(`No backlinks found for "${basename}"`);
        }

        return toolSuccess(
          `Backlinks to "${basename}" (${backlinks.length} files):\n${backlinks.join("\n")}`,
        );
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("get_backlinks failed", { path: notePath, error: msg });
        return toolError(`Failed to get backlinks: ${msg}`);
      }
    },
  );

  // get_tags
  server.registerTool(
    "get_tags",
    {
      description: "Extract all tags from the vault or a specific file. Parses #tag syntax and YAML frontmatter tags.",
      inputSchema: {
        path: z.string().optional().describe("Specific file path (relative to vault root). If omitted, scans entire vault."),
      },
    },
    async ({ path: filePath }) => {
      try {
        const tagCounts = new Map<string, number>();

        if (filePath) {
          const resolved = resolveVaultPath(config.vaultPath, filePath);
          const content = await readFile(resolved, "utf-8");
          extractTags(content, tagCounts);
        } else {
          // Scan all markdown files
          const files = await fg("**/*.md", {
            cwd: config.vaultPath,
            dot: false,
            ignore: [".git/**"],
            followSymbolicLinks: false,
          });

          for (const file of files) {
            try {
              const content = await readFile(
                path.join(config.vaultPath, file),
                "utf-8",
              );
              extractTags(content, tagCounts);
            } catch {
              // Skip unreadable files
            }
          }
        }

        if (tagCounts.size === 0) {
          return toolSuccess("No tags found");
        }

        // Sort by count descending
        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
        const output = sorted.map(([tag, count]) => `${tag} (${count})`).join("\n");
        return toolSuccess(`Tags found (${tagCounts.size} unique):\n${output}`);
      } catch (error) {
        const msg = getErrorMessage(error);
        logger.error("get_tags failed", { path: filePath, error: msg });
        return toolError(`Failed to get tags: ${msg}`);
      }
    },
  );
}

function extractTags(content: string, tagCounts: Map<string, number>): void {
  // Extract inline #tags (but not inside code blocks or URLs)
  const inlineTagRegex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = inlineTagRegex.exec(content)) !== null) {
    const tag = `#${match[1]}`;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  // Extract YAML frontmatter tags
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    // Match "tags:" followed by a list or inline values
    const tagsLineMatch = frontmatter.match(/^tags:\s*(.*)$/m);
    if (tagsLineMatch) {
      const inlineValue = tagsLineMatch[1].trim();
      if (inlineValue.startsWith("[")) {
        // Inline array: tags: [tag1, tag2]
        const inner = inlineValue.slice(1, -1);
        for (const t of inner.split(",")) {
          const tag = `#${t.trim()}`;
          if (tag.length > 1) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      } else if (inlineValue) {
        // Single inline value: tags: tag1
        const tag = `#${inlineValue}`;
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      } else {
        // YAML list format:
        // tags:
        //   - tag1
        //   - tag2
        const listRegex = /^\s+-\s+(.+)$/gm;
        // Re-extract the section after "tags:"
        const tagsIdx = frontmatter.indexOf("tags:");
        const afterTags = frontmatter.slice(tagsIdx + 5);
        let listMatch: RegExpExecArray | null;
        while ((listMatch = listRegex.exec(afterTags)) !== null) {
          const tag = `#${listMatch[1].trim()}`;
          if (tag.length > 1) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }
      }
    }
  }
}
