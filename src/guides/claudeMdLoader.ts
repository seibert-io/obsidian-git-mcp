import path from "node:path";
import { resolveVaultPathSafe } from "../utils/pathValidation.js";
import { readCachedFileOptional } from "../utils/fileCache.js";

const CLAUDE_MD_FILENAME = "CLAUDE.md";

export interface ClaudeMdEntry {
  path: string;
  content: string;
}

export async function loadRootClaudeMd(vaultPath: string): Promise<string | null> {
  return readCachedFileOptional(path.join(vaultPath, CLAUDE_MD_FILENAME));
}

export async function collectClaudeMdFiles(
  vaultPath: string,
  targetPath: string,
): Promise<ClaudeMdEntry[]> {
  // Validate the target path with symlink resolution (rejects traversal + symlink escape)
  await resolveVaultPathSafe(vaultPath, targetPath);

  const normalizedTarget = path.normalize(targetPath);
  // Root is excluded — delivered via get_obsidian_guide tool
  if (normalizedTarget === ".") {
    return [];
  }

  const segments = normalizedTarget.split(path.sep);
  const entries: ClaudeMdEntry[] = [];

  for (let i = 0; i < segments.length; i++) {
    const relativeDirPath = segments.slice(0, i + 1).join(path.sep);
    const absoluteClaudeMdPath = path.join(vaultPath, relativeDirPath, CLAUDE_MD_FILENAME);
    const content = await readCachedFileOptional(absoluteClaudeMdPath);
    if (content !== null) {
      entries.push({ path: relativeDirPath, content });
    }
  }

  return entries;
}
