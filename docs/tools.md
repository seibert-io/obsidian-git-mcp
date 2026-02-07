# MCP Tools Reference

All tools operate within the vault directory boundary. Paths are relative to the vault root.

## File Operations (`src/tools/fileOperations.ts`)

### `read_file`
Read a single file's content.
- **Input**: `{ path: string }`
- **Returns**: File content as text

### `write_file`
Create or overwrite a file. Auto-creates parent directories. Triggers git commit+push.
- **Input**: `{ path: string, content: string }`
- **Returns**: Confirmation message

### `edit_file`
Find-and-replace in a file. The `old_text` must match exactly once.
- **Input**: `{ path: string, old_text: string, new_text: string }`
- **Returns**: Confirmation message
- **Errors**: If `old_text` is not found or matches more than once

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
List files and directories at a path.
- **Input**: `{ path: string, recursive?: boolean, max_depth?: number }`
- **Returns**: Formatted listing with `[file]` / `[directory]` type indicators

### `create_directory`
Create a directory including parent directories.
- **Input**: `{ path: string }`
- **Returns**: Confirmation message

## Search Operations (`src/tools/searchOperations.ts`)

### `search_files`
Find files by glob pattern.
- **Input**: `{ pattern: string, path?: string }`
- **Returns**: Newline-separated list of matching file paths

### `grep`
Search file contents by text or regex.
- **Input**: `{ query: string, path?: string, is_regex?: boolean, case_sensitive?: boolean, include_pattern?: string }`
- **Returns**: Matching lines with `file:line: content` format
- **Limit**: 500 results max

### `find_files`
Advanced file finder with filters.
- **Input**: `{ path?: string, name?: string, modified_after?: string, modified_before?: string, size_min?: number, size_max?: number }`
- **Returns**: File paths with size and modification timestamps

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
