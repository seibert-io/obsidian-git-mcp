import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleMetadata } from "../src/oauth/metadata.js";
import { handleRegistration } from "../src/oauth/registration.js";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth/authorize.js";
import { handleToken } from "../src/oauth/token.js";
import { jwtAuth } from "../src/auth.js";
import { createAccessToken } from "../src/oauth/jwt.js";
import type { Config } from "../src/config.js";

const testConfig: Config = {
  gitRepoUrl: "https://example.com/repo.git",
  gitBranch: "main",
  gitSyncIntervalSeconds: 0,
  gitUserName: "Test",
  gitUserEmail: "test@example.com",
  vaultPath: "/tmp/test-vault-oauth",
  port: 0,
  logLevel: "error",
  oauthPassword: "test-vault-password",
  jwtSecret: "test-jwt-secret-that-is-at-least-32-chars-long",
  serverUrl: "http://localhost:3000",
  accessTokenExpirySeconds: 3600,
  refreshTokenExpirySeconds: 604800,
};

describe("OAuth 2.1 Endpoints", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(() => {
    const app = express();

    // OAuth endpoints
    app.get("/.well-known/oauth-authorization-server", handleMetadata(testConfig));
    app.post("/oauth/register", express.json(), handleRegistration());
    app.get("/oauth/authorize", handleAuthorizeGet(testConfig));
    app.post("/oauth/authorize", express.urlencoded({ extended: false }), handleAuthorizePost(testConfig));
    app.post("/oauth/token", express.urlencoded({ extended: false }), handleToken(testConfig));

    // Protected endpoint for auth testing (OAuth JWT only)
    app.use("/mcp", jwtAuth(testConfig.jwtSecret));
    app.post("/mcp", express.json(), (_req, res) => {
      res.json({ ok: true });
    });

    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    httpServer?.close();
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
    expect(data.grant_types_supported).toContain("authorization_code");
    expect(data.grant_types_supported).toContain("refresh_token");
  });

  it("registers a client via DCR", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client_id).toBeDefined();
    expect(data.client_secret).toBeDefined();
    expect(data.client_name).toBe("Test Client");
    expect(data.redirect_uris).toEqual(["https://claude.ai/oauth/callback"]);
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
    const data = await res.json();
    expect(data.error).toBe("invalid_request");
  });

  it("rejects DCR with disallowed redirect host", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Bad Client",
        redirect_uris: ["https://evil.com/callback"],
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error_description).toContain("not allowed");
  });

  it("returns authorize page for valid params", async () => {
    // Register a client first
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Auth Test Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const client = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "test-state",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const res = await fetch(`${baseUrl}/oauth/authorize?${params}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorize Access");
    expect(html).toContain("Auth Test Client");
  });

  it("rejects authorize with invalid response_type", async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize?response_type=token&client_id=x&redirect_uri=x&state=x&code_challenge=x&code_challenge_method=S256`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Invalid response_type");
  });

  it("completes full OAuth authorization_code flow", async () => {
    // 1. Register client
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Full Flow Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const client = await regRes.json();

    // 2. Generate PKCE
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    // 3. POST authorize with correct password
    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "test-state-123",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authRes = await fetch(`${baseUrl}/oauth/authorize?${authParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${testConfig.oauthPassword}`,
      redirect: "manual",
    });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("location")!;
    expect(location).toContain("https://claude.ai/oauth/callback");
    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get("code")!;
    const state = redirectUrl.searchParams.get("state")!;
    expect(code).toBeDefined();
    expect(state).toBe("test-state-123");

    // 4. Exchange code for tokens
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(testConfig.accessTokenExpirySeconds);

    // 5. Use access token to call protected endpoint
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcpRes.status).toBe(200);

    // 6. Refresh tokens
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const newTokens = await refreshRes.json();
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).toBeDefined();
    // Old refresh token should be consumed (rotation)
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("rejects wrong password in authorize flow", async () => {
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Wrong Password Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const client = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "test-state",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authRes = await fetch(`${baseUrl}/oauth/authorize?${authParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=wrong-password",
      redirect: "manual",
    });
    // Should render form again with error, not redirect
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain("Invalid password");
  });

  it("rejects token exchange with wrong code_verifier (PKCE)", async () => {
    // Register and authorize
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "PKCE Fail Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const client = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "s",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authRes = await fetch(`${baseUrl}/oauth/authorize?${authParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${testConfig.oauthPassword}`,
      redirect: "manual",
    });
    const redirectUrl = new URL(authRes.headers.get("location")!);
    const code = redirectUrl.searchParams.get("code")!;

    // Try exchanging with wrong verifier
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/oauth/callback",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: "wrong-verifier",
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const data = await tokenRes.json();
    expect(data.error).toBe("invalid_grant");
    expect(data.error_description).toContain("PKCE");
  });

  it("rejects auth code reuse", async () => {
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Reuse Client",
        redirect_uris: ["https://claude.ai/oauth/callback"],
      }),
    });
    const client = await regRes.json();

    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/oauth/callback",
      state: "s",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authRes = await fetch(`${baseUrl}/oauth/authorize?${authParams}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${testConfig.oauthPassword}`,
      redirect: "manual",
    });
    const redirectUrl = new URL(authRes.headers.get("location")!);
    const code = redirectUrl.searchParams.get("code")!;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/oauth/callback",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: codeVerifier,
    }).toString();

    // First exchange should succeed
    const tokenRes1 = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(tokenRes1.status).toBe(200);

    // Second exchange with same code should fail
    const tokenRes2 = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    expect(tokenRes2.status).toBe(400);
    const data = await tokenRes2.json();
    expect(data.error).toBe("invalid_grant");
  });

  it("auth middleware accepts JWT access token", async () => {
    const jwt = createAccessToken("test-client", testConfig.jwtSecret, 3600);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("auth middleware rejects invalid token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer invalid-token-here",
        "Content-Type": "application/json",
      },
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
    const data = await res.json();
    expect(data.error).toBe("unsupported_grant_type");
  });
});
