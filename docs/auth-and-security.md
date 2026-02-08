# Authentication & Security

## Authentication

### JWT Auth (`src/auth.ts`)

All requests to `/mcp` must include an `Authorization: Bearer <token>` header with a valid JWT access token issued via the OAuth 2.1 flow (`/oauth/token`). Tokens are verified using the `JWT_SECRET` with audience and issuer claims checked.

Unauthenticated endpoints: `/health`, `/.well-known/oauth-authorization-server`, `/oauth/*`.

### GitHub OAuth (`src/oauth/authorize.ts`, `src/oauth/githubCallback.ts`)

Instead of a password login page, the authorization endpoint redirects users to GitHub for authentication. After GitHub authentication, the server checks the user's GitHub username against the `ALLOWED_GITHUB_USERS` allowlist (case-insensitive). Only whitelisted users receive an authorization code.

The session between the authorize redirect and the GitHub callback is bridged via `sessionStore.ts` (in-memory, 10-minute TTL, one-time use).

### OAuth 2.1 (`src/oauth/`)

Full OAuth 2.1 implementation with PKCE (S256) and Dynamic Client Registration. See `docs/oauth.md` for details.

## Path Security (`src/utils/pathValidation.ts`)

### Path Traversal Prevention

All file paths are validated by `resolveVaultPath()` (sync) and `resolveVaultPathSafe()` (async, with symlink detection):

1. Rejects empty paths
2. Resolves the path relative to `VAULT_PATH` using `path.resolve()`
3. Verifies the resolved path starts with the vault directory
4. Blocks any path component that is `.git` or starts with `.git` at root level
5. (Async) Checks that the file is not a symlink pointing outside the vault

### Protected Paths

- `..` traversal — rejected (resolves outside vault)
- Absolute paths outside vault — rejected
- `.git/` and subdirectories — rejected (all path components checked)
- `.gitmodules`, `.gitattributes`, etc. at vault root — rejected
- Symlinks that escape the vault — rejected by `resolveVaultPathSafe()`

### Error Handling

Path validation errors throw `PathValidationError`, which tool handlers catch and return as structured error responses (never crashes the server).

## Reverse Proxy (`trust proxy`)

Express is configured with `app.set("trust proxy", 1)` to trust the first reverse proxy (Caddy). This ensures `req.ip` returns the real client IP (from `X-Forwarded-For`) instead of Caddy's Docker-internal IP, which is essential for per-client rate limiting.

## Security Headers (Caddy)

Caddy adds the following security headers to all responses:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (HSTS)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Server` header is removed

## Rate Limiting

- OAuth session store: 1000 max pending sessions, 10-minute TTL, one-time use
- Client registration: 10 per minute per IP, 500 max clients
- Token endpoint requests: 20 per minute per IP
- Session limit: 100 concurrent MCP sessions
- Session TTL: 30 minutes of inactivity
- Rate-limit maps are periodically pruned (60s interval) to prevent memory leaks

## File Size Limits

- Maximum file size for read/write operations: 10 MB
- Maximum regex length for grep: 500 characters

## Docker & Network Security

- Runtime uses a non-root user (`mcpuser`)
- Multi-stage build keeps the image minimal
- Only `git` and `curl` are installed as system dependencies
- In production: MCP container is only accessible via Docker-internal network (`expose: 3000`, no `ports`)
- Caddy is the only container with public port exposure (80/443)
- `Caddyfile` is mounted read-only (`:ro`)
- `caddy_data` volume persists certificates to avoid Let's Encrypt rate limits

## Input Validation

- All tool parameters are validated via Zod schemas before the handler executes
- The MCP SDK enforces JSON Schema validation on tool inputs
- Git config values are validated to prevent argument injection (no leading `-`)
- Git credential URLs are sanitized from error messages
