import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadGuide, loadNoteTemplate, loadAllGuides } from "../guides/guideLoader.js";

export function registerGuideOperations(server: McpServer): void {
  server.tool(
    "get_obsidian_guide",
    "Returns best-practice guides for working with this Obsidian vault. Call this before creating or searching notes if you are unsure about vault conventions, link syntax, frontmatter format, or which search tool to use.",
    {
      topic: z.enum(["conventions", "create-note", "search-strategy", "all"])
        .describe("Which guide to retrieve. Use 'all' to get everything at once."),
      note_type: z.enum(["daily", "meeting", "project", "zettel", "literature"])
        .optional()
        .describe("Only for topic 'create-note': which template to return."),
    },
    async ({ topic, note_type }) => {
      try {
        let content: string;

        switch (topic) {
          case "conventions":
          case "search-strategy":
            content = await loadGuide(topic);
            break;
          case "create-note":
            content = await loadNoteTemplate(note_type ?? "zettel", note_type ? "" : "");
            break;
          case "all":
            content = await loadAllGuides();
            break;
        }

        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error loading guide: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
