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

Unit tests for the security-critical path validation logic (17 tests):
- Resolves valid relative paths correctly
- Rejects empty paths
- Rejects `..` path traversal (various forms)
- Rejects absolute paths outside vault
- Blocks `.git` directory access (including nested `.git`, `.gitmodules`, `.gitattributes`)
- Allows filenames containing "git" (not `.git` directory)
- Verifies `PathValidationError` is thrown with correct type

### Integration (`tests/integration.test.ts`)

End-to-end test that starts a real MCP server over Streamable HTTP (9 tests):
- Creates a temporary vault with test files
- Initializes a git repository in the test vault
- Starts an Express server with `StreamableHTTPServerTransport`
- Connects an MCP client to the server
- Tests all 14 tools: listing, reading, searching, grep, backlinks, tags, vault info, guides
- Verifies path traversal is rejected at the tool level

### OAuth (`tests/oauth.test.ts`)

Tests for the full OAuth 2.1 implementation with GitHub authentication (30 tests):

**Server metadata & registration (3 tests):**
- Server metadata endpoint returns correct RFC 8414 data
- Dynamic Client Registration (DCR) — success and failure cases
- Redirect URI validation (HTTPS required, allowed hosts only)

**Authorization & GitHub redirect (2 tests):**
- Authorize endpoint redirects to GitHub with correct parameters
- Missing/invalid authorize parameters return 400

**Session bridge (9 tests):**
- Creates unique session per authorize request (different keys)
- Session consumed on first callback (second callback returns 400)
- Preserves original Claude `state` across GitHub redirect
- Preserves original `redirect_uri` across GitHub redirect
- Preserves PKCE `code_challenge` for token exchange (correct verifier succeeds, wrong verifier fails)
- Invalid/missing/expired state → 400
- Missing code parameter → 400
- Unknown session key → 400
- GitHub error parameter → 400

**Username allowlist (3 tests):**
- Case-insensitive username match allows access
- Non-allowed username redirects with `error=access_denied`
- Unit test: `isAllowedUser()` with various casings

**GitHub API error handling (2 tests):**
- Token exchange failure returns 502
- User info fetch failure returns 502

**Full E2E flow (3 tests):**
- Register → authorize → GitHub callback → token exchange → MCP request → refresh token
- Auth code reuse prevention (one-time use)
- JWT middleware (valid JWT accepted, invalid token rejected)

**Token endpoint (1 test):**
- Unsupported grant type rejection

**OAuthSessionStore unit tests (4 tests):**
- Create + consume returns session data
- Consumed session cannot be reused (one-time use)
- Unknown key returns null
- Multiple sessions get unique keys

**Mocking strategy:** GitHub API calls (`github.com/login/oauth/access_token` and `api.github.com/user`) are intercepted via `globalThis.fetch` override. Local test server requests pass through to the original fetch. No real HTTP requests leave the test process.

**Rate limit handling:** A shared client is registered once in `beforeAll` and reused across all tests to stay within the DCR rate limit (10/min per IP).

### Guides & Prompts (`tests/guides.test.ts`)

Tests for the vault guide tool and MCP prompts (11 tests):
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

## Adding Tests

Place new test files in `tests/` with the `.test.ts` extension. Vitest auto-discovers them.

For tool-specific tests, create a test vault in `/tmp/`, register the relevant tools, and use the MCP client to call them.
