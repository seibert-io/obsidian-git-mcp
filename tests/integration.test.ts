import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerFileOperations } from "../src/tools/fileOperations.js";
import { registerDirectoryOps } from "../src/tools/directoryOps.js";
import { registerSearchOperations } from "../src/tools/searchOperations.js";
import { registerVaultOperations } from "../src/tools/vaultOperations.js";
import type { Config } from "../src/config.js";

const TEST_VAULT = "/tmp/test-vault-integration";

// Create a config that skips git operations by pointing to a non-git dir
const testConfig: Config = {
  gitRepoUrl: "https://example.com/repo.git",
  gitBranch: "main",
  gitSyncIntervalSeconds: 0,
  gitUserName: "Test",
  gitUserEmail: "test@example.com",
  vaultPath: TEST_VAULT,
  port: 0,
  logLevel: "error",
  jwtSecret: "test-jwt-secret-that-is-at-least-32-chars-long",
  serverUrl: "http://localhost:3000",
  accessTokenExpirySeconds: 3600,
  refreshTokenExpirySeconds: 604800,
  githubClientId: "test-github-client-id",
  githubClientSecret: "test-github-client-secret",
  allowedGithubUsers: ["testuser"],
};

describe("Integration: MCP Server over Streamable HTTP", () => {
  let httpServer: Server;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    // Prepare test vault
    await mkdir(TEST_VAULT, { recursive: true });
    await writeFile(path.join(TEST_VAULT, "hello.md"), "# Hello World\n\nThis is a test note.\n\n#test #example\n");
    await mkdir(path.join(TEST_VAULT, "subfolder"), { recursive: true });
    await writeFile(path.join(TEST_VAULT, "subfolder", "nested.md"), "Nested note with [[hello]] link.\n");

    // Initialize git repo so commitAndPush works in write tests
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init"], { cwd: TEST_VAULT });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: TEST_VAULT });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: TEST_VAULT });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: TEST_VAULT });
    await execFileAsync("git", ["add", "."], { cwd: TEST_VAULT });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: TEST_VAULT });

    // Create MCP server
    const mcpServer = new McpServer({
      name: "test-server",
      version: "1.0.0",
    });
    registerFileOperations(mcpServer, testConfig);
    registerDirectoryOps(mcpServer, testConfig);
    registerSearchOperations(mcpServer, testConfig);
    registerVaultOperations(mcpServer, testConfig);

    // Set up Express app with Streamable HTTP transport
    const app = express();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", express.json(), async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
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

    // Start server on random port
    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;

    // Create MCP client
    client = new Client({ name: "test-client", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    httpServer?.close();
    await rm(TEST_VAULT, { recursive: true, force: true });
  });

  it("lists available tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("delete_file");
    expect(toolNames).toContain("rename_file");
    expect(toolNames).toContain("list_directory");
    expect(toolNames).toContain("create_directory");
    expect(toolNames).toContain("search_files");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find_files");
    expect(toolNames).toContain("get_vault_info");
    expect(toolNames).toContain("get_backlinks");
    expect(toolNames).toContain("get_tags");
  });

  it("reads a file", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("# Hello World");
  });

  it("lists directory contents", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "." },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/");
  });

  it("searches files by pattern", async () => {
    const result = await client.callTool({
      name: "search_files",
      arguments: { pattern: "**/*.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/nested.md");
  });

  it("greps file contents", async () => {
    const result = await client.callTool({
      name: "grep",
      arguments: { query: "Hello World" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
  });

  it("gets backlinks", async () => {
    const result = await client.callTool({
      name: "get_backlinks",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("subfolder/nested.md");
  });

  it("gets tags", async () => {
    const result = await client.callTool({
      name: "get_tags",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("#test");
    expect(text).toContain("#example");
  });

  it("gets vault info", async () => {
    const result = await client.callTool({
      name: "get_vault_info",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Total files:");
    expect(text).toContain("Markdown files:");
  });

  it("returns error for path traversal attempt", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("traversal");
  });
});
