import { describe, it, expect } from "vitest";
import { sanitizeErrorForClient, toolError } from "../src/utils/toolResponse.js";

describe("sanitizeErrorForClient", () => {
  it("removes absolute paths starting with /vault/", () => {
    const input = "ENOENT: no such file, open '/vault/secret/data.md'";
    expect(sanitizeErrorForClient(input)).not.toContain("/vault/");
    expect(sanitizeErrorForClient(input)).toContain("data.md");
  });

  it("removes absolute paths starting with /tmp/", () => {
    const input = "Error reading /tmp/test-vault/foo/bar.md";
    expect(sanitizeErrorForClient(input)).not.toContain("/tmp/");
    expect(sanitizeErrorForClient(input)).toContain("bar.md");
  });

  it("removes absolute paths starting with /home/", () => {
    const input = "Cannot find /home/user/.config/secret.json";
    expect(sanitizeErrorForClient(input)).not.toContain("/home/");
    expect(sanitizeErrorForClient(input)).toContain("secret.json");
  });

  it("replaces git object hashes with placeholder", () => {
    const hash = "a".repeat(40);
    const input = `merge conflict at ${hash}`;
    expect(sanitizeErrorForClient(input)).not.toContain(hash);
    expect(sanitizeErrorForClient(input)).toContain("<hash>");
  });

  it("replaces git refs with placeholder", () => {
    const input = "error: failed to push refs/heads/main";
    expect(sanitizeErrorForClient(input)).not.toContain("refs/heads/main");
    expect(sanitizeErrorForClient(input)).toContain("<ref>");
  });

  it("truncates messages exceeding 500 characters", () => {
    const input = "x".repeat(600);
    const result = sanitizeErrorForClient(input);
    expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("leaves short non-sensitive messages unchanged", () => {
    const input = "old_text not found in file";
    expect(sanitizeErrorForClient(input)).toBe(input);
  });

  it("removes absolute paths starting with /app/", () => {
    const input = "Error at /app/dist/tools/fileOperations.js:42";
    expect(sanitizeErrorForClient(input)).not.toContain("/app/");
    expect(sanitizeErrorForClient(input)).toContain("fileOperations.js:42");
  });

  it("removes absolute paths starting with /root/ and /opt/", () => {
    expect(sanitizeErrorForClient("Error at /root/.bashrc")).not.toContain("/root/");
    expect(sanitizeErrorForClient("Error at /opt/app/config.json")).not.toContain("/opt/");
  });

  it("handles combined sanitization (path + hash)", () => {
    const hash = "b".repeat(40);
    const input = `conflict in /vault/notes/daily.md at ${hash}`;
    const result = sanitizeErrorForClient(input);
    expect(result).not.toContain("/vault/");
    expect(result).not.toContain(hash);
    expect(result).toContain("daily.md");
    expect(result).toContain("<hash>");
  });
});

describe("toolError", () => {
  it("sanitizes error messages automatically", () => {
    const result = toolError("Error at /vault/secret/data.md");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("/vault/");
    expect(result.content[0].text).toContain("data.md");
  });
});
