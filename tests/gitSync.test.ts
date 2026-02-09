import { describe, it, expect } from "vitest";
import { sanitizeCommitMessage } from "../src/git/gitSync.js";

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
