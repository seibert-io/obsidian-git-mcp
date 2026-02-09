import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { loadGuide, loadNoteTemplate, loadAllGuides } from "../guides/guideLoader.js";
import { loadRootClaudeMd } from "../guides/claudeMdLoader.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";

export function registerGuideOperations(server: McpServer, config: Config): void {
  server.registerTool(
    "get_obsidian_guide",
    {
      description:
        "IMPORTANT: Call this tool once at the start of every conversation — before using any other tools from this server — with topic 'conventions' to load vault-specific instructions and conventions. " +
        "Also returns best-practice guides for link syntax, frontmatter, note templates, and search strategies.",
      inputSchema: {
        topic: z.enum(["conventions", "create-note", "search-strategy", "all"])
          .describe("Which guide to retrieve. Use 'conventions' at session start. Use 'all' to get everything at once."),
        note_type: z.enum(["daily", "meeting", "project", "zettel", "literature"])
          .optional()
          .describe("Only for topic 'create-note': which template to return."),
      },
    },
    async ({ topic, note_type }) => {
      try {
        let content: string;

        switch (topic) {
          case "conventions":
          case "search-strategy":
            content = await loadGuide(config.promptsDir, topic);
            break;
          case "create-note":
            content = await loadNoteTemplate(config.promptsDir, note_type ?? "zettel", "");
            break;
          case "all":
            content = await loadAllGuides(config.promptsDir);
            break;
        }

        // Prepend root CLAUDE.md when delivering conventions or all guides
        if (topic === "conventions" || topic === "all") {
          const rootClaudeMd = await loadRootClaudeMd(config.vaultPath);
          if (rootClaudeMd) {
            content = `--- Vault Instructions (CLAUDE.md) ---\n${rootClaudeMd}\n\n---\n\n${content}`;
          }
        }

        return toolSuccess(content);
      } catch (error) {
        const msg = getErrorMessage(error);
        return toolError(`Error loading guide: ${msg}`);
      }
    },
  );
}
