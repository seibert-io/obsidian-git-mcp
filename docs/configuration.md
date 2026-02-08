# Configuration

All configuration is via environment variables, parsed in `src/config.ts`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GIT_REPO_URL` | yes | — | Git remote URL (HTTPS or SSH) |
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | yes | — | GitHub OAuth App Client Secret |
| `ALLOWED_GITHUB_USERS` | yes | — | Comma-separated list of allowed GitHub usernames (case-insensitive) |
| `JWT_SECRET` | yes | — | Secret for signing JWT access tokens (min 32 chars) |
| `SERVER_URL` | yes* | — | Public URL of the server (auto-derived in production from `SERVER_DOMAIN`) |
| `SERVER_DOMAIN` | yes (prod) | — | Domain for HTTPS via Caddy (e.g., `vault.example.com`) |
| `GIT_BRANCH` | no | `main` | Branch to sync |
| `GIT_SYNC_INTERVAL_SECONDS` | no | `300` | Auto-pull interval (0 to disable) |
| `GIT_USER_NAME` | no | `Claude MCP` | Git commit author name |
| `GIT_USER_EMAIL` | no | `mcp@example.com` | Git commit author email |
| `VAULT_PATH` | no | `/vault` | Path to vault inside container |
| `PORT` | no | `3000` | HTTP server port |
| `LOG_LEVEL` | no | `info` | Logging verbosity: debug, info, warn, error |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT access token lifetime in seconds |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (default 7 days) |
| `TRUST_PROXY` | no | `true` | Trust `X-Forwarded-For` header for rate limiting. Set to `false` when not behind a reverse proxy |
| `PROMPTS_DIR` | no | `<cwd>/prompts` | Directory containing guide/prompt markdown files (overridable for custom prompts) |

## Private Repository Access

For HTTPS with a Personal Access Token:
```
GIT_REPO_URL=https://<PAT>@github.com/user/vault.git
```

For SSH (mount key into container):
```
GIT_REPO_URL=git@github.com:user/vault.git
```

## Generating Secrets

```bash
# JWT_SECRET (min 32 chars)
openssl rand -hex 32
```

GitHub OAuth credentials are obtained by creating an OAuth App at https://github.com/settings/developers.

## Validation

- `GIT_REPO_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`, `JWT_SECRET`, and `SERVER_URL` are required; startup fails if missing. In production, `SERVER_URL` is auto-derived from `SERVER_DOMAIN` via `docker-compose.prod.yml`
- `ALLOWED_GITHUB_USERS` must contain at least one username (stored lowercase internally)
- `JWT_SECRET` must be at least 32 characters
- `GIT_SYNC_INTERVAL_SECONDS` must be a non-negative integer
- `PORT` must be a valid port number (1-65535)
- `GIT_BRANCH`, `GIT_USER_NAME`, `GIT_USER_EMAIL` must not start with `-` (prevents argument injection)
- Invalid values cause startup failure with a descriptive error message
