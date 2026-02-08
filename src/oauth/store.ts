import crypto from "node:crypto";

const MAX_AUTH_CODES = 1000;
const MAX_REFRESH_TOKENS = 2000;

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
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

export class OAuthStore {
  private clients = new Map<string, RegisteredClient>();
  private authCodes = new Map<string, AuthorizationCode>();
  private refreshTokens = new Map<string, RefreshTokenEntry>();

  // --- Client Registration ---

  registerClient(
    clientName: string,
    redirectUris: string[],
    grantTypes: string[],
    responseTypes: string[],
    tokenEndpointAuthMethod: string,
  ): RegisteredClient {
    const client: RegisteredClient = {
      clientId: crypto.randomUUID(),
      clientSecret: crypto.randomBytes(32).toString("hex"),
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod,
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

  validateClientSecret(clientId: string, clientSecret: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    // Timing-safe comparison
    const a = Buffer.from(client.clientSecret);
    const b = Buffer.from(clientSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
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

  cleanup(): void {
    const now = Date.now();
    for (const [code, entry] of this.authCodes) {
      if (now > entry.expiresAt) this.authCodes.delete(code);
    }
    for (const [token, entry] of this.refreshTokens) {
      if (now > entry.expiresAt) this.refreshTokens.delete(token);
    }
  }
}
