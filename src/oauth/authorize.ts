import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { oauthStore } from "./store.js";
import { logger } from "../utils/logger.js";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    return false;
  }
  entry.count++;
  return true;
}

function renderLoginPage(error?: string, clientName?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obsidian Vault — Authorize</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #eee; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
  .card { background: #16213e; border-radius: 12px; padding: 2rem; max-width: 400px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  p { color: #a0a0b0; font-size: 0.9rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.85rem; margin-bottom: 0.5rem; color: #c0c0d0; }
  input[type=password] { width: 100%; padding: 0.75rem; border: 1px solid #333; border-radius: 8px; background: #0f3460; color: #eee; font-size: 1rem; margin-bottom: 1rem; }
  input[type=password]:focus { outline: none; border-color: #e94560; }
  button { width: 100%; padding: 0.75rem; background: #e94560; border: none; border-radius: 8px; color: #fff; font-size: 1rem; cursor: pointer; font-weight: 600; }
  button:hover { background: #d63851; }
  .error { background: #e9456020; border: 1px solid #e94560; color: #ff6b81; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize Access</h1>
  <p>${clientName ? `<strong>${escapeHtml(clientName)}</strong> wants to access your Obsidian vault.` : "Enter your password to authorize access."}</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="POST">
    <label for="password">Vault Password</label>
    <input type="password" id="password" name="password" required autofocus autocomplete="current-password">
    <button type="submit">Authorize</button>
  </form>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

export function handleAuthorizeGet(config: Config) {
  return (req: Request, res: Response): void => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;

    // Validate required params
    if (response_type !== "code") {
      res.status(400).send(renderLoginPage("Invalid response_type. Expected 'code'."));
      return;
    }
    if (!client_id || !redirect_uri || !state || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).send(renderLoginPage("Missing required parameters (client_id, redirect_uri, state, code_challenge, code_challenge_method=S256)."));
      return;
    }

    const client = oauthStore.getClient(client_id);
    if (!client) {
      res.status(400).send(renderLoginPage("Unknown client_id."));
      return;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).send(renderLoginPage("redirect_uri not registered for this client."));
      return;
    }

    // Render login form — preserve query params in a hidden form or rely on POST having same URL
    const qs = new URLSearchParams({
      client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type,
    }).toString();
    const html = renderLoginPage(undefined, client.clientName).replace(
      'method="POST"',
      `method="POST" action="/oauth/authorize?${escapeHtml(qs)}"`,
    );
    res.type("html").send(html);
  };
}

export function handleAuthorizePost(config: Config) {
  return (req: Request, res: Response): void => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;
    const { password } = req.body;

    const ip = req.ip ?? "unknown";
    if (!checkRateLimit(ip)) {
      res.status(429).send(renderLoginPage("Too many login attempts. Please wait a minute."));
      return;
    }

    // Re-validate params
    if (response_type !== "code" || !client_id || !redirect_uri || !state || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).send(renderLoginPage("Invalid request parameters."));
      return;
    }

    const client = oauthStore.getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      res.status(400).send(renderLoginPage("Invalid client or redirect URI."));
      return;
    }

    // Verify password (timing-safe)
    const pwBuf = Buffer.from(password ?? "");
    const expectedBuf = Buffer.from(config.oauthPassword);
    if (pwBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(pwBuf, expectedBuf)) {
      logger.warn("Failed OAuth login attempt", { clientId: client_id, ip });
      const qs = new URLSearchParams({
        client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type,
      }).toString();
      const html = renderLoginPage("Invalid password.", client.clientName).replace(
        'method="POST"',
        `method="POST" action="/oauth/authorize?${escapeHtml(qs)}"`,
      );
      res.type("html").send(html);
      return;
    }

    // Generate authorization code
    const code = oauthStore.createAuthCode(client_id, redirect_uri, code_challenge);
    logger.info("OAuth authorization code issued", { clientId: client_id });

    // Redirect back to client
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", state);
    res.redirect(redirectUrl.toString());
  };
}
