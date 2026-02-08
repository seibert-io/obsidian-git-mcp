import express from "express";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jwtAuth } from "./auth.js";
import { handleMetadata } from "./oauth/metadata.js";
import { handleRegistration } from "./oauth/registration.js";
import { handleAuthorizeGet, handleAuthorizePost } from "./oauth/authorize.js";
import { handleToken } from "./oauth/token.js";
import { oauthStore } from "./oauth/store.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./config.js";

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export async function startHttpServer(
  mcpServer: McpServer,
  config: Config,
): Promise<void> {
  const app = express();

  // --- OAuth 2.1 endpoints (no auth required) ---
  app.get("/.well-known/oauth-authorization-server", handleMetadata(config));
  app.post("/oauth/register", express.json(), handleRegistration());
  app.get("/oauth/authorize", handleAuthorizeGet(config));
  app.post("/oauth/authorize", express.urlencoded({ extended: false }), handleAuthorizePost(config));
  app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(config));

  // Auth middleware for all /mcp routes (OAuth 2.1 JWT only)
  app.use("/mcp", jwtAuth(config.jwtSecret));

  // Health check endpoint (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Track transports by session ID for stateful mode
  const sessions = new Map<string, SessionEntry>();

  // Periodically clean up idle sessions + expired OAuth entries
  setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        sessions.delete(sid);
        logger.info("Expired idle session", { sessionId: sid });
      }
    }
    oauthStore.cleanup();
  }, 60_000);

  // Handle POST requests to /mcp (main MCP endpoint)
  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // If we have an existing session, route to that transport
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      entry.lastActivity = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    // Enforce session limit
    if (sessions.size >= MAX_SESSIONS) {
      logger.warn("Session limit reached", { current: sessions.size, max: MAX_SESSIONS });
      res.status(503).json({ error: "Too many active sessions" });
      return;
    }

    // New session: create a new transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, lastActivity: Date.now() });
        logger.info("New MCP session initialized", {
          sessionId: newSessionId,
        });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        logger.info("MCP session closed", { sessionId: sid });
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET requests for SSE streams
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    const entry = sessions.get(sessionId)!;
    entry.lastActivity = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  // Handle DELETE requests for session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    const entry = sessions.get(sessionId)!;
    await entry.transport.close();
    sessions.delete(sessionId);
    res.status(200).json({ status: "session terminated" });
  });

  app.listen(config.port, () => {
    logger.info(`MCP server listening on port ${config.port}`);
  });
}
