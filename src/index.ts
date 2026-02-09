import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { initializeVault, startPeriodicSync, stopPeriodicSync } from "./git/gitSync.js";
import { initDebouncedSync, flushDebouncedSync } from "./git/debouncedSync.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./transport.js";
import { getErrorMessage } from "./utils/toolResponse.js";

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

  // Start periodic git sync and debounced write sync
  startPeriodicSync(config);
  initDebouncedSync(config);

  // Start HTTP transport (factory creates a fresh McpServer per session)
  const httpServer = await startHttpServer(async () => createMcpServer(config), config);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    stopPeriodicSync();
    await flushDebouncedSync();
    await httpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  logger.error("Fatal error", { error: getErrorMessage(error) });
  process.exit(1);
});
