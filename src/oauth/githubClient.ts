import { logger } from "../utils/logger.js";

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubUser {
  login: string;
  id: number;
}

/**
 * Exchange a GitHub authorization code for an access token.
 */
export async function exchangeGitHubCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<GitHubTokenResponse> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }

  const data = (await res.json()) as GitHubTokenResponse & { error?: string; error_description?: string };
  if (data.error) {
    logger.warn("GitHub token exchange error", { error: data.error, description: data.error_description });
    throw new Error(`GitHub OAuth error: ${data.error}`);
  }

  logger.info("GitHub token exchange response", {
    token_type: data.token_type,
    scope: data.scope,
    has_access_token: !!data.access_token,
    access_token_length: data.access_token?.length ?? 0,
  });

  return data;
}

/**
 * Fetch the authenticated GitHub user's profile.
 * The token is used once and then discarded by the caller.
 */
export async function fetchGitHubUser(
  accessToken: string,
): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "obsidian-vault-mcp-server",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    logger.error("GitHub user info request failed", {
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new Error(`GitHub user info request failed: ${res.status}`);
  }

  return (await res.json()) as GitHubUser;
}
