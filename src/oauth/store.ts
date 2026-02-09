import crypto from "node:crypto";

const MAX_AUTH_CODES = 1000;
const MAX_REFRESH_TOKENS = 2000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLIENT_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLIENT_CLEANUP_THRESHOLD = 0.9; // evict stale clients when at 90% capacity

export type TokenEndpointAuthMethod = "client_secret_post" | "none";

export interface ClientRegistrationParams {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | undefined;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  registeredAt: number;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface RefreshTokenEntry {
  token: string;
  clientId: string;
  expiresAt: number;
}

/**
 * Verifies client credentials based on the registered auth method.
 * Pure function — no side effects, no lookups.
 */
export function verifyClientCredentials(
  client: RegisteredClient,
  clientSecret: string | undefined,
): boolean {
  if (client.tokenEndpointAuthMethod === "none") {
    return clientSecret === undefined;
  }

  if (!client.clientSecret || !clientSecret) return false;
  const a = Buffer.from(client.clientSecret);
  const b = Buffer.from(clientSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class OAuthStore {
  private clients = new Map<string, RegisteredClient>();
  private authCodes = new Map<string, AuthorizationCode>();
  private refreshTokens = new Map<string, RefreshTokenEntry>();

  // --- Client Registration ---

  registerClient(params: ClientRegistrationParams): RegisteredClient {
    const isPublicClient = params.tokenEndpointAuthMethod === "none";
    const client: RegisteredClient = {
      clientId: crypto.randomUUID(),
      clientSecret: isPublicClient ? undefined : crypto.randomBytes(32).toString("hex"),
      clientName: params.clientName,
      redirectUris: params.redirectUris,
      grantTypes: params.grantTypes,
      responseTypes: params.responseTypes,
      tokenEndpointAuthMethod: params.tokenEndpointAuthMethod,
      registeredAt: Date.now(),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  clientCount(): number {
    return this.clients.size;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Looks up a client and verifies credentials.
   * Delegates to the pure `verifyClientCredentials` function.
   */
  authenticateClient(clientId: string, clientSecret: string | undefined): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    return verifyClientCredentials(client, clientSecret);
  }

  // --- Authorization Codes ---

  createAuthCode(
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
  ): string {
    // Evict oldest entry if at capacity
    if (this.authCodes.size >= MAX_AUTH_CODES) {
      const oldestKey = this.authCodes.keys().next().value;
      if (oldestKey) this.authCodes.delete(oldestKey);
    }
    const code = crypto.randomBytes(32).toString("hex");
    this.authCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  consumeAuthCode(code: string): AuthorizationCode | null {
    const entry = this.authCodes.get(code);
    if (!entry) return null;
    // Always delete (one-time use)
    this.authCodes.delete(code);
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  // --- Refresh Tokens ---

  createRefreshToken(clientId: string, expirySeconds: number): string {
    // Evict oldest entry if at capacity
    if (this.refreshTokens.size >= MAX_REFRESH_TOKENS) {
      const oldestKey = this.refreshTokens.keys().next().value;
      if (oldestKey) this.refreshTokens.delete(oldestKey);
    }
    const token = crypto.randomBytes(32).toString("hex");
    this.refreshTokens.set(token, {
      token,
      clientId,
      expiresAt: Date.now() + expirySeconds * 1000,
    });
    return token;
  }

  consumeRefreshToken(token: string): RefreshTokenEntry | null {
    const entry = this.refreshTokens.get(token);
    if (!entry) return null;
    // Rotation: always delete old token
    this.refreshTokens.delete(token);
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  // --- Cleanup ---

  cleanup(maxClients = 500): void {
    const now = Date.now();
    for (const [code, entry] of this.authCodes) {
      if (now > entry.expiresAt) this.authCodes.delete(code);
    }
    for (const [token, entry] of this.refreshTokens) {
      if (now > entry.expiresAt) this.refreshTokens.delete(token);
    }
    // Evict stale clients when nearing capacity to free registration slots
    if (this.clients.size >= maxClients * CLIENT_CLEANUP_THRESHOLD) {
      for (const [id, client] of this.clients) {
        if (now - client.registeredAt > CLIENT_STALENESS_MS) {
          this.clients.delete(id);
        }
      }
    }
  }
}
