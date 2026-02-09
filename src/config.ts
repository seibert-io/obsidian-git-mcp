import path from "node:path";

function containsControlCharacters(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

export interface Config {
  gitRepoUrl: string;
  gitBranch: string;
  gitSyncIntervalSeconds: number;
  gitDebounceSyncDelaySeconds: number;
  gitUserName: string;
  gitUserEmail: string;
  vaultPath: string;
  port: number;
  logLevel: string;
  // OAuth 2.1
  jwtSecret: string;
  serverUrl: string;
  accessTokenExpirySeconds: number;
  refreshTokenExpirySeconds: number;
  // GitHub OAuth
  githubClientId: string;
  githubClientSecret: string;
  allowedGithubUsers: string[];
  trustProxy: boolean;
  maxSessions: number;
  promptsDir: string;
}

export function loadConfig(): Config {
  const gitRepoUrl = process.env.GIT_REPO_URL;
  if (!gitRepoUrl) {
    throw new Error("GIT_REPO_URL environment variable is required");
  }
  if (containsControlCharacters(gitRepoUrl)) {
    throw new Error("GIT_REPO_URL must not contain control characters");
  }

  const gitBranch = process.env.GIT_BRANCH ?? "main";
  if (gitBranch.startsWith("-")) {
    throw new Error("GIT_BRANCH must not start with a hyphen");
  }
  if (containsControlCharacters(gitBranch)) {
    throw new Error("GIT_BRANCH must not contain control characters");
  }

  const gitUserName = process.env.GIT_USER_NAME ?? "Claude MCP";
  if (gitUserName.startsWith("-")) {
    throw new Error("GIT_USER_NAME must not start with a hyphen");
  }
  if (containsControlCharacters(gitUserName)) {
    throw new Error("GIT_USER_NAME must not contain control characters");
  }

  const gitUserEmail = process.env.GIT_USER_EMAIL ?? "mcp@example.com";
  if (gitUserEmail.startsWith("-")) {
    throw new Error("GIT_USER_EMAIL must not start with a hyphen");
  }
  if (containsControlCharacters(gitUserEmail)) {
    throw new Error("GIT_USER_EMAIL must not contain control characters");
  }

  const syncInterval = parseInt(
    process.env.GIT_SYNC_INTERVAL_SECONDS ?? "300",
    10,
  );
  if (isNaN(syncInterval) || syncInterval < 0) {
    throw new Error("GIT_SYNC_INTERVAL_SECONDS must be a non-negative number");
  }

  const debounceSyncDelay = parseInt(
    process.env.GIT_DEBOUNCE_SYNC_DELAY_SECONDS ?? "10",
    10,
  );
  if (isNaN(debounceSyncDelay) || debounceSyncDelay < 0) {
    throw new Error("GIT_DEBOUNCE_SYNC_DELAY_SECONDS must be a non-negative number");
  }

  const port = parseInt(process.env.PORT ?? "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid port number (1-65535)");
  }

  // GitHub OAuth
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  if (!githubClientId) {
    throw new Error("GITHUB_CLIENT_ID environment variable is required");
  }

  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!githubClientSecret) {
    throw new Error("GITHUB_CLIENT_SECRET environment variable is required");
  }

  const allowedGithubUsersRaw = process.env.ALLOWED_GITHUB_USERS;
  if (!allowedGithubUsersRaw || allowedGithubUsersRaw.trim() === "") {
    throw new Error("ALLOWED_GITHUB_USERS environment variable is required (comma-separated GitHub usernames)");
  }
  const allowedGithubUsers = allowedGithubUsersRaw
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter((u) => u.length > 0);
  if (allowedGithubUsers.length === 0) {
    throw new Error("ALLOWED_GITHUB_USERS must contain at least one username");
  }

  // OAuth 2.1
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

  const trustProxy = (process.env.TRUST_PROXY ?? "false").toLowerCase() === "true";

  const maxSessions = parseInt(process.env.MAX_SESSIONS ?? "100", 10);
  if (isNaN(maxSessions) || maxSessions < 1) {
    throw new Error("MAX_SESSIONS must be a positive number");
  }

  return {
    gitRepoUrl,
    gitBranch,
    gitSyncIntervalSeconds: syncInterval,
    gitDebounceSyncDelaySeconds: debounceSyncDelay,
    gitUserName,
    gitUserEmail,
    vaultPath: process.env.VAULT_PATH ?? "/vault",
    port,
    logLevel: process.env.LOG_LEVEL ?? "info",
    jwtSecret,
    serverUrl: serverUrl.replace(/\/$/, ""), // strip trailing slash
    accessTokenExpirySeconds: accessTokenExpiry,
    refreshTokenExpirySeconds: refreshTokenExpiry,
    githubClientId,
    githubClientSecret,
    allowedGithubUsers,
    trustProxy,
    maxSessions,
    promptsDir: process.env.PROMPTS_DIR ?? path.join(process.cwd(), "prompts"),
  };
}
