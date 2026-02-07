import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./oauth/jwt.js";
import { logger } from "./utils/logger.js";

/**
 * Express middleware that validates authentication.
 * Supports both:
 *   1. OAuth 2.1 JWT access tokens (from /oauth/token flow)
 *   2. Static bearer tokens (legacy MCP_API_TOKEN)
 */
export function bearerAuth(apiToken: string, jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn("Request missing Authorization header", {
        path: req.path,
        ip: req.ip,
      });
      res.status(401).json({ error: "Missing Authorization header" });
      return;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      logger.warn("Malformed Authorization header", {
        path: req.path,
      });
      res.status(401).json({ error: "Invalid Authorization format. Expected: Bearer <token>" });
      return;
    }

    const token = parts[1];

    // Try JWT verification first (OAuth 2.1 flow)
    const jwtPayload = verifyAccessToken(token, jwtSecret);
    if (jwtPayload) {
      next();
      return;
    }

    // Fall back to static bearer token comparison (timing-safe)
    const tokenBuf = Buffer.from(token);
    const apiTokenBuf = Buffer.from(apiToken);
    if (tokenBuf.length === apiTokenBuf.length && crypto.timingSafeEqual(tokenBuf, apiTokenBuf)) {
      next();
      return;
    }

    logger.warn("Invalid bearer token", { path: req.path });
    res.status(401).json({ error: "Invalid token" });
  };
}
