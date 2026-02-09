import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerFileOperations } from "../src/tools/fileOperations.js";
import { registerDirectoryOps } from "../src/tools/directoryOps.js";
import { registerSearchOperations } from "../src/tools/searchOperations.js";
import { registerVaultOperations } from "../src/tools/vaultOperations.js";
import { handleProtectedResource } from "../src/oauth/protectedResource.js";
import { handleMetadata } from "../src/oauth/metadata.js";
import { handleRegistration } from "../src/oauth/registration.js";
import { handleAuthorizeGet } from "../src/oauth/authorize.js";
import { handleGitHubCallback } from "../src/oauth/githubCallback.js";
import { handleToken } from "../src/oauth/token.js";
import { jwtAuth } from "../src/auth.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAuthSessionStore } from "../src/oauth/sessionStore.js";
import { RateLimiter } from "../src/utils/rateLimiter.js";
import { createTestConfig } from "./helpers/testConfig.js";
import { installGitHubMock, uninstallGitHubMock, resetGitHubMock } from "./helpers/mockGitHub.js";
import { startAuthorizeFlow, completeCallback, completeOAuthFlow, completePublicClientOAuthFlow } from "./helpers/oauthHelpers.js";

const execFileAsync = promisify(execFile);
const TEST_VAULT = "/tmp/test-vault-oauth-flow";

const testConfig = createTestConfig({ vaultPath: TEST_VAULT });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthenticatedMcpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function createAuthenticatedMcpClient(baseUrl: string, accessToken: string): AuthenticatedMcpClient {
  const client = new Client({ name: "oauth-flow-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  return { client, transport };
}

async function connectAuthenticatedClient(baseUrl: string, accessToken: string): Promise<Client> {
  const { client, transport } = createAuthenticatedMcpClient(baseUrl, accessToken);
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("OAuth Full-Flow Integration: OAuth → MCP Transport", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    installGitHubMock();

    // --- Vault setup ---
    await rm(TEST_VAULT, { recursive: true, force: true });
    await mkdir(TEST_VAULT, { recursive: true });

    // Resolve symlinks (macOS /tmp → /private/tmp) so path validation passes
    const resolvedVault = await realpath(TEST_VAULT);
    testConfig.vaultPath = resolvedVault;

    await writeFile(path.join(resolvedVault, "hello.md"), "# Hello World\n\nThis is a test note.\n");
    await mkdir(path.join(resolvedVault, "subfolder"), { recursive: true });
    await writeFile(path.join(resolvedVault, "subfolder", "nested.md"), "Nested note content.\n");

    await execFileAsync("git", ["init"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: resolvedVault });
    await execFileAsync("git", ["add", "."], { cwd: resolvedVault });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: resolvedVault });

    // Factory: each MCP session needs its own McpServer instance (SDK limitation)
    const createMcpServer = (): McpServer => {
      const server = new McpServer({ name: "oauth-flow-test", version: "1.0.0" });
      registerFileOperations(server, testConfig);
      registerDirectoryOps(server, testConfig);
      registerSearchOperations(server, testConfig);
      registerVaultOperations(server, testConfig);
      return server;
    };

    // --- Express app with full OAuth + MCP transport ---
    const app = express();

    const oauthStore = new OAuthStore();
    const oauthSessionStore = new OAuthSessionStore();
    const registrationRateLimiter = new RateLimiter(50, 60_000);
    const tokenRateLimiter = new RateLimiter(50, 60_000);

    // Discovery endpoints
    app.get("/.well-known/oauth-protected-resource", handleProtectedResource(testConfig));
    app.get("/.well-known/oauth-authorization-server", handleMetadata(testConfig));

    // OAuth endpoints
    app.post("/oauth/register", express.json(), handleRegistration(oauthStore, registrationRateLimiter));
    app.get("/oauth/authorize", handleAuthorizeGet(testConfig, oauthStore, oauthSessionStore));
    app.get("/oauth/github/callback", handleGitHubCallback(testConfig, oauthSessionStore, oauthStore));
    app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(testConfig, oauthStore, tokenRateLimiter));

    // JWT auth on /mcp
    app.use("/mcp", jwtAuth(testConfig.jwtSecret, testConfig.serverUrl));

    // MCP transport (mirrors src/transport.ts)
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", express.json(), async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Bad session" });
        return;
      }
      await sessions.get(sessionId)!.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.close();
        sessions.delete(sessionId);
      }
      res.status(200).json({ ok: true });
    });

    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    testConfig.serverUrl = baseUrl;
  });

  beforeEach(() => {
    resetGitHubMock();
  });

  afterAll(async () => {
    httpServer?.close();
    await rm(TEST_VAULT, { recursive: true, force: true });
    uninstallGitHubMock();
  });

  // --- Test 1: Full flow → listTools ---
  it("full flow: OAuth → MCP listTools returns registered tools", async () => {
    const { accessToken } = await completeOAuthFlow(baseUrl);
    const client = await connectAuthenticatedClient(baseUrl, accessToken);

    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("list_directory");
    expect(toolNames).toContain("search_files");
    expect(toolNames).toContain("get_vault_info");

    await client.close();
  });

  // --- Test 2: Full flow → read_file ---
  it("full flow: OAuth → MCP read_file returns file content", async () => {
    const { accessToken } = await completeOAuthFlow(baseUrl);
    const client = await connectAuthenticatedClient(baseUrl, accessToken);

    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Hello World");

    await client.close();
  });

  // --- Test 3: Refresh token → new access token → MCP works ---
  it("refresh token grants new access token that works with MCP", async () => {
    const { refreshToken, clientId, clientSecret } = await completeOAuthFlow(baseUrl);

    // Exchange refresh token for new access token
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(refreshToken);

    // Use refreshed token for MCP
    const client = await connectAuthenticatedClient(baseUrl, newTokens.access_token);
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);

    await client.close();
  });

  // --- Test 4: Token response structure (RFC 6749) ---
  it("token response has correct RFC 6749 structure and JWT claims", async () => {
    const { tokenResponse, accessToken } = await completeOAuthFlow(baseUrl);

    // RFC 6749 fields
    expect(typeof tokenResponse.access_token).toBe("string");
    expect((tokenResponse.access_token as string).length).toBeGreaterThan(0);
    expect(tokenResponse.token_type).toBe("Bearer");
    expect(typeof tokenResponse.expires_in).toBe("number");
    expect(tokenResponse.expires_in as number).toBeGreaterThan(0);
    expect(typeof tokenResponse.refresh_token).toBe("string");
    expect((tokenResponse.refresh_token as string).length).toBeGreaterThan(0);

    // JWT structure: 3 dot-separated parts
    const jwtParts = accessToken.split(".");
    expect(jwtParts).toHaveLength(3);

    // Decode payload and verify claims
    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
    expect(payload).toHaveProperty("sub");
    expect(payload).toHaveProperty("client_id");
    expect(payload).toHaveProperty("aud");
    expect(payload).toHaveProperty("iss");
    expect(payload).toHaveProperty("iat");
    expect(payload).toHaveProperty("exp");
    expect(payload.iss).toBe("obsidian-vault-mcp");
  });

  // --- Test 5: Invalid token → MCP connection fails ---
  it("invalid token causes MCP connection to fail", async () => {
    const { client, transport } = createAuthenticatedMcpClient(baseUrl, "invalid-token");

    await expect(client.connect(transport)).rejects.toThrow();
  });

  // --- Test 6: No token → MCP connection fails ---
  it("missing authorization header causes MCP connection to fail", async () => {
    const client = new Client({ name: "no-auth-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

    await expect(client.connect(transport)).rejects.toThrow();
  });

  // --- Test 7: Token exchange with JSON Content-Type (Claude.ai edge case) ---
  it("token endpoint rejects JSON content-type (documents Claude.ai edge case)", async () => {
    // Complete OAuth flow up to auth code
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "JSON Token Test Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const { client_id: clientId, client_secret: clientSecret } = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    // Send token request as JSON instead of form-urlencoded
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    // express.urlencoded() does NOT parse JSON bodies → req.body is undefined
    // The handler crashes trying to destructure undefined, resulting in a 500.
    // This confirms: if Claude.ai sends JSON to the token endpoint, it will fail.
    expect(tokenRes.status).toBeGreaterThanOrEqual(400);
    expect(tokenRes.ok).toBe(false);
  });

  // --- Test 8: Multiple concurrent MCP sessions ---
  it("supports multiple concurrent MCP sessions with different tokens", async () => {
    const flow1 = await completeOAuthFlow(baseUrl);
    const flow2 = await completeOAuthFlow(baseUrl);

    const client1 = await connectAuthenticatedClient(baseUrl, flow1.accessToken);
    const client2 = await connectAuthenticatedClient(baseUrl, flow2.accessToken);

    // Both clients can independently use tools
    const [result1, result2] = await Promise.all([
      client1.callTool({ name: "read_file", arguments: { path: "hello.md" } }),
      client2.callTool({ name: "read_file", arguments: { path: "subfolder/nested.md" } }),
    ]);

    const text1 = (result1.content as Array<{ type: string; text: string }>)[0].text;
    const text2 = (result2.content as Array<{ type: string; text: string }>)[0].text;
    expect(text1).toContain("Hello World");
    expect(text2).toContain("Nested note content");

    await client1.close();
    await client2.close();
  });

  // --- Test 9: Token immediately usable ---
  it("token is usable immediately after issuance (no timing delay)", async () => {
    const { accessToken } = await completeOAuthFlow(baseUrl);

    // Immediately create client and call tool — no delay
    const client = await connectAuthenticatedClient(baseUrl, accessToken);
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.md" },
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Hello World");

    await client.close();
  });

  // --- Test 10: Discovery endpoints ---
  it("discovery endpoints return correct metadata", async () => {
    // Protected Resource Metadata (RFC 9728)
    const prmRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(prmRes.status).toBe(200);
    const prm = await prmRes.json();
    expect(prm.resource).toBe(baseUrl);
    expect(prm.authorization_servers).toEqual([baseUrl]);

    // Authorization Server Metadata (RFC 8414)
    const asmRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(asmRes.status).toBe(200);
    const asm = await asmRes.json();
    expect(asm.issuer).toBe(baseUrl);
    expect(asm.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
    expect(asm.token_endpoint).toBe(`${baseUrl}/oauth/token`);
    expect(asm.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
    expect(asm.response_types_supported).toContain("code");
    expect(asm.grant_types_supported).toContain("authorization_code");
    expect(asm.grant_types_supported).toContain("refresh_token");
    expect(asm.code_challenge_methods_supported).toContain("S256");
    expect(asm.token_endpoint_auth_methods_supported).toContain("client_secret_post");
    expect(asm.token_endpoint_auth_methods_supported).toContain("none");
  });

  // --- Test 11: Public Client full flow → MCP listTools ---
  it("public client full flow: OAuth (no secret) → MCP listTools", async () => {
    const { accessToken } = await completePublicClientOAuthFlow(baseUrl);
    const client = await connectAuthenticatedClient(baseUrl, accessToken);

    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("list_directory");

    await client.close();
  });

  // --- Test 12: Public Client refresh token → new access token → MCP works ---
  it("public client refresh token grants new access token that works with MCP", async () => {
    const { refreshToken, clientId } = await completePublicClientOAuthFlow(baseUrl);

    // Exchange refresh token for new access token (no client_secret)
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(refreshToken);

    // Use refreshed token for MCP
    const client = await connectAuthenticatedClient(baseUrl, newTokens.access_token);
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);

    await client.close();
  });
});
