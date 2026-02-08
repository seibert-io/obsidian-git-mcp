import type { Request, Response } from "express";
import type { Config } from "../config.js";
import type { OAuthStore } from "./store.js";
import type { OAuthSessionStore } from "./sessionStore.js";
import { logger } from "../utils/logger.js";

/**
 * GET /oauth/authorize
 *
 * Instead of showing a login page, saves the Claude session parameters
 * and redirects the user to GitHub for authentication.
 */
export function handleAuthorizeGet(config: Config, store: OAuthStore, sessionStore: OAuthSessionStore) {
  return (req: Request, res: Response): void => {
    const q = (key: string): string | undefined => {
      const v = req.query[key];
      return typeof v === "string" ? v : undefined;
    };
    const client_id = q("client_id");
    const redirect_uri = q("redirect_uri");
    const state = q("state");
    const code_challenge = q("code_challenge");
    const code_challenge_method = q("code_challenge_method");
    const response_type = q("response_type");

    // Validate required params
    if (response_type !== "code") {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid response_type. Expected 'code'." });
      return;
    }
    if (!client_id || !redirect_uri || !state || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters (client_id, redirect_uri, state, code_challenge, code_challenge_method=S256)." });
      return;
    }

    const client = store.getClient(client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_request", error_description: "Unknown client_id." });
      return;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client." });
      return;
    }

    // Save session data and redirect to GitHub
    const sessionKey = sessionStore.create({
      clientId: client_id,
      redirectUri: redirect_uri,
      state,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
    });

    if (!sessionKey) {
      res.status(503).json({ error: "server_error", error_description: "Too many pending authorization sessions" });
      return;
    }

    logger.info("OAuth session created, redirecting to GitHub", { clientId: client_id });

    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", config.githubClientId);
    githubUrl.searchParams.set("redirect_uri", `${config.serverUrl}/oauth/github/callback`);
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", sessionKey);

    res.redirect(githubUrl.toString());
  };
}
