import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sanitizeCommitMessage, git, sanitizeGitEnv, SECRETS_TO_STRIP } from "../src/git/gitSync.js";

// Mock always succeeds — tests verify env passing, not actual git execution
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd, _args, _opts, callback) => {
    callback(null, "", "");
  }),
}));

describe("sanitizeGitEnv", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of SECRETS_TO_STRIP) {
      process.env[key] = `test-value-for-${key}`;
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("strips all application secrets from the environment", () => {
    const env = sanitizeGitEnv();

    for (const key of SECRETS_TO_STRIP) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("preserves non-secret environment variables like HTTP_PROXY", () => {
    process.env.HTTP_PROXY = "http://proxy:8080";

    const env = sanitizeGitEnv();

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.HTTP_PROXY).toBe("http://proxy:8080");
  });

  it("sets GIT_TERMINAL_PROMPT to 0", () => {
    const env = sanitizeGitEnv();

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not mutate process.env", () => {
    sanitizeGitEnv();

    for (const key of SECRETS_TO_STRIP) {
      expect(process.env[key]).toBe(`test-value-for-${key}`);
    }
  });
});

describe("git child process env", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("passes sanitized env to execFile", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    process.env.JWT_SECRET = "test-secret-that-should-not-leak-to-git";

    await git(["status"], "/tmp");

    const callOptions = mockedExecFile.mock.calls[0]?.[2] as Record<string, unknown>;
    const childEnv = callOptions?.env as Record<string, string> | undefined;

    expect(childEnv).toBeDefined();
    expect(childEnv).not.toHaveProperty("JWT_SECRET");
    expect(childEnv?.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("sanitizeCommitMessage", () => {
  it("removes newline characters", () => {
    expect(sanitizeCommitMessage("line1\nline2")).toBe("line1 line2");
  });

  it("removes carriage return characters", () => {
    expect(sanitizeCommitMessage("line1\rline2")).toBe("line1 line2");
  });

  it("removes null bytes", () => {
    expect(sanitizeCommitMessage("file\0name")).toBe("file name");
  });

  it("replaces all control characters with spaces", () => {
    expect(sanitizeCommitMessage("a\x01b\x1fc")).toBe("a b c");
  });

  it("truncates messages exceeding 200 characters", () => {
    const long = "x".repeat(250);
    expect(sanitizeCommitMessage(long).length).toBe(200);
  });

  it("does not truncate messages at or below 200 characters", () => {
    const exact = "y".repeat(200);
    expect(sanitizeCommitMessage(exact)).toBe(exact);
  });

  it("leaves normal messages unchanged", () => {
    expect(sanitizeCommitMessage("MCP: write notes/daily.md")).toBe(
      "MCP: write notes/daily.md",
    );
  });
});
