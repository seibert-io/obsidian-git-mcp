import type { Config } from "../../src/config.js";

export const TEST_JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars-long";

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    gitRepoUrl: "https://example.com/repo.git",
    gitBranch: "main",
    gitSyncIntervalSeconds: 0,
    gitDebounceSyncDelaySeconds: 10,
    gitUserName: "Test",
    gitUserEmail: "test@example.com",
    vaultPath: "/tmp/test-vault",
    port: 0,
    logLevel: "error",
    jwtSecret: TEST_JWT_SECRET,
    serverUrl: "",
    accessTokenExpirySeconds: 3600,
    refreshTokenExpirySeconds: 604800,
    githubClientId: "test-github-client-id",
    githubClientSecret: "test-github-client-secret",
    allowedGithubUsers: ["alloweduser"],
    trustProxy: false,
    maxSessions: 100,
    promptsDir: "prompts",
    ...overrides,
  };
}
