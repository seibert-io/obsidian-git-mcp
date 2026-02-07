import { describe, it, expect } from "vitest";
import { resolveVaultPath, PathValidationError } from "../src/utils/pathValidation.js";

const VAULT = "/vault";

describe("resolveVaultPath", () => {
  it("resolves a simple relative path", () => {
    const result = resolveVaultPath(VAULT, "notes/test.md");
    expect(result).toBe("/vault/notes/test.md");
  });

  it("resolves a path with current directory", () => {
    const result = resolveVaultPath(VAULT, "./notes/test.md");
    expect(result).toBe("/vault/notes/test.md");
  });

  it("resolves a bare filename", () => {
    const result = resolveVaultPath(VAULT, "test.md");
    expect(result).toBe("/vault/test.md");
  });

  it("resolves the vault root itself", () => {
    const result = resolveVaultPath(VAULT, ".");
    expect(result).toBe("/vault");
  });

  it("rejects empty path", () => {
    expect(() => resolveVaultPath(VAULT, "")).toThrow(PathValidationError);
    expect(() => resolveVaultPath(VAULT, "  ")).toThrow(PathValidationError);
  });

  it("rejects path traversal with ..", () => {
    expect(() => resolveVaultPath(VAULT, "../etc/passwd")).toThrow(
      PathValidationError,
    );
  });

  it("rejects path traversal with nested ..", () => {
    expect(() => resolveVaultPath(VAULT, "notes/../../etc/passwd")).toThrow(
      PathValidationError,
    );
  });

  it("rejects absolute path outside vault", () => {
    expect(() => resolveVaultPath(VAULT, "/etc/passwd")).toThrow(
      PathValidationError,
    );
  });

  it("rejects access to .git directory", () => {
    expect(() => resolveVaultPath(VAULT, ".git/config")).toThrow(
      PathValidationError,
    );
  });

  it("rejects access to .git subdirectory", () => {
    expect(() => resolveVaultPath(VAULT, ".git/objects/abc")).toThrow(
      PathValidationError,
    );
  });

  it("rejects nested .git directory (submodules)", () => {
    expect(() => resolveVaultPath(VAULT, "submodule/.git/config")).toThrow(
      PathValidationError,
    );
  });

  it("rejects .gitmodules file", () => {
    expect(() => resolveVaultPath(VAULT, ".gitmodules")).toThrow(
      PathValidationError,
    );
  });

  it("rejects .gitattributes file", () => {
    expect(() => resolveVaultPath(VAULT, ".gitattributes")).toThrow(
      PathValidationError,
    );
  });

  it("allows files with git in the name (not .git dir)", () => {
    const result = resolveVaultPath(VAULT, "git-notes.md");
    expect(result).toBe("/vault/git-notes.md");
  });

  it("allows nested directories", () => {
    const result = resolveVaultPath(VAULT, "a/b/c/d/e.md");
    expect(result).toBe("/vault/a/b/c/d/e.md");
  });

  it("rejects sneaky path traversal", () => {
    expect(() => resolveVaultPath(VAULT, "notes/../../../etc/shadow")).toThrow(
      PathValidationError,
    );
  });

  it("throws PathValidationError type", () => {
    try {
      resolveVaultPath(VAULT, "../escape");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PathValidationError);
      expect((error as PathValidationError).name).toBe("PathValidationError");
    }
  });
});
