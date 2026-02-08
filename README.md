# Obsidian Vault MCP Server

A Dockerized [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that exposes a Git-synced [Obsidian](https://obsidian.md/) vault as a set of file and search tools over Streamable HTTP. Designed for use with Claude.ai Custom MCP Integrations.

## Features

- **14 MCP tools** for reading, writing, searching, and managing vault files
- **Vault guides & prompts** — teaches Claude Obsidian conventions, templates, and search strategies
- **Git sync** — automatically clones, pulls, and pushes your vault via Git
- **GitHub OAuth** — authenticate via GitHub, with username allowlist
- **OAuth 2.1** with PKCE and Dynamic Client Registration for Claude.ai
- **Path sandboxing** — all operations are confined to the vault directory
- **Docker-ready** — multi-stage build, non-root user, health checks

## Quick Start

### Prerequisites

- Docker and Docker Compose
- A Git repository containing your Obsidian vault
- A publicly accessible URL (for Claude.ai integration)

### 1. Clone and configure

```bash
git clone https://github.com/your-org/obsidian-github-mcp.git
cd obsidian-github-mcp
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Required
GIT_REPO_URL=https://github.com/your-user/your-obsidian-vault.git
GITHUB_CLIENT_ID=<from your GitHub OAuth App>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth App>
ALLOWED_GITHUB_USERS=your-github-username
JWT_SECRET=<generate with: openssl rand -hex 32>
SERVER_URL=https://your-server.example.com
```

### 2. Build and run

```bash
docker compose up -d
```

Or build manually:

```bash
docker build -t obsidian-mcp-server .
docker run -d -p 3000:3000 --env-file .env obsidian-mcp-server
```

### 3. Verify it's running

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 4. Connect from Claude.ai

1. In Claude.ai, go to **Settings** and add a **Custom MCP Integration**
2. Enter your server URL: `https://your-server.example.com`
3. Claude.ai will automatically discover the OAuth endpoints, register as a client, and redirect you to GitHub
4. Sign in with a GitHub account that is in your `ALLOWED_GITHUB_USERS` list
5. The vault tools will appear in Claude's tool list

## Available Tools

| Tool | Description |
|---|---|
| `read_file` | Read the contents of a file |
| `write_file` | Create or overwrite a file |
| `edit_file` | Apply search-and-replace edits to a file |
| `delete_file` | Delete a file |
| `rename_file` | Rename or move a file |
| `list_directory` | List files and subdirectories |
| `create_directory` | Create a new directory |
| `search_files` | Find files matching a glob pattern |
| `grep` | Search file contents with regex |
| `find_files` | Find files with time/size filters |
| `get_vault_info` | Get vault statistics |
| `get_backlinks` | Find notes that link to a given note |
| `get_tags` | Extract tags from a note |
| `get_obsidian_guide` | Best-practice guides for vault conventions, templates, search |

Every write operation (write, edit, delete, rename) automatically commits and pushes changes via Git.

### Vault Guides & MCP Prompts

The `get_obsidian_guide` tool and three MCP prompts teach the connected client (e.g., Claude) how to work optimally with your vault:

- **Conventions** — link syntax (`[[wikilinks]]`), frontmatter, tags, callouts
- **Create note** — templates for zettel, meeting, daily, project, and literature notes
- **Search strategy** — which tool to use for different search scenarios

Guide content is stored in `prompts/` and can be customized via a Docker volume mount:
```yaml
volumes:
  - ./my-prompts:/app/prompts
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GIT_REPO_URL` | yes | — | Git remote URL (HTTPS or SSH) |
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | yes | — | GitHub OAuth App Client Secret |
| `ALLOWED_GITHUB_USERS` | yes | — | Comma-separated allowed GitHub usernames |
| `JWT_SECRET` | yes | — | JWT signing secret (min 32 chars) |
| `SERVER_URL` | yes | — | Public server URL |
| `GIT_BRANCH` | no | `main` | Git branch to sync |
| `GIT_SYNC_INTERVAL_SECONDS` | no | `300` | Pull interval (0 to disable) |
| `GIT_USER_NAME` | no | `Claude MCP` | Git commit author name |
| `GIT_USER_EMAIL` | no | `mcp@example.com` | Git commit author email |
| `VAULT_PATH` | no | `/vault` | Vault path inside container |
| `PORT` | no | `3000` | HTTP server port |
| `LOG_LEVEL` | no | `info` | Log level: debug, info, warn, error |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT token lifetime |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (7 days) |

## GitHub OAuth einrichten

Der Server authentifiziert User über GitHub. Nur explizit freigegebene GitHub-Accounts erhalten Zugriff.

### 1. GitHub OAuth App erstellen

1. Gehe zu https://github.com/settings/developers
2. Klicke auf **"New OAuth App"**
3. Fülle die Felder aus:
   - **Application name**: `Obsidian MCP Server` (frei wählbar)
   - **Homepage URL**: Die öffentliche URL deines Servers, z.B. `https://vault.example.com`
   - **Authorization callback URL**: `https://vault.example.com/oauth/github/callback`
     (Ersetze `vault.example.com` mit deiner tatsächlichen Server-URL)
4. Klicke **"Register application"**
5. Auf der nächsten Seite siehst du die **Client ID** — kopiere sie
6. Klicke auf **"Generate a new client secret"** — kopiere das Secret sofort (wird nur einmal angezeigt)

### 2. Environment Variables konfigurieren

Trage die Werte in deine `.env` oder `docker-compose.yml` ein:

```
GITHUB_CLIENT_ID=<Client ID von Schritt 5>
GITHUB_CLIENT_SECRET=<Client Secret von Schritt 6>
ALLOWED_GITHUB_USERS=dein-github-username
```

Für mehrere User komma-separiert:

```
ALLOWED_GITHUB_USERS=user1,user2,user3
```

### 3. Server starten

```bash
docker compose up -d
```

### 4. In Claude.ai verbinden

1. Gehe zu https://claude.ai → Settings → Connectors
2. Klicke **"Add custom connector"**
3. Gib die Server-URL ein: `https://vault.example.com`
4. Claude leitet dich zu GitHub weiter — melde dich an
5. Nach erfolgreicher Anmeldung ist der Connector aktiv

### Troubleshooting

- **"User not authorized"**: Dein GitHub-Username ist nicht in `ALLOWED_GITHUB_USERS` enthalten. Prüfe die Schreibweise (case-insensitive).
- **GitHub zeigt "The redirect_uri is not valid"**: Die Callback-URL in der GitHub OAuth App stimmt nicht mit `SERVER_URL/oauth/github/callback` überein.
- **Claude.ai zeigt einen Verbindungsfehler**: Prüfe ob der Server erreichbar ist und HTTPS korrekt konfiguriert ist.

## Private Repository Access

**HTTPS with Personal Access Token:**
```
GIT_REPO_URL=https://<PAT>@github.com/user/vault.git
```

**SSH (mount key into container):**
```bash
docker run -d -p 3000:3000 \
  -v ~/.ssh/id_ed25519:/home/mcpuser/.ssh/id_ed25519:ro \
  --env-file .env \
  obsidian-mcp-server
```

## How It Works

```
Obsidian (iPhone/Mac)          Docker Container
┌─────────────────┐           ┌──────────────────────────┐
│  Obsidian +      │  git     │  Git Sync (periodic)     │
│  Obsidian Git    │ ◄──────► │       ↕ /vault           │
│  Plugin          │          │  MCP Server (Express)     │
└─────────────────┘           │  - OAuth 2.1 auth        │
                              │  - 14 MCP tools          │
Claude.ai          SSE/HTTP   │  - Path sandboxing       │
┌─────────────────┐ ◄──────► │  - Streamable HTTP       │
│  Claude.ai       │  OAuth   └──────────────────────────┘
│  Custom MCP      │  JWT
└─────────────────┘
```

1. **Obsidian** syncs your vault to a Git repository (via Obsidian Git plugin)
2. The **MCP server** clones and periodically pulls the vault
3. **Claude.ai** connects via OAuth 2.1 and accesses the vault through MCP tools
4. Write operations are committed and pushed back to Git

## Development

```bash
npm install
npm run dev       # Run with tsx (hot reload)
npm test          # Run test suite
npm run build     # Compile TypeScript
npm run lint      # Type-check
```

## Security

- GitHub OAuth authentication with username allowlist
- OAuth 2.1 with PKCE S256 and Dynamic Client Registration
- JWT access tokens with configurable expiry
- Refresh token rotation
- Path traversal and symlink escape prevention
- `.git` directory access blocked
- Rate limiting on registration and token endpoints
- Non-root Docker container
- Git credential sanitization in error messages
- File size limits (10 MB) and regex length limits

## Documentation

Detailed documentation is available in `docs/`:

| File | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, component diagram, request flow |
| [docs/tools.md](docs/tools.md) | All 14 MCP tool definitions with inputs/outputs |
| [docs/oauth.md](docs/oauth.md) | OAuth 2.1 flow, DCR, PKCE, JWT, endpoints |
| [docs/git-sync.md](docs/git-sync.md) | Git clone/pull/push logic, conflict handling |
| [docs/auth-and-security.md](docs/auth-and-security.md) | Authentication, path security, rate limiting |
| [docs/configuration.md](docs/configuration.md) | All environment variables with types/defaults |
| [docs/deployment.md](docs/deployment.md) | Docker, docker-compose, Claude.ai integration |
| [docs/testing.md](docs/testing.md) | Test framework and test suites |

## License

MIT
