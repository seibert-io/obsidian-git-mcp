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
- Tests all 13 tools: listing, reading, searching, grep, backlinks, tags, vault info
- Verifies path traversal is rejected at the tool level

### OAuth (`tests/oauth.test.ts`)

Tests for the full OAuth 2.1 implementation (14 tests):
- Server metadata endpoint returns correct RFC 8414 data
- Dynamic Client Registration (DCR) — success and failure cases
- Redirect URI validation (HTTPS required, allowed hosts only)
- Authorization page rendering
- Full authorization_code flow with PKCE S256
- Token exchange and refresh token rotation
- Wrong password rejection
- PKCE verification failure
- Auth code reuse prevention (one-time use)
- Dual-mode auth middleware (JWT, static bearer, invalid token)
- Unsupported grant type rejection

## Adding Tests

Place new test files in `tests/` with the `.test.ts` extension. Vitest auto-discovers them.

For tool-specific tests, create a test vault in `/tmp/`, register the relevant tools, and use the MCP client to call them.
