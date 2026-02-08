import { readFile, stat } from "node:fs/promises";
import path from "node:path";

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

async function readGuideFile(promptsDir: string, filename: string): Promise<string> {
  const filePath = path.join(promptsDir, filename);
  const fileStat = await stat(filePath);
  const mtime = fileStat.mtimeMs;

  const cacheKey = `${promptsDir}:${filename}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }

  const content = await readFile(filePath, "utf-8");
  cache.set(cacheKey, { content, mtime });
  return content;
}

export async function loadGuide(promptsDir: string, topic: string): Promise<string> {
  switch (topic) {
    case "conventions":
      return readGuideFile(promptsDir, "obsidian-conventions.md");
    case "search-strategy":
      return readGuideFile(promptsDir, "obsidian-search-strategy.md");
    default:
      throw new Error(`Unknown guide topic: ${topic}`);
  }
}

export async function loadNoteTemplate(promptsDir: string, noteType: string, topic: string): Promise<string> {
  const raw = await readGuideFile(promptsDir, "obsidian-create-note.md");

  // Parse the template for the given note type
  const marker = `## type: ${noteType}`;
  const startIdx = raw.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`Unknown note type: ${noteType}. Available: zettel, meeting, daily, project, literature`);
  }

  // Find the end of this template (next ## type: or end of file)
  const afterMarker = startIdx + marker.length;
  const nextMarker = raw.indexOf("\n## type: ", afterMarker);
  const templateRaw = nextMarker === -1
    ? raw.slice(afterMarker)
    : raw.slice(afterMarker, nextMarker);

  // Replace template variables (use callback to prevent $ special sequences in topic)
  const today = new Date().toISOString().split("T")[0];
  const result = templateRaw
    .replace(/\{\{topic\}\}/g, () => topic)
    .replace(/\{\{today\}\}/g, () => today)
    .trim();

  return result;
}

export async function loadAllGuides(promptsDir: string): Promise<string> {
  const conventions = await loadGuide(promptsDir, "conventions");
  const searchStrategy = await loadGuide(promptsDir, "search-strategy");
  const createNote = await readGuideFile(promptsDir, "obsidian-create-note.md");

  return [
    conventions,
    "\n---\n",
    createNote,
    "\n---\n",
    searchStrategy,
  ].join("\n");
}
