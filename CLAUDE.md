# CLAUDE.md — Obsidian Vault MCP Server

## Project Overview

Dockerized Remote MCP Server that exposes a Git-synced Obsidian vault via filesystem tools over Streamable HTTP (SSE). Built with Node.js, TypeScript, and the `@modelcontextprotocol/sdk`.

## Quick Commands

```bash
npm run build     # Compile TypeScript to dist/
npm run dev       # Run with tsx (dev mode)
npm start         # Run compiled dist/index.js
npm test          # Run all tests (vitest)
npm run lint      # Type-check without emitting
```

## Documentation Reference

Load the relevant doc file when working on a specific domain:

| File | Contents | Load When |
|---|---|---|
| `docs/architecture.md` | System design, component diagram, request flow, directory structure | Understanding overall architecture or adding new components |
| `docs/tools.md` | All 13 MCP tool definitions with inputs/outputs | Adding, modifying, or debugging MCP tools |
| `docs/git-sync.md` | Git clone/pull/push logic, conflict handling, timeouts | Working on git sync, debugging push/pull issues |
| `docs/auth-and-security.md` | Bearer token auth, OAuth 2.1, path traversal prevention, Docker security | Security changes, auth modifications, path validation |
| `docs/oauth.md` | OAuth 2.1 flow, DCR, PKCE, JWT tokens, endpoints, env vars | OAuth changes, token flow debugging, client registration |
| `docs/configuration.md` | All environment variables with types/defaults, private repo setup | Adding config options or debugging env var issues |
| `docs/deployment.md` | Docker build/run, docker-compose, Claude.ai OAuth integration, health checks | Deployment, Docker changes, connecting to Claude.ai |
| `docs/testing.md` | Test framework, test suites, how to add tests | Writing or running tests |

## Key Architecture Points

- **Entry point**: `src/index.ts` → loads config → inits vault → starts server
- **Transport**: Streamable HTTP with stateful sessions (each client gets a `StreamableHTTPServerTransport`)
- **Auth**: Dual-mode auth on `/mcp` — JWT (OAuth 2.1) or static bearer token; `/health` and `/oauth/*` are unauthenticated
- **Path safety**: All paths validated by `resolveVaultPath()` in `src/utils/pathValidation.ts`
- **Git writes**: Every write operation triggers `git add . && git commit && git push`

## Documentation Maintenance Requirement

**Whenever changes or additions are made to the codebase, the relevant documentation files in `docs/` must be updated to reflect those changes.** This includes:

- New tools → update `docs/tools.md`
- Architecture changes → update `docs/architecture.md`
- New config options → update `docs/configuration.md`
- Security changes → update `docs/auth-and-security.md`
- New tests → update `docs/testing.md`
- Deployment changes → update `docs/deployment.md`
- Git sync changes → update `docs/git-sync.md`
- New doc files → add an entry to the reference table above in this file
