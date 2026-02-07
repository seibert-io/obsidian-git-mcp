# Project Briefing: Obsidian Vault Remote MCP Server

## Goal

Build a Dockerized Remote MCP Server that exposes a Git-synced Obsidian vault via filesystem tools (read, write, search, grep, list, etc.) to Claude.ai over Streamable HTTP (SSE). This enables Claude.ai — including on iOS — to read and write Obsidian notes via a Custom MCP Integration.

## Architecture Overview

```
┌─────────────┐     git push      ┌──────────────────────────────┐
│ Obsidian +   │ ──────────────►  │  Docker Container             │
│ Obsidian Git │                  │                                │
│ Plugin       │ ◄────────────── │  ┌────────────────────────┐    │
│ (iPhone/Mac) │     git pull     │  │  Git Sync (cron/startup)│    │
└─────────────┘                  │  └────────┬───────────────┘    │
                                 │           │ /vault              │
┌─────────────┐  SSE/HTTP        │  ┌────────▼───────────────┐    │
│ Claude.ai    │ ◄─────────────► │  │  MCP Server (Node.js)   │    │
│ (any device) │  Bearer Token   │  │  - FS tools on /vault   │    │
└─────────────┘                  │  │  - Auth middleware       │    │
                                 │  └────────────────────────┘    │
                                 └──────────────────────────────┘
```

## Tech Stack

- **Runtime**: Node.js (LTS) + TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk` (latest)
- **Transport**: Streamable HTTP (SSE) — this is what Claude.ai Custom Integrations expect
- **Auth**: Bearer Token (static API key, configurable via env var)
- **Git**: CLI git inside the container for vault sync
- **Container**: Docker, single lightweight image (node:22-slim base)

## Configuration (Environment Variables)

All config via env vars, with sensible defaults where possible:

|Variable                   |Required|Description                  |Example                            |
|---------------------------|--------|-----------------------------|-----------------------------------|
|`MCP_API_TOKEN`            |yes     |Bearer token for auth        |`my-secret-token-123`              |
|`GIT_REPO_URL`             |yes     |Git remote URL (HTTPS or SSH)|`https://github.com/user/vault.git`|
|`GIT_BRANCH`               |no      |Branch to sync               |`main` (default)                   |
|`GIT_SYNC_INTERVAL_SECONDS`|no      |Auto-pull interval           |`300` (default, 5 min)             |
|`GIT_USER_NAME`            |no      |Git commit author name       |`Claude MCP` (default)             |
|`GIT_USER_EMAIL`           |no      |Git commit author email      |`mcp@example.com` (default)        |
|`VAULT_PATH`               |no      |Path inside container        |`/vault` (default)                 |
|`PORT`                     |no      |Server port                  |`3000` (default)                   |
|`LOG_LEVEL`                |no      |Logging verbosity            |`info` (default)                   |

For private repos, either:

- Use `https://<PAT>@github.com/user/vault.git` as `GIT_REPO_URL`
- Or mount an SSH key and use SSH URL

## MCP Tools to Implement

Implement comprehensive filesystem tools scoped to the vault directory. The server must **never** allow access outside `VAULT_PATH`.

### Core File Operations

1. **`read_file`** — Read a single file’s content
- params: `{ path: string }`
- returns: file content as text
1. **`write_file`** — Create or overwrite a file
- params: `{ path: string, content: string }`
- Auto-creates parent directories
- Triggers git add + commit + push
1. **`edit_file`** — Find-and-replace in a file (like `str_replace`)
- params: `{ path: string, old_text: string, new_text: string }`
- `old_text` must match exactly once
- Triggers git add + commit + push
1. **`delete_file`** — Delete a file
- params: `{ path: string }`
- Triggers git add + commit + push
1. **`rename_file`** — Move/rename a file
- params: `{ old_path: string, new_path: string }`
- Triggers git add + commit + push

### Directory Operations

1. **`list_directory`** — List files/dirs in a path
- params: `{ path: string, recursive?: boolean, max_depth?: number }`
- returns: structured listing with type indicators (file/dir)
1. **`create_directory`** — Create a directory (including parents)
- params: `{ path: string }`

### Search Operations

1. **`search_files`** — Find files by name pattern (glob)
- params: `{ pattern: string, path?: string }`
- e.g., `*.md`, `**/daily/*.md`
1. **`grep`** — Search file contents (regex or literal)
- params: `{ query: string, path?: string, is_regex?: boolean, case_sensitive?: boolean, include_pattern?: string }`
- returns: matching lines with file paths and line numbers
1. **`find_files`** — Advanced file finder
- params: `{ path?: string, name?: string, modified_after?: string, modified_before?: string, size_min?: number, size_max?: number }`

### Vault-Specific Operations

1. **`get_vault_info`** — Return vault stats
- total files, total markdown files, folder structure overview, last sync time
1. **`get_backlinks`** — Find all notes linking to a given note
- params: `{ path: string }`
- Searches for `[[filename]]` and `[[filename|alias]]` patterns
1. **`get_tags`** — Extract all tags from the vault or a specific file
- params: `{ path?: string }`
- Parses `#tag` and YAML frontmatter tags

## Git Sync Behavior

### Pull (read sync)

- On container startup: `git clone` or `git pull`
- Periodic pull based on `GIT_SYNC_INTERVAL_SECONDS`
- Before every **read** operation: check if pull is needed (optional, configurable)

### Push (write sync)

- After every write operation (write, edit, delete, rename):
1. `git add .`
1. `git commit -m "MCP: <operation> <path>"`
1. `git push`
- Handle merge conflicts gracefully — pull before push, fail with clear error if conflict arises

### Sync Status

- Track last successful sync timestamp
- Expose via `get_vault_info` tool

## Security Requirements

1. **Path traversal prevention**: All paths must be resolved and validated to stay within `VAULT_PATH`. Reject any path containing `..` or resolving outside the vault.
1. **Bearer token auth**: Every HTTP request must include `Authorization: Bearer <MCP_API_TOKEN>`. Return 401 on mismatch.
1. **Read-only `.git` directory**: Never expose `.git` contents through any tool.
1. **Input validation**: Validate all tool parameters. Reject empty paths, invalid globs, etc.

## Project Structure

```
obsidian-mcp-server/
├── Dockerfile
├── docker-compose.yml          # Example compose with env vars
├── .env.example                # Template for env vars
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                # Entry point: start server
│   ├── server.ts               # MCP server setup + tool registration
│   ├── transport.ts            # Streamable HTTP/SSE transport setup
│   ├── auth.ts                 # Bearer token middleware
│   ├── tools/
│   │   ├── fileOperations.ts   # read, write, edit, delete, rename
│   │   ├── directoryOps.ts     # list, create directory
│   │   ├── searchOperations.ts # search, grep, find
│   │   └── vaultOperations.ts  # vault info, backlinks, tags
│   ├── git/
│   │   └── gitSync.ts          # Clone, pull, push, conflict handling
│   ├── utils/
│   │   ├── pathValidation.ts   # Path sanitization + traversal prevention
│   │   └── logger.ts           # Structured logging
│   └── config.ts               # Env var parsing + validation
├── .dockerignore
└── README.md                   # Setup + usage instructions
```

## Dockerfile Requirements

- Base image: `node:22-slim`
- Install `git` via apt
- Multi-stage build: build TypeScript in builder stage, run from slim image
- Non-root user for runtime
- `HEALTHCHECK` instruction
- Expose `PORT`

## docker-compose.yml

Provide a working example with:

- All env vars with placeholder values
- Volume mount option (commented out) as alternative to Git sync
- Port mapping
- Restart policy

## Error Handling

- All tool handlers must return structured errors, never crash the server
- Git operations must have timeouts
- File operations must handle encoding issues gracefully (UTF-8 default, binary files should be skipped/flagged)
- Log all errors with context (tool name, params, error message)

## Testing

- Include basic unit tests for path validation logic (this is security-critical)
- Include a simple integration test that starts the server and calls a tool

## Implementation Notes

- Use `node:fs/promises` for all file operations
- Use `child_process.execFile` (not `exec`) for git commands to avoid shell injection
- Use `glob` or `fast-glob` for pattern matching
- Use `ripgrep` if available in container, fallback to Node.js grep implementation
- Keep the MCP tool schemas strict — use JSON Schema validation for all params

## Out of Scope (for now)

- OAuth 2.0 (Bearer token is sufficient for personal use)
- Multi-vault support
- Obsidian plugin API integration
- Attachment/binary file handling (focus on text/markdown)
- Real-time file watching
