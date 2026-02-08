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
| `docs/tools.md` | All 14 MCP tool definitions, MCP prompts, inputs/outputs | Adding, modifying, or debugging MCP tools or prompts |
| `docs/git-sync.md` | Git clone/pull/push logic, conflict handling, timeouts | Working on git sync, debugging push/pull issues |
| `docs/auth-and-security.md` | OAuth 2.1 JWT auth, path traversal prevention, Docker security | Security changes, auth modifications, path validation |
| `docs/oauth.md` | OAuth 2.1 flow, DCR, PKCE, JWT tokens, endpoints, env vars | OAuth changes, token flow debugging, client registration |
| `docs/configuration.md` | All environment variables with types/defaults, private repo setup | Adding config options or debugging env var issues |
| `docs/deployment.md` | Docker build/run, docker-compose, Claude.ai OAuth integration, health checks | Deployment, Docker changes, connecting to Claude.ai |
| `docs/testing.md` | Test framework, test suites, how to add tests | Writing or running tests |

## Key Architecture Points

- **Entry point**: `src/index.ts` → loads config → inits vault → starts server
- **Transport**: Streamable HTTP with stateful sessions (each client gets a `StreamableHTTPServerTransport`)
- **Auth**: OAuth 2.1 with GitHub authentication; JWT auth on `/mcp`; `/health` and `/oauth/*` are unauthenticated
- **Guides**: `get_obsidian_guide` tool + MCP prompts; source files in `prompts/` (overridable via volume mount)
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

## Mandatory Feedback Loops

**After every code change, the following feedback loops MUST be executed before committing.** Do not skip any step.

### 1. Build Verification
```bash
npm run build
```
The TypeScript build must complete without errors. Fix all type errors before proceeding.

### 2. Test Suite
```bash
npm test
```
All tests must pass (currently 67 tests across 4 suites). If tests fail, fix the root cause — do not skip or disable tests.

### 3. Security Review
Perform a focused security review of all changed files. Check for:
- Path traversal / directory escape
- Injection risks (template injection, command injection, SQL injection)
- Authentication / authorization bypasses
- Information disclosure
- Input validation gaps
- Cache poisoning or DoS vectors
- OWASP Top 10 relevance

Fix any HIGH or MEDIUM findings before committing. Document any accepted LOW/INFO findings.

### Execution Order
1. `npm run build` — fix type errors
2. `npm test` — fix failing tests
3. Security review — fix vulnerabilities
4. Repeat steps 1-3 if fixes were needed
5. Only then: commit and push
