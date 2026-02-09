# Obsidian Vault MCP Server

> Ever wondered how to ask Claude on your phone to add a todo to your Obsidian vault? Quickly look up that info on a contact you know you've jotted down — while on the go? This MCP server makes your Obsidian vault available to Claude and other AI tools, so you can read, search, and edit your notes from any conversation.

A bridge that gives [Claude](https://claude.ai/) (claude.ai, Claude Mobile, Claude Code) and other MCP-capable AI tools read and write access to your [Obsidian](https://obsidian.md/) vault — similar to how Claude Code interacts with local files, but remotely via the [Model Context Protocol](https://modelcontextprotocol.io/).

- **`CLAUDE.md` support** — place `CLAUDE.md` files in your vault to provide context-specific instructions to Claude, just like with Claude Code or Claude Cowork
- **Vault guides** — teaches Claude Obsidian conventions, note templates, and search strategies
- **Authentication** — GitHub OAuth with a username allowlist controls who can access the vault
- **Automatic HTTPS** — Let's Encrypt certificates via Caddy, no manual setup

> **Note:** Skills that might be stored in a vault repository cannot beloaded. To use them, add them directly in Claude Desktop, claude.ai, or Claude Mobile as you would with any other skill.

All you need is an existing [Obsidian Git](https://github.com/Vinzent03/obsidian-git) sync, a small server, and a `.env` file.

## Prerequisites

- **Obsidian Git Sync** set up via the [Obsidian Git Plugin](https://github.com/Vinzent03/obsidian-git) to a Git repository of your choice, e.g. on Github. 
- **A server or service with a public IP** (e.g. Hetzner, AWS, Azure) that can run and publicly expose Docker containers
- **Docker and Docker Compose** installed on the server
- **A (sub-)domain name of your choice** with DNS pointing to the server's IP address
- **Ports 80 and 443** reachable from the internet

## Getting Started

### Step 1: Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) and click **"New OAuth App"**
2. Fill in the fields:
   - **Application name**: `Obsidian MCP Server` (or any name you like)
   - **Homepage URL**: `https://your-domain.example.com` (replace with your chosen domain name)
   - **Authorization callback URL**: `https://your-domain.example.com/oauth/github/callback` (replace with your chosen domain name, but keep path)
3. Click **"Register application"**
4. Copy the **Client ID**
5. Click **"Generate a new client secret"** and copy the secret immediately (it's only shown once)

### Step 2: Create a GitHub Personal Access Token

1. Go to [Personal Access Tokens](https://github.com/settings/personal-access-tokens/new) and create a **Fine-Grained Personal Access Token**
2. Choose if you want the token to automatically expire (more secure, more effort) or not (less secure, less effort)
2. Select your vault repository under **"Only select repositories"**
3. Under **Repository permissions**, set **Contents** to **Read and Write**
4. Copy the token
5. 

### Step 3: Clone and configure

```bash
git clone https://github.com/seibert-io/obsidian-github-mcp.git
cd obsidian-github-mcp
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Your domain (Caddy uses this for automatic HTTPS)
SERVER_DOMAIN=your-domain.example.com

# Your vault repository — insert your Personal Access Token from Step 2
GIT_REPO_URL=https://<YOUR-PERSONAL-ACCESS-TOKEN>@github.com/<user>/<vault-repo>.git

# GitHub OAuth App credentials from Step 1
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret

# GitHub usernames that should have access (comma-separated)
ALLOWED_GITHUB_USERS=your-github-username

# Generate a random secret with min 32 characters, e.g. via  `openssl rand -hex 64`
JWT_SECRET=your-generated-secret
```

### Step 4: Start

```bash
docker compose up -d
```

Caddy automatically obtains a Let's Encrypt certificate on first start (takes about 10–30 seconds).

### Step 5: Connect your AI tool

<details>
<summary><strong>Claude.ai</strong></summary>

1. Go to **Settings** → **Connectors** → **"Add custom connector"**
2. Enter the URL: `https://your-domain.example.com/mcp`
3. Claude redirects you to GitHub — sign in with an account listed in `ALLOWED_GITHUB_USERS`
4. Done — the vault tools will appear in Claude's tool list

</details>

<details>
<summary><strong>Claude Code (CLI)</strong></summary>

```bash
claude mcp add obsidian-vault --transport http https://your-domain.example.com/mcp -s user
```

On first use, the OAuth flow opens in your browser. After signing in with GitHub, the connection is active.

</details>

<details>
<summary><strong>Other MCP-capable tools</strong></summary>

Please refer to your tool's documentation on how to register remote MCP servers. The MCP endpoint URL is:

```
https://your-domain.example.com/mcp
```

</details>

## Updating to a Newer Version

On your server, navigate to the directory where you cloned this repository, then pull the latest changes and rebuild:

```bash
cd /path/to/obsidian-github-mcp
git pull
docker compose up -d --build
```

## CLAUDE.md and Vault Guides

### CLAUDE.md

A `CLAUDE.md` file in the **root** of your vault is automatically delivered to clients when they connect — just like with Claude Code or Claude Cowork. Use it to give Claude vault-wide instructions (naming conventions, folder structure, preferred formats, etc.).

Subdirectory `CLAUDE.md` files are also supported. Clients are instructed to load and follow the `CLAUDE.md` of any subdirectory they are working in via the `get_claude_context` tool.

### Vault Guides

The `get_obsidian_guide` tool and MCP prompts teach Claude how to work with your vault:

- **Conventions** — link syntax (`[[wikilinks]]`), frontmatter, tags, callouts
- **Create note** — templates for zettel, meeting, daily, project, and literature notes
- **Search strategy** — which tool to use for different search scenarios

Guide content is stored in `prompts/` and can be customized via a Docker volume mount:

```yaml
volumes:
  - ./my-prompts:/app/prompts
```

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVER_DOMAIN` | yes | — | Domain for HTTPS via Caddy (e.g., `vault.example.com`) |
| `GIT_REPO_URL` | yes | — | Git remote URL (HTTPS with PAT recommended) |
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | yes | — | GitHub OAuth App Client Secret |
| `ALLOWED_GITHUB_USERS` | yes | — | Comma-separated allowed GitHub usernames |
| `JWT_SECRET` | yes | — | JWT signing secret (min 32 chars) |
| `SERVER_URL` | — | auto | Auto-derived from `SERVER_DOMAIN` |
| `GIT_BRANCH` | no | `main` | Git branch to sync |
| `GIT_SYNC_INTERVAL_SECONDS` | no | `300` | Pull interval (0 to disable) |
| `GIT_USER_NAME` | no | `Claude MCP` | Git commit author name |
| `GIT_USER_EMAIL` | no | `mcp@example.com` | Git commit author email |
| `VAULT_PATH` | no | `/vault` | Vault path inside container |
| `PORT` | no | `3000` | HTTP server port |
| `LOG_LEVEL` | no | `info` | Log level: debug, info, warn, error |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT token lifetime |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (7 days) |

</details>

## How It Works

```
Obsidian (iPhone/Mac)          Docker Host
┌─────────────────┐           ┌──────────────────────────────────┐
│  Obsidian +     │  git      │  ┌────────────────────────────┐  │
│  Obsidian Git   │ ◄──────►  │  │  Git Sync (periodic)       │  │
│  Plugin         │           │  └──────┬─────────────────────┘  │
└─────────────────┘           │         ↕ /vault                 │
                              │  ┌──────────────────────────┐    │
Claude / AI Tool    HTTPS     │  │  MCP Server (Express)    │    │
┌──────────────────┐ ◄──────► │  │  - GitHub OAuth          │    │
│  claude.ai       │  :443    │  │  - Vault tools (MCP)     │    │
│  Claude Code     │          │  └──────────────────────────┘    │
│  Other MCP tools │          │         ↑ reverse proxy          │
└──────────────────┘          │  ┌──────────────────────────┐    │
                              │  │  Caddy (:80/:443)        │    │
                              │  │  - Auto Let's Encrypt    │    │
                              │  └──────────────────────────┘    │
                              └──────────────────────────────────┘
```

1. **Obsidian** syncs your vault to a Git repository via the [Obsidian Git Plugin](https://github.com/Vinzent03/obsidian-git)
2. The **MCP server** clones the repository and periodically pulls changes
3. **Claude** (or another MCP client) connects via OAuth and accesses the vault through MCP tools
4. Write operations (create, edit, delete, rename) are automatically committed and pushed back to Git
5. **`CLAUDE.md` files** in the vault provide context-specific instructions — the root-level file is delivered automatically at session start, subdirectory files are available via the `get_claude_context` tool

## Technical Documentation

Detailed technical documentation is available in `docs/`:

| File | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, component diagram, request flow |
| [docs/tools.md](docs/tools.md) | MCP tool definitions with inputs/outputs |
| [docs/oauth.md](docs/oauth.md) | OAuth 2.1 flow, PKCE, JWT, endpoints |
| [docs/git-sync.md](docs/git-sync.md) | Git clone/pull/push logic, conflict handling |
| [docs/auth-and-security.md](docs/auth-and-security.md) | Authentication, path security, rate limiting |
| [docs/configuration.md](docs/configuration.md) | All environment variables with types/defaults |
| [docs/deployment.md](docs/deployment.md) | Docker, docker-compose, health checks |
| [docs/testing.md](docs/testing.md) | Test framework and test suites |

## License

MIT
