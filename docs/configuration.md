# Configuration

All configuration is via environment variables, parsed in `src/config.ts`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_API_TOKEN` | yes | — | Static bearer token for authentication (min 16 chars) |
| `GIT_REPO_URL` | yes | — | Git remote URL (HTTPS or SSH) |
| `OAUTH_PASSWORD` | yes | — | Password for the OAuth authorization login page |
| `JWT_SECRET` | yes | — | Secret for signing JWT access tokens (min 32 chars) |
| `SERVER_URL` | yes | — | Public URL of the server (e.g., `https://mcp.example.com`) |
| `GIT_BRANCH` | no | `main` | Branch to sync |
| `GIT_SYNC_INTERVAL_SECONDS` | no | `300` | Auto-pull interval (0 to disable) |
| `GIT_USER_NAME` | no | `Claude MCP` | Git commit author name |
| `GIT_USER_EMAIL` | no | `mcp@example.com` | Git commit author email |
| `VAULT_PATH` | no | `/vault` | Path to vault inside container |
| `PORT` | no | `3000` | HTTP server port |
| `LOG_LEVEL` | no | `info` | Logging verbosity: debug, info, warn, error |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT access token lifetime in seconds |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (default 7 days) |

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
# MCP_API_TOKEN (min 16 chars)
openssl rand -hex 32

# JWT_SECRET (min 32 chars)
openssl rand -hex 32

# OAUTH_PASSWORD — choose a strong password
```

## Validation

- `MCP_API_TOKEN`, `GIT_REPO_URL`, `OAUTH_PASSWORD`, `JWT_SECRET`, and `SERVER_URL` are required; startup fails if missing
- `MCP_API_TOKEN` must be at least 16 characters
- `JWT_SECRET` must be at least 32 characters
- `GIT_SYNC_INTERVAL_SECONDS` must be a non-negative integer
- `PORT` must be a valid port number (1-65535)
- `GIT_BRANCH`, `GIT_USER_NAME`, `GIT_USER_EMAIL` must not start with `-` (prevents argument injection)
- Invalid values cause startup failure with a descriptive error message
