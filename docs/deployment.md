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

Edit `docker-compose.yml` to set environment variables. A template is provided with all variables.

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
| `SERVER_URL` | Public URL of the server, used in OAuth metadata (e.g., `https://mcp.example.com`). |

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
- **System deps**: `git`, `curl` (for health checks)
- **Non-root user**: `mcpuser` for runtime
- **Health check**: `curl -f http://localhost:3000/health` every 30s
- **Exposed port**: 3000

## Connecting from Claude.ai (OAuth 2.1)

1. Deploy the server with a public HTTPS URL (or tunnel)
2. Set `SERVER_URL` to your public URL
3. In Claude.ai, go to Settings and add a Custom MCP Integration
4. Enter the server URL: `https://your-server.example.com`
5. Claude.ai will:
   - Discover endpoints via `/.well-known/oauth-authorization-server`
   - Register as a client via `POST /oauth/register`
   - Redirect you to GitHub where you sign in with an allowed account
   - Exchange the auth code for tokens automatically
6. The MCP tools will appear in Claude's tool list

### Custom Vault Guides

To override the built-in guide/prompt content, mount a volume over the prompts directory:
```yaml
volumes:
  - ./my-prompts:/app/prompts
```

The directory should contain: `obsidian-conventions.md`, `obsidian-create-note.md`, `obsidian-search-strategy.md`.

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
