import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface McpTestServer {
  client: Client;
  httpServer: Server;
}

/**
 * Starts a minimal Express server with MCP transport and connects a client.
 * Useful for integration tests that need to test MCP tools end-to-end.
 */
export async function startMcpTestServer(mcpServer: McpServer): Promise<McpTestServer> {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => transports.set(sid, transport),
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Bad session" });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.close();
      transports.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  const httpServer = app.listen(0);
  const port = (httpServer.address() as AddressInfo).port;

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );
  await client.connect(clientTransport);

  return { client, httpServer };
}

/**
 * Initializes a git repository in the given directory with a minimal initial commit.
 */
export async function initTestGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}
