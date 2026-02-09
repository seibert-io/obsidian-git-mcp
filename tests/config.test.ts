import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const VALID_ENV = {
  GIT_REPO_URL: "https://example.com/repo.git",
  GIT_BRANCH: "main",
  GIT_USER_NAME: "Test User",
  GIT_USER_EMAIL: "test@example.com",
  GITHUB_CLIENT_ID: "test-id",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_GITHUB_USERS: "testuser",
  JWT_SECRET: "a-secret-that-is-at-least-32-chars-long!",
  SERVER_URL: "https://example.com",
};

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Set all required env vars for each test
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // --- Control character validation ---

  it("rejects GIT_BRANCH containing newline", () => {
    process.env.GIT_BRANCH = "main\ninjected";
    expect(() => loadConfig()).toThrow("GIT_BRANCH must not contain control characters");
  });

  it("rejects GIT_BRANCH containing carriage return", () => {
    process.env.GIT_BRANCH = "main\rinjected";
    expect(() => loadConfig()).toThrow("GIT_BRANCH must not contain control characters");
  });

  it("rejects GIT_BRANCH containing null byte", () => {
    process.env.GIT_BRANCH = "main\0injected";
    expect(() => loadConfig()).toThrow("GIT_BRANCH must not contain control characters");
  });

  it("rejects GIT_USER_NAME containing control characters", () => {
    process.env.GIT_USER_NAME = "User\nName";
    expect(() => loadConfig()).toThrow("GIT_USER_NAME must not contain control characters");
  });

  it("rejects GIT_USER_EMAIL containing control characters", () => {
    process.env.GIT_USER_EMAIL = "user\0@example.com";
    expect(() => loadConfig()).toThrow("GIT_USER_EMAIL must not contain control characters");
  });

  it("rejects GIT_REPO_URL containing control characters", () => {
    process.env.GIT_REPO_URL = "https://example.com/repo\n.git";
    expect(() => loadConfig()).toThrow("GIT_REPO_URL must not contain control characters");
  });

  // --- Valid values (regression) ---

  it("accepts valid branch names with hyphens and slashes", () => {
    process.env.GIT_BRANCH = "feature/my-branch";
    const config = loadConfig();
    expect(config.gitBranch).toBe("feature/my-branch");
  });

  it("accepts valid user names with spaces", () => {
    process.env.GIT_USER_NAME = "Claude MCP";
    const config = loadConfig();
    expect(config.gitUserName).toBe("Claude MCP");
  });

  it("accepts valid email with @ and dots", () => {
    process.env.GIT_USER_EMAIL = "mcp@example.com";
    const config = loadConfig();
    expect(config.gitUserEmail).toBe("mcp@example.com");
  });

  // --- Existing hyphen validation (regression) ---

  it("rejects GIT_BRANCH starting with hyphen", () => {
    process.env.GIT_BRANCH = "-malicious";
    expect(() => loadConfig()).toThrow("GIT_BRANCH must not start with a hyphen");
  });

  it("rejects GIT_USER_NAME starting with hyphen", () => {
    process.env.GIT_USER_NAME = "-malicious";
    expect(() => loadConfig()).toThrow("GIT_USER_NAME must not start with a hyphen");
  });

  it("rejects GIT_USER_EMAIL starting with hyphen", () => {
    process.env.GIT_USER_EMAIL = "-malicious";
    expect(() => loadConfig()).toThrow("GIT_USER_EMAIL must not start with a hyphen");
  });

  // --- MAX_SESSIONS validation ---

  it("uses default maxSessions of 100", () => {
    const config = loadConfig();
    expect(config.maxSessions).toBe(100);
  });

  it("accepts custom MAX_SESSIONS value", () => {
    process.env.MAX_SESSIONS = "50";
    const config = loadConfig();
    expect(config.maxSessions).toBe(50);
  });

  it("rejects non-positive MAX_SESSIONS", () => {
    process.env.MAX_SESSIONS = "0";
    expect(() => loadConfig()).toThrow("MAX_SESSIONS must be a positive number");
  });

  it("rejects non-numeric MAX_SESSIONS", () => {
    process.env.MAX_SESSIONS = "abc";
    expect(() => loadConfig()).toThrow("MAX_SESSIONS must be a positive number");
  });
});
