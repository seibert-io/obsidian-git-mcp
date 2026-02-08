import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerFileOperations } from "./tools/fileOperations.js";
import { registerDirectoryOps } from "./tools/directoryOps.js";
import { registerSearchOperations } from "./tools/searchOperations.js";
import { registerVaultOperations } from "./tools/vaultOperations.js";
import { registerGuideOperations } from "./tools/guideOperations.js";
import { registerHistoryOperations } from "./tools/historyOperations.js";
import { registerPrompts } from "./prompts/promptHandler.js";

export function createMcpServer(config: Config): McpServer {
  const server = new McpServer({
    name: "obsidian-vault-mcp",
    version: "1.0.0",
  });

  registerFileOperations(server, config);
  registerDirectoryOps(server, config);
  registerSearchOperations(server, config);
  registerVaultOperations(server, config);
  registerGuideOperations(server);
  registerHistoryOperations(server, config);
  registerPrompts(server);

  return server;
}
