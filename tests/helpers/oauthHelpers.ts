import { expect } from "vitest";
import crypto from "node:crypto";

/**
 * Starts an OAuth authorize flow and extracts the session key from the GitHub redirect.
 */
export async function startAuthorizeFlow(
  baseUrl: string,
  clientId: string,
  codeChallenge: string,
  state = "test-state",
): Promise<{ sessionKey: string; location: string }> {
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

/**
 * Completes a GitHub callback cycle and extracts the auth code from the redirect.
 */
export async function completeCallback(
  baseUrl: string,
  sessionKey: string,
  ghCode = "gh_code",
): Promise<{ location: string; authCode: string }> {
  const res = await fetch(`${baseUrl}/oauth/github/callback?code=${ghCode}&state=${sessionKey}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  return { location, authCode: new URL(location).searchParams.get("code")! };
}

interface OAuthFlowResult {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenResponse: Record<string, unknown>;
}

/**
 * Completes the entire OAuth dance: Register → Authorize → GitHub Callback → Token Exchange.
 */
export async function completeOAuthFlow(baseUrl: string): Promise<OAuthFlowResult> {
  // 1. Register client
  const regRes = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `Flow Test Client ${Date.now()}`,
      redirect_uris: ["https://claude.ai/oauth/callback"],
    }),
  });
  expect(regRes.status).toBe(201);
  const { client_id: clientId, client_secret: clientSecret } = await regRes.json();
  expect(clientId).toBeDefined();
  expect(clientSecret).toBeDefined();

  // 2. PKCE
  const codeVerifier = crypto.randomBytes(32).toString("hex");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  // 3. Authorize → GitHub redirect
  const { sessionKey } = await startAuthorizeFlow(baseUrl, clientId, codeChallenge);

  // 4. GitHub callback → auth code
  const { authCode } = await completeCallback(baseUrl, sessionKey);

  // 5. Token exchange
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: "https://claude.ai/oauth/callback",
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const tokenResponse = await tokenRes.json();

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    clientId,
    clientSecret,
    tokenResponse,
  };
}
