import express from "express";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jwtAuth } from "./auth.js";
import { handleProtectedResource } from "./oauth/protectedResource.js";
import { handleMetadata } from "./oauth/metadata.js";
import { handleRegistration } from "./oauth/registration.js";
import { handleAuthorizeGet } from "./oauth/authorize.js";
import { handleGitHubCallback } from "./oauth/githubCallback.js";
import { handleToken } from "./oauth/token.js";
import { OAuthStore } from "./oauth/store.js";
import { OAuthSessionStore } from "./oauth/sessionStore.js";
import { RateLimiter } from "./utils/rateLimiter.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./config.js";

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

export interface HttpServerHandle {
  close: () => Promise<void>;
}

export async function startHttpServer(
  createMcpServer: () => McpServer,
  config: Config,
): Promise<HttpServerHandle> {
  const app = express();

  // Trust the first reverse proxy (Caddy) for correct req.ip in rate limiting.
  // Disable via TRUST_PROXY=false when exposing port directly without a proxy.
  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }

  // CORS — allow any origin so all MCP clients (web, CLI, Inspector) can connect.
  // Auth is enforced via OAuth 2.1 Bearer tokens, not cookies.
  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
  app.use((_req, res, next) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value);
    }
    next();
  });
  app.options("/{*path}", (_req, res) => {
    res.status(204).end();
  });

  // Create OAuth stores and rate limiters (injected into handlers)
  const oauthStore = new OAuthStore();
  const oauthSessionStore = new OAuthSessionStore();
  const registrationRateLimiter = new RateLimiter(10, 60_000);
  const tokenRateLimiter = new RateLimiter(20, 60_000);

  // --- Discovery endpoints (no auth required) ---
  app.get("/.well-known/oauth-protected-resource", handleProtectedResource(config));
  app.get("/.well-known/oauth-authorization-server", handleMetadata(config));

  // --- OAuth 2.1 endpoints (no auth required) ---
  app.post("/oauth/register", express.json(), handleRegistration(oauthStore, registrationRateLimiter));
  app.get("/oauth/authorize", handleAuthorizeGet(config, oauthStore, oauthSessionStore));
  app.get("/oauth/github/callback", handleGitHubCallback(config, oauthSessionStore, oauthStore));
  app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(config, oauthStore, tokenRateLimiter));

  // Auth middleware for all /mcp routes (OAuth 2.1 JWT only)
  app.use("/mcp", jwtAuth(config.jwtSecret, config.serverUrl));

  // Health check endpoint (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Track transports by session ID for stateful mode
  const sessions = new Map<string, SessionEntry>();

  // Periodically clean up idle sessions + expired OAuth entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        entry.transport.close().catch(() => {});
        entry.server.close().catch(() => {});
        sessions.delete(sid);
        logger.info("Expired idle session", { sessionId: sid });
      }
    }
    oauthStore.cleanup();
    oauthSessionStore.cleanup();
    registrationRateLimiter.cleanup();
    tokenRateLimiter.cleanup();
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

    // New session: create a new transport and a dedicated McpServer
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server: mcpServer, lastActivity: Date.now() });
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
      mcpServer.close().catch(() => {});
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

  const server = app.listen(config.port, () => {
    logger.info(`MCP server listening on port ${config.port}`);
  });

  return {
    close: async () => {
      clearInterval(cleanupInterval);
      // Close all active sessions before shutting down the HTTP server
      const closePromises = [...sessions.values()].map(async (entry) => {
        await entry.transport.close().catch(() => {});
        await entry.server.close().catch(() => {});
      });
      await Promise.all(closePromises);
      sessions.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
