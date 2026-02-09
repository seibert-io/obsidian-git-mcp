import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerFileOperations } from "./tools/fileOperations.js";
import { registerDirectoryOps } from "./tools/directoryOps.js";
import { registerSearchOperations } from "./tools/searchOperations.js";
import { registerVaultOperations } from "./tools/vaultOperations.js";
import { registerGuideOperations } from "./tools/guideOperations.js";
import { registerHistoryOperations } from "./tools/historyOperations.js";
import { registerClaudeContextOperations } from "./tools/claudeContextOperations.js";
import { registerPrompts } from "./prompts/promptHandler.js";
import { loadRootClaudeMd } from "./guides/claudeMdLoader.js";

const CLAUDE_CONTEXT_HINT =
  "The content of the root CLAUDE.md file (if it exists in the vault) has already been provided to you above as part of these server instructions — do NOT read it again via tools.\n\n" +
  "When working in a specific subdirectory of this vault, use the `get_claude_context` tool " +
  "with that directory path to discover additional CLAUDE.md instructions that may apply to that area.";

export async function createMcpServer(config: Config): Promise<McpServer> {
  const rootClaudeMd = await loadRootClaudeMd(config.vaultPath);
  const instructions = rootClaudeMd
    ? `${rootClaudeMd}\n\n---\n${CLAUDE_CONTEXT_HINT}`
    : CLAUDE_CONTEXT_HINT;

  const server = new McpServer(
    { name: "obsidian-vault-mcp", version: "1.0.0" },
    { instructions },
  );

  registerFileOperations(server, config);
  registerDirectoryOps(server, config);
  registerSearchOperations(server, config);
  registerVaultOperations(server, config);
  registerGuideOperations(server, config);
  registerHistoryOperations(server, config);
  registerClaudeContextOperations(server, config);
  registerPrompts(server, config);

  return server;
}
