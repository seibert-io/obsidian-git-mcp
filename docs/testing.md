# Testing

## Test Framework

Tests use [Vitest](https://vitest.dev/) v4 and are located in the `tests/` directory.

## Running Tests

```bash
npm test          # Run all tests once
npm run test:watch # Run in watch mode
```

## Test Suites

### Path Validation (`tests/pathValidation.test.ts`)

Unit tests for the security-critical path validation logic:
- Resolves valid relative paths correctly
- Rejects empty paths
- Rejects `..` path traversal (various forms)
- Rejects absolute paths outside vault
- Blocks `.git` directory access (including nested `.git`, `.gitmodules`, `.gitattributes`)
- Allows filenames containing "git" (not `.git` directory)
- Verifies `PathValidationError` is thrown with correct type

### Integration (`tests/integration.test.ts`)

End-to-end test that starts a real MCP server over Streamable HTTP:
- Creates a temporary vault with test files
- Initializes a git repository in the test vault
- Starts an Express server with `StreamableHTTPServerTransport`
- Connects an MCP client to the server
- Tests all tools: listing, reading, searching, grep, backlinks, tags, vault info, guides
- Verifies path traversal is rejected at the tool level

### OAuth (`tests/oauth.test.ts`)

Tests for the full OAuth 2.1 implementation with GitHub authentication:

**Server metadata & registration:**
- Server metadata endpoint returns correct RFC 8414 data
- Dynamic Client Registration (DCR) — success and failure cases
- Redirect URI validation (HTTPS required, allowed hosts only)

**Authorization & GitHub redirect:**
- Authorize endpoint redirects to GitHub with correct parameters
- Missing/invalid authorize parameters return 400

**Session bridge:**
- Creates unique session per authorize request (different keys)
- Session consumed on first callback (second callback returns 400)
- Preserves original Claude `state` across GitHub redirect
- Preserves original `redirect_uri` across GitHub redirect
- Preserves PKCE `code_challenge` for token exchange (correct verifier succeeds, wrong verifier fails)
- Invalid/missing/expired state → 400
- Missing code parameter → 400
- Unknown session key → 400
- GitHub error parameter → 400

**Username allowlist:**
- Case-insensitive username match allows access
- Non-allowed username redirects with `error=access_denied`
- Unit test: `isAllowedUser()` with various casings

**GitHub API error handling:**
- Token exchange failure returns 502
- User info fetch failure returns 502

**Full E2E flow:**
- Register → authorize → GitHub callback → token exchange → MCP request → refresh token
- Auth code reuse prevention (one-time use)
- JWT middleware (valid JWT accepted, invalid token rejected)

**Token endpoint:**
- Unsupported grant type rejection

**Public Client (token_endpoint_auth_method: "none"):**
- Metadata advertises `none` as supported auth method
- Registration with `none` returns no `client_secret`
- Token exchange for public client succeeds without `client_secret` (PKCE only)
- Refresh token grant for public client succeeds without `client_secret`
- Token exchange rejects `client_secret` when sent for a public client
- Token exchange rejects missing `client_secret` for a confidential client
- Full E2E flow: public client register → authorize → callback → token → MCP → refresh

**OAuthStore unit tests:**
- Public client registration: no `clientSecret` generated
- Confidential client registration: `clientSecret` generated
- `authenticateClient`: public client accepts no secret, rejects secret
- `authenticateClient`: confidential client accepts correct secret, rejects wrong/missing secret
- `authenticateClient`: unknown `clientId` rejected
- Fresh clients not evicted at capacity
- Stale clients below threshold not evicted
- Stale clients evicted at 90% capacity (cleanup frees registration slots)

**OAuthSessionStore unit tests:**
- Create + consume returns session data
- Consumed session cannot be reused (one-time use)
- Unknown key returns null
- Multiple sessions get unique keys

**Mocking strategy:** GitHub API calls (`github.com/login/oauth/access_token` and `api.github.com/user`) are intercepted via `globalThis.fetch` override. Local test server requests pass through to the original fetch. No real HTTP requests leave the test process.

**Rate limit handling:** A shared client is registered once in `beforeAll` and reused across all tests to stay within the DCR rate limit (10/min per IP).

### OAuth Full-Flow Integration (`tests/oauthFlow.integration.test.ts`)

End-to-end integration tests that exercise the complete OAuth → MCP transport pipeline:

**Setup:** Combines a real MCP server with registered tools, a full OAuth endpoint stack (registration, authorize, GitHub callback, token exchange), JWT auth middleware, and `StreamableHTTPServerTransport` sessions. GitHub API calls are mocked via `globalThis.fetch` override. A temporary vault with git repo is created for tool operations.

**Full-flow tests:**
- OAuth → MCP `listTools` — verifies tool registration is visible through authenticated transport
- OAuth → MCP `read_file` — verifies actual file I/O works through authenticated transport
- Refresh token → new access token → MCP tool call succeeds

**Token validation:**
- Token response structure conforms to RFC 6749 (access_token, token_type, expires_in, refresh_token)
- JWT payload contains required claims (sub, client_id, aud, iss, iat, exp)
- Invalid/missing tokens cause MCP connection to fail with error

**Edge cases:**
- Token endpoint rejects `application/json` Content-Type (documents potential Claude.ai issue: `express.urlencoded()` does not parse JSON bodies → server error)
- Multiple concurrent MCP sessions with different OAuth tokens operate independently
- Token is usable immediately after issuance (no timing delay)
- Discovery endpoints (`.well-known/oauth-protected-resource` and `.well-known/oauth-authorization-server`) return correct metadata per RFC 9728 and RFC 8414

**Public Client integration:**
- Public client full flow: OAuth (no secret) → MCP `listTools`
- Public client refresh token → new access token → MCP tool call succeeds

**Key finding for Claude.ai debugging:** One test confirms that if a client sends the token exchange request as `application/json` instead of `application/x-www-form-urlencoded`, the server fails because `express.urlencoded()` does not parse the JSON body.

### Guides & Prompts (`tests/guides.test.ts`)

Tests for the vault guide tool and MCP prompts:
- `get_obsidian_guide` with topic `conventions` returns conventions content
- `get_obsidian_guide` with topic `search-strategy` returns search guide
- `get_obsidian_guide` with topic `all` returns all guides concatenated
- `get_obsidian_guide` with `create-note` + `note_type: meeting` returns meeting template
- `get_obsidian_guide` with `create-note` defaults to zettel template
- Template variable `{{today}}` is replaced with ISO date
- Lists three MCP prompts
- Prompt `obsidian-conventions` returns correct content
- Prompt `obsidian-search-strategy` returns correct content
- Prompt `obsidian-create-note` with topic returns template with replaced variables
- Custom prompts via volume mount override defaults

### CLAUDE.md Discovery (`tests/claudeMd.test.ts`)

Unit and integration tests for the CLAUDE.md discovery feature:

**Unit tests — `loadRootClaudeMd`:**
- Returns content when `CLAUDE.md` exists in vault root
- Returns `null` when `CLAUDE.md` does not exist
- Detects file changes via mtime (cache invalidation)

**Unit tests — `collectClaudeMdFiles`:**
- Collects `CLAUDE.md` files along path from root to target, excluding root
- Excludes root `CLAUDE.md`
- Returns empty array when no `CLAUDE.md` files on the path
- Rejects path traversal attempts
- Handles single directory level
- Handles target path that is vault root (returns empty)

**Integration tests — with root `CLAUDE.md`:**
- Root `CLAUDE.md` content delivered via MCP `instructions`
- Instructions include `get_claude_context` hint
- `get_claude_context` listed in available tools
- Returns CLAUDE.md files for path with CLAUDE.md
- Excludes root CLAUDE.md from tool results
- Returns "No CLAUDE.md files found" for path without files
- Rejects path traversal in tool input

**Integration tests — without root `CLAUDE.md`:**
- Instructions contain only `get_claude_context` hint (no root content)

## Adding Tests

Place new test files in `tests/` with the `.test.ts` extension. Vitest auto-discovers them.

For tool-specific tests, create a test vault in `/tmp/`, register the relevant tools, and use the MCP client to call them.
