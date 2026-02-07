import path from "node:path";
import { realpath, lstat } from "node:fs/promises";

/**
 * Resolves and validates that a given path stays within the vault directory.
 * Returns the resolved absolute path.
 * Throws if the path escapes the vault or accesses .git.
 */
export function resolveVaultPath(vaultPath: string, filePath: string): string {
  if (!filePath || filePath.trim() === "") {
    throw new PathValidationError("Path cannot be empty");
  }

  // Normalize the vault path
  const normalizedVault = path.resolve(vaultPath);

  // Resolve the target path relative to the vault
  const resolved = path.resolve(normalizedVault, filePath);

  // Ensure the resolved path is within the vault
  if (!resolved.startsWith(normalizedVault + path.sep) && resolved !== normalizedVault) {
    throw new PathValidationError(
      `Path traversal detected: "${filePath}" resolves outside the vault`,
    );
  }

  // Block access to .git directory and git metadata files in any path component
  const relative = path.relative(normalizedVault, resolved);
  const parts = relative.split(path.sep);
  if (parts.some((p) => p === ".git") || parts[0]?.startsWith(".git")) {
    throw new PathValidationError("Access to git metadata is not allowed");
  }

  return resolved;
}

/**
 * Resolves a vault path and also checks for symlink escape.
 * Use this for any file I/O operation (read, write, edit, delete, rename).
 * Throws if the real (symlink-resolved) path is outside the vault.
 */
export async function resolveVaultPathSafe(vaultPath: string, filePath: string): Promise<string> {
  const resolved = resolveVaultPath(vaultPath, filePath);

  // Check if the target is a symlink escaping the vault
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) {
      const real = await realpath(resolved);
      const normalizedVault = path.resolve(vaultPath);
      if (!real.startsWith(normalizedVault + path.sep) && real !== normalizedVault) {
        throw new PathValidationError(
          `Symlink escape detected: "${filePath}" points outside the vault`,
        );
      }
    }
  } catch (error) {
    // If the file doesn't exist yet (e.g., write_file creating a new file), that's OK
    if (error instanceof PathValidationError) throw error;
  }

  return resolved;
}

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}
