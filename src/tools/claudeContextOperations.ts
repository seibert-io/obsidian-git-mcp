import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { collectClaudeMdFiles } from "../guides/claudeMdLoader.js";
import { toolError, toolSuccess, getErrorMessage } from "../utils/toolResponse.js";

export function registerClaudeContextOperations(server: McpServer, config: Config): void {
  server.registerTool(
    "get_claude_context",
    {
      description:
        "Returns CLAUDE.md instruction files found along the path from vault root to the specified directory. " +
        "Use this tool before working in a specific vault subdirectory or a file in any subdirectory to get directory-specific instructions and conventions. " +
        "The root CLAUDE.md (already provided via server instructions) is excluded.",
      inputSchema: {
        path: z.string().describe("Vault-relative directory path to get context for (e.g. 'projects/webapp')"),
      },
    },
    async ({ path: targetPath }) => {
      try {
        const entries = await collectClaudeMdFiles(config.vaultPath, targetPath);

        if (entries.length === 0) {
          return toolSuccess("No CLAUDE.md files found along this path.");
        }

        const output = entries
          .map((entry) => `--- CLAUDE.md in ${entry.path}/ ---\n${entry.content}`)
          .join("\n\n");

        return toolSuccess(output);
      } catch (error) {
        return toolError(getErrorMessage(error));
      }
    },
  );
}
