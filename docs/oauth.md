# OAuth 2.1 Authentication

## Overview

The server implements OAuth 2.1 with PKCE (S256) and Dynamic Client Registration (RFC 7591) for Claude.ai Custom Connector compatibility. This runs alongside the existing static bearer token authentication.

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | none | RFC 8414 server metadata |
| `/oauth/register` | POST | none | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | GET | none | Renders login page |
| `/oauth/authorize` | POST | none | Password verification → redirect with auth code |
| `/oauth/token` | POST | none | Token exchange (authorization_code, refresh_token) |

## Flow

```
Client                           Server
  │                                │
  │  POST /oauth/register          │  ← Dynamic Client Registration
  │  ─────────────────────────►    │
  │  ◄─────────────────────────    │  → client_id, client_secret
  │                                │
  │  GET /oauth/authorize          │  ← Shows login page
  │  ?response_type=code           │
  │  &client_id=...                │
  │  &redirect_uri=...             │
  │  &state=...                    │
  │  &code_challenge=...           │
  │  &code_challenge_method=S256   │
  │  ─────────────────────────►    │
  │  ◄─────────────────────────    │  → HTML login form
  │                                │
  │  POST /oauth/authorize         │  ← User submits password
  │  (password=...)                │
  │  ─────────────────────────►    │
  │  ◄─────── 302 redirect ──     │  → redirect_uri?code=...&state=...
  │                                │
  │  POST /oauth/token             │  ← Exchange code for tokens
  │  grant_type=authorization_code │
  │  &code=...                     │
  │  &redirect_uri=...             │
  │  &client_id=...                │
  │  &client_secret=...            │
  │  &code_verifier=...            │
  │  ─────────────────────────►    │
  │  ◄─────────────────────────    │  → access_token (JWT), refresh_token
  │                                │
  │  POST /mcp                     │  ← Use access token
  │  Authorization: Bearer <jwt>   │
  │  ─────────────────────────►    │
```

## Source Files

| File | Purpose |
|---|---|
| `src/oauth/metadata.ts` | Server metadata endpoint |
| `src/oauth/registration.ts` | Dynamic Client Registration |
| `src/oauth/authorize.ts` | Authorization endpoint (GET/POST) |
| `src/oauth/token.ts` | Token endpoint (auth_code + refresh) |
| `src/oauth/jwt.ts` | JWT access token create/verify |
| `src/oauth/store.ts` | In-memory store for clients, codes, refresh tokens |

## Security

- **PKCE S256** required for all authorization flows
- **Auth codes** are single-use with 5-minute expiry
- **Refresh token rotation** — each use invalidates the old token and issues a new one
- **Timing-safe** comparisons for client secrets and passwords
- **Rate limiting** — 10 login attempts/min per IP, 20 token requests/min per IP
- **Redirect URI validation** — must be HTTPS and from allowed hosts (claude.ai, claude.com)
- **JWT access tokens** signed with HS256, configurable expiry

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OAUTH_PASSWORD` | yes | — | Password for the authorization login page |
| `JWT_SECRET` | yes | — | Secret for signing JWT access tokens (min 32 chars) |
| `SERVER_URL` | yes | — | Public URL of the server (used in metadata) |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT access token lifetime |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (default 7 days) |

## Dual-Mode Auth

The auth middleware (`src/auth.ts`) accepts both:
1. **JWT access tokens** issued via the OAuth flow
2. **Static bearer tokens** configured via `MCP_API_TOKEN`

JWT verification is attempted first. If it fails, the middleware falls back to static token comparison.
