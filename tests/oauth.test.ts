import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleProtectedResource } from "../src/oauth/protectedResource.js";
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
import { createTestConfig } from "./helpers/testConfig.js";
import {
  installGitHubMock,
  uninstallGitHubMock,
  resetGitHubMock,
  setMockGitHubTokenResponse,
  setMockGitHubUserResponse,
} from "./helpers/mockGitHub.js";
import { startAuthorizeFlow, completeCallback } from "./helpers/oauthHelpers.js";

const testConfig = createTestConfig({
  vaultPath: "/tmp/test-vault-oauth",
  allowedGithubUsers: ["alloweduser", "anotheruser"],
});

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
    installGitHubMock();

    const app = express();

    app.get("/.well-known/oauth-protected-resource", handleProtectedResource(testConfig));
    app.get("/.well-known/oauth-authorization-server", handleMetadata(testConfig));
    app.post("/oauth/register", express.json(), handleRegistration(oauthStore, registrationRateLimiter));
    app.get("/oauth/authorize", handleAuthorizeGet(testConfig, oauthStore, oauthSessionStore));
    app.get("/oauth/github/callback", handleGitHubCallback(testConfig, oauthSessionStore, oauthStore));
    app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(testConfig, oauthStore, tokenRateLimiter));

    app.use("/mcp", jwtAuth(testConfig.jwtSecret, testConfig.serverUrl));
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
    resetGitHubMock();
  });

  afterAll(() => {
    httpServer?.close();
    uninstallGitHubMock();
  });

  // ----- Core OAuth Endpoints -----

  it("returns Protected Resource Metadata (RFC 9728)", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resource).toBe(testConfig.serverUrl);
    expect(data.authorization_servers).toEqual([testConfig.serverUrl]);
  });

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
    setMockGitHubUserResponse({ login: "AllowedUser", id: 12345 });

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
    expect(res.headers.get("location")).not.toContain("error=");
  });

  it("rejects user NOT in allowlist with redirect error", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    setMockGitHubUserResponse({ login: "EvilHacker", id: 99999 });

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
    setMockGitHubTokenResponse({ error: "bad_verification_code", error_description: "The code has expired" });

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=bad&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("server_error");
  });

  it("handles GitHub user info failure", async () => {
    const codeChallenge = crypto.createHash("sha256").update("v").digest("base64url");
    setMockGitHubUserResponse({}, 401);

    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const res = await fetch(`${baseUrl}/oauth/github/callback?code=gc&state=${sessionKey}`, { redirect: "manual" });
    expect(res.status).toBe(502);
  });

  // ----- Full End-to-End Flow -----

  it("completes full flow: register → authorize → GitHub → callback → token → MCP", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    setMockGitHubUserResponse({ login: "AnotherUser", id: 67890 });

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

  it("auth middleware rejects invalid token with WWW-Authenticate header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Authorization": "Bearer invalid-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  it("auth middleware returns WWW-Authenticate on missing Authorization header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
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

  // ----- Public Client (token_endpoint_auth_method: "none") -----

  it("metadata advertises 'none' as supported auth method", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    const data = await res.json();
    expect(data.token_endpoint_auth_methods_supported).toContain("none");
    expect(data.token_endpoint_auth_methods_supported).toContain("client_secret_post");
  });

  it("registers a public client (auth_method: none) without returning client_secret", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Public Client Test",
        redirect_uris: ["http://localhost:3000/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client_id).toBeDefined();
    expect(data.client_secret).toBeUndefined();
    expect(data.token_endpoint_auth_method).toBe("none");
  });

  it("completes token exchange for public client without client_secret", async () => {
    const publicRedirectUri = "http://localhost:3000/callback";
    // Register public client
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Public Token Test",
        redirect_uris: [publicRedirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge, "test-state", publicRedirectUri);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    // Token exchange WITHOUT client_secret
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "http://localhost:3000/callback",
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe("Bearer");
  });

  it("completes refresh token grant for public client without client_secret", async () => {
    const publicRedirectUri = "http://localhost:3000/callback";
    // Register public client and complete full flow
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Public Refresh Test",
        redirect_uris: [publicRedirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge, "test-state", publicRedirectUri);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "http://localhost:3000/callback",
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });
    const { refresh_token: refreshToken } = await tokenRes.json();

    // Refresh WITHOUT client_secret
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
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(refreshToken);
  });

  it("rejects token exchange with client_secret for public client", async () => {
    const publicRedirectUri = "http://localhost:3000/callback";
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Public Reject Secret Test",
        redirect_uris: [publicRedirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge, "test-state", publicRedirectUri);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    // Sending client_secret for a public client should be rejected
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "http://localhost:3000/callback",
        client_id: clientId,
        client_secret: "should-not-be-here",
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(401);
    expect((await tokenRes.json()).error).toBe("invalid_client");
  });

  it("rejects token exchange without client_secret for confidential client", async () => {
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const { sessionKey } = await startAuthorizeFlow(baseUrl, sharedClient.client_id, codeChallenge);
    const { authCode } = await completeCallback(baseUrl, sessionKey);

    // Omitting client_secret for a confidential client should fail
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: sharedClient.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(401);
    expect((await tokenRes.json()).error).toBe("invalid_client");
  });

  it("full flow: public client register → authorize → callback → token → MCP", async () => {
    const publicRedirectUri = "http://localhost:3000/callback";
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Public E2E Client",
        redirect_uris: [publicRedirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge, "public-e2e", publicRedirectUri);
    const callbackRes = await fetch(`${baseUrl}/oauth/github/callback?code=gc_pub&state=${sessionKey}`, { redirect: "manual" });
    expect(callbackRes.status).toBe(302);
    const redirectUrl = new URL(callbackRes.headers.get("location")!);
    expect(redirectUrl.searchParams.get("state")).toBe("public-e2e");
    const authCode = redirectUrl.searchParams.get("code")!;

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: "http://localhost:3000/callback",
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();

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

    // Refresh without secret
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
  });
});

// ----- OAuthStore Unit Tests -----

describe("OAuthStore", () => {
  const defaultParams = {
    redirectUris: ["https://claude.ai/oauth/callback"],
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  } as const;

  const registerPublic = (store: OAuthStore, name: string) =>
    store.registerClient({ ...defaultParams, clientName: name, tokenEndpointAuthMethod: "none" });

  const registerConfidential = (store: OAuthStore, name: string) =>
    store.registerClient({ ...defaultParams, clientName: name, tokenEndpointAuthMethod: "client_secret_post" });

  it("registers a public client without clientSecret", () => {
    const store = new OAuthStore();
    const client = registerPublic(store, "public");
    expect(client.clientId).toBeDefined();
    expect(client.clientSecret).toBeUndefined();
    expect(client.tokenEndpointAuthMethod).toBe("none");
  });

  it("registers a confidential client with clientSecret", () => {
    const store = new OAuthStore();
    const client = registerConfidential(store, "confidential");
    expect(client.clientId).toBeDefined();
    expect(client.clientSecret).toBeDefined();
    expect(client.clientSecret!.length).toBeGreaterThan(0);
    expect(client.tokenEndpointAuthMethod).toBe("client_secret_post");
  });

  it("authenticateClient succeeds for public client without secret", () => {
    const store = new OAuthStore();
    const client = registerPublic(store, "public");
    expect(store.authenticateClient(client.clientId, undefined)).toBe(true);
  });

  it("authenticateClient rejects secret for public client", () => {
    const store = new OAuthStore();
    const client = registerPublic(store, "public");
    expect(store.authenticateClient(client.clientId, "some-secret")).toBe(false);
  });

  it("authenticateClient succeeds for confidential client with correct secret", () => {
    const store = new OAuthStore();
    const client = registerConfidential(store, "confidential");
    expect(store.authenticateClient(client.clientId, client.clientSecret)).toBe(true);
  });

  it("authenticateClient rejects confidential client without secret", () => {
    const store = new OAuthStore();
    const client = registerConfidential(store, "confidential");
    expect(store.authenticateClient(client.clientId, undefined)).toBe(false);
  });

  it("authenticateClient rejects confidential client with wrong secret", () => {
    const store = new OAuthStore();
    const client = registerConfidential(store, "confidential");
    expect(store.authenticateClient(client.clientId, "wrong-secret")).toBe(false);
  });

  it("authenticateClient rejects unknown clientId", () => {
    const store = new OAuthStore();
    expect(store.authenticateClient("nonexistent", undefined)).toBe(false);
    expect(store.authenticateClient("nonexistent", "some-secret")).toBe(false);
  });

  it("cleanup does not evict fresh clients even at capacity", () => {
    const store = new OAuthStore();

    // Fill store to capacity — all clients are fresh (registered now)
    for (let i = 0; i < 500; i++) {
      registerConfidential(store, `client-${i}`);
    }
    expect(store.clientCount()).toBe(500);

    // Cleanup should not evict any fresh clients
    store.cleanup();
    expect(store.clientCount()).toBe(500);
  });

  it("cleanup skips client eviction when below capacity threshold", () => {
    const store = new OAuthStore();
    const CLIENT_STALENESS_MS = 24 * 60 * 60 * 1000;
    const baseTime = 1_000_000_000_000;
    const originalNow = Date.now;

    try {
      // Register a stale client
      Date.now = () => baseTime;
      registerConfidential(store, "old-client");

      // Only 1 client — well below 90% threshold of 500
      Date.now = () => baseTime + CLIENT_STALENESS_MS + 1;
      store.cleanup();
      // Should NOT evict because we're below the capacity threshold
      expect(store.clientCount()).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  it("cleanup removes clients older than staleness threshold when at capacity", () => {
    const store = new OAuthStore();
    const CLIENT_STALENESS_MS = 24 * 60 * 60 * 1000;
    const baseTime = 1_000_000_000_000; // fixed base timestamp
    const originalNow = Date.now;

    try {
      // Register one "old" client at baseTime
      Date.now = () => baseTime;
      registerConfidential(store, "old-client");
      expect(store.clientCount()).toBe(1);

      // Register 449 "fresh" clients at baseTime + STALENESS (not yet stale)
      Date.now = () => baseTime + CLIENT_STALENESS_MS;
      for (let i = 0; i < 449; i++) {
        registerConfidential(store, `filler-${i}`);
      }
      expect(store.clientCount()).toBe(450);

      // Advance time so old-client is stale but fillers are not
      // old-client: registered at baseTime, age = STALENESS + 1 → stale
      // fillers: registered at baseTime + STALENESS, age = 1 → fresh
      Date.now = () => baseTime + CLIENT_STALENESS_MS + 1;

      // Below threshold (450/500 = 90%) — stale clients should be evicted
      store.cleanup();
      expect(store.clientCount()).toBe(449); // old-client removed
    } finally {
      Date.now = originalNow;
    }
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
