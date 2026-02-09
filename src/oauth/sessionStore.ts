import crypto from "node:crypto";

export interface OAuthSession {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SESSIONS = 1000;

export class OAuthSessionStore {
  private sessions = new Map<string, OAuthSession>();

  /**
   * Create a new session to bridge between the Claude authorize request
   * and the GitHub OAuth callback. Returns the session key, or null if
   * the session limit has been reached.
   */
  create(data: Omit<OAuthSession, "createdAt">): string | null {
    this.cleanup();
    if (this.sessions.size >= MAX_SESSIONS) {
      return null;
    }
    const key = crypto.randomBytes(32).toString("hex");
    this.sessions.set(key, { ...data, createdAt: Date.now() });
    return key;
  }

  /**
   * Consume a session by key (one-time use). Returns null if
   * not found or expired.
   */
  consume(key: string): OAuthSession | null {
    const session = this.sessions.get(key);
    if (!session) return null;
    // Always delete (one-time use)
    this.sessions.delete(key);
    if (Date.now() - session.createdAt > SESSION_TTL_MS) return null;
    return session;
  }

  /** Remove expired sessions. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  /** For testing: number of active sessions. */
  size(): number {
    return this.sessions.size;
  }
}
