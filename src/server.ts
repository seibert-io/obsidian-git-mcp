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

const INSTRUCTIONS =
  "IMPORTANT: At the start of every conversation, before performing any vault operations, " +
  "call the `get_obsidian_guide` tool with topic 'conventions' to load vault-specific instructions and conventions.\n\n" +
  "When working in a specific subdirectory of this vault, also use the `get_claude_context` tool " +
  "with that directory path to discover additional CLAUDE.md instructions that may apply to that area.\n\n" +
  "CHANGE PREVIEW REQUIREMENT: It is strongly recommended that you present all planned changes " +
  "to the user in a clear, readable format BEFORE calling any tool that modifies the vault " +
  "(write_file, edit_file, delete_file, rename_file, move_file, move_directory, create_directory). " +
  "The user must be able to understand what will change and have the opportunity to review it.\n\n" +
  "For write_file and edit_file: Output the resulting content directly in the chat as rendered, formatted text — " +
  "NOT as raw Markdown source inside a code block. Users read rendered prose far more easily than Markdown syntax. " +
  "For small files, show the complete content. For large files, show a relevant excerpt that includes the changes. " +
  "The preview must clearly indicate which file is being created or modified.\n\n" +
  "For delete_file: State the full path of the file that will be deleted and briefly describe its content or purpose.\n\n" +
  "For rename_file, move_file, and move_directory: Show both the current path and the new path side by side.\n\n" +
  "For create_directory: State the full directory path that will be created.\n\n" +
  "This is NOT optional boilerplate — skipping the preview degrades the user experience significantly. " +
  "The server cannot enforce this, but clients that omit previews are not meeting the expected standard of transparency.";

export async function createMcpServer(config: Config): Promise<McpServer> {
  const server = new McpServer(
    { name: "obsidian-vault-mcp", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
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
