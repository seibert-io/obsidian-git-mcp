# Deployment

## Docker

### Build
```bash
docker build -t obsidian-mcp-server .
```

### Run
```bash
docker run -d \
  -p 3000:3000 \
  -e GIT_REPO_URL=https://github.com/user/vault.git \
  -e GITHUB_CLIENT_ID=your-github-client-id \
  -e GITHUB_CLIENT_SECRET=your-github-client-secret \
  -e ALLOWED_GITHUB_USERS=your-github-username \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e SERVER_URL=https://your-server.example.com \
  obsidian-mcp-server
```

### Docker Compose
```bash
docker compose up -d
```

The compose file runs the MCP server behind a Caddy reverse proxy that automatically obtains Let's Encrypt certificates. Set `SERVER_DOMAIN` in your `.env` file.

## Build Arguments and Runtime Environment Variables

The Docker image does not require build arguments. All configuration is via runtime environment variables.

### Required Environment Variables

| Variable | Description |
|---|---|
| `GIT_REPO_URL` | Git remote URL for the Obsidian vault. |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret. |
| `ALLOWED_GITHUB_USERS` | Comma-separated list of allowed GitHub usernames (case-insensitive). |
| `JWT_SECRET` | HMAC secret for JWT access tokens (min 32 chars). |
| `SERVER_URL` | Public URL of the server, used in OAuth metadata. Auto-derived in production from `SERVER_DOMAIN`. |
| `SERVER_DOMAIN` | Domain for HTTPS via Caddy (production only, e.g., `vault.example.com`). |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GIT_BRANCH` | `main` | Git branch to sync. |
| `GIT_SYNC_INTERVAL_SECONDS` | `300` | Pull interval in seconds (0 to disable). |
| `GIT_USER_NAME` | `Claude MCP` | Git commit author name. |
| `GIT_USER_EMAIL` | `mcp@example.com` | Git commit author email. |
| `VAULT_PATH` | `/vault` | Vault directory inside the container. |
| `PORT` | `3000` | HTTP server port. |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error. |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | `3600` | JWT access token lifetime. |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | `604800` | Refresh token lifetime (7 days). |

## Dockerfile Details

- **Base image**: `node:22-slim`
- **Multi-stage build**: TypeScript compiled in builder stage, only `dist/` and production deps in runtime
- **System deps**: `git`, `curl` (for health checks), `ca-certificates` (for HTTPS git remotes)
- **Non-root user**: `mcpuser` for runtime
- **Health check**: `curl -f http://localhost:3000/health` every 30s
- **Exposed port**: 3000

## Production Deployment (HTTPS)

The production setup uses [Caddy](https://caddyserver.com/) as a reverse proxy with automatic Let's Encrypt HTTPS certificates.

### Architecture

```
Internet → :443 → Caddy (TLS termination) → :3000 → MCP Server
                   ↕
           Let's Encrypt (automatic)
```

### Files

| File | Purpose |
|---|---|
| `Caddyfile` | Caddy config — reverse proxies `{$SERVER_DOMAIN}` to `mcp:3000` |
| `docker-compose.yml` | Production compose with Caddy + MCP (ports 80/443 only) |

### How `SERVER_URL` is Derived

The `docker-compose.yml` sets `SERVER_URL=https://${SERVER_DOMAIN}` on the MCP container automatically. The user only needs to set `SERVER_DOMAIN` in `.env`. For development without Caddy, `SERVER_URL` must be set directly.

### Volume Persistence

The `caddy_data` volume stores certificates and ACME state. It **must** be persisted across container restarts to avoid hitting Let's Encrypt rate limits. Never delete this volume in production.

### Port Exposure

- **Caddy**: `80:80` and `443:443` (public)
- **MCP**: `expose: 3000` (internal Docker network only, not accessible from outside)

## Connecting MCP Clients

### Claude.ai (OAuth 2.1)

1. Deploy the server with a public HTTPS URL (or tunnel)
2. Set `SERVER_URL` to your public URL
3. In Claude.ai, go to Settings and add a Custom MCP Integration
4. Enter the MCP endpoint URL: `https://your-server.example.com/mcp`
5. Claude.ai will:
   - Discover OAuth endpoints via `/.well-known/oauth-authorization-server`
   - Register as a client via `POST /oauth/register`
   - Redirect you to GitHub where you sign in with an allowed account
   - Exchange the auth code for tokens automatically
6. The MCP tools will appear in Claude's tool list

### Claude Code (CLI)

```bash
claude mcp add obsidian-vault --transport http https://your-server.example.com/mcp -s user
```

On first use, Claude Code triggers the OAuth flow in your browser. After GitHub authentication, the connection is active.

> Both clients use the same URL with `/mcp`. OAuth discovery endpoints (`/.well-known/*`) are resolved relative to the base domain.

### Custom Vault Guides

To override the built-in guide/prompt content, mount a volume over the prompts directory:
```yaml
volumes:
  - ./my-prompts:/app/prompts
```

The directory should contain: `obsidian-conventions.md`, `obsidian-create-note.md`, `obsidian-search-strategy.md`.

## CI/CD Pipeline

### Continuous Integration

Every push to `main` and every pull request targeting `main` triggers the CI workflow (`.github/workflows/ci.yml`), which runs:

1. `npm ci` — install dependencies
2. `npm run lint` — type-check
3. `npm run build` — compile TypeScript
4. `npm test` — run test suite

### Automated Releases

Pushes to `main` trigger the release workflow (`.github/workflows/release.yml`), which uses [semantic-release](https://semantic-release.gitbook.io/) to:

1. Analyze commits since the last release (using [Conventional Commits](https://www.conventionalcommits.org/))
2. Determine the next semantic version (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE` → major)
3. Generate release notes and update `CHANGELOG.md`
4. Update `version` in `package.json` (not published to npm)
5. Create a GitHub Release with a git tag
6. Commit the updated `CHANGELOG.md`, `package.json`, and `package-lock.json` back to `main`

**Important**: The `version` field in `package.json` is managed automatically by semantic-release. Do not edit it manually.

### Commit Message Convention

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format. This is enforced locally via [commitlint](https://commitlint.js.org/) + [Husky](https://typicode.github.io/) on the `commit-msg` hook.

Format: `type(optional-scope): description`

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`.

## Health Check

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## Logs

Logs are written to stdout in structured format:
```
2025-01-01T00:00:00.000Z [INFO] MCP server listening on port 3000
```

Control verbosity with `LOG_LEVEL` (debug, info, warn, error).
