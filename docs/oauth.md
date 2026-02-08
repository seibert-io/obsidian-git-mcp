# OAuth 2.1 Authentication with GitHub

## Overview

The server implements OAuth 2.1 with PKCE (S256) and Dynamic Client Registration (RFC 7591) for Claude.ai Custom Connector compatibility. User authentication is handled by GitHub OAuth — the server acts as both an OAuth server (for Claude.ai) and an OAuth client (to GitHub).

## Architecture

```
Claude.ai → Server → GitHub OAuth → User-Info + Allowlist Check → Token → MCP
```

The server has two OAuth roles simultaneously:
- **OAuth Server** for Claude.ai (DCR, Authorization Endpoint, Token Endpoint)
- **OAuth Client** to GitHub (redirects to GitHub login, handles callback)

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | none | RFC 9728 Protected Resource Metadata |
| `/.well-known/oauth-authorization-server` | GET | none | RFC 8414 Authorization Server Metadata |
| `/oauth/register` | POST | none | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | GET | none | Saves session, redirects to GitHub |
| `/oauth/github/callback` | GET | none | GitHub callback → allowlist check → redirect to Claude |
| `/oauth/token` | POST | none | Token exchange (authorization_code, refresh_token) |

## Discovery Flow (RFC 9728 + RFC 8414)

MCP clients use a two-step discovery process:
1. `GET /.well-known/oauth-protected-resource` — returns `authorization_servers` array pointing to this server
2. `GET /.well-known/oauth-authorization-server` — returns full OAuth metadata (endpoints, supported flows)

The `/mcp` endpoint returns `401` with `WWW-Authenticate: Bearer resource_metadata="<url>"` to trigger discovery.

## Flow

```
Claude.ai                        Server                         GitHub
  │                                │                              │
  │  POST /mcp (no token)          │                              │
  │  ─────────────────────────►    │                              │
  │  ◄── 401 + WWW-Authenticate   │                              │
  │                                │                              │
  │  GET /.well-known/             │                              │
  │    oauth-protected-resource    │                              │
  │  ─────────────────────────►    │                              │
  │  ◄── { authorization_servers } │                              │
  │                                │                              │
  │  GET /.well-known/             │                              │
  │    oauth-authorization-server  │                              │
  │  ─────────────────────────►    │                              │
  │  ◄── { endpoints, ... }       │                              │
  │                                │                              │
  │  POST /oauth/register          │                              │
  │  ─────────────────────────►    │                              │
  │  ◄─────────────────────────    │  → client_id, client_secret  │
  │                                │                              │
  │  GET /oauth/authorize          │                              │
  │  ?response_type=code           │                              │
  │  &client_id=...                │                              │
  │  &redirect_uri=...             │  Save session, redirect      │
  │  &state=...                    │  ──────────────────────────►  │
  │  &code_challenge=...           │                              │
  │  &code_challenge_method=S256   │                              │
  │  ─────────────────────────►    │                              │
  │  ◄──── 302 → GitHub ─────     │  User logs in at GitHub      │
  │                                │                              │
  │                                │  GET /oauth/github/callback  │
  │                                │  ?code=...&state=...         │
  │                                │  ◄──────────────────────────  │
  │                                │  Exchange code → token       │
  │                                │  Fetch user info             │
  │                                │  Check allowlist             │
  │  ◄──── 302 → Claude ─────     │  Generate auth code          │
  │  redirect_uri?code=...         │                              │
  │  &state=...                    │                              │
  │                                │                              │
  │  POST /oauth/token             │                              │
  │  grant_type=authorization_code │                              │
  │  &code=...&code_verifier=...   │                              │
  │  ─────────────────────────►    │                              │
  │  ◄─────────────────────────    │  → access_token, refresh     │
  │                                │                              │
  │  POST /mcp                     │                              │
  │  Authorization: Bearer <jwt>   │                              │
  │  ─────────────────────────►    │                              │
```

## Session Bridge

Between the authorize redirect (step 3) and the GitHub callback (step 4), the server stores the Claude session data in-memory:

- **Key**: `crypto.randomBytes(32).toString('hex')` (64 hex chars)
- **Data**: `clientId`, `redirectUri`, `state`, `codeChallenge`, `codeChallengeMethod`, `createdAt`
- **TTL**: 10 minutes
- **One-time use**: consumed and deleted on first callback

The session key is passed to GitHub as the `state` parameter, allowing the server to restore the Claude session on callback.

## Source Files

| File | Purpose |
|---|---|
| `src/oauth/protectedResource.ts` | RFC 9728 Protected Resource Metadata endpoint |
| `src/oauth/metadata.ts` | Authorization Server metadata endpoint |
| `src/oauth/registration.ts` | Dynamic Client Registration |
| `src/oauth/authorize.ts` | Saves session, redirects to GitHub |
| `src/oauth/githubCallback.ts` | GitHub callback handler |
| `src/oauth/githubClient.ts` | GitHub token exchange + user info fetch |
| `src/oauth/sessionStore.ts` | In-memory session store for OAuth bridge |
| `src/oauth/allowlist.ts` | GitHub username allowlist check |
| `src/oauth/token.ts` | Token endpoint (auth_code + refresh) |
| `src/oauth/jwt.ts` | JWT access token create/verify |
| `src/oauth/store.ts` | In-memory client, code, token storage |

## Security

- **GitHub handles** brute-force protection, 2FA/passkeys, session management
- **Username allowlist** is the primary access control (case-insensitive comparison)
- **PKCE S256** required for all authorization flows
- **Auth codes** are single-use with 5-minute expiry
- **Refresh token rotation** — each use invalidates the old token and issues a new one
- **Rate limiting** — 10 registrations/min per IP, 20 token requests/min per IP
- **Redirect URI validation** — must be HTTPS from allowed hosts (claude.ai, claude.com), or HTTP/HTTPS loopback (localhost, 127.0.0.1, ::1) per RFC 8252 for native CLI clients
- **JWT access tokens** signed with HS256 with audience/issuer validation
- **GitHub token discarded** immediately after user info fetch (not stored)
- **Session store** entries expire after 10 minutes and are consumed on first use

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | yes | — | GitHub OAuth App Client Secret |
| `ALLOWED_GITHUB_USERS` | yes | — | Comma-separated allowed GitHub usernames |
| `JWT_SECRET` | yes | — | Secret for signing JWT access tokens (min 32 chars) |
| `SERVER_URL` | yes | — | Public URL of the server (used in metadata + callback URL) |
| `ACCESS_TOKEN_EXPIRY_SECONDS` | no | `3600` | JWT access token lifetime |
| `REFRESH_TOKEN_EXPIRY_SECONDS` | no | `604800` | Refresh token lifetime (default 7 days) |
