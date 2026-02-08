import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const PROMPTS_DIR = process.env.PROMPTS_DIR ?? path.join(process.cwd(), "prompts");

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

async function readGuideFile(filename: string): Promise<string> {
  const filePath = path.join(PROMPTS_DIR, filename);
  const fileStat = await stat(filePath);
  const mtime = fileStat.mtimeMs;

  const cached = cache.get(filename);
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }

  const content = await readFile(filePath, "utf-8");
  cache.set(filename, { content, mtime });
  return content;
}

export async function loadGuide(topic: string): Promise<string> {
  switch (topic) {
    case "conventions":
      return readGuideFile("obsidian-conventions.md");
    case "search-strategy":
      return readGuideFile("obsidian-search-strategy.md");
    default:
      throw new Error(`Unknown guide topic: ${topic}`);
  }
}

export async function loadNoteTemplate(noteType: string, topic: string): Promise<string> {
  const raw = await readGuideFile("obsidian-create-note.md");

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

export async function loadAllGuides(): Promise<string> {
  const conventions = await loadGuide("conventions");
  const searchStrategy = await loadGuide("search-strategy");
  const createNote = await readGuideFile("obsidian-create-note.md");

  return [
    conventions,
    "\n---\n",
    createNote,
    "\n---\n",
    searchStrategy,
  ].join("\n");
}
