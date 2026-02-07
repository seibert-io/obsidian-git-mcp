# Architecture

## Overview

The Obsidian Vault MCP Server is a Dockerized Node.js application that exposes an Obsidian vault (synced via Git) through the Model Context Protocol (MCP) over Streamable HTTP (SSE).

## Component Diagram

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
│ (any device) │  OAuth 2.1 JWT  │  │  - FS tools on /vault   │    │
└─────────────┘                  │  │  - OAuth 2.1 + Auth     │    │
                                 │  └────────────────────────┘    │
                                 └──────────────────────────────┘
```

## Request Flow

1. Client sends HTTP POST to `/mcp` with `Authorization: Bearer <token>` (JWT or static)
2. `bearerAuth` middleware validates the token (tries JWT first, then static comparison)
3. `StreamableHTTPServerTransport` handles the MCP protocol (session management, SSE)
4. `McpServer` dispatches to the appropriate tool handler
5. Tool handler validates paths, performs FS operations, optionally triggers git commit+push
6. Response flows back through the transport as SSE events

### OAuth 2.1 Flow

1. Client registers via `POST /oauth/register` (Dynamic Client Registration)
2. Client redirects user to `GET /oauth/authorize` with PKCE challenge
3. User enters vault password, server redirects back with auth code
4. Client exchanges code + PKCE verifier at `POST /oauth/token` for JWT + refresh token
5. Client uses JWT to call `/mcp`

## Key Design Decisions

- **Stateful sessions**: Each client connection gets a unique session ID tracked by a `StreamableHTTPServerTransport` instance
- **Path sandboxing**: All file paths are resolved and validated against `VAULT_PATH` before any I/O
- **Git-triggered writes**: Every write operation (write, edit, delete, rename) triggers `git add . && git commit && git push`
- **Periodic pull**: A configurable interval pulls remote changes to keep the vault in sync

## Directory Structure

```
src/
├── index.ts                # Entry point: config → vault init → server start
├── server.ts               # McpServer creation + tool registration
├── transport.ts            # Express app + StreamableHTTP transport setup
├── auth.ts                 # Dual-mode auth middleware (JWT + static bearer)
├── config.ts               # Environment variable parsing
├── oauth/
│   ├── metadata.ts         # /.well-known/oauth-authorization-server
│   ├── registration.ts     # POST /oauth/register (DCR)
│   ├── authorize.ts        # GET/POST /oauth/authorize
│   ├── token.ts            # POST /oauth/token
│   ├── jwt.ts              # JWT create/verify helpers
│   └── store.ts            # In-memory client, code, token storage
├── tools/
│   ├── fileOperations.ts   # read_file, write_file, edit_file, delete_file, rename_file
│   ├── directoryOps.ts     # list_directory, create_directory
│   ├── searchOperations.ts # search_files, grep, find_files
│   └── vaultOperations.ts  # get_vault_info, get_backlinks, get_tags
├── git/
│   └── gitSync.ts          # clone, pull, commit+push, periodic sync
└── utils/
    ├── pathValidation.ts   # Path traversal prevention
    └── logger.ts           # Structured logging
```
