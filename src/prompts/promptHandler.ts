import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadGuide, loadNoteTemplate, loadAllGuides } from "../guides/guideLoader.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "obsidian-conventions",
    {
      description: "Vault-Konventionen, Link-Syntax, Frontmatter, Tags",
    },
    async () => {
      const content = await loadGuide("conventions");
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
      description: "Template für eine neue Notiz",
      argsSchema: {
        topic: z.string().describe("Thema der Notiz"),
        note_type: z.enum(["daily", "meeting", "project", "zettel", "literature"])
          .optional()
          .describe("Art der Notiz (default: zettel)"),
      },
    },
    async ({ topic, note_type }) => {
      const content = await loadNoteTemplate(note_type ?? "zettel", topic);
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
      description: "Welches Such-Tool wann nutzen",
    },
    async () => {
      const content = await loadGuide("search-strategy");
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
