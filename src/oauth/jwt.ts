import jwt from "jsonwebtoken";

export interface AccessTokenPayload {
  sub: string;
  client_id: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
}

export function createAccessToken(
  clientId: string,
  jwtSecret: string,
  expirySeconds: number,
  audience?: string,
): string {
  return jwt.sign(
    { sub: "vault-user", client_id: clientId },
    jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: expirySeconds,
      audience: audience ?? "obsidian-vault-mcp",
      issuer: "obsidian-vault-mcp",
    },
  );
}

export function verifyAccessToken(
  token: string,
  jwtSecret: string,
): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
      audience: "obsidian-vault-mcp",
      issuer: "obsidian-vault-mcp",
    }) as AccessTokenPayload;
    return payload;
  } catch {
    return null;
  }
}
