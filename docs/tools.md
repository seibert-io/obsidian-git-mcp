# MCP Tools Reference

All tools operate within the vault directory boundary. Paths are relative to the vault root.

**Hidden directories:** The `.git` and `.claude` directories are automatically excluded from all listings, searches, file counts, and vault statistics. This is controlled by the `HIDDEN_DIRECTORIES` constant in `src/utils/constants.ts`.

## Tool Annotations

All tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#annotations) to signal their behavior to clients:

| Annotation | Value | Tools |
|---|---|---|
| `readOnlyHint` | `true` | `read_file`, `list_directory`, `is_directory`, `search_files`, `grep`, `find_files`, `get_vault_info`, `get_backlinks`, `get_tags`, `get_recent_changes`, `get_obsidian_guide`, `get_claude_context` |
| `destructiveHint` | `true` | `write_file`, `edit_file`, `delete_file`, `rename_file`, `move_file`, `move_directory` |

`create_directory` has no annotation hints set (it modifies the vault but is not destructive).

### Preview Recommendation for Write Operations

The server recommends (via tool descriptions and server instructions) that clients **present planned changes to the user before executing** any write operation:

- **`write_file`**: Show the intended file content — full content for small files, a representative excerpt for large ones
- **`edit_file`**: Show how the file will look after the edit — full resulting content for small files, a relevant excerpt around the changed section for large ones
- **`delete_file`**: State which file will be deleted and confirm the action
- **`rename_file`**: State the source and destination paths
- **`move_file`**: State the source and destination paths
- **`move_directory`**: State the source and destination directory paths
- **`create_directory`**: State which directory will be created

This is a **recommendation**, not enforcement — the server has no mechanism to block execution. Clients that support human-in-the-loop confirmation (e.g., via `destructiveHint`) should use these signals to prompt for user review.

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

### `read_file_lines`
Read a range of lines from a file. Returns numbered lines with a header showing the range and total line count. Supports negative `start_line` for reading from the end (like Python's negative indexing). Useful for reading frontmatter, tailing logs, or sequentially processing large files.
- **Input**: `{ path: string, start_line: number, end_line?: number }`
  - `start_line`: 1-based. Positive = from start, negative = from end (`-50` = last 50 lines)
  - `end_line`: 1-based, inclusive. Omit to read to end of file. Cannot be used with negative `start_line`
- **Returns**: Header line (`Lines 3-5 of 200 total lines in path:`) followed by numbered lines (`3: content`)
- **Clamping**: `end_line` is clamped to actual line count; negative `start_line` is clamped to line 1
- **Limits**: Max 500 lines per request (`MAX_LINES_PER_PARTIAL_READ`)
- **Examples**:
  - Head (first 20 lines): `{ path: "note.md", start_line: 1, end_line: 20 }`
  - Tail (last 50 lines): `{ path: "note.md", start_line: -50 }`
  - Middle range: `{ path: "note.md", start_line: 100, end_line: 200 }`
  - From line to end: `{ path: "note.md", start_line: 100 }`
- **Errors**: `end_line < start_line`, `end_line` with negative `start_line`, range exceeds max, path traversal, file too large, file not found

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
Move or rename a file using `git mv` to preserve git history. The target parent directory must already exist — use `create_directory` first if needed. Triggers git commit+push.
- **Input**: `{ old_path: string, new_path: string }`
- **Returns**: Confirmation message
- **Errors**: Target directory does not exist, path traversal

### `move_file`
Move a file to a new location using `git mv` to preserve git history. The target parent directory must already exist — use `create_directory` first if needed. Validates that the source is a file (not a directory). Triggers git commit+push.
- **Input**: `{ old_path: string, new_path: string }`
- **Returns**: Confirmation message
- **Errors**: Source is not a file, target directory does not exist, path traversal

## Directory Operations (`src/tools/directoryOps.ts`)

### `list_directory`
List files and directories at vault paths. Supports batch listing.
- **Input (single)**: `{ path: string, recursive?: boolean, max_depth?: number }`
- **Input (batch)**: `{ paths: string[], recursive?: boolean, max_depth?: number }` — max 10 paths. `recursive` and `max_depth` apply to all paths in the batch
- **Batch execution**: Parallel
- **Returns (single)**: Formatted listing with `[file]` / `[directory]` type indicators
- **Returns (batch)**: Batch-formatted results with headers per directory

### `create_directory`
Create a directory including parent directories. Supports recursive creation — multiple directory levels can be created at once (e.g., `a/b/c` creates all three levels).
- **Input**: `{ path: string }`
- **Returns**: Confirmation message

### `is_directory`
Check whether a path exists and is a directory in the vault.
- **Input**: `{ path: string }`
- **Returns**: One of three results:
  - `Directory exists: <path>` — path exists and is a directory
  - `Directory does not exist: <path>` — path does not exist
  - `Path exists but is not a directory: <path>` — path exists but is a file

### `move_directory`
Move a directory and all its contents to a new location using `git mv` to preserve git history for all files inside. The target parent directory must already exist — use `create_directory` first if needed. Triggers git commit+push.
- **Input**: `{ old_path: string, new_path: string }`
- **Returns**: Confirmation message
- **Errors**: Source is not a directory, target parent directory does not exist, path traversal

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
Returns CLAUDE.md instruction files found along the path from vault root to the specified directory. Use this before working in a specific vault subdirectory to discover directory-specific instructions and conventions. The root CLAUDE.md (delivered via `get_obsidian_guide`) is not included — only subdirectory-level CLAUDE.md files.
- **Input**: `{ path: string }` — vault-relative directory path (e.g. `projects/webapp`)
- **Returns**: Concatenated CLAUDE.md contents with path and scope headers, or "No CLAUDE.md files found along this path."
- **How it works**: Walks each segment from vault root to the target path, checks for CLAUDE.md at each level, and returns all found files (excluding root). Uses mtime-based caching for performance.
- **Root CLAUDE.md**: Delivered via the `get_obsidian_guide` tool (topic `conventions` or `all`). Not included in this tool's output.
- **Example output** for path `projects/webapp`:
  ```
  --- CLAUDE.md from projects/ (applies to projects/ and all its subdirectories) ---
  # Project conventions
  Use kebab-case for filenames.

  --- CLAUDE.md from projects/webapp/ (applies to projects/webapp/ and all its subdirectories) ---
  # Webapp specifics
  Components go in components/.
  ```

## Guide Operations (`src/tools/guideOperations.ts`)

### `get_obsidian_guide`
**IMPORTANT: Clients should call this tool with topic `conventions` at the start of every conversation before performing any vault operations.** This is the primary delivery mechanism for vault-specific CLAUDE.md instructions.

Returns best-practice guides for working with the Obsidian vault, including the vault's root CLAUDE.md instructions (when topic is `conventions` or `all`).
- **Input**: `{ topic: "conventions" | "create-note" | "search-strategy" | "all", note_type?: "daily" | "meeting" | "project" | "zettel" | "literature" }`
- **Returns**: Guide content as markdown text. For `conventions` and `all`, the root CLAUDE.md is prepended (if it exists in the vault).
- **Topics**:
  - `conventions` — **Root CLAUDE.md (if present)** + vault link syntax, frontmatter, tags, callouts, best practices
  - `create-note` — Note template for the given `note_type` (default: zettel)
  - `search-strategy` — Which search tool to use when
  - `all` — **Root CLAUDE.md (if present)** + all guides concatenated

## MCP Prompts

Three prompts are registered for clients that support the MCP prompts capability:

| Prompt | Description | Arguments |
|---|---|---|
| `obsidian-conventions` | Vault conventions, link syntax, frontmatter, tags — includes root CLAUDE.md if present | none |
| `obsidian-create-note` | Template for a new note | `topic` (required), `note_type` (optional) |
| `obsidian-search-strategy` | Which search tool to use when | none |

Prompts return the same content as the `get_obsidian_guide` tool, reading from the same markdown source files in `prompts/`. The `obsidian-conventions` prompt also includes the root CLAUDE.md, matching the behavior of `get_obsidian_guide` with topic `conventions`.
