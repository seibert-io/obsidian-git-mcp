import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { loadGuide, loadNoteTemplate } from "../guides/guideLoader.js";
import { loadRootClaudeMd } from "../guides/claudeMdLoader.js";

export function registerPrompts(server: McpServer, config: Config): void {
  server.registerPrompt(
    "obsidian-conventions",
    {
      description: "Vault conventions, link syntax, frontmatter, tags — includes root CLAUDE.md vault instructions if present",
    },
    async () => {
      let content = await loadGuide(config.promptsDir, "conventions");
      const rootClaudeMd = await loadRootClaudeMd(config.vaultPath);
      if (rootClaudeMd) {
        content = `--- Vault Instructions (CLAUDE.md) ---\n${rootClaudeMd}\n\n---\n\n${content}`;
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: content },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "obsidian-create-note",
    {
      description: "Template for a new note",
      argsSchema: {
        topic: z.string().describe("Topic of the note"),
        note_type: z.enum(["daily", "meeting", "project", "zettel", "literature"])
          .optional()
          .describe("Type of note (default: zettel)"),
      },
    },
    async ({ topic, note_type }) => {
      const content = await loadNoteTemplate(config.promptsDir, note_type ?? "zettel", topic);
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: content },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "obsidian-search-strategy",
    {
      description: "Which search tool to use when",
    },
    async () => {
      const content = await loadGuide(config.promptsDir, "search-strategy");
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: content },
          },
        ],
      };
    },
  );
}
