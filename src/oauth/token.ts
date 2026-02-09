import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Config } from "../config.js";
import type { OAuthStore } from "./store.js";
import { createAccessToken } from "./jwt.js";
import type { RateLimiter } from "../utils/rateLimiter.js";
import { logger } from "../utils/logger.js";

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = hash.toString("base64url");
  // Timing-safe comparison to prevent side-channel attacks
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Normalizes the client_secret from a form body.
 * Form-urlencoded sends empty fields as "", which we normalize to undefined
 * so that `authenticateClient` receives a clean signal.
 */
function normalizeClientSecret(value: string | undefined): string | undefined {
  return value === "" || value === undefined ? undefined : value;
}

function issueTokenResponse(
  res: Response,
  clientId: string,
  config: Config,
  store: OAuthStore,
  logMessage: string,
): void {
  const accessToken = createAccessToken(clientId, config.jwtSecret, config.accessTokenExpirySeconds);
  const refreshToken = store.createRefreshToken(clientId, config.refreshTokenExpirySeconds);

  logger.info(logMessage, { clientId });

  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTokenExpirySeconds,
    refresh_token: refreshToken,
  });
}

export function handleToken(config: Config, store: OAuthStore, rateLimiter: RateLimiter) {
  return (req: Request, res: Response): void => {
    const ip = req.ip ?? "unknown";
    if (!rateLimiter.check(ip)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }

    const { grant_type } = req.body;

    if (grant_type === "authorization_code") {
      handleAuthorizationCodeGrant(req, res, config, store);
    } else if (grant_type === "refresh_token") {
      handleRefreshTokenGrant(req, res, config, store);
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
    }
  };
}

function handleAuthorizationCodeGrant(req: Request, res: Response, config: Config, store: OAuthStore): void {
  const { code, redirect_uri, client_id, client_secret, code_verifier } = req.body;

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
    return;
  }

  // Authenticate client (secret required for confidential, forbidden for public)
  if (!store.authenticateClient(client_id, normalizeClientSecret(client_secret))) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Consume auth code (one-time use)
  const authCode = store.consumeAuthCode(code);
  if (!authCode) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
    return;
  }

  // Validate code belongs to this client
  if (authCode.clientId !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code was not issued to this client" });
    return;
  }

  // Validate redirect_uri matches
  if (authCode.redirectUri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }

  // PKCE verification
  if (!verifyPkce(code_verifier, authCode.codeChallenge)) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }

  issueTokenResponse(res, client_id, config, store, "OAuth tokens issued via authorization_code");
}

function handleRefreshTokenGrant(req: Request, res: Response, config: Config, store: OAuthStore): void {
  const { refresh_token, client_id, client_secret } = req.body;

  if (!refresh_token || !client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
    return;
  }

  // Authenticate client (secret required for confidential, forbidden for public)
  if (!store.authenticateClient(client_id, normalizeClientSecret(client_secret))) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Consume refresh token (rotation — old token is invalidated)
  const entry = store.consumeRefreshToken(refresh_token);
  if (!entry) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
    return;
  }

  // Verify token belongs to this client
  if (entry.clientId !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token was not issued to this client" });
    return;
  }

  issueTokenResponse(res, client_id, config, store, "OAuth tokens refreshed");
}
