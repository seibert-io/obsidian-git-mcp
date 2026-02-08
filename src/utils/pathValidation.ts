import path from "node:path";
import { realpath } from "node:fs/promises";

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
  const normalizedVault = path.resolve(vaultPath);

  // Resolve all symlinks (including intermediate directories) and verify
  // the real path is still within the vault.
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(normalizedVault + path.sep) && real !== normalizedVault) {
      throw new PathValidationError(
        `Symlink escape detected: "${filePath}" resolves outside the vault`,
      );
    }
  } catch (error) {
    if (error instanceof PathValidationError) throw error;
    // File doesn't exist yet (e.g., write_file creating a new file) —
    // walk up the directory tree to find the closest existing ancestor
    // and verify it resolves inside the vault.
    let ancestor = path.dirname(resolved);
    while (ancestor !== normalizedVault) {
      try {
        const realAncestor = await realpath(ancestor);
        if (!realAncestor.startsWith(normalizedVault + path.sep) && realAncestor !== normalizedVault) {
          throw new PathValidationError(
            `Symlink escape detected: ancestor of "${filePath}" resolves outside the vault`,
          );
        }
        break; // Found an existing ancestor inside the vault — safe
      } catch (ancestorError) {
        if (ancestorError instanceof PathValidationError) throw ancestorError;
        // This ancestor doesn't exist either — keep walking up
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break; // Reached filesystem root — stop
        ancestor = parent;
      }
    }
  }

  return resolved;
}

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}
