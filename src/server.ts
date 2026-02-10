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
  "PREVIEW BEFORE WRITING: You SHOULD present planned changes to the user for review before calling any tool that modifies the vault " +
  "(write_file, edit_file, delete_file, rename_file, move_file, move_directory, create_directory). For file creation or edits, show the resulting content — " +
  "for small files the complete content, for large files a relevant excerpt. " +
  "For deletions, renames, and moves, clearly state which files are affected. " +
  "This is a recommendation to improve user transparency — the server does not enforce it.";

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
