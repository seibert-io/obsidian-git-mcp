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
| `docs/tools.md` | MCP tool definitions, MCP prompts, inputs/outputs | Adding, modifying, or debugging MCP tools or prompts |
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
All tests must pass. If tests fail, fix the root cause — do not skip or disable tests.

### 3. Security Review

**Security reviews MUST be delegated to an independent subagent** (via the Task tool with `subagent_type: "general-purpose"`). The reviewing agent must be briefed as an independent security auditor who relentlessly identifies all issues — in application code, OAuth flows, infrastructure configuration, and Docker/proxy setup. The developer who wrote the code must NOT review their own changes; an independent agent provides the objectivity needed to catch blind spots.

The agent must be explicitly instructed to **think and operate like an attacker**: assume the system will be targeted, actively try to find ways to break authentication, escape sandboxes, leak secrets, exhaust resources, or abuse any functionality. The reviewer should not just verify that security controls exist — they should try to circumvent them.

#### Subagent briefing template

The security review agent must be instructed to:

1. **Read ALL changed source files** (not just diffs — full files for context)
2. **Read related files** that interact with the changes (e.g., if OAuth changed, also read transport.ts, config.ts, metadata.ts)
3. **Perform three layers of review:**

**Layer 1 — Focused review of changed files (examples, not exhaustive):**
- Path traversal / directory escape (glob patterns, symlinks, `..` in user input)
- Injection risks (command injection via git args, template injection in string replacement)
- Authentication / authorization bypasses (missing auth checks, session fixation)
- Information disclosure (secrets in logs, error messages leaking internals)
- Input validation gaps (missing type checks, unbounded strings, array vs string confusion)
- DoS vectors (unbounded memory growth, missing caps on Maps/stores, missing timeouts on fetch, ReDoS)
- Open redirects (user-controlled redirect URIs not validated against allowlist)
- OWASP Top 10 relevance

**Layer 2 — Holistic review of how changes interact with the full stack (examples, not exhaustive):**
- **Infrastructure**: Does the change affect Caddy, Docker, port exposure, TLS termination?
- **OAuth flow end-to-end**: Does the change break or weaken any step in Claude→Server→GitHub→Callback→Token?
- **Proxy interaction**: Does `req.ip` / `trust proxy` / rate limiting still work correctly behind Caddy?
- **Security headers**: Are HSTS, X-Frame-Options, X-Content-Type-Options still applied via Caddy?
- **Secret handling**: Are env vars, JWT secrets, GitHub credentials properly isolated between containers?
- **Volume/mount security**: Are file mounts read-only where possible? Can mounted paths escape the intended scope?
- **Network exposure**: Is the MCP server only accessible via the internal Docker network (not directly from the internet)?

**Layer 3 — Full-codebase security audit (conditional — only when needed):**
Layer 3 is NOT executed by default. After completing Layer 1 and Layer 2, the reviewer must assess whether the changes could have security implications beyond the files and flows already reviewed. Execute Layer 3 **only if** the reviewer cannot confidently rule out that the changes impact other parts of the codebase or other security-critical flows (e.g., changes to shared utilities, auth primitives, input validation logic, or infrastructure configuration that could have cascading effects).

If Layer 3 is triggered: Review the entire application as if seeing it for the first time. Read ALL source files — not just the ones that changed — and audit the complete codebase for vulnerabilities. This layer catches pre-existing issues, systemic weaknesses, and risks that span multiple files but are invisible when only reviewing a diff. The reviewer must trace every data flow from external input to sensitive operation and verify that each boundary is correctly protected.

If Layer 3 is skipped: The reviewer must include a brief statement in their report confirming that Layer 1 and Layer 2 provided sufficient coverage and explaining why the changes are unlikely to have broader security impact.

**The lists above are starting points, not boundaries.** The reviewer must independently identify any additional attack surfaces, vulnerability classes, or architectural risks that are relevant — even if not listed here. The reviewer is expected to think like an attacker and systematically explore all plausible threat vectors.

4. **Ignore external dependencies** — only review project source code (`src/`, config files, Docker/Caddy files). Do not review code inside `node_modules/` or third-party libraries.
5. **Classify every finding** with severity, file, line reference, and description
6. **Report only findings.** Do not list positive properties, verified-correct implementations, or other non-actionable observations. The output should contain exclusively issues that require attention.
7. The agent must be told: "This is a RESEARCH task — do NOT modify any files."

#### Severity classification
- **CRITICAL/HIGH**: Fix immediately — auth bypass, RCE, secret leakage
- **MEDIUM**: Fix before committing — path traversal, broken rate limiting, missing timeouts, unbounded stores
- **LOW**: Document as accepted — theoretical TOCTOU, ReDoS with length limit, PII in logs
- **INFO**: Note for awareness — in-memory state loss on restart, cosmetic issues

Fix any HIGH or MEDIUM findings before committing. Document any accepted LOW/INFO findings.

#### Test-driven fixing of security findings

When a security reviewer reports a risk, check whether the vulnerability can be demonstrated with a test. If yes, follow this TDD workflow:

1. **Write a test** that exercises the reported vulnerability (e.g., attempts the exploit)
2. **Verify the test fails** — confirming the vulnerability exists
3. **Fix the vulnerability** in the application code
4. **Verify the test passes** — confirming the vulnerability is closed

This ensures every security fix is backed by a regression test that prevents reintroduction. If a finding cannot be meaningfully tested (e.g., infrastructure-only or timing-based), fix it directly and document why no test was added.

### 4. Code Review (Clean Code)

**Code reviews MUST be delegated to an independent subagent** (via the Task tool with `subagent_type: "general-purpose"`). The reviewing agent must be briefed as an independent code reviewer with deep expertise in Clean Code principles. The developer who wrote the code must NOT review their own changes — an independent agent provides the fresh perspective needed to catch readability, design, and maintainability issues.

#### Subagent briefing template

The code review agent must be instructed to:

1. **Read ALL changed source files** (full files, not just diffs)
2. **Read related files** that interact with the changes to understand context and conventions
3. **Perform two layers of review:**

**Layer 1 — Focused review of changed code (examples, not exhaustive):**
- **Naming**: Are variable, function, class, and file names descriptive, consistent, and intention-revealing?
- **Single Responsibility**: Does each function/class/module do exactly one thing?
- **DRY (Don't Repeat Yourself)**: Is there duplicated logic that should be extracted?
- **Function design**: Are functions short, focused, and at a single level of abstraction? Do they have minimal parameters?
- **Readability**: Can the code be understood without excessive mental gymnastics? Would a developer new to the project understand the flow?
- **Error handling**: Is error handling consistent, clear, and at appropriate levels?
- **Magic values**: Are there unexplained literals that should be named constants?
- **Dead code**: Is there commented-out code, unused imports, or unreachable branches?
- **Complexity**: Are there deeply nested conditionals or overly clever constructs that should be simplified?
- **Type safety**: Are TypeScript types precise and meaningful (not `any`, not overly loose)?

**Layer 2 — Holistic codebase review (independent of current changes):**
Review the entire codebase for structural and maintainability issues as if seeing it for the first time:
- **Module structure**: Are responsibilities cleanly separated between files/directories?
- **Consistency**: Are patterns (error handling, logging, validation) applied uniformly across the codebase?
- **Coupling**: Are modules loosely coupled with clear interfaces, or are there hidden dependencies?
- **Abstraction levels**: Are abstractions appropriate — neither premature nor missing where they should exist?
- **Code organization**: Is related code co-located? Are imports clean and organized?
- **API design**: Are function signatures, return types, and error contracts clear and consistent?

**The lists above are starting points, not boundaries.** The reviewer must independently identify any additional code quality issues, anti-patterns, or maintainability risks — even if not listed here.

4. **Ignore external dependencies** — only review project source code (`src/`, config files). Do not review code inside `node_modules/` or third-party libraries.
5. **Classify every finding** with severity, file, line reference, and description
6. **Report only findings.** Do not list positive properties, verified-correct implementations, or other non-actionable observations. The output should contain exclusively issues that require attention.
7. The agent must be told: "This is a RESEARCH task — do NOT modify any files."

#### Severity classification
- **HIGH**: Fix before committing — code that is misleading, significantly hard to maintain, or violates fundamental design principles
- **MEDIUM**: Should fix — unclear naming, moderate duplication, inconsistent patterns, unnecessary complexity
- **LOW**: Nice to have — minor style preferences, cosmetic improvements, small naming tweaks
- **INFO**: Observation — acceptable trade-offs, areas to watch in future changes

Fix any HIGH findings before committing. MEDIUM findings should be fixed unless there is a documented reason to defer. LOW/INFO findings are optional.

### Execution Order
1. `npm run build` — fix type errors
2. `npm test` — fix failing tests
3. Security review (independent agent, 2 layers + conditional Layer 3) — fix vulnerabilities
4. Code review (independent agent, clean code) — fix quality issues
5. Repeat steps 1-4 if fixes were needed
6. Only then: commit and push
