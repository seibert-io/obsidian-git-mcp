# MCP Tools Reference

All tools operate within the vault directory boundary. Paths are relative to the vault root.

**Hidden directories:** The `.git` and `.claude` directories are automatically excluded from all listings, searches, file counts, and vault statistics. This is controlled by the `HIDDEN_DIRECTORIES` constant in `src/utils/constants.ts`.

## Batch Operations

Several tools support batch operations for processing multiple items in a single call. Batch support is implemented via `src/utils/batchUtils.ts`.

**General rules:**
- **Max batch size:** 10 items per call (`MAX_BATCH_SIZE`)
- **Backward compatible:** When a single item is provided (via the original parameters), the tool behaves exactly as before — no batch headers, no format change
- **Batch result format:** Each result is separated by a header line: `--- [N/total] path ---` followed by the result content. Failed items show `ERROR:` prefix in their content
- **Partial failure:** Individual items can fail without aborting the batch. Each result reports success/failure independently
- **Execution mode:** Read-only operations run in parallel (`Promise.all`). Write operations run sequentially with a single git commit at the end

## File Operations (`src/tools/fileOperations.ts`)

### `read_file`
Read file content from the vault. Supports batch reads.
- **Input (single)**: `{ path: string }`
- **Input (batch)**: `{ paths: string[] }` — max 10 paths
- **Batch execution**: Parallel
- **Returns (single)**: File content as text
- **Returns (batch)**: Batch-formatted results with headers per file

### `write_file`
Create or overwrite files in the vault. Auto-creates parent directories. Triggers git commit+push. Supports batch writes.
- **Input (single)**: `{ path: string, content: string }`
- **Input (batch)**: `{ files: Array<{ path: string, content: string }> }` — max 10 files
- **Batch execution**: Sequential writes, single git commit at the end
- **Returns (single)**: Confirmation message
- **Returns (batch)**: Batch-formatted results with headers per file

### `edit_file`
Find-and-replace in files. The `old_text` must match exactly once per file. Supports batch edits.
- **Input (single)**: `{ path: string, old_text: string, new_text: string }`
- **Input (batch)**: `{ edits: Array<{ path: string, old_text: string, new_text: string }> }` — max 10 edits
- **Batch execution**: Sequential edits, single git commit at the end
- **Returns (single)**: Confirmation message
- **Returns (batch)**: Batch-formatted results with headers per file
- **Errors**: If `old_text` is not found or matches more than once (per file; does not abort batch)

### `delete_file`
Delete a file. Triggers git commit+push.
- **Input**: `{ path: string }`
- **Returns**: Confirmation message

### `rename_file`
Move or rename a file. Triggers git commit+push.
- **Input**: `{ old_path: string, new_path: string }`
- **Returns**: Confirmation message

## Directory Operations (`src/tools/directoryOps.ts`)

### `list_directory`
List files and directories at vault paths. Supports batch listing.
- **Input (single)**: `{ path: string, recursive?: boolean, max_depth?: number }`
- **Input (batch)**: `{ paths: string[], recursive?: boolean, max_depth?: number }` — max 10 paths. `recursive` and `max_depth` apply to all paths in the batch
- **Batch execution**: Parallel
- **Returns (single)**: Formatted listing with `[file]` / `[directory]` type indicators
- **Returns (batch)**: Batch-formatted results with headers per directory

### `create_directory`
Create a directory including parent directories.
- **Input**: `{ path: string }`
- **Returns**: Confirmation message

## Search Operations (`src/tools/searchOperations.ts`)

### `search_files`
Find files by name pattern (glob). Supports batch searches.
- **Input (single)**: `{ pattern: string, path?: string }`
- **Input (batch)**: `{ searches: Array<{ pattern: string, path?: string }> }` — max 10 searches
- **Batch execution**: Parallel
- **Returns (single)**: Newline-separated list of matching file paths
- **Returns (batch)**: Batch-formatted results with headers per search

### `grep`
Search file contents by text or regex.
- **Input**: `{ query: string, path?: string, is_regex?: boolean, case_sensitive?: boolean, include_pattern?: string }`
- **Returns**: Matching lines with `file:line: content` format
- **Limit**: 500 results max

### `find_files`
Advanced file finder with filters. Supports batch queries.
- **Input (single)**: `{ path?: string, name?: string, modified_after?: string, modified_before?: string, size_min?: number, size_max?: number }`
- **Input (batch)**: `{ queries: Array<{ path?: string, name?: string, modified_after?: string, modified_before?: string, size_min?: number, size_max?: number }> }` — max 10 queries
- **Batch execution**: Parallel
- **Returns (single)**: File paths with size and modification timestamps
- **Returns (batch)**: Batch-formatted results with headers per query

## Vault Operations (`src/tools/vaultOperations.ts`)

### `get_vault_info`
Return vault statistics.
- **Input**: none
- **Returns**: Total files, markdown files, folder count, top-level folders, last sync time

### `get_backlinks`
Find all notes linking to a given note via `[[wikilink]]` syntax.
- **Input**: `{ path: string }`
- **Returns**: List of files containing backlinks with link count

### `get_tags`
Extract all tags from the vault or a specific file. Parses `#tag` inline syntax and YAML frontmatter `tags:` field.
- **Input**: `{ path?: string }`
- **Returns**: Tag list sorted by frequency

## History Operations (`src/tools/historyOperations.ts`)

### `get_recent_changes`
Show recent changes made to the vault with full diffs. Returns a list of recent commits showing what content was added, modified, or deleted in each file.
- **Input**: `{ count?: number }` — number of recent changes to retrieve (1–20, default 10)
- **Returns**: Numbered list of commits with date, message, and per-file diffs showing added (`+`) and removed (`-`) lines
- **Limits**: Max 80 diff lines per file (truncated with notice)
- **Example output**:
  ```
  1. 2026-02-08 12:00:00
     MCP: write notes/daily.md
     [added] notes/daily.md
    +# Daily Note 2026-02-08
    +- Meeting at 10am
    +- Review PRs

  2. 2026-02-08 11:30:00
     MCP: edit notes/project.md
     [modified] notes/project.md
    -Status: planning
    +Status: in progress
  ```

## CLAUDE.md Context (`src/tools/claudeContextOperations.ts`)

### `get_claude_context`
Returns CLAUDE.md instruction files found along the path from vault root to the specified directory. Use this before working in a specific vault subdirectory to discover directory-specific instructions and conventions. The root CLAUDE.md (already provided via server instructions) is excluded.
- **Input**: `{ path: string }` — vault-relative directory path (e.g. `projects/webapp`)
- **Returns**: Concatenated CLAUDE.md contents with path headers, or "No CLAUDE.md files found along this path."
- **How it works**: Walks each segment from vault root to the target path, checks for CLAUDE.md at each level, and returns all found files (excluding root). Uses mtime-based caching for performance.
- **Root CLAUDE.md**: Delivered separately via the MCP `instructions` field at session initialization. Not included in this tool's output.
- **Example output** for path `projects/webapp`:
  ```
  --- CLAUDE.md in projects/ ---
  # Project conventions
  Use kebab-case for filenames.

  --- CLAUDE.md in projects/webapp/ ---
  # Webapp specifics
  Components go in components/.
  ```

## Guide Operations (`src/tools/guideOperations.ts`)

### `get_obsidian_guide`
Returns best-practice guides for working with the Obsidian vault. Call this before creating or searching notes if unsure about vault conventions, link syntax, frontmatter format, or which search tool to use.
- **Input**: `{ topic: "conventions" | "create-note" | "search-strategy" | "all", note_type?: "daily" | "meeting" | "project" | "zettel" | "literature" }`
- **Returns**: Guide content as markdown text
- **Topics**:
  - `conventions` — Vault link syntax, frontmatter, tags, callouts, best practices
  - `create-note` — Note template for the given `note_type` (default: zettel)
  - `search-strategy` — Which search tool to use when
  - `all` — All guides concatenated

## MCP Prompts

Three prompts are registered for clients that support the MCP prompts capability:

| Prompt | Description | Arguments |
|---|---|---|
| `obsidian-conventions` | Vault conventions, link syntax, frontmatter, tags | none |
| `obsidian-create-note` | Template for a new note | `topic` (required), `note_type` (optional) |
| `obsidian-search-strategy` | Which search tool to use when | none |

Prompts return the same content as the `get_obsidian_guide` tool, reading from the same markdown source files in `prompts/`.
