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

**Security reviews MUST be delegated to an independent subagent** (via the Task tool with `subagent_type: "general-purpose"`). The reviewing agent must be briefed as an independent security auditor who relentlessly identifies all issues — in application code, OAuth flows, infrastructure configuration, and Docker/proxy setup. The developer who wrote the code must NOT review their own changes; an independent agent provides the objectivity needed to catch blind spots.

#### Subagent briefing template

The security review agent must be instructed to:

1. **Read ALL changed source files** (not just diffs — full files for context)
2. **Read related files** that interact with the changes (e.g., if OAuth changed, also read transport.ts, config.ts, metadata.ts)
3. **Perform two layers of review:**

**Layer 1 — Focused review of changed files:**
- Path traversal / directory escape (glob patterns, symlinks, `..` in user input)
- Injection risks (command injection via git args, template injection in string replacement)
- Authentication / authorization bypasses (missing auth checks, session fixation)
- Information disclosure (secrets in logs, error messages leaking internals)
- Input validation gaps (missing type checks, unbounded strings, array vs string confusion)
- DoS vectors (unbounded memory growth, missing caps on Maps/stores, missing timeouts on fetch, ReDoS)
- Open redirects (user-controlled redirect URIs not validated against allowlist)
- OWASP Top 10 relevance

**Layer 2 — Holistic review of how changes interact with the full stack:**
- **Infrastructure**: Does the change affect Caddy, Docker, port exposure, TLS termination?
- **OAuth flow end-to-end**: Does the change break or weaken any step in Claude→Server→GitHub→Callback→Token?
- **Proxy interaction**: Does `req.ip` / `trust proxy` / rate limiting still work correctly behind Caddy?
- **Security headers**: Are HSTS, X-Frame-Options, X-Content-Type-Options still applied via Caddy?
- **Secret handling**: Are env vars, JWT secrets, GitHub credentials properly isolated between containers?
- **Volume/mount security**: Are file mounts read-only where possible? Can mounted paths escape the intended scope?
- **Network exposure**: Is the MCP server only accessible via the internal Docker network (not directly from the internet)?

4. **Classify every finding** with severity, file, line reference, and description
5. **List positive security properties** that were verified and are correctly implemented
6. The agent must be told: "This is a RESEARCH task — do NOT modify any files."

#### Severity classification
- **CRITICAL/HIGH**: Fix immediately — auth bypass, RCE, secret leakage
- **MEDIUM**: Fix before committing — path traversal, broken rate limiting, missing timeouts, unbounded stores
- **LOW**: Document as accepted — theoretical TOCTOU, ReDoS with length limit, PII in logs
- **INFO**: Note for awareness — in-memory state loss on restart, cosmetic issues

Fix any HIGH or MEDIUM findings before committing. Document any accepted LOW/INFO findings.

### Execution Order
1. `npm run build` — fix type errors
2. `npm test` — fix failing tests
3. Security review (focused + holistic) — fix vulnerabilities
4. Repeat steps 1-3 if fixes were needed
5. Only then: commit and push
