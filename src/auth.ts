import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./oauth/jwt.js";
import { logger } from "./utils/logger.js";

/**
 * Express middleware that validates OAuth 2.1 JWT access tokens.
 * Only JWT tokens issued via the /oauth/token flow are accepted.
 */
export function jwtAuth(jwtSecret: string) {
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

    const jwtPayload = verifyAccessToken(token, jwtSecret);
    if (jwtPayload) {
      next();
      return;
    }

    logger.warn("Invalid bearer token", { path: req.path });
    res.status(401).json({ error: "Invalid token" });
  };
}
