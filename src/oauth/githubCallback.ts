import type { Request, Response } from "express";
import type { Config } from "../config.js";
import { oauthSessionStore } from "./sessionStore.js";
import { oauthStore } from "./store.js";
import { exchangeGitHubCode, fetchGitHubUser } from "./githubClient.js";
import { isAllowedUser } from "./allowlist.js";
import { logger } from "../utils/logger.js";

/**
 * GET /oauth/github/callback
 *
 * Handles the redirect back from GitHub after the user authenticates.
 * Validates the session, checks the allowlist, and redirects to Claude
 * with an authorization code.
 */
export function handleGitHubCallback(config: Config) {
  return async (req: Request, res: Response): Promise<void> => {
    const { code, state, error: ghError } = req.query as Record<string, string>;

    // GitHub may redirect with an error (e.g. user denied access)
    if (ghError) {
      logger.warn("GitHub OAuth error", { error: ghError });
      res.status(400).json({ error: "access_denied", error_description: "GitHub authorization was denied." });
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code or state from GitHub." });
      return;
    }

    // Look up the session (one-time use)
    const session = oauthSessionStore.consume(state);
    if (!session) {
      logger.warn("Invalid or expired GitHub OAuth session", { state: state.slice(0, 8) + "..." });
      res.status(400).json({ error: "invalid_request", error_description: "Invalid or expired session. Please try again." });
      return;
    }

    try {
      // Exchange GitHub code for access token
      const tokenData = await exchangeGitHubCode(
        code,
        config.githubClientId,
        config.githubClientSecret,
      );

      // Fetch GitHub user info
      const githubUser = await fetchGitHubUser(tokenData.access_token);
      // GitHub access token is not stored — used once and discarded

      logger.info("GitHub user authenticated", { username: githubUser.login });

      // Allowlist check (case-insensitive)
      if (!isAllowedUser(githubUser.login, config.allowedGithubUsers)) {
        logger.warn("GitHub user not in allowlist", { username: githubUser.login });
        const redirectUrl = new URL(session.redirectUri);
        redirectUrl.searchParams.set("error", "access_denied");
        redirectUrl.searchParams.set("error_description", "User not authorized");
        redirectUrl.searchParams.set("state", session.state);
        res.redirect(redirectUrl.toString());
        return;
      }

      // Generate authorization code for Claude (same as before)
      const authCode = oauthStore.createAuthCode(
        session.clientId,
        session.redirectUri,
        session.codeChallenge,
      );
      logger.info("OAuth authorization code issued via GitHub", {
        clientId: session.clientId,
        githubUser: githubUser.login,
      });

      // Redirect back to Claude with the authorization code
      const redirectUrl = new URL(session.redirectUri);
      redirectUrl.searchParams.set("code", authCode);
      redirectUrl.searchParams.set("state", session.state);
      res.redirect(redirectUrl.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("GitHub OAuth callback failed", { error: message });
      res.status(502).json({ error: "server_error", error_description: "Failed to authenticate with GitHub." });
    }
  };
}
