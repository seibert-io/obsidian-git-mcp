import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { oauthStore } from "./store.js";
import { oauthSessionStore } from "./sessionStore.js";
import { logger } from "../utils/logger.js";

/**
 * GET /oauth/authorize
 *
 * Instead of showing a login page, saves the Claude session parameters
 * and redirects the user to GitHub for authentication.
 */
export function handleAuthorizeGet(config: Config) {
  return (req: Request, res: Response): void => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;

    // Validate required params
    if (response_type !== "code") {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid response_type. Expected 'code'." });
      return;
    }
    if (!client_id || !redirect_uri || !state || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters (client_id, redirect_uri, state, code_challenge, code_challenge_method=S256)." });
      return;
    }

    const client = oauthStore.getClient(client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_request", error_description: "Unknown client_id." });
      return;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client." });
      return;
    }

    // Save session data and redirect to GitHub
    const sessionKey = oauthSessionStore.create({
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
