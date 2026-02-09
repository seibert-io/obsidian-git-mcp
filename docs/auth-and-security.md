# Authentication & Security

## Authentication

### JWT Auth (`src/auth.ts`)

All requests to `/mcp` must include an `Authorization: Bearer <token>` header with a valid JWT access token issued via the OAuth 2.1 flow (`/oauth/token`). Tokens are verified using the `JWT_SECRET` with audience and issuer claims checked. Unauthenticated requests receive a `401` with `WWW-Authenticate: Bearer resource_metadata="<url>"` per RFC 9728 to trigger OAuth discovery.

Unauthenticated endpoints: `/health`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/*`.

### GitHub OAuth (`src/oauth/authorize.ts`, `src/oauth/githubCallback.ts`)

Instead of a password login page, the authorization endpoint redirects users to GitHub for authentication. After GitHub authentication, the server checks the user's GitHub username against the `ALLOWED_GITHUB_USERS` allowlist (case-insensitive). Only whitelisted users receive an authorization code.

The session between the authorize redirect and the GitHub callback is bridged via `sessionStore.ts` (in-memory, 10-minute TTL, one-time use).

### OAuth 2.1 (`src/oauth/`)

Full OAuth 2.1 implementation with PKCE (S256) and Dynamic Client Registration. Supports both **confidential clients** (`client_secret_post`) and **public clients** (`token_endpoint_auth_method: "none"`). Public clients (e.g. Claude Code CLI) authenticate via PKCE only — no client secret is generated or accepted. See `docs/oauth.md` for details.

## Path Security (`src/utils/pathValidation.ts`)

### Path Traversal Prevention

All file paths are validated by `resolveVaultPath()` (sync) and `resolveVaultPathSafe()` (async, with symlink detection):

1. Rejects empty paths
2. Resolves the path relative to `VAULT_PATH` using `path.resolve()`
3. Verifies the resolved path starts with the vault directory
4. Blocks any path component that matches a hidden directory (`.git`, `.claude`) or starts with `.git` at root level
5. (Async) Uses `realpath()` to resolve all symlinks (including intermediate directories) and verifies the real path is inside the vault. For non-existent files, walks up the directory tree to find the closest existing ancestor and verifies that.

### Protected Paths

- `..` traversal — rejected (resolves outside vault)
- Absolute paths outside vault — rejected
- `.git/` and `.claude/` and their subdirectories — rejected (all path components checked against `HIDDEN_DIRECTORIES`)
- `.gitmodules`, `.gitattributes`, etc. at vault root — rejected
- Symlinks that escape the vault — rejected by `resolveVaultPathSafe()` and by `isInsideVault()` (shared utility in `src/utils/pathValidation.ts`) in directory listings

### Hidden Directories

The directories listed in `HIDDEN_DIRECTORIES` (`src/utils/constants.ts`) — currently `.git` and `.claude` — are protected at two levels:

1. **Access control** (path validation): Direct access via any tool (`read_file`, `write_file`, `edit_file`, `delete_file`, `rename_file`) is blocked by `resolveVaultPath()`. Any path containing a hidden directory component is rejected with a `PathValidationError`.
2. **Visibility** (listing/search): Hidden directories are excluded from all tool results (`list_directory`, `search_files`, `grep`, `find_files`, `get_vault_info`, `get_backlinks`, `get_tags`) via `isHiddenDirectory()` and `HIDDEN_DIRECTORY_GLOBS`.

### Error Handling

Path validation errors throw `PathValidationError`, which tool handlers catch and return as structured error responses (never crashes the server).

## Reverse Proxy (`trust proxy`)

When `TRUST_PROXY=true`, Express is configured with `app.set("trust proxy", 1)` to trust the first reverse proxy (Caddy). This ensures `req.ip` returns the real client IP (from `X-Forwarded-For`) instead of Caddy's Docker-internal IP, which is essential for per-client rate limiting. The default is `false` — set to `true` only when behind a reverse proxy (e.g., Caddy in production). The `docker-compose.yml` sets `TRUST_PROXY=true` explicitly.

## Security Headers (Caddy)

Caddy adds the following security headers to all responses:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (HSTS)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Server` header is removed

## CORS (`src/transport.ts`)

All responses include `Access-Control-Allow-Origin: *` so that any MCP client (web, CLI, Inspector) can connect. This is safe because authentication relies on OAuth 2.1 Bearer tokens, not cookies. The CORS middleware also exposes the `Mcp-Session-Id` header and allows the `Mcp-Protocol-Version` request header required by the MCP transport protocol. A catch-all `OPTIONS` handler returns `204` for preflight requests.

## Rate Limiting

- **MCP endpoint**: 100 requests per minute per IP, applied as middleware to all `/mcp` routes (POST, GET, DELETE)
- OAuth session store: 1000 max pending sessions, 10-minute TTL, one-time use
- Client registration: 10 per minute per IP, 500 max clients, stale clients (>24h) evicted at 90% capacity
- Token endpoint requests: 20 per minute per IP
- Session limit: configurable via `MAX_SESSIONS` env var (default 100)
- Session TTL: 30 minutes of inactivity
- Rate-limit maps are periodically pruned (60s interval) to prevent memory leaks

### Rate Limiter Memory Cap

The `RateLimiter` class (`src/utils/rateLimiter.ts`) accepts a `maxEntries` parameter (default: 10,000 via `DEFAULT_MAX_RATE_LIMIT_ENTRIES`) that caps the number of tracked keys. When a new key is added and the map is at capacity, the oldest entry is evicted (FIFO order via `Map` insertion order). A warning is logged when eviction occurs. This prevents unbounded memory growth from a large number of distinct client IPs.

### OAuth Store Eviction Logging

The OAuth store (`src/oauth/store.ts`) logs at `debug` level whenever entries are evicted due to capacity limits:
- **Auth codes**: logged when the auth code store reaches its maximum and the oldest code is evicted
- **Refresh tokens**: logged when the refresh token store reaches its maximum and the oldest token is evicted
- **Stale clients**: logged when stale clients (>24h since registration) are evicted during cleanup at 90% client capacity

## File Size & Result Limits

- Maximum file size for read/write operations: 10 MB (`MAX_FILE_SIZE` in `src/utils/constants.ts`)
- Maximum regex length for grep: 500 characters
- Maximum grep results: 500 matches
- Maximum find_files results: 500 files

## Docker & Network Security

- Runtime uses a non-root user (`mcpuser`)
- Multi-stage build keeps the image minimal
- Only `git`, `curl`, and `ca-certificates` are installed as system dependencies
- In production: MCP container is only accessible via Docker-internal network (`expose: 3000`, no `ports`)
- Caddy is the only container with public port exposure (80/443)
- `Caddyfile` is mounted read-only (`:ro`)
- `caddy_data` volume persists certificates to avoid Let's Encrypt rate limits

## CLAUDE.md Trust Model

The vault can contain `CLAUDE.md` files that provide instructions to connected LLM clients. The root `CLAUDE.md` is delivered via the MCP `instructions` field at session initialization; subdirectory `CLAUDE.md` files are accessible via the `get_claude_context` tool.

**Trust assumption:** CLAUDE.md content is delivered unsanitized to the LLM client. Anyone with push access to the vault's git repository can inject arbitrary instructions that the LLM will treat as authoritative server directives. This is analogous to how Claude Code treats `CLAUDE.md` files in local repositories — they are inherently trusted.

**Recommendation:** Only grant git push access to the vault repository to trusted individuals. If the vault has untrusted collaborators, be aware that they can influence LLM behavior via `CLAUDE.md` files.

## Git Child Process Isolation

Git commands are executed via `execFile` in `src/git/gitSync.ts`. The `sanitizeGitEnv()` function creates a sanitized copy of `process.env` that strips application secrets (`JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`, `GIT_REPO_URL`) before passing it to the child process. This prevents secrets from being exposed via git hooks, process listings, or malicious remotes. `GIT_TERMINAL_PROMPT=0` is always set to disable interactive prompts.

## Input Validation

- All tool parameters are validated via Zod schemas before the handler executes
- The MCP SDK enforces JSON Schema validation on tool inputs
- Git config values are validated to prevent argument injection (no leading `-`)
- Git credential URLs are sanitized from error messages

### Git Config Control Character Validation

`GIT_REPO_URL`, `GIT_BRANCH`, `GIT_USER_NAME`, and `GIT_USER_EMAIL` are validated in `src/config.ts` to reject any value containing control characters (ASCII 0x00–0x1F and 0x7F). This prevents injection of newlines, null bytes, or other control sequences into git commands. The check uses the regex `/[\x00-\x1f\x7f]/` and throws a descriptive error at startup if a violation is detected.

### Error Message Sanitization

All tool error messages are passed through `sanitizeErrorForClient()` (`src/utils/toolResponse.ts`) before being returned to the client. This function:

1. **Strips absolute paths** — replaces paths starting with `/vault/`, `/tmp/`, `/private/`, `/home/`, `/var/`, `/usr/`, `/etc/`, `/app/`, `/root/`, `/opt/`, `/mnt/`, `/data/` with just the filename (last path component)
2. **Redacts git object hashes** — replaces 40-character hex strings with `<hash>`
3. **Redacts git refs** — replaces `refs/...` patterns with `<ref>`
4. **Truncates long messages** — messages exceeding 500 characters are truncated with `...`

The `toolError()` helper automatically applies sanitization, so all tool handlers benefit without extra effort.

### Commit Message Sanitization

All git commit messages are passed through `sanitizeCommitMessage()` (`src/git/gitSync.ts`) before being used in `git commit -m`. This function:

1. **Strips control characters** — replaces all ASCII control characters (0x00–0x1F, 0x7F) with spaces
2. **Truncates long messages** — messages exceeding 200 characters are truncated (no ellipsis)

This prevents injection of shell-interpreted characters or excessively long strings into git commands.
