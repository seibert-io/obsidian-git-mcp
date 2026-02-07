import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { initializeVault, startPeriodicSync, stopPeriodicSync } from "./git/gitSync.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./transport.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info("Starting Obsidian Vault MCP Server", {
    port: config.port,
    vaultPath: config.vaultPath,
    gitBranch: config.gitBranch,
    syncInterval: config.gitSyncIntervalSeconds,
  });

  // Initialize vault (clone or pull)
  await initializeVault(config);

  // Start periodic git sync
  startPeriodicSync(config);

  // Create MCP server with all tools
  const mcpServer = createMcpServer(config);

  // Start HTTP transport
  await startHttpServer(mcpServer, config);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    stopPeriodicSync();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
