export interface Config {
  gitRepoUrl: string;
  gitBranch: string;
  gitSyncIntervalSeconds: number;
  gitUserName: string;
  gitUserEmail: string;
  vaultPath: string;
  port: number;
  logLevel: string;
  // OAuth 2.1
  oauthPassword: string;
  jwtSecret: string;
  serverUrl: string;
  accessTokenExpirySeconds: number;
  refreshTokenExpirySeconds: number;
}

export function loadConfig(): Config {
  const gitRepoUrl = process.env.GIT_REPO_URL;
  if (!gitRepoUrl) {
    throw new Error("GIT_REPO_URL environment variable is required");
  }

  const gitBranch = process.env.GIT_BRANCH ?? "main";
  if (gitBranch.startsWith("-")) {
    throw new Error("GIT_BRANCH must not start with a hyphen");
  }

  const gitUserName = process.env.GIT_USER_NAME ?? "Claude MCP";
  if (gitUserName.startsWith("-")) {
    throw new Error("GIT_USER_NAME must not start with a hyphen");
  }

  const gitUserEmail = process.env.GIT_USER_EMAIL ?? "mcp@example.com";
  if (gitUserEmail.startsWith("-")) {
    throw new Error("GIT_USER_EMAIL must not start with a hyphen");
  }

  const syncInterval = parseInt(
    process.env.GIT_SYNC_INTERVAL_SECONDS ?? "300",
    10,
  );
  if (isNaN(syncInterval) || syncInterval < 0) {
    throw new Error("GIT_SYNC_INTERVAL_SECONDS must be a non-negative number");
  }

  const port = parseInt(process.env.PORT ?? "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid port number (1-65535)");
  }

  // OAuth 2.1
  const oauthPassword = process.env.OAUTH_PASSWORD;
  if (!oauthPassword) {
    throw new Error("OAUTH_PASSWORD environment variable is required");
  }
  if (oauthPassword.length < 12) {
    throw new Error("OAUTH_PASSWORD must be at least 12 characters");
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }

  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) {
    throw new Error("SERVER_URL environment variable is required");
  }

  const accessTokenExpiry = parseInt(
    process.env.ACCESS_TOKEN_EXPIRY_SECONDS ?? "3600",
    10,
  );
  if (isNaN(accessTokenExpiry) || accessTokenExpiry < 1) {
    throw new Error("ACCESS_TOKEN_EXPIRY_SECONDS must be a positive number");
  }

  const refreshTokenExpiry = parseInt(
    process.env.REFRESH_TOKEN_EXPIRY_SECONDS ?? "604800",
    10,
  );
  if (isNaN(refreshTokenExpiry) || refreshTokenExpiry < 1) {
    throw new Error("REFRESH_TOKEN_EXPIRY_SECONDS must be a positive number");
  }

  return {
    gitRepoUrl,
    gitBranch,
    gitSyncIntervalSeconds: syncInterval,
    gitUserName,
    gitUserEmail,
    vaultPath: process.env.VAULT_PATH ?? "/vault",
    port,
    logLevel: process.env.LOG_LEVEL ?? "info",
    oauthPassword,
    jwtSecret,
    serverUrl: serverUrl.replace(/\/$/, ""), // strip trailing slash
    accessTokenExpirySeconds: accessTokenExpiry,
    refreshTokenExpirySeconds: refreshTokenExpiry,
  };
}
