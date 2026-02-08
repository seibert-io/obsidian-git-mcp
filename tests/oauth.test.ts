import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleMetadata } from "../src/oauth/metadata.js";
import { handleRegistration } from "../src/oauth/registration.js";
import { handleAuthorizeGet } from "../src/oauth/authorize.js";
import { handleGitHubCallback } from "../src/oauth/githubCallback.js";
import { handleToken } from "../src/oauth/token.js";
import { jwtAuth } from "../src/auth.js";
import { createAccessToken } from "../src/oauth/jwt.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAuthSessionStore } from "../src/oauth/sessionStore.js";
import { RateLimiter } from "../src/utils/rateLimiter.js";
import { isAllowedUser } from "../src/oauth/allowlist.js";
import type { Config } from "../src/config.js";

// --- Mock GitHub HTTP calls ---
let mockGitHubTokenResponse: object = {};
let mockGitHubUserResponse: object = {};
let mockGitHubTokenStatus = 200;
let mockGitHubUserStatus = 200;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  if (url === "https://github.com/login/oauth/access_token") {
    return new Response(JSON.stringify(mockGitHubTokenResponse), {
      status: mockGitHubTokenStatus,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "https://api.github.com/user") {
    return new Response(JSON.stringify(mockGitHubUserResponse), {
      status: mockGitHubUserStatus,
      headers: { "Content-Type": "application/json" },
    });
  }

  return originalFetch(input, init);
};

const testConfig: Config = {
  gitRepoUrl: "https://example.com/repo.git",
  gitBranch: "main",
  gitSyncIntervalSeconds: 0,
  gitUserName: "Test",
  gitUserEmail: "test@example.com",
  vaultPath: "/tmp/test-vault-oauth",
  port: 0,
  logLevel: "error",
  jwtSecret: "test-jwt-secret-that-is-at-least-32-chars-long",
  serverUrl: "",
  accessTokenExpirySeconds: 3600,
  refreshTokenExpirySeconds: 604800,
  githubClientId: "test-github-client-id",
  githubClientSecret: "test-github-client-secret",
  allowedGithubUsers: ["alloweduser", "anotheruser"],
  trustProxy: false,
  promptsDir: "prompts",
};

// Helper: start authorize flow and extract session key from GitHub redirect
async function startAuthorizeFlow(baseUrl: string, clientId: string, codeChallenge: string, state = "test-state") {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://claude.ai/oauth/callback",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const res = await fetch(`${baseUrl}/oauth/authorize?${params}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  expect(location).toContain("github.com/login/oauth/authorize");

  const redirectUrl = new URL(location);
  const sessionKey = redirectUrl.searchParams.get("state")!;
  expect(sessionKey).toBeDefined();
  expect(sessionKey.length).toBe(64);
  return { sessionKey, location };
}

// Helper: complete a full callback cycle, returning the auth code
async function completeCallback(baseUrl: string, sessionKey: string, ghCode = "gh_code") {
  const res = await fetch(`${baseUrl}/oauth/github/callback?code=${ghCode}&state=${sessionKey}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  return { location, authCode: new URL(location).searchParams.get("code")! };
}

describe("OAuth 2.1 with GitHub Authentication", () => {
  let httpServer: Server;
  let baseUrl: string;
  // Shared client — registered once to avoid hitting the per-IP rate limit
  let sharedClient: { client_id: string; client_secret: string };

  // Fresh stores and rate limiters per test suite
  const oauthStore = new OAuthStore();
  const oauthSessionStore = new OAuthSessionStore();
  const registrationRateLimiter = new RateLimiter(10, 60_000);
  const tokenRateLimiter = new RateLimiter(20, 60_000);

  beforeAll(async () => {
    const app = express();

    app.get("/.well-known/oauth-authorization-server", handleMetadata(testConfig));
    app.post("/oauth/register", express.json(), handleRegistration(oauthStore, registrationRateLimiter));
    app.get("/oauth/authorize", handleAuthorizeGet(testConfig, oauthStore, oauthSessionStore));
    app.get("/oauth/github/callback", handleGitHubCallback(testConfig, oauthSessionStore, oauthStore));
    app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(testConfig, oauthStore, tokenRateLimiter));

    app.use("/mcp", jwtAuth(testConfig.jwtSecret));
    app.post("/mcp", express.json(), (_req, res) => {
      res.json({ ok: true });
    });

    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    testConfig.serverUrl = baseUrl;

    // Register shared client once
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Shared Test Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    sharedClient = await regRes.json();
  });

  beforeEach(() => {
    mockGitHubTokenResponse = { access_token: "gh_mock_token", token_type: "bearer", scope: "read:user" };
    mockGitHubUserResponse = { login: "AllowedUser", id: 12345 };
    mockGitHubTokenStatus = 200;
    mockGitHubUserStatus = 200;
  });

  afterAll(() => {
    httpServer?.close();
    globalThis.fetch = originalFetch;
  });

  // ----- Core OAuth Endpoints -----

  it("returns OAuth server metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issuer).toBe(testConfig.serverUrl);
    expect(data.authorization_endpoint).toContain("/oauth/authorize");
    expect(data.token_endpoint).toContain("/oauth/token");
    expect(data.registration_endpoint).toContain("/oauth/register");
    expect(data.code_challenge_methods_supported).toContain("S256");
  });

  it("registers a client via DCR", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "DCR Test Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client_id).toBeDefined();
    expect(data.client_secret).toBeDefined();
  });

  it("rejects DCR with non-HTTPS redirect URI", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Bad Client",
        redirect_uris: ["http://evil.com/callback"],
      }),
    });
    expect(res.status).toBe(400);
  });

  // ----- Authorize → GitHub Redirect -----

  it("redirects to GitHub on valid authorize request", async () => {
    const codeChallenge = crypto.createHash("sha256").update("verifier").digest("base64url");
    const { location } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);

    const url = new URL(location);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(testConfig.githubClientId);
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseUrl}/oauth/github/callback`);
  });

  it("rejects authorize with invalid response_type", async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize?response_type=token&client_id=x&redirect_uri=x&state=x&code_challenge=x&code_challenge_method=S256`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error_description).toContain("response_type");
  });

  it("rejects authorize with unknown client_id", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "nonexistent",
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "s",
      code_challenge: "abc",
      code_challenge_method: "S256",
    });
    const res = await fetch(`${baseUrl}/oauth/authorize?${params}`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error_description).toContain("Unknown client_id");
  });

  // ----- Session Bridge: Thorough Tests -----

  it("creates a unique session for each authorize request", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v1").digest("base64url");

    const { sessionKey: key1 } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge, "state1");
    const { sessionKey: key2 } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge, "state2");

    expect(key1).not.toBe(key2);
    expect(key1.length).toBe(64);
    expect(key2.length).toBe(64);
  });

  it("session is consumed on first callback (one-time use)", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);

    // First callback succeeds
    const res1 = await fetch(`${baseUrl}/oauth/github/callback?code=gh_code&state=${sessionKey}`, { redirect: "manual" });
    expect(res1.status).toBe(302);
    expect(res1.headers.get("location")).toContain("code=");

    // Second callback with same key fails
    const res2 = await fetch(`${baseUrl}/oauth/github/callback?code=gh_code&state=${sessionKey}`, { redirect: "manual" });
    expect(res2.status).toBe(400);
    const data = await res2.json();
    expect(data.error_description).toContain("Invalid or expired session");
  });

  it("session preserves original Claude state across GitHub redirect", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    const originalState = "claude-state-abc123";

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge, originalState);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const redirectUrl = new URL(res.headers.get("location")!);
    expect(redirectUrl.searchParams.get("state")).toBe(originalState);
  });

  it("session preserves original redirect_uri across GitHub redirect", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);

    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://claude.ai/oauth/callback");
  });

  it("session preserves PKCE code_challenge for token exchange", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    // Authorize → GitHub → callback → get auth code
    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    // Token exchange with correct PKCE verifier succeeds
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: sharedClient.client_id,
        client_secret: sharedClient.client_secret,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();

    // New flow with wrong PKCE verifier fails
    const { sessionKey: key2 } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge, "s2");
    const { authCode: code2 } = await completeCallback(baseUrl, key2, "gc2");

    const tokenRes2 = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code2,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: sharedClient.client_id,
        client_secret: sharedClient.client_secret,
        code_verifier: "wrong-verifier",
      }).toString(),
    });
    expect(tokenRes2.status).toBe(400);
    expect((await tokenRes2.json()).error_description).toContain("PKCE");
  });

  it("callback with invalid state returns 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=invalid-key`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("Invalid or expired session");
  });

  it("callback with missing code returns 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/github/callback?state=something`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("Missing code or state");
  });

  it("callback with missing state returns 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("Missing code or state");
  });

  it("callback with unknown/expired session key returns 400", async () => {
    const fakeKey = crypto.randomBytes(32).toString("hex");
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=c&state=${fakeKey}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("Invalid or expired session");
  });

  it("callback with GitHub error parameter returns 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/github/callback?error=access_denied&state=x`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("access_denied");
  });

  // ----- GitHub User Allowlist -----

  it("allows user in allowlist (case-insensitive)", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    mockGitHubUserResponse = { login: "AllowedUser", id: 12345 }; // mixed case

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
    expect(res.headers.get("location")).not.toContain("error=");
  });

  it("rejects user NOT in allowlist with redirect error", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    mockGitHubUserResponse = { login: "EvilHacker", id: 99999 };

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const redirectUrl = new URL(res.headers.get("location")!);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("error_description")).toBe("User not authorized");
  });

  it("allowlist check is case-insensitive for various casings", () => {
    const allowedUsers = ["alice", "bob"];
    expect(isAllowedUser("Alice", allowedUsers)).toBe(true);
    expect(isAllowedUser("ALICE", allowedUsers)).toBe(true);
    expect(isAllowedUser("alice", allowedUsers)).toBe(true);
    expect(isAllowedUser("Bob", allowedUsers)).toBe(true);
    expect(isAllowedUser("BOB", allowedUsers)).toBe(true);
    expect(isAllowedUser("charlie", allowedUsers)).toBe(false);
    expect(isAllowedUser("", allowedUsers)).toBe(false);
  });

  // ----- GitHub API Error Handling -----

  it("handles GitHub token exchange failure", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    mockGitHubTokenResponse = { error: "bad_verification_code", error_description: "The code has expired" };

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=bad&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("server_error");
  });

  it("handles GitHub user info failure", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    mockGitHubUserStatus = 401;

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(502);
  });

  // ----- Full End-to-End Flow -----

  it("completes full flow: register → authorize → GitHub → callback → token → MCP", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    mockGitHubUserResponse = { login: "AnotherUser", id: 67890 };

    // Authorize → GitHub redirect
    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge, "e2e-state");

    // GitHub callback → Claude redirect with code
    const callbackRes = await fetch(`${baseUrl}/oauth/github/callback?code=gc_e2e&state=${sessionKey}`, { redirect: "manual" });
    expect(callbackRes.status).toBe(302);
    const redirectUrl = new URL(callbackRes.headers.get("location")!);
    expect(redirectUrl.searchParams.get("state")).toBe("e2e-state");
    const authCode = redirectUrl.searchParams.get("code")!;

    // Token exchange
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: sharedClient.client_id,
        client_secret: sharedClient.client_secret,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe("Bearer");

    // Use JWT on protected endpoint
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcpRes.status).toBe(200);

    // Refresh token
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: sharedClient.client_id,
        client_secret: sharedClient.client_secret,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("rejects auth code reuse after GitHub flow", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: "https://claude.ai/oauth/callback",
      client_id: sharedClient.client_id,
      client_secret: sharedClient.client_secret,
      code_verifier: codeVerifier,
    }).toString();

    const res1 = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe("invalid_grant");
  });

  // ----- JWT Auth Middleware -----

  it("auth middleware accepts JWT access token", async () => {
    const jwt = createAccessToken("test-client", testConfig.jwtSecret, 3600);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("auth middleware rejects invalid token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Authorization": "Bearer invalid-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unsupported grant type", async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});

// ----- Session Store Unit Tests -----

describe("OAuthSessionStore", () => {
  const sessionStore = new OAuthSessionStore();

  it("creates and consumes sessions", () => {
    const key = sessionStore.create({
      clientId: "c1",
      redirectUri: "https://example.com/cb",
      state: "s1",
      codeChallenge: "ch1",
      codeChallengeMethod: "S256",
    });
    expect(key).toHaveLength(64);

    const session = sessionStore.consume(key!);
    expect(session).not.toBeNull();
    expect(session!.clientId).toBe("c1");
    expect(session!.redirectUri).toBe("https://example.com/cb");
    expect(session!.state).toBe("s1");
    expect(session!.codeChallenge).toBe("ch1");
  });

  it("returns null on second consume (one-time use)", () => {
    const key = sessionStore.create({
      clientId: "c2",
      redirectUri: "https://example.com/cb",
      state: "s2",
      codeChallenge: "ch2",
      codeChallengeMethod: "S256",
    });
    expect(sessionStore.consume(key!)).not.toBeNull();
    expect(sessionStore.consume(key!)).toBeNull();
  });

  it("returns null for unknown key", () => {
    expect(sessionStore.consume("nonexistent-key")).toBeNull();
  });

  it("each session gets a unique key", () => {
    const data = { clientId: "c3", redirectUri: "u", state: "s", codeChallenge: "c", codeChallengeMethod: "S256" };
    const key1 = sessionStore.create(data);
    const key2 = sessionStore.create(data);
    expect(key1).not.toBe(key2);
  });
});
