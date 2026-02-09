import { readFile, stat } from "node:fs/promises";
import { MAX_FILE_SIZE } from "./constants.js";

const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

function evictOldestEntries(): void {
  const entriesToRemove = cache.size - MAX_CACHE_ENTRIES;
  if (entriesToRemove <= 0) return;

  const iterator = cache.keys();
  for (let i = 0; i < entriesToRemove; i++) {
    const key = iterator.next().value;
    if (key !== undefined) cache.delete(key);
  }
}

/**
 * Reads a file with mtime-based caching. Returns cached content if the file
 * has not been modified since last read. Throws if the file does not exist
 * or exceeds MAX_FILE_SIZE.
 */
export async function readCachedFile(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);

  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
  }

  const mtime = fileStat.mtimeMs;

  const cached = cache.get(filePath);
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }

  const content = await readFile(filePath, "utf-8");

  if (cache.size >= MAX_CACHE_ENTRIES) {
    evictOldestEntries();
  }
  cache.set(filePath, { content, mtime });

  return content;
}

/**
 * Reads a file with mtime-based caching. Returns null if the file does not exist.
 */
export async function readCachedFileOptional(filePath: string): Promise<string | null> {
  try {
    return await readCachedFile(filePath);
  } catch {
    return null;
  }
}
